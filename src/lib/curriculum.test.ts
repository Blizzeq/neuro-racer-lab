import { describe, expect, it } from 'vitest';
import { DEFAULT_TRAINING_CONFIG } from '../types';
import { createPresetTrack, generateTrack } from './geometry';
import {
  buildTrackSegments,
  calculateSmartSegmentFitness,
  createSegmentScores,
  createTrainingStarts,
  poseAtDistance,
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

    expect(starts).toHaveLength(32);
    expect(starts.some((start) => start.kind === 'fullLap')).toBe(true);
    expect(starts.some((start) => start.kind === 'segment')).toBe(true);
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
