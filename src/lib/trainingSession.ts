import type {
  Genome,
  ReplayFrame,
  SegmentScore,
  TrackDefinition,
  TrackSegment,
  TrainingConfig,
  TrainingPhase,
  TrainingStart,
  TrainingStats,
} from '../types';
import { DEFAULT_TRAINING_CONFIG } from '../types';
import {
  buildTrackSegments,
  createSegmentScores,
  createTrainingStarts,
  hardestSegmentIndex,
  segmentCoverage,
  shouldUseFullLapBootstrap,
} from './curriculum';
import { bestGenome, compareGenomes, createInitialPopulation, evolvePopulation } from './evolution';
import { cloneGenome, mutateGenome } from './neural';
import { type SimCar, carProgressRatio, createCar, estimateReferenceLapTicks, finishCar, scoreCar, stepCar } from './simulation';
import { type TrackIndex, buildTrackIndex } from './trackIndex';
import {
  calculateLapGoalTicks,
  finalExamComplete,
  goalProgress,
  nextFinalExamRoundsCompleted,
  shouldStartFinalExam,
} from './trainingGoal';

export type SessionEvent = 'idle' | 'tick' | 'generation' | 'complete' | 'showcaseComplete';

export type HeatPoint = { x: number; y: number; strength: number };

const HEAT_INTERVAL = 6;
const MAX_HEAT_POINTS = 900;
const HISTORY_LENGTH = 48;

/**
 * Deterministic (for a given RNG) training loop: curriculum, simulation, evolution, and goal tracking.
 * Rendering and input live elsewhere; this class never touches the DOM.
 */
export class TrainingSession {
  track: TrackDefinition;
  index: TrackIndex;
  config: TrainingConfig;
  cars: SimCar[] = [];
  generation = 0;
  generationStep = 0;
  trackSegments: TrackSegment[] = [];
  segmentScores: SegmentScore[] = [];
  trainingPhase: TrainingPhase = 'learningStart';
  activeSegmentIndex: number | null = null;
  ghostReplay: ReplayFrame[] = [];
  fullLapGhostReplay: ReplayFrame[] = [];
  heatPoints: HeatPoint[] = [];
  trainingComplete = false;
  showcaseMode = false;
  /** Result of the most recent champion run, for UI feedback. */
  lastShowcase: { outcome: SimCar['outcome']; lapTicks: number | null } | null = null;

  private readonly random: () => number;
  private population: Genome[] = [];
  private trainingStarts: TrainingStart[] = [];
  private bestGenomeEver: Genome | null = null;
  private bestCoachGenome: Genome | null = null;
  private bestScoreEver = 0;
  private bestLapTicksEver: number | null = null;
  private lastBestLapGeneration: number | null = null;
  private history: number[] = [];
  private lastEvolution = { eliteCount: 0, teacherChildren: 0, randomImmigrants: 0 };
  private recordAttempts = 0;
  private validationLapTicks: number | null = null;
  private goalTargetLapTicks = 0;
  private finalExamActive = false;
  private finalRoundsCompleted = 0;
  private heatCursor = 0;
  private referenceLapTicks = 1;
  private resumeAfterShowcase = false;

  constructor(track: TrackDefinition, config: TrainingConfig = DEFAULT_TRAINING_CONFIG, random: () => number = Math.random) {
    this.random = random;
    this.config = { ...config };
    this.track = track;
    this.index = buildTrackIndex(track);
    this.setTrack(track);
  }

  /** Replaces the track and restarts training from scratch. */
  setTrack(track: TrackDefinition): void {
    this.track = track;
    this.index = buildTrackIndex(track);
    this.referenceLapTicks = estimateReferenceLapTicks(this.index);
    this.rebuildTrackSegments();
    this.resetTraining();
  }

