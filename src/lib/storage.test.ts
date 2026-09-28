import { describe, expect, it } from 'vitest';
import { DEFAULT_TRAINING_CONFIG } from '../types';
import { createPresetTrack } from './geometry';
import { createRandomGenome } from './neural';
import { createExportSnapshot, normalizeTrainingConfig, parseExportSnapshot } from './storage';

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

  it('normalizes legacy training modes on import', () => {
    const snapshot = createExportSnapshot(createPresetTrack(), null, {
      ...DEFAULT_TRAINING_CONFIG,
      trainingMode: 'smartCoach',
    }, 2);
    const parsed = parseExportSnapshot(JSON.stringify({
      ...snapshot,
      config: {
        ...snapshot.config,
        trainingMode: 'balanced',
      },
    }));

    expect(parsed?.config.trainingMode).toBe('manualLab');
    expect(parsed?.config.smartSegmentCount).toBe(DEFAULT_TRAINING_CONFIG.smartSegmentCount);
  });
});

describe('snapshot validation', () => {
  it('drops genomes with the wrong topology or non-finite weights instead of crashing the simulator', () => {
    const snapshot = createExportSnapshot(createPresetTrack(), createRandomGenome(), DEFAULT_TRAINING_CONFIG, 1);
    const wrongLength = parseExportSnapshot(JSON.stringify({ ...snapshot, bestGenome: { ...snapshot.bestGenome, weights: [1, 2, 3] } }));
    const nonFinite = JSON.stringify({ ...snapshot, bestGenome: { ...snapshot.bestGenome, weights: snapshot.bestGenome?.weights.map(() => 'x') } });

    expect(wrongLength).not.toBeNull();
    expect(wrongLength?.bestGenome).toBeNull();
    expect(parseExportSnapshot(nonFinite)?.bestGenome).toBeNull();
  });

  it('rejects malformed tracks and rebuilds derived track data from the centerline', () => {
    const snapshot = createExportSnapshot(createPresetTrack(), null, DEFAULT_TRAINING_CONFIG, 1);
    const tampered = parseExportSnapshot(JSON.stringify({
      ...snapshot,
      track: { ...snapshot.track, leftBoundary: [], checkpoints: 'broken' },
    }));

    expect(tampered?.track.leftBoundary).toHaveLength(snapshot.track.centerline.length);
    expect(tampered?.track.checkpoints.length).toBe(snapshot.track.checkpoints.length);
    expect(parseExportSnapshot(JSON.stringify({ ...snapshot, track: { centerline: [{ x: 'a', y: 1 }] } }))).toBeNull();
    expect(parseExportSnapshot('not json')).toBeNull();
    expect(parseExportSnapshot(JSON.stringify({ version: 3 }))).toBeNull();
  });

  it('rejects degenerate, oversized, and self-crossing imported tracks without freezing', () => {
    const snapshot = createExportSnapshot(createPresetTrack(), null, DEFAULT_TRAINING_CONFIG, 1);
    const withCenterline = (centerline: Array<{ x: number; y: number }>) =>
      JSON.stringify({ ...snapshot, track: { ...snapshot.track, centerline } });
    const square = (side: number) => [
      { x: 0, y: 0 },
      { x: side, y: 0 },
      { x: side, y: side },
      { x: 0, y: side },
    ];

    const started = performance.now();
    expect(parseExportSnapshot(withCenterline(square(999_000)))).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(parseExportSnapshot(withCenterline(Array.from({ length: 4 }, () => ({ x: 5, y: 5 }))))).toBeNull();
    expect(parseExportSnapshot(withCenterline([
      { x: 0, y: 0 },
      { x: 900, y: 700 },
      { x: 900, y: 0 },
      { x: 0, y: 700 },
    ]))).toBeNull();
    expect(parseExportSnapshot(withCenterline(square(1200)))?.track.centerline.length).toBeGreaterThan(100);
  });

  it('clamps imported config values to supported ranges', () => {
    const config = normalizeTrainingConfig({ populationSize: 1_000_000, speedMultiplier: 3, mutationRate: -5, maxSteps: 'x' });

    expect(config.populationSize).toBe(128);
    expect(config.speedMultiplier).toBe(4);
    expect(config.mutationRate).toBeGreaterThan(0);
    expect(config.maxSteps).toBe(DEFAULT_TRAINING_CONFIG.maxSteps);
  });
});
