import type { Genome, TrainingConfig } from '../types';
import { cloneGenome, createRandomGenome, crossoverGenome, mutateGenome } from './neural';

export type EvolutionResult = {
  population: Genome[];
  eliteCount: number;
  teacherChildren: number;
  randomImmigrants: number;
};

export function createInitialPopulation(size: number, generation = 0, random = Math.random): Genome[] {
  return Array.from({ length: size }, () => createRandomGenome(generation, random));
}

export function bestGenome(population: Genome[]): Genome | null {
  if (population.length === 0) {
    return null;
  }

  return population.reduce((best, candidate) => (compareGenomes(candidate, best) > 0 ? candidate : best));
}

export function compareGenomes(a: Genome, b: Genome): number {
  const aLapTicks = finiteLapTicks(a);
  const bLapTicks = finiteLapTicks(b);

  if (aLapTicks !== null || bLapTicks !== null) {
    if (aLapTicks !== null && bLapTicks !== null) {
      return bLapTicks - aLapTicks;
    }
    return aLapTicks !== null ? 1 : -1;
  }

  return a.score - b.score;
}

export function evolvePopulation(
  population: Genome[],
  config: TrainingConfig,
  generation: number,
  teacherGenome: Genome | null = null,
  random = Math.random,
): EvolutionResult {
  const normalizedPopulation = normalizePopulation(population, config.populationSize, generation, random);
  const ranked = rankGenomes(normalizedPopulation);
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
        ...mutateGenome(teacher, config.mutationRate, mutationAmount, random),
        id: `g${generation + 1}-teacher-${index}`,
        generation: generation + 1,
        score: 0,
      });
    }
  }

  for (let index = 0; index < crossoverChildren && next.length < config.populationSize; index += 1) {
    const parentA = tournamentParent(parentPool, random);
    const parentB = tournamentParent(parentPool, random);
    const [child] = random() <= config.crossoverRate
      ? crossoverGenome(parentA, parentB, random)
      : [cloneGenome(parentA), cloneGenome(parentB)];
    next.push({
      ...mutateGenome(child, config.mutationRate * 0.72, 0.28, random),
      id: `g${generation + 1}-cross-${index}`,
      generation: generation + 1,
      score: 0,
    });
  }

  while (next.length < config.populationSize - randomImmigrants) {
    const parent = tournamentParent(parentPool, random);
    next.push({
      ...mutateGenome(parent, config.mutationRate * 1.4, 0.55, random),
      id: `g${generation + 1}-fill-${next.length}`,
      generation: generation + 1,
      score: 0,
    });
  }

  while (next.length < config.populationSize) {
    next.push(createRandomGenome(generation + 1, random));
  }

  return {
    population: next.slice(0, config.populationSize),
    eliteCount,
    teacherChildren: Math.min(teacherChildren, config.populationSize - eliteCount),
    randomImmigrants,
  };
}

function normalizePopulation(population: Genome[], size: number, generation: number, random: () => number): Genome[] {
  const result = population.slice(0, size).map(cloneGenome);

  while (result.length < size) {
    result.push(createRandomGenome(generation, random));
  }

  return result;
}

function resetForNextGeneration(genome: Genome, generation: number, suffix: string): Genome {
  return {
    ...cloneGenome(genome),
    id: `g${generation}-${suffix}`,
    generation,
    score: 0,
    completedLap: false,
    bestLapTicks: null,
  };
}

function tournamentParent(population: Genome[], random: () => number): Genome {
  const first = population[Math.floor(random() * population.length)];
  const second = population[Math.floor(random() * population.length)];
  const third = population[Math.floor(random() * population.length)];
  return rankGenomes([first, second, third])[0];
}

function rankGenomes(population: Genome[]): Genome[] {
  return [...population].sort((a, b) => compareGenomes(b, a));
}

function finiteLapTicks(genome: Genome): number | null {
  const lapTicks = genome.bestLapTicks;
  return typeof lapTicks === 'number' && Number.isFinite(lapTicks) && lapTicks > 0 ? lapTicks : null;
}
