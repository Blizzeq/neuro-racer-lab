import type { Checkpoint, Point, TrackDefinition } from '../types';

const TRACK_ID_PREFIX = 'track';
export const MIN_TRACK_WIDTH = 124;
export const DEFAULT_TRACK_WIDTH = MIN_TRACK_WIDTH;
const CENTERLINE_SPACING = 20;
const MIN_TRACK_LENGTH = 900;
const MAX_TRACK_LENGTH = 80_000;
const MAX_TRACK_EXTENT = 30_000;
const BOUNDARY_LOOP_WINDOW = 48;

/** Raised when a drawn or imported route cannot become a drivable closed track. */
export class TrackGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackGenerationError';
  }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalize(point: Point): Point {
  const length = Math.hypot(point.x, point.y);
  if (length < 0.00001) {
    return { x: 1, y: 0 };
  }
  return { x: point.x / length, y: point.y / length };
}

export function subtract(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function scale(point: Point, factor: number): Point {
  return { x: point.x * factor, y: point.y * factor };
}

export function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

export function perpendicular(point: Point): Point {
  return { x: -point.y, y: point.x };
}

export function wrapAngle(angle: number): number {
  let result = angle;
  while (result > Math.PI) result -= Math.PI * 2;
  while (result < -Math.PI) result += Math.PI * 2;
  return result;
}

export function trackWallSegments(track: TrackDefinition): Array<[Point, Point]> {
  return [
    ...closedSegments(track.leftBoundary),
    ...closedSegments(track.rightBoundary),
  ];
}

export function closedSegments(points: Point[]): Array<[Point, Point]> {
  return points.map((point, index) => [point, points[(index + 1) % points.length]]);
}

export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const denominator = (d.y - c.y) * (b.x - a.x) - (d.x - c.x) * (b.y - a.y);
  if (Math.abs(denominator) < 0.00001) {
    return false;
  }

  const ua = ((d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x)) / denominator;
  const ub = ((b.x - a.x) * (a.y - c.y) - (b.y - a.y) * (a.x - c.x)) / denominator;
  return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
}

export function raySegmentDistance(origin: Point, angle: number, maxDistance: number, a: Point, b: Point): number | null {
  const rayEnd = {
    x: origin.x + Math.cos(angle) * maxDistance,
    y: origin.y + Math.sin(angle) * maxDistance,
  };
  const denominator = (b.y - a.y) * (rayEnd.x - origin.x) - (b.x - a.x) * (rayEnd.y - origin.y);

  if (Math.abs(denominator) < 0.00001) {
    return null;
  }

  const ua = ((b.x - a.x) * (origin.y - a.y) - (b.y - a.y) * (origin.x - a.x)) / denominator;
  const ub = ((rayEnd.x - origin.x) * (origin.y - a.y) - (rayEnd.y - origin.y) * (origin.x - a.x)) / denominator;

  if (ua < 0 || ua > 1 || ub < 0 || ub > 1) {
    return null;
  }

  return ua * maxDistance;
}

export function nearestDistanceToPolyline(point: Point, points: Point[]): number {
  return nearestPointOnClosedPath(point, points).distance;
}

export function nearestPointOnClosedPath(point: Point, points: Point[]): {
  point: Point;
  distance: number;
  progress: number;
  progressDistance: number;
  segmentIndex: number;
} {
  const segments = closedSegments(points);
  const lengths = segments.map(([a, b]) => distance(a, b));
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  let traversed = 0;
  let nearest = {
    point: points[0],
    distance: Number.POSITIVE_INFINITY,
    progress: 0,
    progressDistance: 0,
    segmentIndex: 0,
  };

  for (let index = 0; index < segments.length; index += 1) {
    const [a, b] = segments[index];
    const ab = subtract(b, a);
    const ap = subtract(point, a);
    const lengthSquared = Math.max(0.00001, dot(ab, ab));
    const t = clamp(dot(ap, ab) / lengthSquared, 0, 1);
    const projection = add(a, scale(ab, t));
    const projectedDistance = distance(point, projection);
    const progressDistance = traversed + lengths[index] * t;

    if (projectedDistance < nearest.distance) {
      nearest = {
        point: projection,
        distance: projectedDistance,
        progress: totalLength > 0 ? progressDistance / totalLength : 0,
        progressDistance,
        segmentIndex: index,
      };
    }

    traversed += lengths[index];
  }

  return nearest;
}

export function closedPathLength(points: Point[]): number {
  return closedSegments(points).reduce((nearest, [a, b]) => {
    return nearest + distance(a, b);
  }, 0);
}

