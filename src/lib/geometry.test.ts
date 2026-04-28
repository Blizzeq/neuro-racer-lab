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

  it('supports tracks longer than the old 1120x720 viewport', () => {
    const track = generateTrack([
      { x: 180, y: 220 },
      { x: 2450, y: 260 },
      { x: 2530, y: 1480 },
      { x: 240, y: 1520 },
    ]);

    expect(track.bounds.maxX).toBeGreaterThan(1120);
    expect(track.bounds.maxY).toBeGreaterThan(720);
  });

  it('widens generated tracks enough for sharp turns', () => {
    const track = generateTrack([
      { x: 100, y: 100 },
      { x: 620, y: 100 },
      { x: 620, y: 220 },
      { x: 120, y: 220 },
    ], 70);

    expect(track.width).toBeGreaterThanOrEqual(124);
    expect(track.leftBoundary).toHaveLength(track.centerline.length);
    expect(track.rightBoundary).toHaveLength(track.centerline.length);
  });

  it('does not clamp drawn points to the simulator workspace', () => {
    const track = generateTrack([
      { x: -1300, y: -900 },
      { x: 4300, y: -760 },
      { x: 4550, y: 2800 },
      { x: -1450, y: 3050 },
    ]);

    expect(track.bounds.minX).toBeLessThan(0);
    expect(track.bounds.minY).toBeLessThan(0);
    expect(track.bounds.maxX).toBeGreaterThan(2800);
    expect(track.bounds.maxY).toBeGreaterThan(1800);
  });

  it('rejects underspecified tracks', () => {
    expect(() => generateTrack([
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { x: 30, y: 30 },
    ])).toThrow();
  });
});
