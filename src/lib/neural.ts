import type { Genome } from '../types';

export const NETWORK_INPUTS = 8;
export const NETWORK_HIDDEN = 7;
export const NETWORK_OUTPUTS = 2;
export const GENOME_WEIGHT_COUNT = (NETWORK_INPUTS + 1) * NETWORK_HIDDEN + (NETWORK_HIDDEN + 1) * NETWORK_OUTPUTS;

export function createRandomGenome(generation = 0, random = Math.random): Genome {
  return {
    id: createGenomeId(generation, random),
    generation,
    score: 0,
    weights: Array.from({ length: GENOME_WEIGHT_COUNT }, () => randomWeight(random)),
  };
}

export function evaluateNetwork(weights: number[], inputs: number[]): [number, number] {
  if (weights.length !== GENOME_WEIGHT_COUNT) {
    throw new Error(`Expected ${GENOME_WEIGHT_COUNT} weights, received ${weights.length}.`);
  }
  if (inputs.length !== NETWORK_INPUTS) {
    throw new Error(`Expected ${NETWORK_INPUTS} inputs, received ${inputs.length}.`);
  }

  let cursor = 0;
  const hidden = Array.from({ length: NETWORK_HIDDEN }, () => {
    let sum = weights[cursor];
    cursor += 1;
    for (let index = 0; index < NETWORK_INPUTS; index += 1) {
      sum += inputs[index] * weights[cursor];
      cursor += 1;
    }
    return Math.tanh(sum);
  });

  const outputs = Array.from({ length: NETWORK_OUTPUTS }, () => {
    let sum = weights[cursor];
    cursor += 1;
    for (let index = 0; index < NETWORK_HIDDEN; index += 1) {
      sum += hidden[index] * weights[cursor];
      cursor += 1;
    }
    return Math.tanh(sum);
  });

  return [outputs[0], outputs[1]];
}

export function mutateGenome(genome: Genome, mutationRate: number, mutationAmount = 0.42, random = Math.random): Genome {
  return {
    ...genome,
    id: createGenomeId(genome.generation + 1, random),
    score: 0,
    generation: genome.generation + 1,
    weights: genome.weights.map((weight) => {
      if (random() > mutationRate) {
        return weight;
      }
      return clampWeight(weight + gaussian(random) * mutationAmount);
    }),
  };
}

export function crossoverGenome(a: Genome, b: Genome, random = Math.random): [Genome, Genome] {
  const pivot = Math.floor(random() * GENOME_WEIGHT_COUNT);
  const childA = [
    ...a.weights.slice(0, pivot),
    ...b.weights.slice(pivot),
  ];
  const childB = [
    ...b.weights.slice(0, pivot),
    ...a.weights.slice(pivot),
  ];

  return [
    { ...a, id: createGenomeId(a.generation + 1, random), score: 0, generation: a.generation + 1, weights: childA },
    { ...b, id: createGenomeId(b.generation + 1, random), score: 0, generation: b.generation + 1, weights: childB },
  ];
}

export function cloneGenome(genome: Genome): Genome {
  return {
    ...genome,
    weights: [...genome.weights],
  };
}

export function calculateFitness(input: {
  checkpoints: number;
  progressScore?: number;
  speedScore: number;
  age: number;
  crashed: boolean;
  stagnant: boolean;
  reversePenalty?: number;
  wallPenalty?: number;
}): number {
  const crashPenalty = input.crashed ? 80 : 0;
  const stagnantPenalty = input.stagnant ? 65 : 0;
  const reversePenalty = input.reversePenalty ?? 0;
  const wallPenalty = input.wallPenalty ?? 0;
  return Math.max(
    0,
    (input.progressScore ?? 0) * 1.15
      + input.checkpoints * 90
      + input.speedScore * 1.35
      + input.age * 0.018
      - crashPenalty
      - stagnantPenalty
      - reversePenalty
      - wallPenalty,
  );
}

function randomWeight(random: () => number): number {
  return random() * 2 - 1;
}

function clampWeight(weight: number): number {
  return Math.max(-3, Math.min(3, weight));
}

function createGenomeId(generation: number, random: () => number): string {
  return `g${generation}-${Math.floor(random() * 1_000_000).toString(36)}`;
}

function gaussian(random: () => number): number {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