export function createPresetTrack(): TrackDefinition {
  const points = [
    { x: 520, y: 940 },
    { x: 620, y: 520 },
    { x: 1060, y: 330 },
    { x: 1620, y: 390 },
    { x: 2110, y: 630 },
    { x: 2280, y: 1040 },
    { x: 1960, y: 1390 },
    { x: 1430, y: 1300 },
    { x: 1220, y: 1020 },
    { x: 900, y: 1280 },
  ];

  return generateTrack(points, DEFAULT_TRACK_WIDTH, 'Neon Circuit');
}

/**
 * Turns a freehand route into a smoothed closed track.
 * Throws TrackGenerationError when the route is too short, too small, or crosses itself.
 */
export function generateTrack(rawPoints: Point[], width = DEFAULT_TRACK_WIDTH, name = 'Custom Loop'): TrackDefinition {
  const cleaned = removeNearDuplicates(rawPoints, 18);
  if (cleaned.length < 4) {
    throw new TrackGenerationError('A track needs at least four distinct points.');
  }

  const trackWidth = Math.max(width, MIN_TRACK_WIDTH);
  const centerline = resampleClosedPath(chaikin(cleaned, 3), CENTERLINE_SPACING);
  validateCenterline(centerline, trackWidth);
  return buildTrackFromCenterline(centerline, trackWidth, name);
}

/**
 * Builds walls, checkpoints, spawn pose, and bounds from an already smoothed centerline.
 * Used for generated tracks and for rebuilding imported snapshots from trusted-shape data.
 */
export function buildTrackFromCenterline(
  centerline: Point[],
  width: number,
  name: string,
  id = `${TRACK_ID_PREFIX}-${Date.now().toString(36)}-${Math.round(Math.random() * 1000)}`,
): TrackDefinition {
  if (centerline.length < 4) {
    throw new TrackGenerationError('A track needs at least four centerline points.');
  }

  const halfWidth = width / 2;
  const normals = centerline.map((_point, index) => {
    const previous = centerline[(index - 1 + centerline.length) % centerline.length];
    const next = centerline[(index + 1) % centerline.length];
    return perpendicular(normalize(subtract(next, previous)));
  });

  const leftBoundary = removeBoundaryLoops(centerline.map((point, index) => add(point, scale(normals[index], halfWidth))));
  const rightBoundary = removeBoundaryLoops(centerline.map((point, index) => add(point, scale(normals[index], -halfWidth))));
  const checkpoints = createCheckpoints(centerline, leftBoundary, rightBoundary);
  const spawnDirection = normalize(subtract(centerline[1], centerline[0]));
  const allPoints = [...leftBoundary, ...rightBoundary];

  return {
    id,
    name,
    width,
    centerline,
    leftBoundary,
    rightBoundary,
    checkpoints,
    spawnPose: {
      x: centerline[0].x,
      y: centerline[0].y,
      angle: Math.atan2(spawnDirection.y, spawnDirection.x),
    },
    bounds: {
      minX: Math.min(...allPoints.map((point) => point.x)),
      minY: Math.min(...allPoints.map((point) => point.y)),
      maxX: Math.max(...allPoints.map((point) => point.x)),
      maxY: Math.max(...allPoints.map((point) => point.y)),
    },
  };
}

/**
 * Rebuilds a track from an untrusted centerline (saved or imported): resamples it to the
 * simulator's point spacing and applies the same validation as freshly drawn tracks.
 */
export function rebuildTrackFromCenterline(centerline: Point[], width: number, name: string, id?: string): TrackDefinition {
  if (centerline.length < 4) {
    throw new TrackGenerationError('A track needs at least four centerline points.');
  }
  const trackWidth = Math.max(width, MIN_TRACK_WIDTH);
  const resampled = resampleClosedPath(centerline, CENTERLINE_SPACING);
  validateCenterline(resampled, trackWidth);
  return buildTrackFromCenterline(resampled, trackWidth, name, id);
}

function validateCenterline(centerline: Point[], trackWidth: number): void {
  const length = closedPathLength(centerline);
  if (!(length >= MIN_TRACK_LENGTH)) {
    throw new TrackGenerationError('Track is too small. Draw a bigger loop.');
  }
  const xs = centerline.map((point) => point.x);
  const ys = centerline.map((point) => point.y);
  if (
    length > MAX_TRACK_LENGTH
    || Math.max(...xs) - Math.min(...xs) > MAX_TRACK_EXTENT
    || Math.max(...ys) - Math.min(...ys) > MAX_TRACK_EXTENT
  ) {
    throw new TrackGenerationError('Track is too large. Draw a smaller loop.');
  }

  const segments = closedSegments(centerline);
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 2; j < segments.length; j += 1) {
      if (i === 0 && j === segments.length - 1) {
        continue;
      }
      if (segmentsIntersect(segments[i][0], segments[i][1], segments[j][0], segments[j][1])) {
        throw new TrackGenerationError('Track crosses itself. Draw a single loop without crossings.');
      }
    }
  }

  // Two parts of the route that are far apart along the loop but close in space would share walls.
  const cumulative = [0];
  for (let index = 1; index < centerline.length; index += 1) {
    cumulative.push(cumulative[index - 1] + distance(centerline[index - 1], centerline[index]));
  }
  const minSeparation = trackWidth * 0.98;
  const minArc = trackWidth * 2.6;
  for (let i = 0; i < centerline.length; i += 1) {
    for (let j = i + 1; j < centerline.length; j += 1) {
      const arc = cumulative[j] - cumulative[i];
      if (Math.min(arc, length - arc) < minArc) {
        continue;
      }
      if (distance(centerline[i], centerline[j]) < minSeparation) {
        throw new TrackGenerationError('Parts of the track are too close together. Leave more space between lanes.');
      }
    }
  }
}

