import { describe, expect, it } from 'vitest';
import type { Genome, TrainingStart } from '../types';
import { BENCHMARK_TRACKS } from './benchmarkTracks';
import { buildTrackSegments } from './curriculum';
import { createPresetTrack, generateTrack, raySegmentDistance, trackWallSegments } from './geometry';
import { GENOME_WEIGHT_COUNT } from './neural';
import {
  CAR_RADIUS,
  MAX_SPEED,
  SENSOR_RANGE,
  createCar,
  estimateReferenceLapTicks,
  maxYawRate,
  stepCar,
} from './simulation';
import { buildTrackIndex, capsuleHitsWall, castRay, projectOnTrack } from './trackIndex';

const ovalTrack = generateTrack(BENCHMARK_TRACKS.oval ?? [], undefined, 'Oval');

function constantGenome(steerBias: number, throttleBias: number): Genome {
  const weights = new Array<number>(GENOME_WEIGHT_COUNT).fill(0);
  const outputOffset = (8 + 1) * 7;
  weights[outputOffset] = steerBias;
  weights[outputOffset + 8] = throttleBias;
  return { id: 'constant', weights, score: 0, generation: 0 };
}

function fullLapStart(index: ReturnType<typeof buildTrackIndex>): TrainingStart {
  return {
    kind: 'fullLap',
    phase: 'recordAttempt',
    pose: index.track.spawnPose,
    startDistance: 0,
    targetDistance: index.length,
    segmentIndex: null,
    validation: false,
  };
}

describe('track index', () => {
  it('casts rays that match a brute-force wall scan', () => {
    const track = createPresetTrack();
    const index = buildTrackIndex(track);
    const walls = trackWallSegments(track);
    let seed = 11;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };

    for (let sample = 0; sample < 300; sample += 1) {
      const anchor = track.centerline[Math.floor(random() * track.centerline.length)];
      const origin = { x: anchor.x + (random() - 0.5) * 80, y: anchor.y + (random() - 0.5) * 80 };
      const angle = random() * Math.PI * 2;
      const expected = walls.reduce((best, [a, b]) => {
        const hit = raySegmentDistance(origin, angle, SENSOR_RANGE, a, b);
        return hit === null ? best : Math.min(best, hit);
      }, SENSOR_RANGE);

      expect(castRay(index, origin.x, origin.y, angle, SENSOR_RANGE)).toBeCloseTo(expected, 4);
    }
  });

  it('measures side walls at half the road width from the centerline', () => {
    const index = buildTrackIndex(ovalTrack);
    const pose = ovalTrack.spawnPose;
    const left = castRay(index, pose.x, pose.y, pose.angle - Math.PI / 2, SENSOR_RANGE);
    const right = castRay(index, pose.x, pose.y, pose.angle + Math.PI / 2, SENSOR_RANGE);

    expect(left).toBeCloseTo(ovalTrack.width / 2, 0);
    expect(right).toBeCloseTo(ovalTrack.width / 2, 0);
  });

  it('detects capsule contact with walls only near the edge', () => {
    const index = buildTrackIndex(ovalTrack);
    const pose = ovalTrack.spawnPose;
    const nx = Math.cos(pose.angle + Math.PI / 2);
    const ny = Math.sin(pose.angle + Math.PI / 2);
    const at = (offset: number) => capsuleHitsWall(
      index,
      pose.x + nx * offset - Math.cos(pose.angle) * 6,
      pose.y + ny * offset - Math.sin(pose.angle) * 6,
      pose.x + nx * offset + Math.cos(pose.angle) * 6,
      pose.y + ny * offset + Math.sin(pose.angle) * 6,
      CAR_RADIUS,
    );

    expect(at(0)).toBe(false);
    expect(at(ovalTrack.width / 2 - CAR_RADIUS - 2)).toBe(false);
    expect(at(ovalTrack.width / 2 - CAR_RADIUS + 1)).toBe(true);
  });

  it('keeps windowed projection consistent with a global search', () => {
    const index = buildTrackIndex(createPresetTrack());
    for (let point = 0; point < index.pointCount; point += 7) {
      const { x, y } = index.track.centerline[point];
      const global = projectOnTrack(index, x + 10, y - 8, null);
      const local = projectOnTrack(index, x + 10, y - 8, global.segmentIndex);
      expect(local.progressDistance).toBeCloseTo(global.progressDistance, 6);
    }
  });
});

describe('car simulation', () => {
  it('limits yaw rate at high speed so tight corners need braking', () => {
    expect(maxYawRate(MAX_SPEED)).toBeLessThan(maxYawRate(4));
    expect(maxYawRate(0)).toBe(0);
  });

  it('crashes into walls instead of tunneling through them at full speed', () => {
    const index = buildTrackIndex(ovalTrack);
    const car = createCar(index, constantGenome(0, 3), fullLapStart(index), 0, 0);
    let maxOffset = 0;
    for (let tick = 0; tick < 600 && car.alive; tick += 1) {
      stepCar(index, car);
      maxOffset = Math.max(maxOffset, projectOnTrack(index, car.x, car.y, null).distance);
    }

    expect(car.outcome).toBe('crashed');
    expect(maxOffset).toBeLessThan(ovalTrack.width / 2 + 1);
  });

  it('marks cars that stop making progress as stagnant', () => {
    const index = buildTrackIndex(ovalTrack);
    const car = createCar(index, constantGenome(0, -6), fullLapStart(index), 0, 0);
    for (let tick = 0; tick < 1200 && car.alive; tick += 1) {
      stepCar(index, car);
    }

    expect(car.outcome).toBe('stagnant');
  });

  it('starts sector drivers without a phantom reverse penalty', () => {
    const track = createPresetTrack();
    const index = buildTrackIndex(track);
    const segment = buildTrackSegments(track, 12)[5];
    const car = createCar(index, constantGenome(0, 0), {
      kind: 'segment',
      phase: 'trainingSector',
      pose: segment.spawnPose,
      startDistance: segment.spawnDistance,
      targetDistance: segment.targetDistance,
      segmentIndex: segment.index,
      validation: false,
    }, 0, 0);
    stepCar(index, car);

    expect(car.reverseDistance).toBe(0);
    expect(car.progress).toBeGreaterThan(0);
  });

  it('estimates slower reference laps for twistier tracks of similar length', () => {
    const oval = buildTrackIndex(ovalTrack);
    const technical = buildTrackIndex(generateTrack(BENCHMARK_TRACKS.technical ?? []));
    const ovalPace = oval.length / estimateReferenceLapTicks(oval);
    const technicalPace = technical.length / estimateReferenceLapTicks(technical);

    expect(ovalPace).toBeLessThanOrEqual(MAX_SPEED);
    expect(technicalPace).toBeLessThan(ovalPace);
  });
});
