import type { ExportSnapshot, Genome, Point, SaveSnapshot, TrackDefinition, TrainingConfig } from '../types';
import { DEFAULT_TRAINING_CONFIG } from '../types';
import { MIN_TRACK_WIDTH, rebuildTrackFromCenterline } from './geometry';
import { GENOME_WEIGHT_COUNT } from './neural';

const STORAGE_KEY = 'neuro-racer-lab:snapshot';
const MAX_CENTERLINE_POINTS = 5000;
const MAX_COORDINATE = 1_000_000;
export const SPEED_STEPS = [1, 2, 4, 8, 16, 32, 64] as const;
const POPULATION_OPTIONS = [24, 40, 64, 96, 128];

export function createExportSnapshot(
  track: TrackDefinition,
  bestGenome: Genome | null,
  config: TrainingConfig,
  generation: number,
): ExportSnapshot {
  return {
    version: 2,
    timestamp: new Date().toISOString(),
    track,
    bestGenome,
    config,
    generation,
  };
}

/** Saves to localStorage. Returns null when storage is unavailable (private mode, quota, disabled). */
export function saveSnapshot(
  track: TrackDefinition,
  bestGenome: Genome | null,
  config: TrainingConfig,
  generation: number,
): ExportSnapshot | null {
  const snapshot = createExportSnapshot(track, bestGenome, config, generation);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    return snapshot;
  } catch {
    return null;
  }
}

export function loadSnapshot(): SaveSnapshot | null {
  const raw = readStorage();
  if (!raw) {
    return null;
  }
  return parseSnapshot(raw, [1, 2]);
}

export function hasSnapshot(): boolean {
  return readStorage() !== null;
}

/** Parses an imported JSON file. Only version 2 exports are accepted. */
export function parseExportSnapshot(raw: string): ExportSnapshot | null {
  const snapshot = parseSnapshot(raw, [2]);
  return snapshot?.version === 2 ? snapshot : null;
}

export function snapshotTime(snapshot: SaveSnapshot): string {
  return snapshot.version === 2 ? snapshot.timestamp : snapshot.savedAt;
}

/**
 * Validates untrusted snapshot JSON. The track is resampled and validated like a drawn track and
 * its derived data (walls, checkpoints, bounds) is rebuilt, so a tampered file cannot crash or
 * freeze the simulator.
 */
function parseSnapshot(raw: string, versions: number[]): SaveSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !versions.includes(parsed.version as number)) {
    return null;
  }

  const track = parseTrack(parsed.track);
  if (!track) {
    return null;
  }
  const bestGenome = parseGenome(parsed.bestGenome);
  const generation = typeof parsed.generation === 'number' && Number.isFinite(parsed.generation)
    ? Math.max(0, Math.min(1_000_000, Math.floor(parsed.generation)))
    : 0;

  if (parsed.version === 1) {
    return {
      version: 1,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(0).toISOString(),
      track,
      bestGenome,
      generation,
    };
  }

  return {
    version: 2,
    timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date(0).toISOString(),
    track,
    bestGenome,
    config: normalizeTrainingConfig(isRecord(parsed.config) ? parsed.config : {}),
    generation,
  };
}

function parseTrack(value: unknown): TrackDefinition | null {
  if (!isRecord(value) || !Array.isArray(value.centerline)) {
    return null;
  }
  const centerline = value.centerline;
  if (centerline.length < 4 || centerline.length > MAX_CENTERLINE_POINTS || !centerline.every(isPoint)) {
    return null;
  }
  const width = typeof value.width === 'number' && Number.isFinite(value.width)
    ? Math.min(400, Math.max(MIN_TRACK_WIDTH, value.width))
    : MIN_TRACK_WIDTH;
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 60) : 'Imported Track';
  const id = typeof value.id === 'string' ? value.id.slice(0, 80) : undefined;
  try {
    return rebuildTrackFromCenterline(centerline.map((point: Point) => ({ x: point.x, y: point.y })), width, name, id);
  } catch {
    return null;
  }
}