/**
 * Offsetting a curve inward by more than its turn radius creates small reversed loops.
 * Those loops become invisible walls inside the road, so each loop is collapsed to its crossing point.
 * The array length is preserved to keep left/right/centerline indexes aligned.
 */
function removeBoundaryLoops(boundary: Point[]): Point[] {
  const count = boundary.length;
  const result = boundary.map((point) => ({ ...point }));
  const window = Math.min(BOUNDARY_LOOP_WINDOW, Math.floor(count / 3));

  let index = 0;
  while (index < count) {
    const a = result[index];
    const b = result[(index + 1) % count];
    let collapsedTo = -1;

    for (let offset = window; offset >= 2; offset -= 1) {
      const j = index + offset;
      const c = result[j % count];
      const d = result[(j + 1) % count];
      const hit = segmentIntersectionPoint(a, b, c, d);
      if (hit) {
        for (let k = index + 1; k <= j; k += 1) {
          result[k % count] = { ...hit };
        }
        collapsedTo = j;
        break;
      }
    }

    index = collapsedTo > index ? collapsedTo : index + 1;
  }

  return result;
}

function segmentIntersectionPoint(a: Point, b: Point, c: Point, d: Point): Point | null {
  const denominator = (d.y - c.y) * (b.x - a.x) - (d.x - c.x) * (b.y - a.y);
  if (Math.abs(denominator) < 0.00001) {
    return null;
  }

  const ua = ((d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x)) / denominator;
  const ub = ((b.x - a.x) * (a.y - c.y) - (b.y - a.y) * (a.x - c.x)) / denominator;
  if (ua <= 0.0001 || ua >= 0.9999 || ub <= 0.0001 || ub >= 0.9999) {
    return null;
  }
  return { x: a.x + (b.x - a.x) * ua, y: a.y + (b.y - a.y) * ua };
}

function removeNearDuplicates(points: Point[], minDistance: number): Point[] {
  const result: Point[] = [];

  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      continue;
    }
    const safePoint = point;
    const previous = result.at(-1);
    if (!previous || distance(previous, safePoint) >= minDistance) {
      result.push(safePoint);
    }
  }

  if (result.length > 2 && distance(result[0], result[result.length - 1]) < minDistance * 1.4) {
    result.pop();
  }

  return result;
}

function chaikin(points: Point[], iterations: number): Point[] {
  let result = points;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next: Point[] = [];
    for (let index = 0; index < result.length; index += 1) {
      const current = result[index];
      const following = result[(index + 1) % result.length];
      next.push({
        x: current.x * 0.75 + following.x * 0.25,
        y: current.y * 0.75 + following.y * 0.25,
      });
      next.push({
        x: current.x * 0.25 + following.x * 0.75,
        y: current.y * 0.25 + following.y * 0.75,
      });
    }
    result = next;
  }

  return result;
}

function resampleClosedPath(points: Point[], step: number): Point[] {
  const segments = closedSegments(points);
  const lengths = segments.map(([a, b]) => distance(a, b));
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  const sampleCount = Math.max(28, Math.round(totalLength / step));
  const result: Point[] = [];

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const target = (sample / sampleCount) * totalLength;
    let cursor = 0;

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segmentLength = lengths[segmentIndex];
      if (cursor + segmentLength >= target) {
        const [a, b] = segments[segmentIndex];
        const local = (target - cursor) / segmentLength;
        result.push({
          x: a.x + (b.x - a.x) * local,
          y: a.y + (b.y - a.y) * local,
        });
        break;
      }
      cursor += segmentLength;
    }
  }

  return result;
}

function createCheckpoints(centerline: Point[], left: Point[], right: Point[]): Checkpoint[] {
  const interval = Math.max(3, Math.round(centerline.length / 24));
  const checkpoints: Checkpoint[] = [];

  for (let index = 0; index < centerline.length; index += interval) {
    checkpoints.push({
      index: checkpoints.length,
      a: left[index],
      b: right[index],
      center: centerline[index],
      progress: index / centerline.length,
    });
  }

  return checkpoints;
}
