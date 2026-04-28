import { describe, expect, it } from 'vitest';
import { calculateLapGoalTicks, finalExamComplete, goalProgress, shouldStartFinalExam } from './trainingGoal';

describe('training goal', () => {
  it('creates a finite lap target from track length', () => {
    expect(calculateLapGoalTicks(4200, 1500)).toBeGreaterThan(360);
    expect(calculateLapGoalTicks(4200, 1500)).toBeLessThanOrEqual(1650);
  });

  it('tracks progress toward the target lap time', () => {
    expect(goalProgress(null, 900)).toBe(0);
    expect(goalProgress(1800, 900)).toBeCloseTo(0.5);
    expect(goalProgress(800, 900)).toBe(1);
  });

  it('starts the final exam after target or plateau', () => {
    expect(shouldStartFinalExam({
      bestLapTicks: 820,
      targetLapTicks: 900,
      generation: 8,
      lastImprovedGeneration: 8,
      patienceGenerations: 12,
      finalExamActive: false,
      trainingComplete: false,
    })).toBe(true);

    expect(shouldStartFinalExam({
      bestLapTicks: 980,
      targetLapTicks: 900,
      generation: 30,
      lastImprovedGeneration: 10,
      patienceGenerations: 12,
      finalExamActive: false,
      trainingComplete: false,
    })).toBe(true);
  });

  it('finishes after the configured final rounds', () => {
    expect(finalExamComplete(2, 3)).toBe(false);
    expect(finalExamComplete(3, 3)).toBe(true);
  });
});
