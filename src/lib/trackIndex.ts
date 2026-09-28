import type { Pose, TrackDefinition } from '../types';
import { trackWallSegments } from './geometry';

const GRID_CELL_SIZE = 48;
const PROJECTION_WINDOW = 10;

/**
 * Precomputed, allocation-free lookups for one track: wall grid for rays and collisions,
 * cumulative centerline distances for progress and look-ahead poses.
 */
export type TrackIndex = {
  track: TrackDefinition;
  length: number;
  pointCount: number;
  /** cumulative[i] = distance along the centerline to point i; cumulative[pointCount] = length. */
  cumulative: Float64Array;
  segmentLength: Float64Array;
  /** Wall segments packed as [ax, ay, bx, by] per wall. */
  walls: Float64Array;
  wallCount: number;
  gridMinX: number;
  gridMinY: number;
  gridColumns: number;
  gridRows: number;
  /** Wall ids per grid cell (CSR layout). */
  cellStart: Int32Array;
  cellWalls: Int32Array;
  /** Per-wall stamp used to skip walls already tested in the current query. */
  visitStamp: Int32Array;
  stamp: number;
};

export type TrackProjection = {
  segmentIndex: number;
  /** Distance along the centerline, in [0, length). */
  progressDistance: number;
  /** Distance from the query point to the centerline. */
  distance: number;
};

export function buildTrackIndex(track: TrackDefinition): TrackIndex {
  const points = track.centerline;
  const pointCount = points.length;
  const cumulative = new Float64Array(pointCount + 1);
  const segmentLength = new Float64Array(pointCount);
  for (let index = 0; index < pointCount; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % pointCount];
    segmentLength[index] = Math.hypot(b.x - a.x, b.y - a.y);
    cumulative[index + 1] = cumulative[index] + segmentLength[index];
  }

  const wallPairs = trackWallSegments(track).filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) > 0.0001);
  const wallCount = wallPairs.length;
  const walls = new Float64Array(wallCount * 4);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  wallPairs.forEach(([a, b], index) => {
    walls[index * 4] = a.x;
    walls[index * 4 + 1] = a.y;
    walls[index * 4 + 2] = b.x;
    walls[index * 4 + 3] = b.y;
    minX = Math.min(minX, a.x, b.x);
    minY = Math.min(minY, a.y, b.y);
    maxX = Math.max(maxX, a.x, b.x);
    maxY = Math.max(maxY, a.y, b.y);
  });
  if (wallCount === 0) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }

  const gridMinX = minX - GRID_CELL_SIZE;
  const gridMinY = minY - GRID_CELL_SIZE;
  const gridColumns = Math.max(1, Math.ceil((maxX - gridMinX + GRID_CELL_SIZE) / GRID_CELL_SIZE));
  const gridRows = Math.max(1, Math.ceil((maxY - gridMinY + GRID_CELL_SIZE) / GRID_CELL_SIZE));
  const buckets: number[][] = Array.from({ length: gridColumns * gridRows }, () => []);
  for (let wall = 0; wall < wallCount; wall += 1) {
    const ax = walls[wall * 4];
    const ay = walls[wall * 4 + 1];
    const bx = walls[wall * 4 + 2];
    const by = walls[wall * 4 + 3];
    const c0 = Math.floor((Math.min(ax, bx) - gridMinX) / GRID_CELL_SIZE);
    const c1 = Math.floor((Math.max(ax, bx) - gridMinX) / GRID_CELL_SIZE);
    const r0 = Math.floor((Math.min(ay, by) - gridMinY) / GRID_CELL_SIZE);
    const r1 = Math.floor((Math.max(ay, by) - gridMinY) / GRID_CELL_SIZE);
    for (let row = r0; row <= r1; row += 1) {
      for (let column = c0; column <= c1; column += 1) {
        buckets[row * gridColumns + column].push(wall);
      }
    }
  }

  const cellStart = new Int32Array(buckets.length + 1);
  for (let cell = 0; cell < buckets.length; cell += 1) {
    cellStart[cell + 1] = cellStart[cell] + buckets[cell].length;
  }
  const cellWalls = new Int32Array(cellStart[buckets.length]);
  buckets.forEach((bucket, cell) => cellWalls.set(bucket, cellStart[cell]));

  return {
    track,
    length: cumulative[pointCount],
    pointCount,
    cumulative,
    segmentLength,
    walls,
    wallCount,
    gridMinX,
    gridMinY,
    gridColumns,
    gridRows,
    cellStart,
    cellWalls,
    visitStamp: new Int32Array(wallCount),
    stamp: 0,
  };
}

