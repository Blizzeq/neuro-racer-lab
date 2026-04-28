import { describe, expect, it } from 'vitest';
import { DEFAULT_TRAINING_CONFIG } from '../types';
import { createPresetTrack, generateTrack } from './geometry';
import {
  buildTrackSegments,
  calculateSmartSegmentFitness,
  createSegmentScores,
  createTrainingStarts,
  poseAtDistance,
  shouldUseFullLapBootstrap,
} from './curriculum';

describe('smart curriculum training', () => {
  it('covers short and long closed tracks with ordered segments', () => {
    const shortTrack = generateTrack([
      { x: 180, y: 180 },
      { x: 760, y: 180 },
      { x: 760, y: 620 },
      { x: 180, y: 620 },
    ]);
    const longTrack = createPresetTrack();

    for (const track of [shortTrack, longTrack]) {
      const segments = buildTrackSegments(track, 12);
      expect(segments.length).toBeGreaterThanOrEqual(4);
      expect(segments[0].startDistance).toBe(0);
      expect(segments.at(-1)?.endDistance).toBeGreaterThan(segments.at(-1)?.startDistance ?? 0);
      expect(segments.every((segment) => segment.targetDistance > 0)).toBe(true);
    }
  });

  it('creates segment spawn poses aligned to the track direction', () => {
    const track = createPresetTrack();
    const pose = poseAtDistance(track.centerline, 400);

    expect(Number.isFinite(pose.x)).toBe(true);
    expect(Number.isFinite(pose.y)).toBe(true);
    expect(pose.angle).toBeGreaterThanOrEqual(-Math.PI);
    expect(pose.angle).toBeLessThanOrEqual(Math.PI);
  });

  it('mixes full lap starts and sector starts in Smart Coach', () => {
    const track = createPresetTrack();
    const segments = buildTrackSegments(track, 10);
    const starts = createTrainingStarts(
      track,
      segments,
      createSegmentScores(segments),
      { ...DEFAULT_TRAINING_CONFIG, populationSize: 32, trainingMode: 'smartCoach' },
      3,
      32,
      () => 0.42,
    );
    const fullLapStarts = starts.filter((start) => start.kind === 'fullLap');
    const sectorStarts = starts.filter((start) => start.kind === 'segment');

    expect(starts).toHaveLength(32);
    expect(fullLapStarts.length).toBeGreaterThan(starts.length / 2);
    expect(sectorStarts.length).toBeGreaterThan(0);
  });

  it('anchors validation generations even more strongly on full-lap attempts', () => {
    const track = createPresetTrack();
    const segments = buildTrackSegments(track, 10);
    const scores = createSegmentScores(segments);
    const config = { ...DEFAULT_TRAINING_CONFIG, populationSize: 40, trainingMode: 'smartCoach' as const };
    const normal = createTrainingStarts(track, segments, scores, config, 3, 40, () => 0.42);
    const validation = createTrainingStarts(track, segments, scores, config, config.fullLapValidationInterval, 40, () => 0.42);

    expect(validation.filter((start) => start.kind === 'fullLap').length)
      .toBeGreaterThan(normal.filter((start) => start.kind === 'fullLap').length);
    expect(validation.some((start) => start.validation)).toBe(true);
  });

  it('starts sector practice from the first weak frontier segment', () => {
    const track = createPresetTrack();
    const segments = buildTrackSegments(track, 10);
    const scores = createSegmentScores(segments).map((score, index) => ({
      ...score,
      attempts: 6,
      completions: index < 4 ? 5 : 0,
      crashes: index === 4 ? 4 : 0,
      bestProgress: index < 4 ? 1 : index === 4 ? 0.22 : 0,
    }));
    const starts = createTrainingStarts(
      track,
      segments,
      scores,
      { ...DEFAULT_TRAINING_CONFIG, populationSize: 32, trainingMode: 'smartCoach' },
      8,
      32,
      () => 0.1,
    );

    expect(starts.find((start) => start.kind === 'segment')?.segmentIndex).toBe(4);
  });

  it('uses full lap starts only outside Smart Coach', () => {
    const track = createPresetTrack();
    const segments = buildTrackSegments(track, 10);
    const starts = createTrainingStarts(
      track,
      segments,
      createSegmentScores(segments),
      { ...DEFAULT_TRAINING_CONFIG, trainingMode: 'fullLap' },
      3,
      16,
      () => 0.2,
    );

    expect(starts.every((start) => start.kind === 'fullLap')).toBe(true);
  });

  it('keeps Smart Coach in full-lap bootstrap until the first completed lap', () => {
    expect(shouldUseFullLapBootstrap(
      { ...DEFAULT_TRAINING_CONFIG, trainingMode: 'smartCoach' },
      2,
      null,
    )).toBe(true);
    expect(shouldUseFullLapBootstrap(
      { ...DEFAULT_TRAINING_CONFIG, trainingMode: 'smartCoach' },
      8,
      null,
    )).toBe(false);
    expect(shouldUseFullLapBootstrap(
      { ...DEFAULT_TRAINING_CONFIG, trainingMode: 'smartCoach' },
      2,
      720,
    )).toBe(false);
  });

  it('rewards sector progress and penalizes crash, reverse, and stagnation', () => {
    const strong = calculateSmartSegmentFitness({
      progress: 500,
      targetDistance: 500,
      speedScore: 40,
      age: 180,
      crashed: false,
      stagnant: false,
      completed: true,
    });
    const weak = calculateSmartSegmentFitness({
      progress: 180,
      targetDistance: 500,
      speedScore: 12,
      age: 260,
      crashed: true,
      stagnant: true,
      reversePenalty: 90,
      wallPenalty: 80,
      completed: false,
    });

    expect(strong).toBeGreaterThan(weak);
  });
});