  /**
   * Merges a config change. Population size changes restart the population (keeping the champion);
   * returns true when cars were respawned.
   */
  applyConfig(config: Partial<TrainingConfig>): boolean {
    const populationChanged = config.populationSize !== undefined && config.populationSize !== this.config.populationSize;
    const segmentCountChanged = config.smartSegmentCount !== undefined && config.smartSegmentCount !== this.config.smartSegmentCount;
    this.config = { ...this.config, ...config };
    if (this.config.trainingMode !== 'manualLab') {
      this.config.advancedTuningEnabled = false;
    }
    if (segmentCountChanged) {
      this.rebuildTrackSegments();
    }
    this.goalTargetLapTicks = this.resolveGoalTicks();

    if (populationChanged && !this.showcaseMode) {
      this.population = this.seededPopulation(this.bestGenomeEver ?? this.bestCoachGenome);
      this.startGeneration();
      return true;
    }
    return false;
  }

  /** Full reset: new random population, generation 0, no champion, cleared history and overlays. */
  resetTraining(): void {
    this.generation = 0;
    this.bestGenomeEver = null;
    this.bestCoachGenome = null;
    this.bestScoreEver = 0;
    this.bestLapTicksEver = null;
    this.lastBestLapGeneration = null;
    this.validationLapTicks = null;
    this.recordAttempts = 0;
    this.history = [];
    this.lastEvolution = { eliteCount: 0, teacherChildren: 0, randomImmigrants: 0 };
    this.segmentScores = createSegmentScores(this.trackSegments);
    this.clearOverlays();
    this.finalExamActive = false;
    this.finalRoundsCompleted = 0;
    this.trainingComplete = false;
    this.showcaseMode = false;
    this.goalTargetLapTicks = this.resolveGoalTicks();
    this.population = createInitialPopulation(this.config.populationSize, 0, this.random);
    this.startGeneration();
  }

  /** Restores a saved driver: it becomes the teacher and seeds part of the new population. */
  restoreChampion(genome: Genome | null, generation: number): void {
    this.resetTraining();
    this.generation = Math.max(0, Math.floor(generation));
    if (genome) {
      const restored = cloneGenome(genome);
      if (restored.completedLap && restored.bestLapTicks) {
        this.bestGenomeEver = restored;
        this.bestLapTicksEver = restored.bestLapTicks;
        this.validationLapTicks = restored.bestLapTicks;
        this.lastBestLapGeneration = this.generation;
      }
      this.bestCoachGenome = cloneGenome(restored);
      this.bestScoreEver = restored.score;
    }
    this.population = this.seededPopulation(genome);
    this.startGeneration();
  }

  /** Best driver to save or show: fastest lap finisher, else the best full-lap attempt. */
  get champion(): Genome | null {
    return this.bestGenomeEver ?? this.bestCoachGenome;
  }

  /** Advances every alive car by one tick and handles generation boundaries. */
  step(): SessionEvent {
    if (this.trainingComplete && !this.showcaseMode) {
      return 'idle';
    }
    if (this.cars.length === 0) {
      return 'idle';
    }

    this.generationStep += 1;
    let alive = 0;
    for (const car of this.cars) {
      if (!car.alive) {
        continue;
      }
      stepCar(this.index, car);
      car.fitness = scoreCar(this.index, car);
      if (car.alive) {
        alive += 1;
        if (this.generationStep % HEAT_INTERVAL === 0 && car.bestProgress > 80) {
          this.addHeatPoint(car);
        }
      }
    }

    if (alive > 0 && this.generationStep < this.getCurrentMaxSteps()) {
      return 'tick';
    }

    if (this.showcaseMode) {
      this.finishShowcaseRun();
      return 'showcaseComplete';
    }
    this.finishGeneration();
    return this.trainingComplete ? 'complete' : 'generation';
  }

