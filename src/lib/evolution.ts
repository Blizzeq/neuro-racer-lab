import createGeneticAlgorithm from 'geneticalgorithm';
import type { Genome, TrainingConfig } from '../types';
import { cloneGenome, createRandomGenome, crossoverGenome, mutateGenome } from './neural';

type GeneticAlgorithmInstance = {
  evolve: () => GeneticAlgorithmInstance;
  population: () => Genome[];
};

export function createInitialPopulation(size: number, generation = 0): Genome[] {
  return Array.from({ length: size }, () => createRandomGenome(generation));
}

export function bestGenome(population: Genome[]): Genome | null {
  if (population.length === 0) {
    return null;
  }

  return population.reduce((best, candidate) => (candidate.score > best.score ? candidate : best));
}

export function evolvePopulation(population: Genome[], config: TrainingConfig, generation: number): Genome[] {
  const normalizedPopulation = normalizePopulation(population, config.populationSize, generation);
  const elite = cloneGenome(bestGenome(normalizedPopulation) ?? normalizedPopulation[0]);

  const ga = createGeneticAlgorithm({
    population: normalizedPopulation.map(cloneGenome),
    populationSize: config.populationSize,
    mutationFunction: (genome: Genome) => mutateGenome(genome, config.mutationRate),
    crossoverFunction: (a: Genome, b: Genome) => {
      if (Math.random() > config.crossoverRate) {
        return [cloneGenome(a), cloneGenome(b)];
      }
      return crossoverGenome(a, b);
    },
    fitnessFunction: (genome: Genome) => (Number.isFinite(genome.score) ? genome.score : 0),
  }) as GeneticAlgorithmInstance;

  ga.evolve();
  const next = ga.population().slice(0, config.populationSize).map((genome, index) => ({
    ...genome,
    id: `g${generation + 1}-${index}-${Math.floor(Math.random() * 1_000_000).toString(36)}`,
    generation: generation + 1,
    score: 0,
    weights: [...genome.weights],
  }));

  next[0] = {
    ...elite,
    id: `g${generation + 1}-elite`,
    generation: generation + 1,
    score: 0,
    weights: [...elite.weights],
  };

  return next;
}

function normalizePopulation(population: Genome[], size: number, generation: number): Genome[] {
  const result = population.slice(0, size).map(cloneGenome);

  while (result.length < size) {
    result.push(createRandomGenome(generation));
  }

  return result;
}
