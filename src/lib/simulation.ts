import type { Genome, ReplayFrame, TrainingStart } from '../types';
import { calculateSmartSegmentFitness } from './curriculum';
import { wrapAngle } from './geometry';
import { calculateFitness, evaluateNetwork } from './neural';
import { type TrackIndex, capsuleHitsWall, castRay, poseAtTrackDistance, projectOnTrack } from './trackIndex';

export const SENSOR_ANGLES = [-1.35, -0.72, 0, 0.72, 1.35] as const;
export const SENSOR_RANGE = 260;
export const MAX_SPEED = 9.8;
/** Car hitbox: a capsule whose axis spans ±CAR_HALF_AXIS along the heading. */
export const CAR_RADIUS = 6;
export const CAR_HALF_AXIS = 6;
/** A driver must gain STAGNATION_PROGRESS px of best progress every STAGNATION_TICKS or it is removed. */
export const STAGNATION_TICKS = 120;
const STAGNATION_PROGRESS = 90;
const WRONG_WAY_DISTANCE = 140;
const REPLAY_INTERVAL = 4;
const MAX_REPLAY_FRAMES = 600;
const TRAIL_INTERVAL = 5;
const MAX_TRAIL_POINTS = 28;

const ACCELERATION_BASE = 0.1;
const ACCELERATION_THROTTLE = 1.3;
const AIR_DRAG = 0.048;
const LATERAL_GRIP = 0.22;
const BRAKE_DRAG = 0.11;
/** Yaw rate cap (rad/tick) at low speed. */
const MAX_YAW_RATE = 0.09;
/** Lateral acceleration limit (px/tick²): above v²/r = limit the car cannot hold the corner. */
export const LATERAL_ACCEL_LIMIT = 0.32;
const STEER_FULL_SPEED = 1.5;

export type CarOutcome = 'running' | 'crashed' | 'stagnant' | 'lap' | 'segment' | 'timeout';

/** Mutable state of one simulated driver. Plain data so it can run in tests and headless scripts. */
export type SimCar = {
  id: string;
  slot: number;
  genome: Genome;
  start: TrainingStart;
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  speed: number;
  steer: number;
  throttle: number;
  alive: boolean;
  outcome: CarOutcome;
  age: number;
  segmentHint: number;
  rawProgress: number;
  /** Unwrapped distance travelled along the centerline since spawn (negative when reversing). */
  progress: number;
  bestProgress: number;
  progressMark: number;
  lastImprovementAge: number;
  reverseDistance: number;
  wallPenalty: number;
  speedScore: number;
  lapTicks: number | null;
  fitness: number;
  sensors: Float64Array;
  trail: Array<{ x: number; y: number }>;
  replay: ReplayFrame[];
};

export function createCar(index: TrackIndex, genome: Genome, start: TrainingStart, slot: number, lateralOffset: number): SimCar {
  const lateralX = Math.cos(start.pose.angle + Math.PI / 2);
  const lateralY = Math.sin(start.pose.angle + Math.PI / 2);
  const x = start.pose.x + lateralX * lateralOffset;
  const y = start.pose.y + lateralY * lateralOffset;
  const projection = projectOnTrack(index, x, y, null);

  return {
    id: genome.id,
    slot,
    genome,
    start,
    x,
    y,
    angle: start.pose.angle,
    vx: 0,
    vy: 0,
    speed: 0,
    steer: 0,
    throttle: 0,
    alive: true,
    outcome: 'running',
    age: 0,
    segmentHint: projection.segmentIndex,
    rawProgress: projection.progressDistance,
    progress: 0,
    bestProgress: 0,
    progressMark: 0,
    lastImprovementAge: 0,
    reverseDistance: 0,
    wallPenalty: 0,
    speedScore: 0,
    lapTicks: null,
    fitness: 0,
    sensors: new Float64Array(SENSOR_ANGLES.length).fill(SENSOR_RANGE),
    trail: [{ x, y }],
    replay: [],
  };
}

/** Network inputs: wall rays, speed, heading error to the look-ahead tangent, and upcoming turn. */
export function readCarInputs(index: TrackIndex, car: SimCar): number[] {
  for (let sensor = 0; sensor < SENSOR_ANGLES.length; sensor += 1) {
    car.sensors[sensor] = castRay(index, car.x, car.y, car.angle + SENSOR_ANGLES[sensor], SENSOR_RANGE);
  }

  const lookAhead = 115 + car.speed * 22;
  const trackDistance = car.rawProgress;
  const nearPose = poseAtTrackDistance(index, trackDistance + lookAhead);
  const farPose = poseAtTrackDistance(index, trackDistance + lookAhead * 2.35);

  return [
    car.sensors[0] / SENSOR_RANGE,
    car.sensors[1] / SENSOR_RANGE,
    car.sensors[2] / SENSOR_RANGE,
    car.sensors[3] / SENSOR_RANGE,
    car.sensors[4] / SENSOR_RANGE,
    Math.min(1, car.speed / MAX_SPEED),
    wrapAngle(nearPose.angle - car.angle) / Math.PI,
    wrapAngle(farPose.angle - nearPose.angle) / Math.PI,
  ];
}