  /**
   * Runs the champion alone on a full lap. Returns false when no champion exists yet.
   * After the run the session returns to training unless training was already complete.
   */
  startChampionRun(): boolean {
    const champion = this.champion;
    if (!champion) {
      return false;
    }

    this.resumeAfterShowcase = !this.trainingComplete;
    this.showcaseMode = true;
    this.trainingPhase = 'finalComplete';
    this.activeSegmentIndex = null;
    this.generationStep = 0;
    this.trainingStarts = [this.createFullLapStart('finalComplete', true)];
    const genome: Genome = {
      ...cloneGenome(champion),
      id: `champion-${this.generation}`,
      generation: this.generation,
      score: 0,
      completedLap: false,
      bestLapTicks: null,
    };
    this.cars = [createCar(this.index, genome, this.trainingStarts[0], 0, 0)];
    return true;
  }

  /** The car the camera and sensor overlay should follow. */
  focusCar(): SimCar | null {
    let bestAlive: SimCar | null = null;
    let best: SimCar | null = null;
    for (const car of this.cars) {
      if (!best || compareCars(car, best) > 0) {
        best = car;
      }
      if (car.alive && (!bestAlive || compareCars(car, bestAlive) > 0)) {
        bestAlive = car;
      }
    }
    return bestAlive ?? best;
  }

  getStats(status: TrainingStats['status']): TrainingStats {
    const cars = this.cars;
    let alive = 0;
    let bestCurrent = 0;
    let totalFitness = 0;
    let crashed = 0;
    let lapCompletions = 0;
    let bestLapProgress = 0;
    let currentBestLapTicks: number | null = null;
    for (const car of cars) {
      alive += car.alive ? 1 : 0;
      bestCurrent = Math.max(bestCurrent, car.fitness);
      totalFitness += car.fitness;
      crashed += car.outcome === 'crashed' ? 1 : 0;
      lapCompletions += car.outcome === 'lap' ? 1 : 0;
      currentBestLapTicks = minLapTicks(currentBestLapTicks, car.lapTicks);
      if (car.start.kind === 'fullLap') {
        bestLapProgress = Math.max(bestLapProgress, carProgressRatio(this.index, car));
      }
    }
    const checkpointCount = this.track.checkpoints.length;
    const maxCheckpoint = Math.floor(bestLapProgress * checkpointCount);
    const bestLapTicks = minLapTicks(this.bestLapTicksEver, currentBestLapTicks);
    const complete = this.trainingComplete && !this.showcaseMode;

    return {
      generation: this.generation,
      bestScore: bestCurrent,
      bestEver: Math.max(this.bestScoreEver, bestCurrent),
      currentBestLapTicks,
      bestLapTicks,
      lapCompletions,
      averageScore: cars.length > 0 ? totalFitness / cars.length : 0,
      aliveCount: alive,
      populationSize: this.config.populationSize,
      checkpointProgress: checkpointCount > 0 ? Math.min(1, maxCheckpoint / checkpointCount) : 0,
      maxCheckpoint,
      crashRate: cars.length > 0 ? crashed / cars.length : 0,
      bestProgress: bestLapProgress,
      eliteCount: this.lastEvolution.eliteCount,
      teacherChildren: this.lastEvolution.teacherChildren,
      trainingPhase: this.trainingPhase,
      activeSegmentIndex: this.activeSegmentIndex,
      segmentCoverage: segmentCoverage(this.segmentScores),
      hardestSegmentIndex: hardestSegmentIndex(this.segmentScores),
      recordAttempts: this.recordAttempts,
      validationLapTicks: this.validationLapTicks,
      goalTargetLapTicks: this.goalTargetLapTicks,
      goalProgress: goalProgress(bestLapTicks, this.goalTargetLapTicks),
      finalRoundsCompleted: this.finalRoundsCompleted,
      finalRoundTarget: this.config.finalExamRounds,
      trainingComplete: this.trainingComplete,
      hasChampion: this.bestGenomeEver !== null,
      history: this.history,
      status: complete ? 'complete' : status,
    };
  }

