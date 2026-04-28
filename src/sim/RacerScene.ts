import Phaser from 'phaser';
import Panzoom, { type PanzoomObject } from '@panzoom/panzoom';
import type {
  CameraState,
  ExportSnapshot,
  Genome,
  ReplayFrame,
  SegmentScore,
  SaveSnapshot,
  TrackDefinition,
  TrackSegment,
  TrainingConfig,
  TrainingPhase,
  TrainingStats,
  TrainingStart,
} from '../types';
import { DEFAULT_TRAINING_CONFIG } from '../types';
import {
  WORLD_HEIGHT,
  WORLD_WIDTH,
  clamp,
  closedPathLength,
  createPresetTrack,
  distance,
  generateTrack,
  nearestDistanceToPolyline,
  nearestPointOnClosedPath,
  raySegmentDistance,
  segmentsIntersect,
  trackWallSegments,
  wrapAngle,
} from '../lib/geometry';
import { bestGenome, compareGenomes, createInitialPopulation, evolvePopulation } from '../lib/evolution';
import {
  buildTrackSegments,
  calculateSmartSegmentFitness,
  createSegmentScores,
  createTrainingStarts,
  hardestSegmentIndex,
  segmentCoverage,
} from '../lib/curriculum';
import { calculateFitness, cloneGenome, evaluateNetwork } from '../lib/neural';
import { createExportSnapshot, hasSnapshot, loadSnapshot, parseExportSnapshot, saveSnapshot } from '../lib/storage';

type MatterBody = MatterJS.BodyType;

type SceneCallbacks = {
  onReady: (scene: RacerScene) => void;
  onStats: (stats: TrainingStats) => void;
  onTrackChange: (track: TrackDefinition) => void;
  onStorageChange: (hasSave: boolean) => void;
  onCameraChange: (camera: CameraState) => void;
};

type SimCar = {
  id: string;
  genome: Genome;
  body: MatterBody;
  alive: boolean;
  removed: boolean;
  crashed: boolean;
  stagnant: boolean;
  completedLap: boolean;
  age: number;
  completedLaps: number;
  lapStartAge: number;
  bestLapTicks: number | null;
  nextCheckpoint: number;
  trainingStart: TrainingStart;
  segmentCompleted: boolean;
  checkpointCount: number;
  speedScore: number;
  progressScore: number;
  bestProgress: number;
  previousProgressDistance: number;
  lapOffset: number;
  reversePenalty: number;
  wallPenalty: number;
  fitness: number;
  lastCheckpointAge: number;
  lastProgressAge: number;
  previousPosition: { x: number; y: number };
  trail: Array<{ x: number; y: number }>;
  replay: ReplayFrame[];
  color: number;
};

const SENSOR_ANGLES = [-0.95, -0.48, 0, 0.48, 0.95];
const SENSOR_RANGE = 210;
const MAX_SPEED = 9.2;
const CAR_WIDTH = 27;
const CAR_HEIGHT = 14;
const WALL_THICKNESS = 12;
const CAR_COLORS = [0x38f8d4, 0xffce45, 0xff5b7c, 0x67a6ff, 0xd6ff5a, 0xf489ff];
const CAR_CATEGORY = 0x0001;
const WALL_CATEGORY = 0x0002;
const MIN_VIEWPORT_SCALE = 0.12;
const MAX_VIEWPORT_SCALE = 2.4;
const FIT_TRACK_MARGIN = 720;

export class RacerScene extends Phaser.Scene {
  private callbacks: SceneCallbacks;
  private track: TrackDefinition = createPresetTrack();
  private wallSegments = trackWallSegments(this.track);
  private trackLength = closedPathLength(this.track.centerline);
  private wallBodies: MatterBody[] = [];
  private cars: SimCar[] = [];
  private population: Genome[] = [];
  private bestGenomeEver: Genome | null = null;
  private bestCoachGenome: Genome | null = null;
  private bestScoreEver = 0;
  private bestLapTicksEver: number | null = null;
  private generation = 0;
  private generationStep = 0;
  private history: number[] = [];
  private lastEvolution = { eliteCount: 0, teacherChildren: 0, randomImmigrants: 0 };
  private running = false;
  private drawing = false;
  private drawPoints: Array<{ x: number; y: number }> = [];
  private drawPointerId: number | null = null;
  private drawingHandlers: Array<{ type: keyof HTMLElementEventMap; handler: EventListener }> = [];
  private cameraState: CameraState = { zoom: 1, scrollX: 0, scrollY: 0, followBest: false };
  private panzoom: PanzoomObject | null = null;
  private panzoomChangeHandler?: EventListener;
  private wheelHandler?: (event: WheelEvent) => void;
  private resizeObserver?: ResizeObserver;
  private ghostReplay: ReplayFrame[] = [];
  private fullLapGhostReplay: ReplayFrame[] = [];
  private heatPoints: Array<{ x: number; y: number; strength: number }> = [];
  private trackSegments: TrackSegment[] = [];
  private segmentScores: SegmentScore[] = [];
  private trainingStarts: TrainingStart[] = [];
  private trainingPhase: TrainingPhase = 'learningStart';
  private activeSegmentIndex: number | null = null;
  private recordAttempts = 0;
  private validationLapTicks: number | null = null;
  private config: TrainingConfig = { ...DEFAULT_TRAINING_CONFIG };
  private trackGraphics?: Phaser.GameObjects.Graphics;
  private ghostGraphics?: Phaser.GameObjects.Graphics;
  private heatGraphics?: Phaser.GameObjects.Graphics;
  private carGraphics?: Phaser.GameObjects.Graphics;
  private sensorGraphics?: Phaser.GameObjects.Graphics;
  private drawGraphics?: Phaser.GameObjects.Graphics;

  constructor(callbacks: SceneCallbacks) {
    super({ key: 'RacerScene' });
    this.callbacks = callbacks;
  }

