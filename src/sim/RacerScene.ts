import Phaser from 'phaser';
import type {
  CameraState,
  ExportSnapshot,
  Genome,
  ReplayFrame,
  SaveSnapshot,
  TrackDefinition,
  TrainingConfig,
  TrainingStats,
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
import { calculateFitness, cloneGenome, evaluateNetwork } from '../lib/neural';
import { createExportSnapshot, hasSnapshot, loadSnapshot, parseExportSnapshot, saveSnapshot } from '../lib/storage';

type MatterBody = MatterJS.BodyType;

type SceneCallbacks = {
  onReady: (scene: RacerScene) => void;
  onStats: (stats: TrainingStats) => void;
  onTrackChange: (track: TrackDefinition) => void;
  onStorageChange: (hasSave: boolean) => void;
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

export class RacerScene extends Phaser.Scene {
  private callbacks: SceneCallbacks;
  private track: TrackDefinition = createPresetTrack();
  private wallSegments = trackWallSegments(this.track);
  private trackLength = closedPathLength(this.track.centerline);
  private wallBodies: MatterBody[] = [];
  private cars: SimCar[] = [];
  private population: Genome[] = [];
  private bestGenomeEver: Genome | null = null;
  private bestScoreEver = 0;
  private bestLapTicksEver: number | null = null;
  private generation = 0;
  private generationStep = 0;
  private history: number[] = [];
  private lastEvolution = { eliteCount: 0, teacherChildren: 0, randomImmigrants: 0 };
  private running = false;
  private drawing = false;
  private drawPoints: Array<{ x: number; y: number }> = [];
  private cameraState: CameraState = { zoom: 1, scrollX: 0, scrollY: 0, followBest: false };
  private panning = false;
  private panStart = { x: 0, y: 0, scrollX: 0, scrollY: 0 };
  private ghostReplay: ReplayFrame[] = [];
  private heatPoints: Array<{ x: number; y: number; strength: number }> = [];
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
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.matter.world.pause();
    this.installCollisionHandler();
    this.installCameraInput();
    this.installDrawingInput();
    this.setTrack(this.track, false);
    this.resetTraining();
    this.callbacks.onReady(this);
    this.callbacks.onStorageChange(hasSnapshot());
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
    this.config = {
      ...this.config,
      ...config,
    };
    this.matter.world.engine.timing.timeScale = this.config.speedMultiplier;

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
    if (drawing) {
      this.setRunning(false);
    }
    this.emitStats(drawing ? 'drawing' : 'paused');
  }

  loadPresetTrack(): void {
    this.setRunning(false);
    this.setTrack(createPresetTrack(), true);
    this.bestGenomeEver = null;
    this.bestScoreEver = 0;
    this.bestLapTicksEver = null;
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
    this.bestScoreEver = this.bestGenomeEver?.score ?? 0;
    this.bestLapTicksEver = this.bestGenomeEver?.bestLapTicks ?? null;
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
    this.bestScoreEver = this.bestGenomeEver?.score ?? 0;
    this.bestLapTicksEver = this.bestGenomeEver?.bestLapTicks ?? null;
    this.generation = snapshot.generation;
    this.config = { ...this.config, ...snapshot.config };
    this.setTrack(snapshot.track, true);
    this.resetTraining();
    return snapshot;
  }

  zoomIn(): void {
    this.setCameraZoom(this.cameras.main.zoom * 1.18);
  }

  zoomOut(): void {
    this.setCameraZoom(this.cameras.main.zoom / 1.18);
  }

  fitToTrack(): void {
    const camera = this.cameras.main;
    const margin = 180;
    const width = Math.max(200, this.track.bounds.maxX - this.track.bounds.minX + margin * 2);
    const height = Math.max(200, this.track.bounds.maxY - this.track.bounds.minY + margin * 2);
    const zoom = clamp(Math.min(camera.width / width, camera.height / height), 0.22, 1.35);
    camera.setZoom(zoom);
    camera.centerOn(
      (this.track.bounds.minX + this.track.bounds.maxX) / 2,
      (this.track.bounds.minY + this.track.bounds.maxY) / 2,
    );
    this.syncCameraState();
  }

  toggleFollowBest(): CameraState {
    this.cameraState = {
      ...this.cameraState,
      followBest: !this.cameraState.followBest,
    };
    return this.cameraState;
  }

  getCameraState(): CameraState {
    this.syncCameraState();
    return this.cameraState;
  }

  getCurrentTrack(): TrackDefinition {
    return this.track;
  }

  private setTrack(track: TrackDefinition, notify: boolean): void {
    this.track = track;
    this.wallSegments = trackWallSegments(track);
    this.trackLength = closedPathLength(track.centerline);
    this.destroyWalls();
    this.createWalls();
    this.drawTrack();
    this.fitToTrack();
    if (notify) {
      this.callbacks.onTrackChange(track);
    }
  }

  private installCameraInput(): void {
    this.input.mouse?.disableContextMenu();

    this.input.on('wheel', (pointer: Phaser.Input.Pointer, _gameObjects: unknown, _deltaX: number, deltaY: number) => {
      const before = { x: pointer.worldX, y: pointer.worldY };
      const zoomFactor = deltaY > 0 ? 0.9 : 1.1;
      this.setCameraZoom(this.cameras.main.zoom * zoomFactor);
      const after = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.cameras.main.scrollX += before.x - after.x;
      this.cameras.main.scrollY += before.y - after.y;
      this.syncCameraState();
    });

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (this.drawing) return;
      if (pointer.rightButtonDown() || pointer.middleButtonDown()) {
        this.panning = true;
        this.cameraState.followBest = false;
        this.panStart = {
          x: pointer.x,
          y: pointer.y,
          scrollX: this.cameras.main.scrollX,
          scrollY: this.cameras.main.scrollY,
        };
      }
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this.panning) return;
      const camera = this.cameras.main;
      camera.scrollX = this.panStart.scrollX - (pointer.x - this.panStart.x) / camera.zoom;
      camera.scrollY = this.panStart.scrollY - (pointer.y - this.panStart.y) / camera.zoom;
      this.syncCameraState();
    });

    this.input.on('pointerup', () => {
      this.panning = false;
    });

    this.input.on('pointerupoutside', () => {
      this.panning = false;
    });
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
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!this.drawing) return;
      this.drawPoints = [{ x: pointer.worldX, y: pointer.worldY }];
      this.renderDrawPoints();
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this.drawing || !pointer.isDown) return;
      const point = { x: pointer.worldX, y: pointer.worldY };
      const previous = this.drawPoints.at(-1);
      if (!previous || distance(previous, point) > 10) {
        this.drawPoints.push(point);
        this.renderDrawPoints();
      }
    });

    this.input.on('pointerup', () => {
      if (!this.drawing || this.drawPoints.length < 8) return;
      try {
        const nextTrack = generateTrack(this.drawPoints, this.track.width);
        this.setTrack(nextTrack, true);
        this.bestGenomeEver = null;
        this.bestScoreEver = 0;
        this.bestLapTicksEver = null;
        this.history = [];
        this.generation = 0;
        this.resetTraining();
      } catch {
        this.drawPoints = [];
        this.renderDrawPoints();
      }
    });
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
    this.cars = this.population.map((genome, index) => this.createCar(genome, index));
    this.renderCars();
  }

  private finishGeneration(): void {
    this.emitStats('evolving');
    const scoredPopulation = this.cars.map((car) => ({
      ...cloneGenome(car.genome),
      score: car.fitness,
      completedLap: car.completedLap,
      bestLapTicks: car.bestLapTicks,
    }));
    const generationBest = bestGenome(scoredPopulation);
    const bestCar = this.selectBestCar();
    if (bestCar && bestCar.replay.length > 6) {
      this.ghostReplay = bestCar.replay.slice(-260);
    }
    if (generationBest) {
      this.bestScoreEver = Math.max(this.bestScoreEver, generationBest.score);
    }
    if (generationBest && (!this.bestGenomeEver || compareGenomes(generationBest, this.bestGenomeEver) > 0)) {
      this.bestGenomeEver = cloneGenome(generationBest);
      this.bestLapTicksEver = generationBest.bestLapTicks ?? this.bestLapTicksEver;
    }

    this.history = [...this.history.slice(-47), generationBest?.score ?? 0];
    const evolution = evolvePopulation(scoredPopulation, this.config, this.generation, this.bestGenomeEver);
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
    const spawn = this.track.spawnPose;
    const lateral = {
      x: Math.cos(spawn.angle + Math.PI / 2),
      y: Math.sin(spawn.angle + Math.PI / 2),
    };
    const body = this.matter.add.rectangle(
      spawn.x + lateral.x * offset * 2.4,
      spawn.y + lateral.y * offset * 2.4,
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
      nextCheckpoint: 1 % this.track.checkpoints.length,
      checkpointCount: 0,
      speedScore: 0,
      progressScore: 0,
      bestProgress: 0,
      previousProgressDistance: nearestPointOnClosedPath({ x: body.position.x, y: body.position.y }, this.track.centerline).progressDistance,
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
    car.fitness = calculateFitness({
      checkpoints: car.checkpointCount,
      progressScore: car.progressScore,
      speedScore: car.speedScore,
      age: car.age,
      crashed: car.crashed,
      stagnant: car.stagnant,
      reversePenalty: car.reversePenalty,
      wallPenalty: car.wallPenalty,
      completedLap: car.completedLap,
      bestLapTicks: car.bestLapTicks,
    });

    const centerDistance = nearestDistanceToPolyline(currentPosition, this.track.centerline);
    if (centerDistance > this.track.width * 0.39) {
      car.wallPenalty += (centerDistance - this.track.width * 0.39) * 0.045;
    }
    if (centerDistance > this.track.width * 0.68) {
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
      const completesLap = checkpoint.index === 0 && car.checkpointCount >= this.track.checkpoints.length - 1;
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
    car.fitness = calculateFitness({
      checkpoints: car.checkpointCount,
      speedScore: car.speedScore,
      age: car.age,
      crashed: false,
      stagnant: false,
      progressScore: car.progressScore,
      reversePenalty: car.reversePenalty,
      wallPenalty: car.wallPenalty,
      completedLap: true,
      bestLapTicks: car.bestLapTicks,
    });
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

  private killCar(car: SimCar, crashed: boolean, stagnant: boolean): void {
    if (!car.alive) {
      return;
    }
    car.alive = false;
    car.crashed = crashed;
    car.stagnant = stagnant;
    car.fitness = calculateFitness({
      checkpoints: car.checkpointCount,
      speedScore: car.speedScore,
      age: car.age,
      crashed,
      stagnant,
      progressScore: car.progressScore,
      reversePenalty: car.reversePenalty,
      wallPenalty: car.wallPenalty,
      completedLap: car.completedLap,
      bestLapTicks: car.bestLapTicks,
    });
    this.matter.body.setVelocity(car.body, { x: 0, y: 0 });
    this.matter.body.setAngularVelocity(car.body, 0);
    this.removeCarBody(car);
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

    for (const checkpoint of this.track.checkpoints) {
      graphics.lineStyle(checkpoint.index === 0 ? 4 : 1, checkpoint.index === 0 ? 0xffffff : 0x8fa3bb, checkpoint.index === 0 ? 0.9 : 0.24);
      graphics.lineBetween(checkpoint.a.x, checkpoint.a.y, checkpoint.b.x, checkpoint.b.y);
    }

    graphics.fillStyle(0x38f8d4, 0.92);
    graphics.fillCircle(this.track.spawnPose.x, this.track.spawnPose.y, 5);
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
    if (this.ghostReplay.length < 3) {
      return;
    }

    graphics.lineStyle(3, 0xffffff, 0.22);
    graphics.strokePoints(this.ghostReplay.map((frame) => ({ x: frame.x, y: frame.y })), false);
    const frame = this.ghostReplay[Math.min(this.ghostReplay.length - 1, Math.floor((this.generationStep / 5) % this.ghostReplay.length))];
    const points = [
      this.rotatePoint(frame.x, frame.y, -CAR_WIDTH * 0.45, -CAR_HEIGHT * 0.55, frame.angle),
      this.rotatePoint(frame.x, frame.y, CAR_WIDTH * 0.55, 0, frame.angle),
      this.rotatePoint(frame.x, frame.y, -CAR_WIDTH * 0.45, CAR_HEIGHT * 0.55, frame.angle),
      this.rotatePoint(frame.x, frame.y, -CAR_WIDTH * 0.2, 0, frame.angle),
    ];
    graphics.fillStyle(0xffffff, 0.22);
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

  private selectBestCar(): SimCar | null {
    if (this.cars.length === 0) {
      return null;
    }

    return this.cars.reduce((best, candidate) => (this.compareCars(candidate, best) > 0 ? candidate : best));
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
      history: this.history,
      status,
    });
  }

  private getCarId(body: MatterBody): string | undefined {
    return (body.plugin as { carId?: string } | undefined)?.carId;
  }

  private setCameraZoom(zoom: number): void {
    this.cameras.main.setZoom(clamp(zoom, 0.22, 2.2));
    this.syncCameraState();
  }

  private updateFollowCamera(): void {
    if (!this.cameraState.followBest) {
      return;
    }
    const focusCar = this.selectFocusCar();
    if (!focusCar) {
      return;
    }
    this.cameras.main.centerOn(focusCar.body.position.x, focusCar.body.position.y);
    this.syncCameraState();
  }

  private syncCameraState(): void {
    const camera = this.cameras.main;
    this.cameraState = {
      ...this.cameraState,
      zoom: camera.zoom,
      scrollX: camera.scrollX,
      scrollY: camera.scrollY,
    };
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