/** Advances one alive car by one fixed tick (1/60 s). */
export function stepCar(index: TrackIndex, car: SimCar): void {
  if (!car.alive) {
    return;
  }

  const [steer, throttleSignal] = evaluateNetwork(car.genome.weights, readCarInputs(index, car));
  car.steer = steer;
  car.throttle = throttleSignal;

  car.angle = wrapAngle(car.angle + steer * maxYawRate(car.speed));
  const forwardX = Math.cos(car.angle);
  const forwardY = Math.sin(car.angle);

  const lateralSpeed = -forwardY * car.vx + forwardX * car.vy;
  let vx = car.vx + forwardY * lateralSpeed * LATERAL_GRIP;
  let vy = car.vy - forwardX * lateralSpeed * LATERAL_GRIP;

  const brake = Math.max(0, -throttleSignal);
  const throttle = (throttleSignal + 1) / 2;
  const acceleration = ACCELERATION_BASE + throttle * ACCELERATION_THROTTLE;
  const drag = (1 - AIR_DRAG) * (1 - brake * BRAKE_DRAG);
  vx = (vx + forwardX * acceleration) * drag;
  vy = (vy + forwardY * acceleration) * drag;

  let speed = Math.hypot(vx, vy);
  if (speed > MAX_SPEED) {
    vx *= MAX_SPEED / speed;
    vy *= MAX_SPEED / speed;
    speed = MAX_SPEED;
  }

  car.vx = vx;
  car.vy = vy;
  car.speed = speed;
  car.x += vx;
  car.y += vy;
  car.age += 1;
  car.speedScore += speed * 0.018;

  updateProgress(index, car);

  const clearance = Math.min(...car.sensors);
  const safeClearance = Math.max(CAR_RADIUS * 3.5, index.track.width * 0.16);
  if (clearance < safeClearance) {
    car.wallPenalty += (safeClearance - clearance) * 0.022;
  }

  if (capsuleHitsWall(
    index,
    car.x - forwardX * CAR_HALF_AXIS,
    car.y - forwardY * CAR_HALF_AXIS,
    car.x + forwardX * CAR_HALF_AXIS,
    car.y + forwardY * CAR_HALF_AXIS,
    CAR_RADIUS,
  )) {
    finishCar(car, 'crashed');
  } else if (car.start.kind === 'fullLap' && car.bestProgress >= index.length) {
    car.lapTicks = car.age;
    finishCar(car, 'lap');
  } else if (car.start.kind === 'segment' && car.bestProgress >= car.start.targetDistance) {
    finishCar(car, 'segment');
  } else if (car.age - car.lastImprovementAge > STAGNATION_TICKS || car.bestProgress - car.progress > WRONG_WAY_DISTANCE) {
    finishCar(car, 'stagnant');
  }

  recordCarHistory(car);
}

/** Grip-limited yaw rate: tight turns are only possible after slowing down. */
export function maxYawRate(speed: number): number {
  const gripLimited = LATERAL_ACCEL_LIMIT / Math.max(speed, 0.001);
  return Math.min(MAX_YAW_RATE, gripLimited) * Math.min(1, speed / STEER_FULL_SPEED);
}

/**
 * Lap time (ticks) of an ideal driver that follows the centerline at the grip limit,
 * accelerating and braking with this car model. Used to set a track-aware lap goal.
 */