  private startGeneration(): void {
    this.generationStep = 0;
    const size = this.config.populationSize;
    const fullLapBootstrap = shouldUseFullLapBootstrap(this.config, this.generation, this.bestLapTicksEver);
    this.trainingStarts = this.finalExamActive
      ? Array.from({ length: size }, () => this.createFullLapStart('finalExam', true))
      : fullLapBootstrap
        ? Array.from({ length: size }, () => this.createFullLapStart(this.generation < 2 ? 'learningStart' : 'recordAttempt', false))
        : createTrainingStarts(this.track, this.trackSegments, this.segmentScores, this.config, this.generation, size, this.random);
    this.activeSegmentIndex = this.trainingStarts.find((start) => start.segmentIndex !== null)?.segmentIndex ?? null;
    const validationRun = this.trainingStarts.some((start) => start.validation);
    const sectorStart = this.trainingStarts.find((start) => start.kind === 'segment');
    this.trainingPhase = this.finalExamActive
      ? 'finalExam'
      : validationRun
        ? 'fullLapValidation'
        : this.config.trainingMode !== 'smartCoach'
          ? 'recordAttempt'
          : this.generation < 2
            ? 'learningStart'
            : sectorStart?.phase ?? 'recordAttempt';

    this.cars = this.population.map((genome, slot) => {
      const start = this.trainingStarts[slot] ?? this.createFullLapStart('recordAttempt', false);
      const lane = (slot % 8) - 3.5;
      return createCar(this.index, genome, start, slot, lane * (start.kind === 'segment' ? 1.1 : 2.4));
    });
  }

  private finishGeneration(): void {
    for (const car of this.cars) {
      finishCar(car, 'timeout');
      car.fitness = scoreCar(this.index, car);
      this.recordSegmentAttempt(car);
    }

    const scored = this.cars.map((car) => ({
      car,
      genome: {
        ...cloneGenome(car.genome),
        score: this.selectionFitness(car),
        completedLap: car.outcome === 'lap',
        bestLapTicks: car.lapTicks,
      },
    }));
    this.recordAttempts += scored.filter((entry) => entry.car.start.kind === 'fullLap').length;
    const scoredPopulation = scored.map((entry) => entry.genome);
    const generationBest = bestGenome(scoredPopulation);
    const generationFullLapBest = bestGenome(scored.filter((entry) => entry.car.start.kind === 'fullLap').map((entry) => entry.genome));
    const generationLapBest = bestGenome(scoredPopulation.filter((genome) => genome.completedLap && genome.bestLapTicks));

    const bestCar = this.cars.reduce<SimCar | null>((best, car) => (!best || compareCars(car, best) > 0 ? car : best), null);
    if (bestCar && bestCar.replay.length > 6) {
      this.ghostReplay = bestCar.replay.slice(-260);
    }
    const bestLapCar = this.cars.filter((car) => car.outcome === 'lap').reduce<SimCar | null>(
      (best, car) => (!best || compareCars(car, best) > 0 ? car : best),
      null,
    );
    if (bestLapCar && bestLapCar.replay.length > 6) {
      this.fullLapGhostReplay = bestLapCar.replay.slice();
      this.validationLapTicks = minLapTicks(this.validationLapTicks, bestLapCar.lapTicks);
    }
    if (generationBest) {
      this.bestScoreEver = Math.max(this.bestScoreEver, generationBest.score);
    }
    if (generationFullLapBest && (!this.bestCoachGenome || compareGenomes(generationFullLapBest, this.bestCoachGenome) > 0)) {
      this.bestCoachGenome = cloneGenome(generationFullLapBest);
    } else if (!this.bestCoachGenome && generationBest) {
      this.bestCoachGenome = cloneGenome(generationBest);
    }
    if (generationLapBest && (!this.bestGenomeEver || compareGenomes(generationLapBest, this.bestGenomeEver) > 0)) {
      this.bestGenomeEver = cloneGenome(generationLapBest);
      this.bestLapTicksEver = generationLapBest.bestLapTicks ?? this.bestLapTicksEver;
      this.lastBestLapGeneration = this.generation;
    }

    this.history = [...this.history.slice(-(HISTORY_LENGTH - 1)), this.generationPerformance()];

    if (this.finalExamActive) {
      this.finalRoundsCompleted = nextFinalExamRoundsCompleted(this.finalRoundsCompleted, Boolean(generationLapBest));
      if (finalExamComplete(this.finalRoundsCompleted, this.config.finalExamRounds)) {
        this.completeTraining();
        return;
      }
    } else if (shouldStartFinalExam({
      bestLapTicks: this.bestLapTicksEver,
      targetLapTicks: this.goalTargetLapTicks,
      generation: this.generation,
      lastImprovedGeneration: this.lastBestLapGeneration,
      patienceGenerations: this.config.goalPatienceGenerations,
      finalExamActive: this.finalExamActive,
      trainingComplete: this.trainingComplete,
    })) {
      this.finalExamActive = true;
      this.finalRoundsCompleted = 0;
    }

    const evolution = evolvePopulation(
      scoredPopulation,
      this.adaptiveConfig(),
      this.generation,
      this.bestGenomeEver ?? this.bestCoachGenome ?? generationBest,
      this.random,
    );
    this.population = evolution.population;
    this.lastEvolution = {
      eliteCount: evolution.eliteCount,
      teacherChildren: evolution.teacherChildren,
      randomImmigrants: evolution.randomImmigrants,
    };
    this.generation += 1;
    this.startGeneration();
  }

