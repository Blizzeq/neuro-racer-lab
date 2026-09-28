/** Slack over the centerline reference lap: a good driver must be close to the ideal line. */
export const GOAL_REFERENCE_SLACK = 1.08;

/** Lap goal in ticks from the physics-based reference lap of the current track. */
export function calculateLapGoalTicks(referenceLapTicks: number): number {
  return Math.max(60, Math.round(referenceLapTicks * GOAL_REFERENCE_SLACK));
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
