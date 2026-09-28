import { describe, expect, it } from 'vitest';
import type { Point } from '../types';
import {
  TrackGenerationError,
  buildTrackFromCenterline,
  createPresetTrack,
  generateTrack,
  nearestDistanceToPolyline,
  segmentsIntersect,
  trackWallSegments,
} from './geometry';

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
      { x: 620, y: 320 },
      { x: 120, y: 320 },
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

  it('rejects loops whose lanes would overlap', () => {
    expect(() => generateTrack([
      { x: 100, y: 100 },
      { x: 620, y: 100 },
      { x: 620, y: 200 },
      { x: 120, y: 200 },
    ])).toThrow(TrackGenerationError);
  });

  it('rejects self-crossing and tiny routes', () => {
    const figureEight = [
      { x: 0, y: 0 },
      { x: 900, y: 700 },
      { x: 900, y: 0 },
      { x: 0, y: 700 },
    ];
    expect(() => generateTrack(figureEight)).toThrow(/crosses itself/);
    expect(() => generateTrack([
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: 120 },
      { x: 0, y: 120 },
    ])).toThrow(/too small/);
  });

  it('removes inner-boundary loops created by corners tighter than half the road width', () => {
    const centerline: Point[] = [];
    for (let index = 0; index < 60; index += 1) {
      centerline.push({ x: index * 20, y: 0 });
    }
    for (let index = 0; index < 5; index += 1) {
      const angle = -Math.PI / 2 + (Math.PI * (index + 1)) / 6;
      centerline.push({ x: 1180 + Math.cos(angle) * 40, y: 40 + Math.sin(angle) * 40 });
    }
    for (let index = 59; index >= 0; index -= 1) {
      centerline.push({ x: index * 20, y: 400 });
    }
    const track = buildTrackFromCenterline(centerline, 124, 'Hairpin');

    expect(countBoundarySelfCrossings(track.leftBoundary)).toBe(0);
    expect(countBoundarySelfCrossings(track.rightBoundary)).toBe(0);
    expect(trackWallSegments(track)).toHaveLength(track.centerline.length * 2);
  });

  it('rejects underspecified tracks', () => {
    expect(() => generateTrack([
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { x: 30, y: 30 },
    ])).toThrow();
  });
});

function countBoundarySelfCrossings(boundary: Point[]): number {
  const segments = boundary.map((point, index) => [point, boundary[(index + 1) % boundary.length]] as const);
  const shareEndpoint = (a: readonly [Point, Point], b: readonly [Point, Point]) =>
    a.some((p) => b.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.001));
  let crossings = 0;
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 2; j < Math.min(segments.length, i + 30); j += 1) {
      if (segmentsIntersect(segments[i][0], segments[i][1], segments[j][0], segments[j][1]) && !shareEndpoint(segments[i], segments[j])) {
        crossings += 1;
      }
    }
  }
  return crossings;
}
