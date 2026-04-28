import type { ExportSnapshot, Genome, SaveSnapshot, TrackDefinition, TrainingConfig } from '../types';
import { DEFAULT_TRAINING_CONFIG } from '../types';

const STORAGE_KEY = 'neuro-racer-lab:snapshot';

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

export function saveSnapshot(
  track: TrackDefinition,
  bestGenome: Genome | null,
  config: TrainingConfig,
  generation: number,
): ExportSnapshot {
  const snapshot = createExportSnapshot(track, bestGenome, config, generation);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export function loadSnapshot(): SaveSnapshot | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as SaveSnapshot;
    if (![1, 2].includes(parsed.version) || !parsed.track?.centerline?.length) {
      return null;
    }
    if (parsed.version === 2) {
      parsed.config = normalizeTrainingConfig(parsed.config);
    }
    return parsed;
  } catch {
    return null;
  }
}

export function hasSnapshot(): boolean {
  return window.localStorage.getItem(STORAGE_KEY) !== null;
}

export function parseExportSnapshot(raw: string): ExportSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as ExportSnapshot;
    if (parsed.version !== 2 || !parsed.track?.centerline?.length || !parsed.config) {
      return null;
    }
    parsed.config = normalizeTrainingConfig(parsed.config);
    return parsed;
  } catch {
    return null;
  }
}

export function snapshotTime(snapshot: SaveSnapshot): string {
  return snapshot.version === 2 ? snapshot.timestamp : snapshot.savedAt;
}

function normalizeTrainingConfig(config: Partial<TrainingConfig>): TrainingConfig {
  const legacyMode = config.trainingMode as string | undefined;
  const trainingMode = legacyMode === 'fullLap' || legacyMode === 'manualLab' || legacyMode === 'smartCoach'
    ? legacyMode
    : legacyMode === 'explore' || legacyMode === 'balanced' || legacyMode === 'exploit'
      ? 'manualLab'
      : DEFAULT_TRAINING_CONFIG.trainingMode;

  return {
    ...DEFAULT_TRAINING_CONFIG,
    ...config,
    trainingMode,
    advancedTuningEnabled: trainingMode === 'manualLab' ? true : config.advancedTuningEnabled ?? false,
  };
}
