import { describe, expect, it } from 'vitest';
import {
  calculateLapGoalTicks,
  finalExamComplete,
  goalProgress,
  nextFinalExamRoundsCompleted,
  shouldStartFinalExam,
} from './trainingGoal';

describe('training goal', () => {
  it('derives the lap target from the reference lap with a small slack', () => {
    expect(calculateLapGoalTicks(500)).toBeGreaterThan(500);
    expect(calculateLapGoalTicks(500)).toBeLessThan(600);
    expect(calculateLapGoalTicks(3000)).toBeGreaterThan(calculateLapGoalTicks(500));
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

  it('counts only completed final exam laps as confirmed rounds', () => {
    expect(nextFinalExamRoundsCompleted(1, false)).toBe(1);
    expect(nextFinalExamRoundsCompleted(1, true)).toBe(2);
  });
});