/**
 * Projects a point onto the centerline. With a segment hint only nearby segments are searched,
 * which keeps progress continuous on hairpins where another part of the track is spatially closer.
 */
export function projectOnTrack(index: TrackIndex, x: number, y: number, hint: number | null): TrackProjection {
  const points = index.track.centerline;
  const count = index.pointCount;
  let bestSegment = 0;
  let bestT = 0;
  let bestDistanceSquared = Number.POSITIVE_INFINITY;

  const testSegment = (segment: number) => {
    const a = points[segment];
    const b = points[(segment + 1) % count];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lengthSquared = abx * abx + aby * aby;
    let t = lengthSquared > 0 ? ((x - a.x) * abx + (y - a.y) * aby) / lengthSquared : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = a.x + abx * t - x;
    const dy = a.y + aby * t - y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      bestSegment = segment;
      bestT = t;
    }
  };

  if (hint !== null && count > PROJECTION_WINDOW * 2) {
    for (let offset = -PROJECTION_WINDOW; offset <= PROJECTION_WINDOW; offset += 1) {
      testSegment((((hint + offset) % count) + count) % count);
    }
  }

  const halfWidth = index.track.width / 2;
  if (hint === null || count <= PROJECTION_WINDOW * 2 || bestDistanceSquared > halfWidth * halfWidth * 4) {
    for (let segment = 0; segment < count; segment += 1) {
      testSegment(segment);
    }
  }

  return {
    segmentIndex: bestSegment,
    progressDistance: index.cumulative[bestSegment] + index.segmentLength[bestSegment] * bestT,
    distance: Math.sqrt(bestDistanceSquared),
  };
}

