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
  completedLap?: boolean;
  bestLapTicks?: number | null;
};

export type TrainingMode = 'smartCoach' | 'fullLap' | 'manualLab';

export type TrainingPhase =
  | 'learningStart'
  | 'trainingSector'
  | 'hardCornerPractice'
  | 'fullLapValidation'
  | 'recordAttempt';

export type TrackSegment = {
  index: number;
  startIndex: number;
  endIndex: number;
  startDistance: number;
  endDistance: number;
  length: number;
  spawnPose: Pose;
  targetDistance: number;
};

export type TrainingStart = {
  kind: 'fullLap' | 'segment';
  phase: TrainingPhase;
  pose: Pose;
  startDistance: number;
  targetDistance: number;
  segmentIndex: number | null;
  validation: boolean;
};

export type SegmentScore = {
  segmentIndex: number;
  attempts: number;
  completions: number;
  crashes: number;
  bestScore: number;
  bestProgress: number;
};

export type TrainingConfig = {
  populationSize: number;
  mutationRate: number;
  crossoverRate: number;
  maxSteps: number;
  speedMultiplier: number;
  elitismRate: number;
  teacherCloneRate: number;
  randomImmigrantRate: number;
  trainingMode: TrainingMode;
  smartSegmentCount: number;
  smartStartsPerGeneration: number;
  fullLapValidationInterval: number;
  advancedTuningEnabled: boolean;
};

export type TrainingStats = {
  generation: number;
  bestScore: number;
  bestEver: number;
  currentBestLapTicks: number | null;
  bestLapTicks: number | null;
  lapCompletions: number;
  averageScore: number;
  aliveCount: number;
  populationSize: number;
  checkpointProgress: number;
  maxCheckpoint: number;
  crashRate: number;
  bestProgress: number;
  eliteCount: number;
  teacherChildren: number;
  trainingPhase: TrainingPhase;
  activeSegmentIndex: number | null;
  segmentCoverage: number;
  hardestSegmentIndex: number | null;
  recordAttempts: number;
  validationLapTicks: number | null;
  history: number[];
  status: 'ready' | 'drawing' | 'running' | 'paused' | 'evolving';
};

export type CameraState = {
  zoom: number;
  scrollX: number;
  scrollY: number;
  followBest: boolean;
};

export type ReplayFrame = {
  x: number;
  y: number;
  angle: number;
  tick: number;
  score: number;
};

export type LegacySaveSnapshot = {
  version: 1;
  savedAt: string;
  track: TrackDefinition;
  bestGenome: Genome | null;
  generation: number;
};

export type ExportSnapshot = {
  version: 2;
  timestamp: string;
  track: TrackDefinition;
  bestGenome: Genome | null;
  config: TrainingConfig;
  generation: number;
};

export type SaveSnapshot = LegacySaveSnapshot | ExportSnapshot;

export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  populationSize: 64,
  mutationRate: 0.16,
  crossoverRate: 0.72,
  maxSteps: 1500,
  speedMultiplier: 3,
  elitismRate: 0.14,
  teacherCloneRate: 0.34,
  randomImmigrantRate: 0.18,
  trainingMode: 'smartCoach',
  smartSegmentCount: 12,
  smartStartsPerGeneration: 5,
  fullLapValidationInterval: 5,
  advancedTuningEnabled: false,
};
