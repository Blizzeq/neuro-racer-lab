import Phaser from 'phaser';
import type { Genome, SaveSnapshot, TrackDefinition, TrainingConfig, TrainingStats } from '../types';
import { DEFAULT_TRAINING_CONFIG } from '../types';
import {
  WORLD_HEIGHT,
  WORLD_WIDTH,
  createPresetTrack,
  distance,
  generateTrack,
  nearestDistanceToPolyline,
  raySegmentDistance,
  segmentsIntersect,
  trackWallSegments,
  wrapAngle,
} from '../lib/geometry';
import { bestGenome, createInitialPopulation, evolvePopulation } from '../lib/evolution';
import { calculateFitness, cloneGenome, evaluateNetwork } from '../lib/neural';
import { hasSnapshot, loadSnapshot, saveSnapshot } from '../lib/storage';

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
  age: number;
  nextCheckpoint: number;
  checkpointCount: number;
  speedScore: number;
  fitness: number;
  lastCheckpointAge: number;
  previousPosition: { x: number; y: number };
  trail: Array<{ x: number; y: number }>;
  color: number;
};

const SENSOR_ANGLES = [-0.95, -0.48, 0, 0.48, 0.95];
const SENSOR_RANGE = 210;
const MAX_SPEED = 9.2;
const CAR_WIDTH = 27;
const CAR_HEIGHT = 14;
const WALL_THICKNESS = 12;
const CAR_COLORS = [0x38f8d4, 0xffce45, 0xff5b7c, 0x67a6ff, 0xd6ff5a, 0xf489ff];

export class RacerScene extends Phaser.Scene {
  private callbacks: SceneCallbacks;
  private track: TrackDefinition = createPresetTrack();
  private wallSegments = trackWallSegments(this.track);
  private wallBodies: MatterBody[] = [];
  private cars: SimCar[] = [];
  private population: Genome[] = [];
  private bestGenomeEver: Genome | null = null;
  private bestScoreEver = 0;
  private generation = 0;
  private generationStep = 0;
  private history: number[] = [];
  private running = false;
  private drawing = false;
  private drawPoints: Array<{ x: number; y: number }> = [];
  private config: TrainingConfig = { ...DEFAULT_TRAINING_CONFIG };
  private trackGraphics?: Phaser.GameObjects.Graphics;
  private carGraphics?: Phaser.GameObjects.Graphics;
  private sensorGraphics?: Phaser.GameObjects.Graphics;
  private drawGraphics?: Phaser.GameObjects.Graphics;

  constructor(callbacks: SceneCallbacks) {
    super({ key: 'RacerScene' });
    this.callbacks = callbacks;
  }

  create(): void {
    this.trackGraphics = this.add.graphics();
    this.sensorGraphics = this.add.graphics();
    this.carGraphics = this.add.graphics();
    this.drawGraphics = this.add.graphics();
    this.matter.world.disableGravity();
    this.matter.world.setBounds(-80, -80, WORLD_WIDTH + 160, WORLD_HEIGHT + 160, 80);
    this.matter.world.pause();
    this.installCollisionHandler();
    this.installDrawingInput();
    this.setTrack(this.track, false);
    this.resetTraining();
    this.callbacks.onReady(this);
    this.callbacks.onStorageChange(hasSnapshot());
  }

