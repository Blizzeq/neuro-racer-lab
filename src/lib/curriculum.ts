import type {
  Point,
  SegmentScore,
  TrackDefinition,
  TrackSegment,
  TrainingConfig,
  TrainingStart,
} from '../types';
import { add, clamp, closedPathLength, closedSegments, distance, normalize, scale } from './geometry';

const MIN_SEGMENTS = 4;
const MAX_SEGMENTS = 18;
export const SMART_LAP_BOOTSTRAP_GENERATIONS = 6;

export function buildTrackSegments(track: TrackDefinition, desiredCount: number): TrackSegment[] {
  const pointCount = track.centerline.length;
  if (pointCount < MIN_SEGMENTS) {
    return [];
  }

  const trackLength = closedPathLength(track.centerline);
  const count = clamp(Math.round(desiredCount), MIN_SEGMENTS, Math.min(MAX_SEGMENTS, Math.floor(pointCount / 3)));
  const cumulative = cumulativeDistances(track.centerline);

  return Array.from({ length: count }, (_value, index) => {
    const startIndex = Math.floor((index / count) * pointCount);
    const endIndex = Math.floor(((index + 1) / count) * pointCount) % pointCount;
    const startDistance = cumulative[startIndex] ?? 0;
    const endDistance = index === count - 1 ? trackLength : cumulative[endIndex] ?? trackLength;
    const length = Math.max(1, endDistance - startDistance);

    return {
      index,
      startIndex,
      endIndex,
      startDistance,
      endDistance,
      length,
      spawnPose: poseAtDistance(track.centerline, Math.max(0, startDistance - Math.min(90, length * 0.22))),
      targetDistance: Math.max(120, length * 0.96),
    };
  });
}

export function createSegmentScores(segments: TrackSegment[]): SegmentScore[] {
  return segments.map((segment) => ({
    segmentIndex: segment.index,
    attempts: 0,
    completions: 0,
    crashes: 0,
    bestScore: 0,
    bestProgress: 0,
  }));
}

export function shouldUseFullLapBootstrap(config: TrainingConfig, generation: number, bestLapTicks: number | null): boolean {
  return config.trainingMode === 'smartCoach'
    && bestLapTicks === null
    && generation < SMART_LAP_BOOTSTRAP_GENERATIONS;
}

export function createTrainingStarts(
  track: TrackDefinition,
  segments: TrackSegment[],
  scores: SegmentScore[],
  config: TrainingConfig,
  generation: number,
  populationSize: number,
  random = Math.random,
): TrainingStart[] {
  const fullLap = createFullLapStart(track, 'recordAttempt', false);
  if (config.trainingMode !== 'smartCoach' || segments.length === 0) {
    return Array.from({ length: populationSize }, () => ({ ...fullLap }));
  }

  const validation = generation > 0 && generation % Math.max(1, config.fullLapValidationInterval) === 0;
  const fullLapRatio = validation ? 0.82 : generation < 4 ? 0.68 : 0.56;
  const minimumSectorStarts = populationSize >= 12 ? Math.max(2, Math.round(populationSize * 0.1)) : 0;
  const fullLapCount = clamp(
    Math.round(populationSize * fullLapRatio),
    Math.min(populationSize, 4),
    Math.max(Math.min(populationSize, 4), populationSize - minimumSectorStarts),
  );
  const segmentIndexes = selectTrainingSegmentIndexes(segments, scores, config, generation, populationSize - fullLapCount, random);

  return Array.from({ length: populationSize }, (_value, index) => {
    if (index < fullLapCount) {
      return createFullLapStart(track, validation ? 'fullLapValidation' : generation < 2 ? 'learningStart' : 'recordAttempt', validation);
    }

    const segmentIndex = segmentIndexes[(index - fullLapCount) % segmentIndexes.length] ?? 0;
    const segment = segments[segmentIndex] ?? segments[0];
    const score = scores[segment.index];
    const phase = score && score.attempts > 0 && score.crashes / Math.max(1, score.attempts) > 0.55
      ? 'hardCornerPractice'
      : 'trainingSector';

    return {
      kind: 'segment',
      phase,
      pose: segment.spawnPose,
      startDistance: segment.startDistance,
      targetDistance: segment.targetDistance,
      segmentIndex: segment.index,
      validation: false,
    };
  });
}

export function hardestSegmentIndex(scores: SegmentScore[]): number | null {
  if (scores.length === 0) {
    return null;
  }

  return scores.reduce((hardest, score) => {
    const current = segmentDifficulty(score);
    const previous = segmentDifficulty(hardest);
    return current > previous ? score : hardest;
  }).segmentIndex;
}

export function segmentCoverage(scores: SegmentScore[]): number {
  if (scores.length === 0) {
    return 0;
  }

  return scores.filter((score) => score.completions > 0 || score.bestProgress >= 0.72).length / scores.length;
}