/** Pose on the centerline at a distance along the track (wraps around the loop). */
export function poseAtTrackDistance(index: TrackIndex, targetDistance: number): Pose {
  const points = index.track.centerline;
  const count = index.pointCount;
  if (count < 2 || index.length <= 0) {
    return index.track.spawnPose;
  }

  const wrapped = ((targetDistance % index.length) + index.length) % index.length;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (index.cumulative[middle] <= wrapped) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  const a = points[low];
  const b = points[(low + 1) % count];
  const segmentLength = index.segmentLength[low];
  const local = segmentLength > 0 ? (wrapped - index.cumulative[low]) / segmentLength : 0;
  return {
    x: a.x + (b.x - a.x) * local,
    y: a.y + (b.y - a.y) * local,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

/** Distance from origin along the ray to the closest wall, or maxDistance when nothing is hit. */
export function castRay(index: TrackIndex, originX: number, originY: number, angle: number, maxDistance: number): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const walls = index.walls;
  const stampValue = nextStamp(index);
  let best = maxDistance;

  let column = Math.floor((originX - index.gridMinX) / GRID_CELL_SIZE);
  let row = Math.floor((originY - index.gridMinY) / GRID_CELL_SIZE);
  const stepColumn = dx > 0 ? 1 : -1;
  const stepRow = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(GRID_CELL_SIZE / dx) : Number.POSITIVE_INFINITY;
  const tDeltaY = dy !== 0 ? Math.abs(GRID_CELL_SIZE / dy) : Number.POSITIVE_INFINITY;
  const cellMinX = index.gridMinX + column * GRID_CELL_SIZE;
  const cellMinY = index.gridMinY + row * GRID_CELL_SIZE;
  let tMaxX = dx > 0 ? (cellMinX + GRID_CELL_SIZE - originX) / dx : dx < 0 ? (cellMinX - originX) / dx : Number.POSITIVE_INFINITY;
  let tMaxY = dy > 0 ? (cellMinY + GRID_CELL_SIZE - originY) / dy : dy < 0 ? (cellMinY - originY) / dy : Number.POSITIVE_INFINITY;
  let tCellEnter = 0;

  while (tCellEnter <= best) {
    if (column >= 0 && row >= 0 && column < index.gridColumns && row < index.gridRows) {
      const cell = row * index.gridColumns + column;
      for (let cursor = index.cellStart[cell]; cursor < index.cellStart[cell + 1]; cursor += 1) {
        const wall = index.cellWalls[cursor];
        if (index.visitStamp[wall] === stampValue) {
          continue;
        }
        index.visitStamp[wall] = stampValue;
        const hit = rayWallDistance(originX, originY, dx, dy, walls, wall);
        if (hit < best) {
          best = hit;
        }
      }
    } else if (
      (column < 0 && stepColumn < 0)
      || (row < 0 && stepRow < 0)
      || (column >= index.gridColumns && stepColumn > 0)
      || (row >= index.gridRows && stepRow > 0)
    ) {
      break;
    }

    if (tMaxX < tMaxY) {
      tCellEnter = tMaxX;
      tMaxX += tDeltaX;
      column += stepColumn;
    } else {
      tCellEnter = tMaxY;
      tMaxY += tDeltaY;
      row += stepRow;
    }
  }

  return best;
}

/**
 * True when a capsule (segment a-b inflated by radius) touches any wall.
 * Cars are capsules; with speed below the capsule diameter this check cannot tunnel through walls.
 */
export function capsuleHitsWall(index: TrackIndex, ax: number, ay: number, bx: number, by: number, radius: number): boolean {
  const walls = index.walls;
  const stampValue = nextStamp(index);
  const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - radius - index.gridMinX) / GRID_CELL_SIZE));
  const c1 = Math.min(index.gridColumns - 1, Math.floor((Math.max(ax, bx) + radius - index.gridMinX) / GRID_CELL_SIZE));
  const r0 = Math.max(0, Math.floor((Math.min(ay, by) - radius - index.gridMinY) / GRID_CELL_SIZE));
  const r1 = Math.min(index.gridRows - 1, Math.floor((Math.max(ay, by) + radius - index.gridMinY) / GRID_CELL_SIZE));
  const radiusSquared = radius * radius;

  for (let row = r0; row <= r1; row += 1) {
    for (let column = c0; column <= c1; column += 1) {
      const cell = row * index.gridColumns + column;
      for (let cursor = index.cellStart[cell]; cursor < index.cellStart[cell + 1]; cursor += 1) {
        const wall = index.cellWalls[cursor];
        if (index.visitStamp[wall] === stampValue) {
          continue;
        }
        index.visitStamp[wall] = stampValue;
        const cx = walls[wall * 4];
        const cy = walls[wall * 4 + 1];
        const dx = walls[wall * 4 + 2];
        const dy = walls[wall * 4 + 3];
        if (segmentDistanceSquared(ax, ay, bx, by, cx, cy, dx, dy) <= radiusSquared) {
          return true;
        }
      }
    }
  }

  return false;
}

function nextStamp(index: TrackIndex): number {
  index.stamp += 1;
  if (index.stamp > 2_000_000_000) {
    index.stamp = 1;
    index.visitStamp.fill(0);
  }
  return index.stamp;
}

function rayWallDistance(ox: number, oy: number, dx: number, dy: number, walls: Float64Array, wall: number): number {
  const ax = walls[wall * 4];
  const ay = walls[wall * 4 + 1];
  const ex = walls[wall * 4 + 2] - ax;
  const ey = walls[wall * 4 + 3] - ay;
  const denominator = dx * ey - dy * ex;
  if (Math.abs(denominator) < 1e-9) {
    return Number.POSITIVE_INFINITY;
  }
  const qx = ax - ox;
  const qy = ay - oy;
  const t = (qx * ey - qy * ex) / denominator;
  const u = (qx * dy - qy * dx) / denominator;
  return t >= 0 && u >= 0 && u <= 1 ? t : Number.POSITIVE_INFINITY;
}

function pointSegmentDistanceSquared(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSquared = abx * abx + aby * aby;
  let t = lengthSquared > 0 ? ((px - ax) * abx + (py - ay) * aby) / lengthSquared : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + abx * t - px;
  const dy = ay + aby * t - py;
  return dx * dx + dy * dy;
}

function segmentDistanceSquared(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return 0;
  }
  return Math.min(
    pointSegmentDistanceSquared(ax, ay, cx, cy, dx, dy),
    pointSegmentDistanceSquared(bx, by, cx, cy, dx, dy),
    pointSegmentDistanceSquared(cx, cy, ax, ay, bx, by),
    pointSegmentDistanceSquared(dx, dy, ax, ay, bx, by),
  );
}
