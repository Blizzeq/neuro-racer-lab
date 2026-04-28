import { describe, expect, it } from 'vitest';
import { DEFAULT_TRAINING_CONFIG } from '../types';
import { createInitialPopulation, evolvePopulation } from './evolution';

describe('population evolution', () => {
  it('keeps population size and resets scores for the next generation', () => {
    const population = createInitialPopulation(12, 0).map((genome, index) => ({
      ...genome,
      score: index * 10,
    }));
    const evolved = evolvePopulation(population, {
      ...DEFAULT_TRAINING_CONFIG,
      populationSize: 12,
    }, 0);

    expect(evolved).toHaveLength(12);
    expect(evolved.every((genome) => genome.score === 0)).toBe(true);
    expect(evolved.every((genome) => genome.generation === 1)).toBe(true);
  });
});
