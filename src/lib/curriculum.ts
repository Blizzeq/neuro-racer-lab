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
  const segmentIndexes = selectTrainingSegmentIndexes(segments, scores, config, generation, random);
  const fullLapCount = validation
    ? Math.max(1, Math.ceil(populationSize * 0.72))
    : Math.max(4, Math.ceil(populationSize * 0.22));

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
  const completionBonus = input.completed ? 1850 + Math.max(0, 640 - input.age * 0.4) : 0;
  const crashPenalty = input.crashed ? 145 : 0;
  const stagnantPenalty = input.stagnant ? 115 : 0;

  return Math.max(
    0,
    progress * 1.55
      + progressRatio * 920
      + input.speedScore * 1.2
      + completionBonus
      - crashPenalty
      - stagnantPenalty
      - (input.reversePenalty ?? 0) * 1.15
      - (input.wallPenalty ?? 0) * 1.2,
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
  random: () => number,
): number[] {
  const count = clamp(config.smartStartsPerGeneration, 1, segments.length);
  const selected = new Set<number>();
  const hardest = hardestSegmentIndex(scores);
  if (hardest !== null) {
    selected.add(hardest);
  }

  selected.add(generation % segments.length);

  const ranked = [...scores]
    .sort((a, b) => segmentDifficulty(b) - segmentDifficulty(a))
    .map((score) => score.segmentIndex);

  for (const index of ranked) {
    selected.add(index);
    if (selected.size >= count) {
      break;
    }
  }

  while (selected.size < count) {
    selected.add(Math.floor(random() * segments.length));
  }

  return [...selected];
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