  /** Raises mutation while the best lap is stuck, to help the population escape a plateau. */
  private adaptiveConfig(): TrainingConfig {
    if (this.lastBestLapGeneration === null || this.config.trainingMode === 'manualLab') {
      return this.config;
    }
    const stuckGenerations = this.generation - this.lastBestLapGeneration;
    const boost = 1 + Math.min(1.2, Math.max(0, stuckGenerations - 3) * 0.1);
    return { ...this.config, mutationRate: Math.min(0.6, this.config.mutationRate * boost) };
  }

  /**
   * Chart value per generation: lap progress (0..1) before the first finisher,
   * then 1 + goal progress (1..2) once laps are completed.
   */
  private generationPerformance(): number {
    let lapProgress = 0;
    let lapTicks: number | null = null;
    for (const car of this.cars) {
      if (car.start.kind === 'fullLap') {
        lapProgress = Math.max(lapProgress, carProgressRatio(this.index, car));
      }
      lapTicks = minLapTicks(lapTicks, car.lapTicks);
    }
    return lapTicks === null ? lapProgress : 1 + goalProgress(lapTicks, this.goalTargetLapTicks);
  }

  private completeTraining(): void {
    this.trainingComplete = true;
    this.finalExamActive = false;
    this.showcaseMode = false;
    this.trainingPhase = 'finalComplete';
    this.activeSegmentIndex = null;
  }

  private finishShowcaseRun(): void {
    const car = this.cars[0];
    this.lastShowcase = car ? { outcome: car.outcome, lapTicks: car.lapTicks } : null;
    if (car?.outcome === 'lap' && car.lapTicks) {
      this.validationLapTicks = minLapTicks(this.validationLapTicks, car.lapTicks);
      this.fullLapGhostReplay = car.replay.slice();
    }
    this.showcaseMode = false;
    if (this.resumeAfterShowcase) {
      // A champion run started mid-training returns to the interrupted generation.
      this.startGeneration();
      return;
    }
    this.trainingComplete = true;
    this.trainingPhase = 'finalComplete';
  }

  private getCurrentMaxSteps(): number {
    const hasFullLapRun = this.showcaseMode
      || this.finalExamActive
      || this.config.trainingMode !== 'smartCoach'
      || this.trainingStarts.some((start) => start.kind === 'fullLap');
    if (!hasFullLapRun) {
      return this.config.maxSteps;
    }

    const validationOrExam = this.showcaseMode
      || this.finalExamActive
      || this.config.trainingMode !== 'smartCoach'
      || this.trainingStarts.some((start) => start.kind === 'fullLap' && start.validation);
    return Math.max(this.config.maxSteps, Math.round(this.goalTargetLapTicks * (validationOrExam ? 1.45 : 1.25)));
  }

