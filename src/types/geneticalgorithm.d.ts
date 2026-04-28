declare module 'geneticalgorithm' {
  type GeneticAlgorithmOptions<T> = {
    mutationFunction?: (phenotype: T) => T;
    crossoverFunction?: (a: T, b: T) => [T, T];
    fitnessFunction?: (phenotype: T) => number;
    doesABeatBFunction?: (a: T, b: T) => boolean;
    population: T[];
    populationSize?: number;
  };

  type GeneticAlgorithmInstance<T> = {
    evolve: (options?: Partial<GeneticAlgorithmOptions<T>>) => GeneticAlgorithmInstance<T>;
    best: () => T;
    bestScore: () => number;
    population: () => T[];
    scoredPopulation: () => Array<{ phenotype: T; score: number }>;
    config: () => GeneticAlgorithmOptions<T>;
    clone: (options?: Partial<GeneticAlgorithmOptions<T>>) => GeneticAlgorithmInstance<T>;
  };

  export default function createGeneticAlgorithm<T>(options: GeneticAlgorithmOptions<T>): GeneticAlgorithmInstance<T>;
}
