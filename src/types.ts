export type Point = {
  x: number;
  y: number;
};

export type Pose = Point & {
  angle: number;
};

export type Checkpoint = {
  index: number;
  a: Point;
  b: Point;
  center: Point;
  progress: number;
};

export type TrackDefinition = {
  id: string;
  name: string;
  width: number;
  centerline: Point[];
  leftBoundary: Point[];
  rightBoundary: Point[];
  checkpoints: Checkpoint[];
  spawnPose: Pose;
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
};

export type Genome = {
  id: string;
  weights: number[];
  score: number;
  generation: number;
};

export type TrainingConfig = {
  populationSize: number;
  mutationRate: number;
  crossoverRate: number;
  maxSteps: number;
  speedMultiplier: number;
};

export type TrainingStats = {
  generation: number;
  bestScore: number;
  bestEver: number;
  averageScore: number;
  aliveCount: number;
  populationSize: number;
  checkpointProgress: number;
  maxCheckpoint: number;
  history: number[];
  status: 'ready' | 'drawing' | 'running' | 'paused' | 'evolving';
};

export type SaveSnapshot = {
  version: 1;
  savedAt: string;
  track: TrackDefinition;
  bestGenome: Genome | null;
  generation: number;
};

export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  populationSize: 64,
  mutationRate: 0.18,
  crossoverRate: 0.72,
  maxSteps: 1100,
  speedMultiplier: 3,
};
