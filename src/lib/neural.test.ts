import { describe, expect, it } from 'vitest';
import { GENOME_WEIGHT_COUNT, calculateFitness, createRandomGenome, crossoverGenome, evaluateNetwork, mutateGenome } from './neural';

describe('neural genome', () => {
  it('creates the expected fixed topology', () => {
    const genome = createRandomGenome(0, () => 0.5);

    expect(genome.weights).toHaveLength(GENOME_WEIGHT_COUNT);
    expect(genome.weights.every((weight) => Number.isFinite(weight))).toBe(true);
  });

  it('produces finite bounded network outputs', () => {
    const genome = createRandomGenome();
    const outputs = evaluateNetwork(genome.weights, [1, 0.8, 0.4, 0.3, 1, 0.5, -0.2, 0.7]);

    expect(outputs).toHaveLength(2);
    expect(outputs.every((output) => Number.isFinite(output))).toBe(true);
    expect(outputs.every((output) => output >= -1 && output <= 1)).toBe(true);
  });

  it('mutates and crosses over JSON-compatible genomes', () => {
    const a = createRandomGenome(1, () => 0.25);
    const b = createRandomGenome(1, () => 0.75);
    const mutated = mutateGenome(a, 1, 0.2, () => 0.42);
    const [childA, childB] = crossoverGenome(a, b, () => 0.5);

    expect(mutated.weights).toHaveLength(GENOME_WEIGHT_COUNT);
    expect(childA.weights).toHaveLength(GENOME_WEIGHT_COUNT);
    expect(childB.weights).toHaveLength(GENOME_WEIGHT_COUNT);
    expect(JSON.parse(JSON.stringify(childA)).weights).toHaveLength(GENOME_WEIGHT_COUNT);
  });
});

describe('fitness scoring', () => {
  it('rewards continuous forward progress more than survival alone', () => {
    const slow = calculateFitness({ checkpoints: 0, progressScore: 20, speedScore: 5, age: 500, crashed: false, stagnant: false });
    const progressed = calculateFitness({ checkpoints: 1, progressScore: 520, speedScore: 5, age: 200, crashed: false, stagnant: false });

    expect(progressed).toBeGreaterThan(slow);
  });

  it('penalizes crash, stagnation, reversing, and wall scraping', () => {
    const clean = calculateFitness({ checkpoints: 2, progressScore: 300, speedScore: 20, age: 300, crashed: false, stagnant: false });
    const failed = calculateFitness({
      checkpoints: 2,
      progressScore: 300,
      speedScore: 20,
      age: 300,
      crashed: true,
      stagnant: true,
      reversePenalty: 40,
      wallPenalty: 30,
    });

    expect(failed).toBeLessThan(clean);
  });

  it('rewards faster completed laps more than slower completed laps', () => {
    const slowLap = calculateFitness({
      checkpoints: 12,
      progressScore: 1200,
      speedScore: 60,
      age: 900,
      crashed: false,
      stagnant: false,
      completedLap: true,
      bestLapTicks: 900,
    });
    const fastLap = calculateFitness({
      checkpoints: 12,
      progressScore: 1200,
      speedScore: 60,
      age: 620,
      crashed: false,
      stagnant: false,
      completedLap: true,
      bestLapTicks: 620,
    });

    expect(fastLap).toBeGreaterThan(slowLap);
  });
});
