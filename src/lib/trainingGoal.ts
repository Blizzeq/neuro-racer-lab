const TARGET_SPEED_PX_PER_TICK = 5.8;

export function calculateLapGoalTicks(trackLength: number, maxSteps: number): number {
  const rawTarget = Math.round(trackLength / TARGET_SPEED_PX_PER_TICK);
  const minimumTarget = Math.min(360, Math.max(180, Math.round(maxSteps * 0.24)));
  return Math.max(minimumTarget, rawTarget);
}

export function goalProgress(bestLapTicks: number | null | undefined, targetLapTicks: number): number {
  if (!bestLapTicks || !Number.isFinite(bestLapTicks) || bestLapTicks <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, targetLapTicks / bestLapTicks));
}

export function shouldStartFinalExam(input: {
  bestLapTicks: number | null | undefined;
  targetLapTicks: number;
  generation: number;
  lastImprovedGeneration: number | null;
  patienceGenerations: number;
  finalExamActive: boolean;
  trainingComplete: boolean;
}): boolean {
  if (
    input.finalExamActive
    || input.trainingComplete
    || !input.bestLapTicks
    || !Number.isFinite(input.bestLapTicks)
    || input.bestLapTicks <= 0
  ) {
    return false;
  }

  if (input.bestLapTicks <= input.targetLapTicks) {
    return true;
  }

  if (input.lastImprovedGeneration === null) {
    return false;
  }

  return input.generation - input.lastImprovedGeneration >= input.patienceGenerations;
}

export function finalExamComplete(roundsCompleted: number, targetRounds: number): boolean {
  return roundsCompleted >= Math.max(1, targetRounds);
}

export function nextFinalExamRoundsCompleted(roundsCompleted: number, completedLap: boolean): number {
  return completedLap ? roundsCompleted + 1 : roundsCompleted;
}