export function estimateReferenceLapTicks(index: TrackIndex): number {
  const points = index.track.centerline;
  const count = points.length;
  if (count < 5 || index.length <= 0) {
    return 1;
  }

  const heading = (point: number) => {
    const a = points[((point % count) + count) % count];
    const b = points[(((point + 1) % count) + count) % count];
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  const limit = new Float64Array(count);
  for (let point = 0; point < count; point += 1) {
    const turn = Math.abs(wrapAngle(heading(point + 1) - heading(point - 2)));
    const span = index.segmentLength[((point - 2) % count + count) % count]
      + index.segmentLength[((point - 1) % count + count) % count]
      + index.segmentLength[point];
    const curvature = turn / Math.max(1, span);
    limit[point] = Math.min(MAX_SPEED, curvature > 1e-6 ? Math.sqrt(LATERAL_ACCEL_LIMIT / curvature) : MAX_SPEED);
  }

  const speed = Float64Array.from(limit);
  const fullThrottle = ACCELERATION_BASE + ACCELERATION_THROTTLE;
  for (let pass = 0; pass < 2; pass += 1) {
    for (let step = 0; step < count; step += 1) {
      const point = step % count;
      const next = (point + 1) % count;
      const accel = Math.max(0.05, fullThrottle * (1 - AIR_DRAG) - AIR_DRAG * speed[point]);
      speed[next] = Math.min(speed[next], Math.sqrt(speed[point] ** 2 + 2 * accel * index.segmentLength[point]));
    }
    for (let step = count - 1; step >= 0; step -= 1) {
      const point = step;
      const next = (point + 1) % count;
      const decel = speed[next] * (1 - (1 - AIR_DRAG) * (1 - BRAKE_DRAG)) + 0.05;
      speed[point] = Math.min(speed[point], Math.sqrt(speed[next] ** 2 + 2 * decel * index.segmentLength[point]));
    }
  }

  let ticks = 0;
  for (let point = 0; point < count; point += 1) {
    const next = (point + 1) % count;
    ticks += index.segmentLength[point] / Math.max(0.5, (speed[point] + speed[next]) / 2);
  }
  return Math.round(ticks);
}

export function finishCar(car: SimCar, outcome: Exclude<CarOutcome, 'running'>): void {
  if (!car.alive) {
    return;
  }
  car.alive = false;
  car.outcome = outcome;
  car.vx = 0;
  car.vy = 0;
  car.speed = 0;
  recordCarHistory(car, true);
}

/** Fitness used for ranking inside one start type (full lap or sector practice). */
export function scoreCar(index: TrackIndex, car: SimCar): number {
  const crashed = car.outcome === 'crashed';
  const stagnant = car.outcome === 'stagnant';
  if (car.start.kind === 'segment') {
    return calculateSmartSegmentFitness({
      progress: Math.max(0, car.bestProgress),
      targetDistance: car.start.targetDistance,
      speedScore: car.speedScore,
      age: car.age,
      crashed,
      stagnant,
      reversePenalty: car.reverseDistance * 0.65,
      wallPenalty: car.wallPenalty,
      completed: car.outcome === 'segment',
    });
  }

  const checkpointCount = index.track.checkpoints.length;
  return calculateFitness({
    checkpoints: Math.floor((Math.max(0, car.bestProgress) / Math.max(1, index.length)) * checkpointCount),
    progressScore: Math.max(0, car.bestProgress),
    speedScore: car.speedScore,
    age: car.age,
    crashed,
    stagnant,
    reversePenalty: car.reverseDistance * 0.65,
    wallPenalty: car.wallPenalty,
    completedLap: car.outcome === 'lap',
    bestLapTicks: car.lapTicks,
  });
}

/** Lap progress in [0, 1] for full-lap starts; segment progress for sector starts. */
export function carProgressRatio(index: TrackIndex, car: SimCar): number {
  const target = car.start.kind === 'fullLap' ? index.length : car.start.targetDistance;
  return Math.max(0, Math.min(1, car.bestProgress / Math.max(1, target)));
}

function updateProgress(index: TrackIndex, car: SimCar): void {
  const projection = projectOnTrack(index, car.x, car.y, car.segmentHint);
  car.segmentHint = projection.segmentIndex;
  let delta = projection.progressDistance - car.rawProgress;
  if (delta < -index.length / 2) {
    delta += index.length;
  } else if (delta > index.length / 2) {
    delta -= index.length;
  }
  car.rawProgress = projection.progressDistance;
  car.progress += delta;
  if (delta < 0) {
    car.reverseDistance -= delta;
  }
  if (car.progress > car.bestProgress) {
    car.bestProgress = car.progress;
  }
  if (car.bestProgress >= car.progressMark + STAGNATION_PROGRESS) {
    car.progressMark = car.bestProgress;
    car.lastImprovementAge = car.age;
  }
}

function recordCarHistory(car: SimCar, force = false): void {
  if (force || car.age % TRAIL_INTERVAL === 0) {
    car.trail.push({ x: car.x, y: car.y });
    if (car.trail.length > MAX_TRAIL_POINTS) {
      car.trail.shift();
    }
  }
  if (force || car.age % REPLAY_INTERVAL === 0) {
    car.replay.push({ x: car.x, y: car.y, angle: car.angle, tick: car.age, score: car.fitness });
    if (car.replay.length > MAX_REPLAY_FRAMES) {
      car.replay.shift();
    }
  }
}
