import createGeneticAlgorithm from 'geneticalgorithm';
import type { Genome, TrainingConfig } from '../types';
import { cloneGenome, createRandomGenome, crossoverGenome, mutateGenome } from './neural';

type GeneticAlgorithmInstance = {
  evolve: () => GeneticAlgorithmInstance;
  population: () => Genome[];
};

export type EvolutionResult = {
  population: Genome[];
  eliteCount: number;
  teacherChildren: number;
  randomImmigrants: number;
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

export function evolvePopulation(
  population: Genome[],
  config: TrainingConfig,
  generation: number,
  teacherGenome: Genome | null = null,
): EvolutionResult {
  const normalizedPopulation = normalizePopulation(population, config.populationSize, generation);
  const ranked = [...normalizedPopulation].sort((a, b) => b.score - a.score);
  const eliteCount = Math.max(2, Math.round(config.populationSize * config.elitismRate));
  const teacherChildren = Math.max(2, Math.round(config.populationSize * config.teacherCloneRate));
  const randomImmigrants = Math.max(2, Math.round(config.populationSize * config.randomImmigrantRate));
  const crossoverChildren = Math.max(0, config.populationSize - eliteCount - teacherChildren - randomImmigrants);
  const parentPool = ranked.slice(0, Math.max(4, Math.round(config.populationSize * 0.3)));
  const teacher = teacherGenome ?? ranked[0] ?? null;

  const next: Genome[] = [];

  for (let index = 0; index < eliteCount && next.length < config.populationSize; index += 1) {
    const elite = ranked[index] ?? ranked[0];
    next.push(resetForNextGeneration(elite, generation + 1, `elite-${index}`));
  }

  if (teacher) {
    for (let index = 0; index < teacherChildren && next.length < config.populationSize; index += 1) {
      const mutationAmount = index % 3 === 0 ? 0.12 : index % 3 === 1 ? 0.24 : 0.44;
      next.push({
        ...mutateGenome(teacher, config.mutationRate, mutationAmount),
        id: `g${generation + 1}-teacher-${index}`,
        generation: generation + 1,
        score: 0,
      });
    }
  }

  for (let index = 0; index < crossoverChildren && next.length < config.populationSize; index += 1) {
    const parentA = tournamentParent(parentPool);
    const parentB = tournamentParent(parentPool);
    const [child] = Math.random() <= config.crossoverRate
      ? crossoverGenome(parentA, parentB)
      : [cloneGenome(parentA), cloneGenome(parentB)];
    next.push({
      ...mutateGenome(child, config.mutationRate * 0.72, 0.28),
      id: `g${generation + 1}-cross-${index}`,
      generation: generation + 1,
      score: 0,
    });
  }

  while (next.length < config.populationSize - randomImmigrants) {
    const parent = tournamentParent(parentPool);
    next.push({
      ...mutateGenome(parent, config.mutationRate * 1.4, 0.55),
      id: `g${generation + 1}-fill-${next.length}`,
      generation: generation + 1,
      score: 0,
    });
  }

  while (next.length < config.populationSize) {
    next.push(createRandomGenome(generation + 1));
  }

  return {
    population: next.slice(0, config.populationSize),
    eliteCount,
    teacherChildren: Math.min(teacherChildren, config.populationSize - eliteCount),
    randomImmigrants,
  };
}

export function evolvePopulationWithPackage(population: Genome[], config: TrainingConfig, generation: number): EvolutionResult {
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

  return {
    population: next,
    eliteCount: 1,
    teacherChildren: 0,
    randomImmigrants: 0,
  };
}

function normalizePopulation(population: Genome[], size: number, generation: number): Genome[] {
  const result = population.slice(0, size).map(cloneGenome);

  while (result.length < size) {
    result.push(createRandomGenome(generation));
  }

  return result;
}

function resetForNextGeneration(genome: Genome, generation: number, suffix: string): Genome {
  return {
    ...cloneGenome(genome),
    id: `g${generation}-${suffix}`,
    generation,
    score: 0,
  };
}

function tournamentParent(population: Genome[]): Genome {
  const first = population[Math.floor(Math.random() * population.length)];
  const second = population[Math.floor(Math.random() * population.length)];
  const third = population[Math.floor(Math.random() * population.length)];
  return [first, second, third].sort((a, b) => b.score - a.score)[0];
}
