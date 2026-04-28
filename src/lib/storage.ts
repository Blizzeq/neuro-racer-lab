import type { Genome, SaveSnapshot, TrackDefinition } from '../types';

const STORAGE_KEY = 'neuro-racer-lab:snapshot';

export function saveSnapshot(track: TrackDefinition, bestGenome: Genome | null, generation: number): SaveSnapshot {
  const snapshot: SaveSnapshot = {
    version: 1,
    savedAt: new Date().toISOString(),
    track,
    bestGenome,
    generation,
  };
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
    if (parsed.version !== 1 || !parsed.track?.centerline?.length) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function hasSnapshot(): boolean {
  return window.localStorage.getItem(STORAGE_KEY) !== null;
}