function parseGenome(value: unknown): Genome | null {
  if (!isRecord(value) || !Array.isArray(value.weights) || value.weights.length !== GENOME_WEIGHT_COUNT) {
    return null;
  }
  if (!value.weights.every((weight) => typeof weight === 'number' && Number.isFinite(weight))) {
    return null;
  }
  const bestLapTicks = typeof value.bestLapTicks === 'number' && Number.isFinite(value.bestLapTicks) && value.bestLapTicks > 0
    ? value.bestLapTicks
    : null;
  return {
    id: typeof value.id === 'string' ? value.id.slice(0, 80) : 'imported',
    weights: value.weights.map((weight: number) => Math.max(-3, Math.min(3, weight))),
    score: typeof value.score === 'number' && Number.isFinite(value.score) ? value.score : 0,
    generation: typeof value.generation === 'number' && Number.isFinite(value.generation) ? Math.max(0, Math.floor(value.generation)) : 0,
    completedLap: value.completedLap === true && bestLapTicks !== null,
    bestLapTicks,
  };
}

/** Fills missing fields, maps legacy modes, and clamps numbers to ranges the UI and simulator support. */
export function normalizeTrainingConfig(config: Record<string, unknown>): TrainingConfig {
  const legacyMode = config.trainingMode;
  const trainingMode = legacyMode === 'fullLap' || legacyMode === 'manualLab' || legacyMode === 'smartCoach'
    ? legacyMode
    : legacyMode === 'explore' || legacyMode === 'balanced' || legacyMode === 'exploit'
      ? 'manualLab'
      : DEFAULT_TRAINING_CONFIG.trainingMode;
  const number = (key: keyof TrainingConfig, min: number, max: number): number => {
    const value = config[key];
    const fallback = DEFAULT_TRAINING_CONFIG[key] as number;
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const populationSize = Math.round(number('populationSize', 8, 128));
  const targetLapTicks = typeof config.targetLapTicks === 'number' && Number.isFinite(config.targetLapTicks) && config.targetLapTicks > 0
    ? Math.round(config.targetLapTicks)
    : null;

  return {
    populationSize: POPULATION_OPTIONS.includes(populationSize) ? populationSize : DEFAULT_TRAINING_CONFIG.populationSize,
    mutationRate: number('mutationRate', 0.01, 0.6),
    crossoverRate: number('crossoverRate', 0, 1),
    maxSteps: Math.round(number('maxSteps', 300, 6000)),
    speedMultiplier: nearestSpeedStep(number('speedMultiplier', 1, 64)),
    elitismRate: number('elitismRate', 0, 0.5),
    teacherCloneRate: number('teacherCloneRate', 0, 0.6),
    randomImmigrantRate: number('randomImmigrantRate', 0, 0.5),
    trainingMode,
    smartSegmentCount: Math.round(number('smartSegmentCount', 4, 18)),
    smartStartsPerGeneration: Math.round(number('smartStartsPerGeneration', 1, 18)),
    fullLapValidationInterval: Math.round(number('fullLapValidationInterval', 1, 50)),
    targetLapTicks,
    finalExamRounds: Math.round(number('finalExamRounds', 1, 10)),
    goalPatienceGenerations: Math.round(number('goalPatienceGenerations', 2, 200)),
    advancedTuningEnabled: trainingMode === 'manualLab',
  };
}

export function nearestSpeedStep(value: number): number {
  return SPEED_STEPS.reduce((best, step) => (Math.abs(step - value) <= Math.abs(best - value) ? step : best), SPEED_STEPS[0]);
}

function readStorage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPoint(value: unknown): value is Point {
  return isRecord(value)
    && typeof value.x === 'number'
    && typeof value.y === 'number'
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Math.abs(value.x) < MAX_COORDINATE
    && Math.abs(value.y) < MAX_COORDINATE;
}
