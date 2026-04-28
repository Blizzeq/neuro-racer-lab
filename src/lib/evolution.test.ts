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

    expect(evolved.population).toHaveLength(12);
    expect(evolved.population.every((genome) => genome.score === 0)).toBe(true);
    expect(evolved.population.every((genome) => genome.generation === 1)).toBe(true);
  });

  it('keeps elites, creates teacher children, and preserves random immigrants', () => {
    const population = createInitialPopulation(30, 0).map((genome, index) => ({
      ...genome,
      score: index * 25,
    }));
    const teacher = population[29];
    const evolved = evolvePopulation(population, {
      ...DEFAULT_TRAINING_CONFIG,
      populationSize: 30,
      elitismRate: 0.14,
      teacherCloneRate: 0.34,
      randomImmigrantRate: 0.18,
    }, 0, teacher);

    expect(evolved.eliteCount).toBeGreaterThanOrEqual(2);
    expect(evolved.teacherChildren).toBeGreaterThanOrEqual(2);
    expect(evolved.randomImmigrants).toBeGreaterThanOrEqual(2);
    expect(evolved.population.some((genome) => genome.id.includes('elite'))).toBe(true);
    expect(evolved.population.some((genome) => genome.id.includes('teacher'))).toBe(true);
  });
});