  /** Cross-start-type selection score: finished laps win, sector runs are discounted. */
  private selectionFitness(car: SimCar): number {
    if (car.outcome === 'lap' && car.lapTicks) {
      return car.fitness;
    }
    if (car.start.kind === 'segment') {
      return car.fitness * 0.74;
    }
    return car.fitness + carProgressRatio(this.index, car) * 420 + 120;
  }

  private recordSegmentAttempt(car: SimCar): void {
    const segmentIndex = car.start.segmentIndex;
    const score = segmentIndex === null ? undefined : this.segmentScores[segmentIndex];
    if (!score) {
      return;
    }
    score.attempts += 1;
    score.completions += car.outcome === 'segment' ? 1 : 0;
    score.crashes += car.outcome === 'crashed' ? 1 : 0;
    score.bestScore = Math.max(score.bestScore, car.fitness);
    score.bestProgress = Math.max(score.bestProgress, carProgressRatio(this.index, car));
  }

  private seededPopulation(seed: Genome | null): Genome[] {
    const size = this.config.populationSize;
    const population = createInitialPopulation(size, this.generation, this.random);
    if (!seed) {
      return population;
    }
    const teacherChildren = Math.round(size * 0.3);
    population[0] = { ...cloneGenome(seed), id: `g${this.generation}-saved-elite`, generation: this.generation, score: 0, completedLap: false, bestLapTicks: null };
    for (let slot = 1; slot <= teacherChildren && slot < size; slot += 1) {
      population[slot] = {
        ...mutateGenome(seed, this.config.mutationRate, slot % 2 === 0 ? 0.12 : 0.28, this.random),
        id: `g${this.generation}-saved-teacher-${slot}`,
        generation: this.generation,
      };
    }
    return population;
  }

  private createFullLapStart(phase: TrainingPhase, validation: boolean): TrainingStart {
    return {
      kind: 'fullLap',
      phase,
      pose: this.track.spawnPose,
      startDistance: 0,
      targetDistance: this.index.length,
      segmentIndex: null,
      validation,
    };
  }

  private rebuildTrackSegments(): void {
    this.trackSegments = buildTrackSegments(this.track, this.config.smartSegmentCount);
    this.segmentScores = createSegmentScores(this.trackSegments);
    this.trainingStarts = [];
    this.activeSegmentIndex = null;
  }

  private resolveGoalTicks(): number {
    return this.config.targetLapTicks ?? calculateLapGoalTicks(this.referenceLapTicks);
  }

  private clearOverlays(): void {
    this.ghostReplay = [];
    this.fullLapGhostReplay = [];
    this.heatPoints = [];
    this.heatCursor = 0;
  }

  private addHeatPoint(car: SimCar): void {
    const point = { x: car.x, y: car.y, strength: Math.min(1, car.fitness / 3000) };
    if (this.heatPoints.length < MAX_HEAT_POINTS) {
      this.heatPoints.push(point);
    } else {
      this.heatPoints[this.heatCursor] = point;
      this.heatCursor = (this.heatCursor + 1) % MAX_HEAT_POINTS;
    }
  }
}

/** Positive when a ranks above b: completed laps first (shorter wins), then fitness. */
export function compareCars(a: SimCar, b: SimCar): number {
  const aLap = finiteLapTicks(a.lapTicks);
  const bLap = finiteLapTicks(b.lapTicks);
  if (aLap !== null || bLap !== null) {
    if (aLap !== null && bLap !== null) {
      return bLap - aLap;
    }
    return aLap !== null ? 1 : -1;
  }
  return a.fitness - b.fitness;
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
