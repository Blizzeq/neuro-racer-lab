import { describe, expect, it } from 'vitest';
import { createPresetTrack, generateTrack, nearestDistanceToPolyline, trackWallSegments } from './geometry';

describe('track generation', () => {
  it('creates boundaries and checkpoints from a centerline', () => {
    const track = createPresetTrack();

    expect(track.centerline.length).toBeGreaterThan(28);
    expect(track.leftBoundary).toHaveLength(track.centerline.length);
    expect(track.rightBoundary).toHaveLength(track.centerline.length);
    expect(track.checkpoints.length).toBeGreaterThan(12);
    expect(track.spawnPose.angle).toBeGreaterThanOrEqual(-Math.PI);
    expect(track.spawnPose.angle).toBeLessThanOrEqual(Math.PI);
  });

  it('keeps generated walls closed', () => {
    const track = generateTrack([
      { x: 160, y: 160 },
      { x: 920, y: 160 },
      { x: 930, y: 560 },
      { x: 170, y: 560 },
    ]);

    expect(trackWallSegments(track)).toHaveLength(track.centerline.length * 2);
    expect(nearestDistanceToPolyline(track.spawnPose, track.centerline)).toBeLessThan(1);
  });

  it('rejects underspecified tracks', () => {
    expect(() => generateTrack([
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { x: 30, y: 30 },
    ])).toThrow();
  });
});
