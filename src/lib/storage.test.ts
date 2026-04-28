import { describe, expect, it } from 'vitest';
import { DEFAULT_TRAINING_CONFIG } from '../types';
import { createPresetTrack } from './geometry';
import { createRandomGenome } from './neural';
import { createExportSnapshot, parseExportSnapshot } from './storage';

describe('snapshot export/import', () => {
  it('round-trips track, genome, and config', () => {
    const track = createPresetTrack();
    const genome = createRandomGenome();
    const snapshot = createExportSnapshot(track, genome, DEFAULT_TRAINING_CONFIG, 7);
    const parsed = parseExportSnapshot(JSON.stringify(snapshot));

    expect(parsed?.track.centerline.length).toBe(track.centerline.length);
    expect(parsed?.bestGenome?.weights).toHaveLength(genome.weights.length);
    expect(parsed?.config.trainingMode).toBe(DEFAULT_TRAINING_CONFIG.trainingMode);
    expect(parsed?.generation).toBe(7);
  });
});