  update(): void {
    if (!this.running || this.cars.length === 0) {
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
      };
    }
    this.generationStep = 0;
    this.startGeneration();
    this.emitStats(this.running ? 'running' : 'paused');
  }

  saveCurrentSnapshot(): SaveSnapshot {
    const snapshot = saveSnapshot(this.track, this.bestGenomeEver, this.generation);
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
    this.generation = snapshot.generation;
    this.setTrack(snapshot.track, true);
    this.resetTraining();
    return snapshot;
  }

  getCurrentTrack(): TrackDefinition {
    return this.track;
  }

  private setTrack(track: TrackDefinition, notify: boolean): void {
    this.track = track;
    this.wallSegments = trackWallSegments(track);
    this.destroyWalls();
    this.createWalls();
    this.drawTrack();
    if (notify) {
      this.callbacks.onTrackChange(track);
    }
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
    }));
    const generationBest = bestGenome(scoredPopulation);
    if (generationBest && generationBest.score >= this.bestScoreEver) {
      this.bestScoreEver = generationBest.score;
      this.bestGenomeEver = cloneGenome(generationBest);
    }

    this.history = [...this.history.slice(-47), generationBest?.score ?? 0];
    this.population = evolvePopulation(scoredPopulation, this.config, this.generation);
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
      age: 0,
      nextCheckpoint: 1 % this.track.checkpoints.length,
      checkpointCount: 0,
      speedScore: 0,
      fitness: 0,
      lastCheckpointAge: 0,
      previousPosition: { x: body.position.x, y: body.position.y },
      trail: [{ x: body.position.x, y: body.position.y }],
      color: CAR_COLORS[index % CAR_COLORS.length],
    };
  }

  private updateCar(car: SimCar): void {
    const body = car.body;
    const currentPosition = { x: body.position.x, y: body.position.y };
    this.updateCheckpointProgress(car, currentPosition);
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
      speedScore: car.speedScore,
      age: car.age,
      crashed: car.crashed,
      stagnant: car.stagnant,
    });

    const centerDistance = nearestDistanceToPolyline(currentPosition, this.track.centerline);
    if (centerDistance > this.track.width * 0.68) {
      this.killCar(car, true, false);
    } else if (car.age - car.lastCheckpointAge > 360 && speed < 1.2) {
      this.killCar(car, false, true);
    } else if (car.age - car.lastCheckpointAge > 620) {
      this.killCar(car, false, true);
    }

    car.previousPosition = currentPosition;
    if (car.alive && Math.round(car.age) % 5 === 0) {
      car.trail.push(currentPosition);
      if (car.trail.length > 28) {
        car.trail.shift();
      }
    }
  }

  private updateCheckpointProgress(car: SimCar, currentPosition: { x: number; y: number }): void {
    const checkpoint = this.track.checkpoints[car.nextCheckpoint];
    if (!checkpoint) return;

    if (segmentsIntersect(car.previousPosition, currentPosition, checkpoint.a, checkpoint.b)) {
      car.checkpointCount += 1;
      car.nextCheckpoint = (car.nextCheckpoint + 1) % this.track.checkpoints.length;
      car.lastCheckpointAge = car.age;
      car.fitness += 120;
    }
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
    graphics.lineStyle(1, 0x16202a, 0.72);
    for (let x = 0; x <= WORLD_WIDTH; x += 40) {
      graphics.lineBetween(x, 0, x, WORLD_HEIGHT);
    }
    for (let y = 0; y <= WORLD_HEIGHT; y += 40) {
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
    this.renderTrails(carGraphics);

    for (const car of this.cars) {
      this.drawCar(carGraphics, car, car === focusCar);
    }

    if (focusCar?.alive) {
      this.drawSensors(sensorGraphics, focusCar);
    }
  }

  private renderTrails(graphics: Phaser.GameObjects.Graphics): void {
    const leaders = [...this.cars]
      .filter((car) => car.trail.length > 2)
      .sort((a, b) => b.fitness - a.fitness)
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
    if (this.cars.length === 0) {
      return null;
    }

    return this.cars.reduce((best, candidate) => (candidate.fitness > best.fitness ? candidate : best));
  }

  private emitStats(status: TrainingStats['status']): void {
    const alive = this.cars.filter((car) => car.alive);
    const scored = this.cars.length > 0 ? this.cars : [];
    const bestCurrent = scored.reduce((best, car) => Math.max(best, car.fitness), 0);
    const average = scored.length > 0
      ? scored.reduce((sum, car) => sum + car.fitness, 0) / scored.length
      : 0;
    const maxCheckpoint = scored.reduce((best, car) => Math.max(best, car.checkpointCount), 0);

    this.callbacks.onStats({
      generation: this.generation,
      bestScore: bestCurrent,
      bestEver: Math.max(this.bestScoreEver, bestCurrent),
      averageScore: average,
      aliveCount: alive.length,
      populationSize: this.config.populationSize,
      checkpointProgress: this.track.checkpoints.length > 0
        ? Math.min(1, maxCheckpoint / this.track.checkpoints.length)
        : 0,
      maxCheckpoint,
      history: this.history,
      status,
    });
  }

  private getCarId(body: MatterBody): string | undefined {
    return (body.plugin as { carId?: string } | undefined)?.carId;
  }
}