  create(): void {
    this.trackGraphics = this.add.graphics();
    this.heatGraphics = this.add.graphics();
    this.ghostGraphics = this.add.graphics();
    this.sensorGraphics = this.add.graphics();
    this.carGraphics = this.add.graphics();
    this.drawGraphics = this.add.graphics();
    this.matter.world.disableGravity();
    this.matter.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT, 80);
    this.matter.world.pause();
    this.cameras.main.setScroll(0, 0);
    this.cameras.main.setZoom(1);
    this.installViewportControls();
    this.installCollisionHandler();
    this.installDrawingInput();
    this.setTrack(this.track, false);
    this.resetTraining();
    this.callbacks.onReady(this);
    this.callbacks.onStorageChange(hasSnapshot());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.destroyViewportControls();
      this.destroyDrawingInput();
    });
  }

  update(): void {
    if (!this.running || this.cars.length === 0) {
      this.updateFollowCamera();
      this.renderCars();
      return;
    }

    this.generationStep += this.config.speedMultiplier;
    for (const car of this.cars) {
      if (car.alive) {
        this.updateCar(car);
      }
    }

    if (this.cars.every((car) => !car.alive) || this.generationStep >= this.config.maxSteps) {
      this.finishGeneration();
      return;
    }

    this.renderCars();
    this.updateFollowCamera();
    if (Math.round(this.generationStep) % 8 === 0) {
      this.emitStats('running');
    }
  }

  applyConfig(config: Partial<TrainingConfig>): void {
    const populationChanged = config.populationSize !== undefined && config.populationSize !== this.config.populationSize;
    const segmentCountChanged = config.smartSegmentCount !== undefined && config.smartSegmentCount !== this.config.smartSegmentCount;
    this.config = {
      ...this.config,
      ...config,
    };
    if (this.config.trainingMode !== 'manualLab') {
      this.config.advancedTuningEnabled = false;
    }
    this.matter.world.engine.timing.timeScale = this.config.speedMultiplier;

    if (segmentCountChanged) {
      this.rebuildTrackSegments();
    }

    if (populationChanged) {
      this.resetTraining();
    } else {
      this.emitStats(this.running ? 'running' : 'paused');
    }
  }

  setRunning(running: boolean): void {
    this.running = running;
    if (running) {
      this.drawing = false;
      this.drawPoints = [];
      this.drawGraphics?.clear();
      this.matter.world.resume();
      this.matter.world.engine.timing.timeScale = this.config.speedMultiplier;
    } else {
      this.matter.world.pause();
    }
    this.emitStats(running ? 'running' : 'paused');
  }

  setDrawing(drawing: boolean): void {
    this.drawing = drawing;
    this.panzoom?.setOptions({
      disablePan: drawing,
      cursor: drawing ? 'crosshair' : 'grab',
    });
    if (drawing) {
      this.setRunning(false);
    }
    this.emitStats(drawing ? 'drawing' : 'paused');
  }

  loadPresetTrack(): void {
    this.setRunning(false);
    this.setTrack(createPresetTrack(), true);
    this.bestGenomeEver = null;
    this.bestCoachGenome = null;
    this.bestScoreEver = 0;
    this.bestLapTicksEver = null;
    this.validationLapTicks = null;
    this.recordAttempts = 0;
    this.history = [];
    this.generation = 0;
    this.resetTraining();
  }

  resetTraining(): void {
    this.destroyCars();
    this.population = createInitialPopulation(this.config.populationSize, this.generation);
    if (this.bestGenomeEver) {
      this.population[0] = {
        ...cloneGenome(this.bestGenomeEver),
        id: `g${this.generation}-saved-elite`,
        generation: this.generation,
        score: 0,
        completedLap: false,
        bestLapTicks: null,
      };
    }
    this.generationStep = 0;
    this.startGeneration();
    this.emitStats(this.running ? 'running' : 'paused');
  }

  saveCurrentSnapshot(): ExportSnapshot {
    const snapshot = saveSnapshot(this.track, this.bestGenomeEver, this.config, this.generation);
    this.callbacks.onStorageChange(true);
    return snapshot;
  }

  loadSavedSnapshot(): SaveSnapshot | null {
    const snapshot = loadSnapshot();
    if (!snapshot) {
      return null;
    }

    this.setRunning(false);
    this.bestGenomeEver = snapshot.bestGenome ? cloneGenome(snapshot.bestGenome) : null;
    this.bestCoachGenome = this.bestGenomeEver ? cloneGenome(this.bestGenomeEver) : null;
    this.bestScoreEver = this.bestGenomeEver?.score ?? 0;
    this.bestLapTicksEver = this.bestGenomeEver?.bestLapTicks ?? null;
    this.validationLapTicks = this.bestLapTicksEver;
    this.generation = snapshot.generation;
    if (snapshot.version === 2) {
      this.applyConfig(snapshot.config);
    }
    this.setTrack(snapshot.track, true);
    this.resetTraining();
    return snapshot;
  }

  exportCurrentSnapshot(): ExportSnapshot {
    return createExportSnapshot(this.track, this.bestGenomeEver, this.config, this.generation);
  }

  importSnapshot(raw: string): ExportSnapshot | null {
    const snapshot = parseExportSnapshot(raw);
    if (!snapshot) {
      return null;
    }

    this.setRunning(false);
    this.bestGenomeEver = snapshot.bestGenome ? cloneGenome(snapshot.bestGenome) : null;
    this.bestCoachGenome = this.bestGenomeEver ? cloneGenome(this.bestGenomeEver) : null;
    this.bestScoreEver = this.bestGenomeEver?.score ?? 0;
    this.bestLapTicksEver = this.bestGenomeEver?.bestLapTicks ?? null;
    this.validationLapTicks = this.bestLapTicksEver;
    this.generation = snapshot.generation;
    this.config = { ...this.config, ...snapshot.config };
    this.setTrack(snapshot.track, true);
    this.resetTraining();
    return snapshot;
  }

  zoomIn(): void {
    this.zoomViewportAtCenter(1.18);
  }

  zoomOut(): void {
    this.zoomViewportAtCenter(1 / 1.18);
  }

  fitToTrack(): void {
    this.cameraState.followBest = false;
    this.fitViewportToTrack(true);
  }

  toggleFollowBest(): CameraState {
    this.cameraState = {
      ...this.cameraState,
      followBest: !this.cameraState.followBest,
    };
    return this.cameraState;
  }

  getCameraState(): CameraState {
    this.syncViewportState(false);
    return this.cameraState;
  }

  getCurrentTrack(): TrackDefinition {
    return this.track;
  }

  resizeViewport(width: number, height: number): void {
    this.scale.resize(WORLD_WIDTH, WORLD_HEIGHT);
    if (width > 0 && height > 0 && !this.cameraState.followBest) {
      this.fitViewportToTrack(true);
    }
  }

  private setTrack(track: TrackDefinition, notify: boolean): void {
    this.track = track;
    this.wallSegments = trackWallSegments(track);
    this.trackLength = closedPathLength(track.centerline);
    this.rebuildTrackSegments();
    this.destroyWalls();
    this.createWalls();
    this.drawTrack();
    this.fitViewportToTrack(true);
    if (notify) {
      this.callbacks.onTrackChange(track);
    }
  }

  private installViewportControls(): void {
    const canvas = this.game.canvas;
    const parent = canvas.parentElement;
    if (!parent) {
      return;
    }

    this.input.mouse?.disableContextMenu();
    parent.addEventListener('contextmenu', (event) => event.preventDefault());
    this.panzoom = Panzoom(canvas, {
      canvas: true,
      minScale: MIN_VIEWPORT_SCALE,
      maxScale: MAX_VIEWPORT_SCALE,
      step: 0.34,
      cursor: 'grab',
      origin: '0 0',
      touchAction: 'none',
      overflow: 'hidden',
      handleStartEvent: (event) => {
        event.preventDefault();
      },
    });

    this.panzoomChangeHandler = ((event: Event) => {
      const detail = (event as CustomEvent<{ x: number; y: number; scale: number }>).detail;
      this.cameraState = {
        ...this.cameraState,
        zoom: detail.scale,
        scrollX: detail.x,
        scrollY: detail.y,
      };
      this.callbacks.onCameraChange(this.cameraState);
    }) as EventListener;
    canvas.addEventListener('panzoomchange', this.panzoomChangeHandler);

    this.wheelHandler = (event: WheelEvent) => {
      event.preventDefault();
      this.cameraState.followBest = false;
      const direction = event.deltaY > 0 ? 1 / 1.14 : 1.14;
      this.zoomViewportToPoint(event.clientX, event.clientY, direction, true);
    };
    parent.addEventListener('wheel', this.wheelHandler, { passive: false });

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.cameraState.followBest) {
        this.fitViewportToTrack(true);
      }
    });
    this.resizeObserver.observe(parent);
  }

  private destroyViewportControls(): void {
    const canvas = this.game.canvas;
    const parent = canvas.parentElement;
    if (this.panzoomChangeHandler) {
      canvas.removeEventListener('panzoomchange', this.panzoomChangeHandler);
    }
    if (this.wheelHandler && parent) {
      parent.removeEventListener('wheel', this.wheelHandler);
    }
    this.resizeObserver?.disconnect();
    this.panzoom?.destroy();
    this.panzoom = null;
  }

  private installCollisionHandler(): void {
    this.matter.world.on('collisionstart', (event: { pairs: Array<{ bodyA: MatterBody; bodyB: MatterBody }> }) => {
      for (const pair of event.pairs) {
        const carBody = pair.bodyA.label === 'car' ? pair.bodyA : pair.bodyB.label === 'car' ? pair.bodyB : null;
        const wallBody = pair.bodyA.label === 'wall' ? pair.bodyA : pair.bodyB.label === 'wall' ? pair.bodyB : null;
        if (carBody && wallBody) {
          const id = this.getCarId(carBody);
          const car = this.cars.find((candidate) => candidate.id === id);
          if (car) {
            this.killCar(car, true, false);
          }
        }
      }
    });
  }

  private installDrawingInput(): void {
    const parent = this.getViewportElement();
    if (!parent) {
      return;
    }

    const onPointerDown = ((event: Event) => {
      if (!this.drawing || !(event instanceof PointerEvent)) return;
      event.preventDefault();
      this.drawPointerId = event.pointerId;
      parent.setPointerCapture?.(event.pointerId);
      this.drawPoints = [this.clientToWorld(event.clientX, event.clientY)];
      this.renderDrawPoints();
    }) as EventListener;

    const onPointerMove = ((event: Event) => {
      if (!this.drawing || !(event instanceof PointerEvent) || event.pointerId !== this.drawPointerId) return;
      const point = this.clientToWorld(event.clientX, event.clientY);
      const previous = this.drawPoints.at(-1);
      if (!previous || distance(previous, point) > 10) {
        this.drawPoints.push(point);
        this.renderDrawPoints();
      }
    }) as EventListener;

    const onPointerUp = ((event: Event) => {
      if (!(event instanceof PointerEvent) || event.pointerId !== this.drawPointerId) return;
      parent.releasePointerCapture?.(event.pointerId);
      this.drawPointerId = null;
      this.finishDrawingTrack();
    }) as EventListener;

    this.drawingHandlers = [
      { type: 'pointerdown', handler: onPointerDown },
      { type: 'pointermove', handler: onPointerMove },
      { type: 'pointerup', handler: onPointerUp },
      { type: 'pointercancel', handler: onPointerUp },
    ];
    for (const { type, handler } of this.drawingHandlers) {
      parent.addEventListener(type, handler);
    }
  }

  private destroyDrawingInput(): void {
    const parent = this.getViewportElement();
    if (!parent) {
      return;
    }
    for (const { type, handler } of this.drawingHandlers) {
      parent.removeEventListener(type, handler);
    }
    this.drawingHandlers = [];
  }

  private clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const parent = this.getViewportElement();
    const rect = parent?.getBoundingClientRect();
    const scale = this.panzoom?.getScale() ?? 1;
    const pan = this.panzoom?.getPan() ?? { x: 0, y: 0 };
    return {
      x: ((clientX - (rect?.left ?? 0)) / scale) - pan.x,
      y: ((clientY - (rect?.top ?? 0)) / scale) - pan.y,
    };
  }

  private finishDrawingTrack(): void {
    if (!this.drawing || this.drawPoints.length < 8) return;
    try {
      const nextTrack = generateTrack(this.drawPoints, this.track.width);
      this.setTrack(nextTrack, true);
      this.bestGenomeEver = null;
      this.bestCoachGenome = null;
      this.bestScoreEver = 0;
      this.bestLapTicksEver = null;
      this.validationLapTicks = null;
      this.recordAttempts = 0;
      this.history = [];
      this.generation = 0;
      this.resetTraining();
    } catch {
      this.drawPoints = [];
      this.renderDrawPoints();
    }
  }

  private createWalls(): void {
    for (const [a, b] of this.wallSegments) {
      const length = distance(a, b);
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const body = this.matter.add.rectangle(center.x, center.y, length, WALL_THICKNESS, {
        isStatic: true,
        label: 'wall',
        friction: 0,
        restitution: 0.1,
        collisionFilter: {
          category: WALL_CATEGORY,
          mask: CAR_CATEGORY,
        },
      }) as MatterBody;
      this.matter.body.setAngle(body, angle);
      this.wallBodies.push(body);
    }
  }

  private destroyWalls(): void {
    for (const body of this.wallBodies) {
      this.matter.world.remove(body);
    }
    this.wallBodies = [];
  }

  private startGeneration(): void {
    this.destroyCars();
    this.generationStep = 0;
    this.trainingStarts = createTrainingStarts(
      this.track,
      this.trackSegments,
      this.segmentScores,
      this.config,
      this.generation,
      this.config.populationSize,
    );
    this.activeSegmentIndex = this.trainingStarts.find((start) => start.segmentIndex !== null)?.segmentIndex ?? null;
    const validationRun = this.trainingStarts.some((start) => start.validation);
    const sectorStart = this.trainingStarts.find((start) => start.kind === 'segment');
    this.trainingPhase = validationRun
      ? 'fullLapValidation'
      : this.config.trainingMode !== 'smartCoach'
        ? 'recordAttempt'
        : this.generation < 2
          ? 'learningStart'
          : sectorStart?.phase ?? 'recordAttempt';
    if (validationRun) {
      this.recordAttempts += this.trainingStarts.filter((start) => start.kind === 'fullLap').length;
    }
    this.drawTrack();
    this.cars = this.population.map((genome, index) => this.createCar(genome, index));
    this.renderCars();
  }

  private finishGeneration(): void {
    this.emitStats('evolving');
    for (const car of this.cars) {
      if (car.alive && car.trainingStart.kind === 'segment') {
        this.recordSegmentAttempt(car);
      }
    }
    const scoredPopulation = this.cars.map((car) => ({
      ...cloneGenome(car.genome),
      score: car.fitness,
      completedLap: car.completedLap,
      bestLapTicks: car.bestLapTicks,
    }));
    const generationBest = bestGenome(scoredPopulation);
    const generationLapBest = bestGenome(scoredPopulation.filter((genome) => genome.completedLap && genome.bestLapTicks));
    const bestCar = this.selectBestCar();
    if (bestCar && bestCar.replay.length > 6) {
      this.ghostReplay = bestCar.replay.slice(-260);
    }
    const bestLapCar = this.selectBestCar((car) => car.completedLap);
    if (bestLapCar && bestLapCar.replay.length > 6) {
      this.fullLapGhostReplay = bestLapCar.replay.slice(-360);
      this.validationLapTicks = minLapTicks(this.validationLapTicks, bestLapCar.bestLapTicks);
    }
    if (generationBest) {
      this.bestScoreEver = Math.max(this.bestScoreEver, generationBest.score);
      if (!this.bestCoachGenome || compareGenomes(generationBest, this.bestCoachGenome) > 0) {
        this.bestCoachGenome = cloneGenome(generationBest);
      }
    }
    if (generationLapBest && (!this.bestGenomeEver || compareGenomes(generationLapBest, this.bestGenomeEver) > 0)) {
      this.bestGenomeEver = cloneGenome(generationLapBest);
      this.bestLapTicksEver = generationLapBest.bestLapTicks ?? this.bestLapTicksEver;
    }

    this.history = [...this.history.slice(-47), generationBest?.score ?? 0];
    const evolution = evolvePopulation(scoredPopulation, this.config, this.generation, this.bestCoachGenome ?? this.bestGenomeEver);
    this.population = evolution.population;
    this.lastEvolution = {
      eliteCount: evolution.eliteCount,
      teacherChildren: evolution.teacherChildren,
      randomImmigrants: evolution.randomImmigrants,
    };
    this.generation += 1;
    this.startGeneration();
    if (this.running) {
      this.matter.world.resume();
    }
    this.emitStats(this.running ? 'running' : 'paused');
  }

  private createCar(genome: Genome, index: number): SimCar {
    const offset = (index % 8) - 3.5;
    const trainingStart = this.trainingStarts[index] ?? {
      kind: 'fullLap',
      phase: 'recordAttempt',
      pose: this.track.spawnPose,
      startDistance: 0,
      targetDistance: this.trackLength,
      segmentIndex: null,
      validation: false,
    } satisfies TrainingStart;
    const spawn = trainingStart.pose;
    const lateral = {
      x: Math.cos(spawn.angle + Math.PI / 2),
      y: Math.sin(spawn.angle + Math.PI / 2),
    };
    const spawnOffset = trainingStart.kind === 'segment' ? offset * 1.1 : offset * 2.4;
    const body = this.matter.add.rectangle(
      spawn.x + lateral.x * spawnOffset,
      spawn.y + lateral.y * spawnOffset,
      CAR_WIDTH,
      CAR_HEIGHT,
      {
        label: 'car',
        frictionAir: 0.055,
        friction: 0.02,
        restitution: 0.12,
        collisionFilter: {
          category: CAR_CATEGORY,
          mask: WALL_CATEGORY,
        },
      },
    ) as MatterBody;
    this.matter.body.setAngle(body, spawn.angle);
    body.plugin = {
      ...body.plugin,
      carId: genome.id,
    };

    return {
      id: genome.id,
      genome,
      body,
      alive: true,
      removed: false,
      crashed: false,
      stagnant: false,
      completedLap: false,
      age: 0,
      completedLaps: 0,
      lapStartAge: 0,
      bestLapTicks: null,
      nextCheckpoint: this.findNextCheckpoint(trainingStart.startDistance),
      trainingStart,
      segmentCompleted: false,
      checkpointCount: 0,
      speedScore: 0,
      progressScore: 0,
      bestProgress: 0,
      previousProgressDistance: trainingStart.startDistance,
      lapOffset: 0,
      reversePenalty: 0,
      wallPenalty: 0,
      fitness: 0,
      lastCheckpointAge: 0,
      lastProgressAge: 0,
      previousPosition: { x: body.position.x, y: body.position.y },
      trail: [{ x: body.position.x, y: body.position.y }],
      replay: [],
      color: CAR_COLORS[index % CAR_COLORS.length],
    };
  }

  private updateCar(car: SimCar): void {
    const body = car.body;
    const currentPosition = { x: body.position.x, y: body.position.y };
    this.updateContinuousProgress(car, currentPosition);
    if (this.updateCheckpointProgress(car, currentPosition)) {
      car.previousPosition = currentPosition;
      return;
    }
    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    const inputs = this.readInputs(car, currentPosition, speed);
    const [steer, throttleSignal] = evaluateNetwork(car.genome.weights, inputs);
    const forward = { x: Math.cos(body.angle), y: Math.sin(body.angle) };
    const lateral = { x: -forward.y, y: forward.x };
    const lateralSpeed = body.velocity.x * lateral.x + body.velocity.y * lateral.y;
    const correctedVelocity = {
      x: body.velocity.x - lateral.x * lateralSpeed * 0.22,
      y: body.velocity.y - lateral.y * lateralSpeed * 0.22,
    };

    this.matter.body.setVelocity(body, correctedVelocity);
    this.matter.body.setAngularVelocity(body, steer * 0.075);

    const throttle = 0.62 + throttleSignal * 0.38;
    this.matter.body.applyForce(body, body.position, {
      x: forward.x * throttle * 0.00115,
      y: forward.y * throttle * 0.00115,
    });

    this.limitSpeed(body);
    car.age += this.config.speedMultiplier;
    car.speedScore += speed * 0.018;
    car.fitness = this.calculateCarFitness(car, false, false);

    const centerDistance = nearestDistanceToPolyline(currentPosition, this.track.centerline);
    if (centerDistance > this.track.width * 0.39) {
      car.wallPenalty += (centerDistance - this.track.width * 0.39) * 0.045;
    }
    if (this.shouldCompleteSegment(car)) {
      this.completeSegment(car, currentPosition);
    } else if (centerDistance > this.track.width * 0.68) {
      this.killCar(car, true, false);
    } else if (car.age - car.lastProgressAge > 330 && speed < 1.2) {
      this.killCar(car, false, true);
    } else if (car.age - car.lastProgressAge > 620) {
      this.killCar(car, false, true);
    }

    car.previousPosition = currentPosition;
    if (car.alive && Math.round(car.age) % 5 === 0) {
      car.trail.push(currentPosition);
      if (car.trail.length > 28) {
        car.trail.shift();
      }
      car.replay.push({
        x: currentPosition.x,
        y: currentPosition.y,
        angle: body.angle,
        tick: Math.round(car.age),
        score: car.fitness,
      });
      if (car.replay.length > 320) {
        car.replay.shift();
      }
      if (car.fitness > 120) {
        this.heatPoints.push({ x: currentPosition.x, y: currentPosition.y, strength: Math.min(1, car.fitness / 3000) });
        if (this.heatPoints.length > 900) {
          this.heatPoints.shift();
        }
      }
    }
  }

  private updateContinuousProgress(car: SimCar, currentPosition: { x: number; y: number }): void {
    const progress = nearestPointOnClosedPath(currentPosition, this.track.centerline);
    let absoluteProgress = progress.progressDistance + car.lapOffset;
    const halfTrack = this.trackLength * 0.5;

    if (absoluteProgress - car.previousProgressDistance < -halfTrack) {
      car.lapOffset += this.trackLength;
      absoluteProgress += this.trackLength;
    } else if (absoluteProgress - car.previousProgressDistance > halfTrack) {
      car.lapOffset -= this.trackLength;
      absoluteProgress -= this.trackLength;
    }

    const delta = absoluteProgress - car.previousProgressDistance;
    if (delta > 0) {
      car.progressScore += delta;
      car.bestProgress = Math.max(car.bestProgress, absoluteProgress);
      if (delta > 0.45) {
        car.lastProgressAge = car.age;
      }
    } else {
      car.reversePenalty += Math.abs(delta) * 0.65;
    }

    car.previousProgressDistance = absoluteProgress;
  }

  private updateCheckpointProgress(car: SimCar, currentPosition: { x: number; y: number }): boolean {
    const checkpoint = this.track.checkpoints[car.nextCheckpoint];
    if (!checkpoint) return false;

    if (segmentsIntersect(car.previousPosition, currentPosition, checkpoint.a, checkpoint.b)) {
      const completesLap = car.trainingStart.kind === 'fullLap'
        && checkpoint.index === 0
        && car.checkpointCount >= this.track.checkpoints.length - 1;
      car.checkpointCount += 1;
      car.nextCheckpoint = (car.nextCheckpoint + 1) % this.track.checkpoints.length;
      car.lastCheckpointAge = car.age;
      car.fitness += completesLap ? 420 : 120;
      if (completesLap) {
        this.completeLap(car, Math.max(1, car.age - car.lapStartAge), currentPosition);
        return true;
      }
    }

    return false;
  }

  private readInputs(car: SimCar, position: { x: number; y: number }, speed: number): number[] {
    const body = car.body;
    const sensorValues = SENSOR_ANGLES.map((sensorAngle) => {
      const angle = body.angle + sensorAngle;
      const nearest = this.wallSegments.reduce((best, [a, b]) => {
        const hit = raySegmentDistance(position, angle, SENSOR_RANGE, a, b);
        return hit === null ? best : Math.min(best, hit);
      }, SENSOR_RANGE);
      return nearest / SENSOR_RANGE;
    });
    const checkpoint = this.track.checkpoints[car.nextCheckpoint] ?? this.track.checkpoints[0];
    const desiredAngle = Math.atan2(checkpoint.center.y - position.y, checkpoint.center.x - position.x);
    const headingError = wrapAngle(desiredAngle - body.angle) / Math.PI;
    const centerDistance = nearestDistanceToPolyline(position, this.track.centerline);

    return [
      ...sensorValues,
      Math.min(1, speed / MAX_SPEED),
      headingError,
      1 - Math.min(1, centerDistance / (this.track.width * 0.5)),
    ];
  }

  private findNextCheckpoint(startDistance: number): number {
    if (this.track.checkpoints.length === 0 || this.trackLength <= 0) {
      return 0;
    }

    const normalizedDistance = ((startDistance % this.trackLength) + this.trackLength) % this.trackLength;
    const checkpoint = this.track.checkpoints.find((candidate) => candidate.progress * this.trackLength > normalizedDistance + 8);
    return checkpoint?.index ?? 0;
  }

  private limitSpeed(body: MatterBody): void {
    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    if (speed <= MAX_SPEED) {
      return;
    }
    const ratio = MAX_SPEED / speed;
    this.matter.body.setVelocity(body, {
      x: body.velocity.x * ratio,
      y: body.velocity.y * ratio,
    });
  }

  private completeLap(car: SimCar, lapTicks: number, currentPosition: { x: number; y: number }): void {
    if (!car.alive) {
      return;
    }

    car.completedLap = true;
    car.completedLaps += 1;
    car.bestLapTicks = car.bestLapTicks === null ? lapTicks : Math.min(car.bestLapTicks, lapTicks);
    car.lapStartAge = car.age;
    car.alive = false;
    car.crashed = false;
    car.stagnant = false;
    car.fitness = this.calculateCarFitness(car, false, false);
    car.replay.push({
      x: currentPosition.x,
      y: currentPosition.y,
      angle: car.body.angle,
      tick: Math.round(car.age),
      score: car.fitness,
    });
    this.matter.body.setVelocity(car.body, { x: 0, y: 0 });
    this.matter.body.setAngularVelocity(car.body, 0);
    this.removeCarBody(car);
  }

  private completeSegment(car: SimCar, currentPosition: { x: number; y: number }): void {
    if (!car.alive || car.trainingStart.kind !== 'segment') {
      return;
    }

    car.alive = false;
    car.segmentCompleted = true;
    car.crashed = false;
    car.stagnant = false;
    car.fitness = this.calculateCarFitness(car, false, false);
    car.replay.push({
      x: currentPosition.x,
      y: currentPosition.y,
      angle: car.body.angle,
      tick: Math.round(car.age),
      score: car.fitness,
    });
    this.recordSegmentAttempt(car);
    this.matter.body.setVelocity(car.body, { x: 0, y: 0 });
    this.matter.body.setAngularVelocity(car.body, 0);
    this.removeCarBody(car);
  }

  private killCar(car: SimCar, crashed: boolean, stagnant: boolean): void {
    if (!car.alive) {
      return;
    }
    car.alive = false;
    car.crashed = crashed;
    car.stagnant = stagnant;
    car.fitness = this.calculateCarFitness(car, crashed, stagnant);
    this.recordSegmentAttempt(car);
    this.matter.body.setVelocity(car.body, { x: 0, y: 0 });
    this.matter.body.setAngularVelocity(car.body, 0);
    this.removeCarBody(car);
  }

  private calculateCarFitness(car: SimCar, crashed: boolean, stagnant: boolean): number {
    if (car.trainingStart.kind === 'segment') {
      return calculateSmartSegmentFitness({
        progress: Math.max(0, car.bestProgress - car.trainingStart.startDistance),
        targetDistance: car.trainingStart.targetDistance,
        speedScore: car.speedScore,
        age: car.age,
        crashed,
        stagnant,
        reversePenalty: car.reversePenalty,
        wallPenalty: car.wallPenalty,
        completed: car.segmentCompleted,
      });
    }

    return calculateFitness({
      checkpoints: car.checkpointCount,
      progressScore: car.progressScore,
      speedScore: car.speedScore,
      age: car.age,
      crashed,
      stagnant,
      reversePenalty: car.reversePenalty,
      wallPenalty: car.wallPenalty,
      completedLap: car.completedLap,
      bestLapTicks: car.bestLapTicks,
    });
  }

  private shouldCompleteSegment(car: SimCar): boolean {
    return car.trainingStart.kind === 'segment'
      && !car.segmentCompleted
      && car.bestProgress - car.trainingStart.startDistance >= car.trainingStart.targetDistance;
  }

  private recordSegmentAttempt(car: SimCar): void {
    const segmentIndex = car.trainingStart.segmentIndex;
    if (segmentIndex === null) {
      return;
    }

    const score = this.segmentScores[segmentIndex];
    if (!score) {
      return;
    }

    const progress = clamp(
      (car.bestProgress - car.trainingStart.startDistance) / Math.max(1, car.trainingStart.targetDistance),
      0,
      1,
    );
    score.attempts += 1;
    score.completions += car.segmentCompleted ? 1 : 0;
    score.crashes += car.crashed ? 1 : 0;
    score.bestScore = Math.max(score.bestScore, car.fitness);
    score.bestProgress = Math.max(score.bestProgress, progress);
  }

  private removeCarBody(car: SimCar): void {
    if (car.removed) {
      return;
    }
    this.matter.world.remove(car.body);
    car.removed = true;
  }

  private destroyCars(): void {
    for (const car of this.cars) {
      this.removeCarBody(car);
    }
    this.cars = [];
  }

  private drawTrack(): void {
    const graphics = this.trackGraphics;
    if (!graphics) return;

    graphics.clear();
    graphics.fillStyle(0x090b10, 1);
    graphics.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.drawGrid(graphics);

    const roadPolygon = [
      ...this.track.leftBoundary,
      ...[...this.track.rightBoundary].reverse(),
    ];
    graphics.fillStyle(0x131923, 1);
    graphics.fillPoints(roadPolygon, true, true);
    graphics.lineStyle(10, 0x202b37, 0.7);
    graphics.strokePoints(this.track.leftBoundary, true, true);
    graphics.strokePoints(this.track.rightBoundary, true, true);
    graphics.lineStyle(3, 0x33f0cf, 0.86);
    graphics.strokePoints(this.track.leftBoundary, true, true);
    graphics.lineStyle(3, 0xffce45, 0.8);
    graphics.strokePoints(this.track.rightBoundary, true, true);
    graphics.lineStyle(1, 0x6b7b8f, 0.35);
    graphics.strokePoints(this.track.centerline, true, true);

    const hardest = hardestSegmentIndex(this.segmentScores);
    for (const segment of this.trackSegments) {
      if (segment.index === this.activeSegmentIndex || segment.index === hardest) {
        const color = segment.index === this.activeSegmentIndex ? 0x38f8d4 : 0xff5b7c;
        graphics.lineStyle(segment.index === this.activeSegmentIndex ? 6 : 4, color, segment.index === this.activeSegmentIndex ? 0.42 : 0.28);
        graphics.strokePoints(this.segmentPoints(segment), false);
      }
      graphics.fillStyle(0x8fa3bb, segment.index === this.activeSegmentIndex ? 0.74 : 0.24);
      graphics.fillCircle(segment.spawnPose.x, segment.spawnPose.y, segment.index === this.activeSegmentIndex ? 4.2 : 2.6);
    }

    for (const checkpoint of this.track.checkpoints) {
      graphics.lineStyle(checkpoint.index === 0 ? 4 : 1, checkpoint.index === 0 ? 0xffffff : 0x8fa3bb, checkpoint.index === 0 ? 0.9 : 0.24);
      graphics.lineBetween(checkpoint.a.x, checkpoint.a.y, checkpoint.b.x, checkpoint.b.y);
    }

    graphics.fillStyle(0x38f8d4, 0.92);
    graphics.fillCircle(this.track.spawnPose.x, this.track.spawnPose.y, 5);
  }

  private segmentPoints(segment: TrackSegment): Array<{ x: number; y: number }> {
    if (this.track.centerline.length === 0) {
      return [];
    }

    const points: Array<{ x: number; y: number }> = [];
    let index = segment.startIndex;
    for (let guard = 0; guard < this.track.centerline.length; guard += 1) {
      points.push(this.track.centerline[index]);
      if (index === segment.endIndex) {
        break;
      }
      index = (index + 1) % this.track.centerline.length;
    }
    return points;
  }

  private drawGrid(graphics: Phaser.GameObjects.Graphics): void {
    graphics.lineStyle(1, 0x16202a, 0.62);
    for (let x = 0; x <= WORLD_WIDTH; x += 80) {
      graphics.lineBetween(x, 0, x, WORLD_HEIGHT);
    }
    for (let y = 0; y <= WORLD_HEIGHT; y += 80) {
      graphics.lineBetween(0, y, WORLD_WIDTH, y);
    }
  }

  private renderDrawPoints(): void {
    const graphics = this.drawGraphics;
    if (!graphics) return;

    graphics.clear();
    if (this.drawPoints.length < 2) {
      return;
    }

    graphics.lineStyle(4, 0xff5b7c, 0.9);
    graphics.strokePoints(this.drawPoints, false);
    graphics.fillStyle(0xffce45, 0.9);
    for (const point of this.drawPoints) {
      graphics.fillCircle(point.x, point.y, 2.2);
    }
  }

  private renderCars(): void {
    const carGraphics = this.carGraphics;
    const sensorGraphics = this.sensorGraphics;
    if (!carGraphics || !sensorGraphics) return;

    carGraphics.clear();
    sensorGraphics.clear();
    const focusCar = this.selectFocusCar();
    this.renderHeat();
    this.renderGhost();
    this.renderTrails(carGraphics);

    for (const car of this.cars) {
      this.drawCar(carGraphics, car, car === focusCar);
    }

    if (focusCar?.alive) {
      this.drawSensors(sensorGraphics, focusCar);
    }
  }

  private renderHeat(): void {
    const graphics = this.heatGraphics;
    if (!graphics) return;
    graphics.clear();
    for (const point of this.heatPoints) {
      graphics.fillStyle(0xff5b7c, 0.06 + point.strength * 0.14);
      graphics.fillCircle(point.x, point.y, 9 + point.strength * 8);
    }
  }

  private renderGhost(): void {
    const graphics = this.ghostGraphics;
    if (!graphics) return;
    graphics.clear();

    if (this.fullLapGhostReplay.length > 3) {
      graphics.lineStyle(4, 0xffffff, 0.2);
      graphics.strokePoints(this.fullLapGhostReplay.map((frame) => ({ x: frame.x, y: frame.y })), false);
    }

    if (this.ghostReplay.length < 3) {
      return;
    }

    graphics.lineStyle(3, 0x38f8d4, 0.2);
    graphics.strokePoints(this.ghostReplay.map((frame) => ({ x: frame.x, y: frame.y })), false);
    const frame = this.ghostReplay[Math.min(this.ghostReplay.length - 1, Math.floor((this.generationStep / 5) % this.ghostReplay.length))];
    const points = [
      this.rotatePoint(frame.x, frame.y, -CAR_WIDTH * 0.45, -CAR_HEIGHT * 0.55, frame.angle),
      this.rotatePoint(frame.x, frame.y, CAR_WIDTH * 0.55, 0, frame.angle),
      this.rotatePoint(frame.x, frame.y, -CAR_WIDTH * 0.45, CAR_HEIGHT * 0.55, frame.angle),
      this.rotatePoint(frame.x, frame.y, -CAR_WIDTH * 0.2, 0, frame.angle),
    ];
    graphics.fillStyle(0x38f8d4, 0.22);
    graphics.fillPoints(points, true, true);
  }

  private renderTrails(graphics: Phaser.GameObjects.Graphics): void {
    const leaders = [...this.cars]
      .filter((car) => car.trail.length > 2)
      .sort((a, b) => this.compareCars(b, a))
      .slice(0, 5);

    for (const car of leaders) {
      graphics.lineStyle(car.alive ? 2 : 1, car.color, car.alive ? 0.38 : 0.16);
      graphics.strokePoints(car.trail, false);
    }
  }

  private drawCar(graphics: Phaser.GameObjects.Graphics, car: SimCar, focused: boolean): void {
    const body = car.body;
    const alpha = car.alive ? (focused ? 1 : 0.68) : 0.22;
    const points = [
      this.rotatePoint(body.position.x, body.position.y, -CAR_WIDTH * 0.45, -CAR_HEIGHT * 0.55, body.angle),
      this.rotatePoint(body.position.x, body.position.y, CAR_WIDTH * 0.55, 0, body.angle),
      this.rotatePoint(body.position.x, body.position.y, -CAR_WIDTH * 0.45, CAR_HEIGHT * 0.55, body.angle),
      this.rotatePoint(body.position.x, body.position.y, -CAR_WIDTH * 0.2, 0, body.angle),
    ];

    if (focused) {
      graphics.lineStyle(3, 0xffffff, 0.42);
      graphics.strokePoints(points, true, true);
    }
    graphics.fillStyle(car.alive ? car.color : 0x65758a, alpha);
    graphics.fillPoints(points, true, true);
  }

  private drawSensors(graphics: Phaser.GameObjects.Graphics, car: SimCar): void {
    const position = { x: car.body.position.x, y: car.body.position.y };
    for (const sensorAngle of SENSOR_ANGLES) {
      const angle = car.body.angle + sensorAngle;
      const nearest = this.wallSegments.reduce((best, [a, b]) => {
        const hit = raySegmentDistance(position, angle, SENSOR_RANGE, a, b);
        return hit === null ? best : Math.min(best, hit);
      }, SENSOR_RANGE);
      graphics.lineStyle(1, 0x38f8d4, 0.18 + (1 - nearest / SENSOR_RANGE) * 0.36);
      graphics.lineBetween(
        position.x,
        position.y,
        position.x + Math.cos(angle) * nearest,
        position.y + Math.sin(angle) * nearest,
      );
      graphics.fillStyle(0xffce45, 0.55);
      graphics.fillCircle(position.x + Math.cos(angle) * nearest, position.y + Math.sin(angle) * nearest, 2);
    }
  }

  private rotatePoint(x: number, y: number, offsetX: number, offsetY: number, angle: number): { x: number; y: number } {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      x: x + offsetX * cos - offsetY * sin,
      y: y + offsetX * sin + offsetY * cos,
    };
  }

  private selectFocusCar(): SimCar | null {
    return this.selectBestCar();
  }

  private selectBestCar(predicate: (car: SimCar) => boolean = () => true): SimCar | null {
    const cars = this.cars.filter(predicate);
    if (cars.length === 0) {
      return null;
    }

    return cars.reduce((best, candidate) => (this.compareCars(candidate, best) > 0 ? candidate : best));
  }

  private compareCars(a: SimCar, b: SimCar): number {
    const aLapTicks = finiteLapTicks(a.bestLapTicks);
    const bLapTicks = finiteLapTicks(b.bestLapTicks);

    if (aLapTicks !== null || bLapTicks !== null) {
      if (aLapTicks !== null && bLapTicks !== null) {
        return bLapTicks - aLapTicks;
      }
      return aLapTicks !== null ? 1 : -1;
    }

    return a.fitness - b.fitness;
  }

  private emitStats(status: TrainingStats['status']): void {
    const alive = this.cars.filter((car) => car.alive);
    const scored = this.cars.length > 0 ? this.cars : [];
    const bestCurrent = scored.reduce((best, car) => Math.max(best, car.fitness), 0);
    const average = scored.length > 0
      ? scored.reduce((sum, car) => sum + car.fitness, 0) / scored.length
      : 0;
    const maxCheckpoint = scored.reduce((best, car) => Math.max(best, car.checkpointCount), 0);
    const bestProgress = scored.reduce((best, car) => Math.max(best, car.bestProgress), 0);
    const crashed = scored.filter((car) => !car.alive && car.crashed).length;
    const currentBestLapTicks = scored.reduce<number | null>(
      (best, car) => minLapTicks(best, car.bestLapTicks),
      null,
    );
    const lapCompletions = scored.filter((car) => car.completedLap).length;

    this.callbacks.onStats({
      generation: this.generation,
      bestScore: bestCurrent,
      bestEver: Math.max(this.bestScoreEver, bestCurrent),
      currentBestLapTicks,
      bestLapTicks: minLapTicks(this.bestLapTicksEver, currentBestLapTicks),
      lapCompletions,
      averageScore: average,
      aliveCount: alive.length,
      populationSize: this.config.populationSize,
      checkpointProgress: this.track.checkpoints.length > 0
        ? Math.min(1, maxCheckpoint / this.track.checkpoints.length)
        : 0,
      maxCheckpoint,
      crashRate: scored.length > 0 ? crashed / scored.length : 0,
      bestProgress: this.trackLength > 0 ? Math.min(1, bestProgress / this.trackLength) : 0,
      eliteCount: this.lastEvolution.eliteCount,
      teacherChildren: this.lastEvolution.teacherChildren,
      trainingPhase: this.trainingPhase,
      activeSegmentIndex: this.activeSegmentIndex,
      segmentCoverage: segmentCoverage(this.segmentScores),
      hardestSegmentIndex: hardestSegmentIndex(this.segmentScores),
      recordAttempts: this.recordAttempts,
      validationLapTicks: this.validationLapTicks,
      history: this.history,
      status,
    });
  }

  private getCarId(body: MatterBody): string | undefined {
    return (body.plugin as { carId?: string } | undefined)?.carId;
  }

  private updateFollowCamera(): void {
    if (!this.cameraState.followBest) {
      return;
    }
    const focusCar = this.selectFocusCar();
    if (!focusCar) {
      return;
    }
    this.panViewportToWorldPoint({ x: focusCar.body.position.x, y: focusCar.body.position.y }, false);
  }

  private getViewportSize(): { width: number; height: number } {
    const parent = this.getViewportElement();
    return {
      width: parent?.clientWidth ?? WORLD_WIDTH,
      height: parent?.clientHeight ?? WORLD_HEIGHT,
    };
  }

  private zoomViewportAtCenter(factor: number): void {
    const parent = this.getViewportElement();
    if (!parent) {
      return;
    }

    const rect = parent.getBoundingClientRect();
    this.cameraState.followBest = false;
    this.zoomViewportToPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, factor, true);
  }

  private zoomViewportToPoint(clientX: number, clientY: number, factor: number, emit: boolean): void {
    const parent = this.getViewportElement();
    if (!this.panzoom || !parent) {
      return;
    }

    const rect = parent.getBoundingClientRect();
    const oldScale = this.panzoom.getScale();
    const nextScale = clamp(oldScale * factor, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE);
    const pan = this.panzoom.getPan();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const worldX = localX / oldScale - pan.x;
    const worldY = localY / oldScale - pan.y;
    const nextPanX = localX / nextScale - worldX;
    const nextPanY = localY / nextScale - worldY;

    this.applyViewportTransform(nextScale, nextPanX, nextPanY, emit);
  }

  private fitViewportToTrack(emit: boolean): void {
    const viewport = this.getViewportSize();
    if (viewport.width < 10 || viewport.height < 10) {
      return;
    }
    const width = Math.max(200, this.track.bounds.maxX - this.track.bounds.minX + FIT_TRACK_MARGIN);
    const height = Math.max(200, this.track.bounds.maxY - this.track.bounds.minY + FIT_TRACK_MARGIN);
    const scale = clamp(Math.min(viewport.width / width, viewport.height / height), MIN_VIEWPORT_SCALE, 1.35);
    this.panViewportToWorldPoint(this.getTrackCenter(), emit, scale);
  }

  private panViewportToWorldPoint(point: { x: number; y: number }, emit: boolean, scale = this.panzoom?.getScale() ?? 1): void {
    if (!this.panzoom) {
      return;
    }

    const viewport = this.getViewportSize();
    const x = viewport.width / (2 * scale) - point.x;
    const y = viewport.height / (2 * scale) - point.y;

    this.applyViewportTransform(scale, x, y, emit);
  }

  private getTrackCenter(): { x: number; y: number } {
    const points = [...this.track.leftBoundary, ...this.track.rightBoundary];
    if (points.length > 0) {
      return {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      };
    }

    return {
      x: (this.track.bounds.minX + this.track.bounds.maxX) / 2,
      y: (this.track.bounds.minY + this.track.bounds.maxY) / 2,
    };
  }

  private syncViewportState(emit: boolean): void {
    const pan = this.panzoom?.getPan() ?? { x: 0, y: 0 };
    this.cameraState = {
      ...this.cameraState,
      zoom: this.panzoom?.getScale() ?? 1,
      scrollX: pan.x,
      scrollY: pan.y,
    };
    if (emit) {
      this.callbacks.onCameraChange(this.cameraState);
    }
  }

  private applyViewportTransform(scale: number, x: number, y: number, emit: boolean): void {
    if (!this.panzoom) {
      return;
    }

    this.panzoom.setOptions({
      startScale: scale,
      startX: x,
      startY: y,
    });
    this.panzoom.reset({ animate: false, force: true, silent: !emit });
    this.syncViewportState(emit);
  }

  private rebuildTrackSegments(): void {
    this.trackSegments = buildTrackSegments(this.track, this.config.smartSegmentCount);
    this.segmentScores = createSegmentScores(this.trackSegments);
    this.trainingStarts = [];
    this.activeSegmentIndex = null;
  }

  private getViewportElement(): HTMLElement | null {
    return this.game.canvas.parentElement;
  }
}

function finiteLapTicks(lapTicks: number | null | undefined): number | null {
  return typeof lapTicks === 'number' && Number.isFinite(lapTicks) && lapTicks > 0 ? lapTicks : null;
}

function minLapTicks(a: number | null | undefined, b: number | null | undefined): number | null {
  const first = finiteLapTicks(a);
  const second = finiteLapTicks(b);

  if (first === null) {
    return second;
  }
  if (second === null) {
    return first;
  }
  return Math.min(first, second);
}