export function calculateSmartSegmentFitness(input: {
  progress: number;
  targetDistance: number;
  speedScore: number;
  age: number;
  crashed: boolean;
  stagnant: boolean;
  reversePenalty?: number;
  wallPenalty?: number;
  completed: boolean;
}): number {
  const targetDistance = Math.max(1, input.targetDistance);
  const progress = clamp(input.progress, 0, targetDistance * 1.35);
  const progressRatio = clamp(progress / targetDistance, 0, 1);
  const completionBonus = input.completed ? 1320 + Math.max(0, 520 - input.age * 0.48) : 0;
  const crashPenalty = input.crashed ? 170 : 0;
  const stagnantPenalty = input.stagnant ? 140 : 0;

  return Math.max(
    0,
    progress * 1.28
      + progressRatio * 720
      + input.speedScore * 1.18
      + completionBonus
      - crashPenalty
      - stagnantPenalty
      - (input.reversePenalty ?? 0) * 1.32
      - (input.wallPenalty ?? 0) * 0.88,
  );
}

export function poseAtDistance(points: Point[], targetDistance: number): { x: number; y: number; angle: number } {
  const segments = closedSegments(points);
  const totalLength = closedPathLength(points);
  const wrappedDistance = ((targetDistance % totalLength) + totalLength) % totalLength;
  let cursor = 0;

  for (const [start, end] of segments) {
    const segmentLength = distance(start, end);
    if (cursor + segmentLength >= wrappedDistance) {
      const local = segmentLength > 0 ? (wrappedDistance - cursor) / segmentLength : 0;
      const point = add(start, scale({ x: end.x - start.x, y: end.y - start.y }, local));
      const direction = normalize({ x: end.x - start.x, y: end.y - start.y });
      return {
        x: point.x,
        y: point.y,
        angle: Math.atan2(direction.y, direction.x),
      };
    }
    cursor += segmentLength;
  }

  const fallback = points[0] ?? { x: 0, y: 0 };
  const next = points[1] ?? { x: fallback.x + 1, y: fallback.y };
  return {
    x: fallback.x,
    y: fallback.y,
    angle: Math.atan2(next.y - fallback.y, next.x - fallback.x),
  };
}

function createFullLapStart(track: TrackDefinition, phase: TrainingStart['phase'], validation: boolean): TrainingStart {
  return {
    kind: 'fullLap',
    phase,
    pose: track.spawnPose,
    startDistance: 0,
    targetDistance: closedPathLength(track.centerline),
    segmentIndex: null,
    validation,
  };
}

function selectTrainingSegmentIndexes(
  segments: TrackSegment[],
  scores: SegmentScore[],
  config: TrainingConfig,
  generation: number,
  startCount: number,
  random: () => number,
): number[] {
  const count = clamp(Math.max(config.smartStartsPerGeneration, startCount), 1, segments.length);
  const selected: number[] = [];
  const add = (index: number | null | undefined) => {
    if (index === null || index === undefined || !Number.isFinite(index)) {
      return;
    }
    const normalized = ((Math.round(index) % segments.length) + segments.length) % segments.length;
    if (!selected.includes(normalized)) {
      selected.push(normalized);
    }
  };

  const frontier = frontierSegmentIndex(segments, scores);
  add(frontier);
  add(frontier + 1);

  for (const index of rankedHardSegments(scores)) {
    add(index);
    if (selected.length >= count) {
      break;
    }
  }

  add(generation % segments.length);

  while (selected.length < count) {
    add(Math.floor(random() * segments.length));
  }

  return selected;
}

function frontierSegmentIndex(segments: TrackSegment[], scores: SegmentScore[]): number {
  const weakSegment = segments.find((segment) => {
    const score = scores[segment.index];
    return !score || segmentMastery(score) < 0.68;
  });

  return weakSegment?.index ?? hardestSegmentIndex(scores) ?? 0;
}

function rankedHardSegments(scores: SegmentScore[]): number[] {
  return [...scores]
    .sort((a, b) => segmentDifficulty(b) - segmentDifficulty(a))
    .map((score) => score.segmentIndex);
}

function segmentMastery(score: SegmentScore): number {
  const attempts = Math.max(1, score.attempts);
  const crashRate = score.crashes / attempts;
  const completionRate = score.completions / attempts;
  return clamp(score.bestProgress * 0.6 + completionRate * 0.4 - crashRate * 0.25, 0, 1);
}

function segmentDifficulty(score: SegmentScore): number {
  const attempts = Math.max(1, score.attempts);
  const crashRate = score.crashes / attempts;
  const completionRate = score.completions / attempts;
  return crashRate * 1.4 + (1 - completionRate) + (1 - clamp(score.bestProgress, 0, 1)) * 0.8;
}

function cumulativeDistances(points: Point[]): number[] {
  const result = [0];
  let cursor = 0;

  for (const [start, end] of closedSegments(points).slice(0, -1)) {
    cursor += distance(start, end);
    result.push(cursor);
  }

  return result;
}
