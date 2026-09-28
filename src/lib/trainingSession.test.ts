import { describe, expect, it } from 'vitest';
import { DEFAULT_TRAINING_CONFIG } from '../types';
import { BENCHMARK_TRACKS } from './benchmarkTracks';
import { generateTrack } from './geometry';
import { TrainingSession } from './trainingSession';

const ovalTrack = generateTrack(BENCHMARK_TRACKS.oval ?? [], undefined, 'Oval');

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

function runGenerations(session: TrainingSession, generations: number): void {
  const target = session.generation + generations;
  for (let guard = 0; guard < 200_000 && session.generation < target && !session.trainingComplete; guard += 1) {
    session.step();
  }
}

describe('training session', () => {
  it('is deterministic for a seeded random source', () => {
    const config = { ...DEFAULT_TRAINING_CONFIG, populationSize: 24 };
    const a = new TrainingSession(ovalTrack, config, seeded(7));
    const b = new TrainingSession(ovalTrack, config, seeded(7));
    runGenerations(a, 3);
    runGenerations(b, 3);

    expect(a.getStats('running')).toEqual(b.getStats('running'));
  });

  it('learns a full lap on a simple oval within a few generations', () => {
    const session = new TrainingSession(ovalTrack, DEFAULT_TRAINING_CONFIG, seeded(3));
    runGenerations(session, 6);
    const stats = session.getStats('running');

    expect(stats.bestLapTicks).not.toBeNull();
    expect(stats.hasChampion).toBe(true);
    expect(session.champion?.completedLap).toBe(true);
  });

  it('fully resets generation, champion, and overlays', () => {
    const session = new TrainingSession(ovalTrack, { ...DEFAULT_TRAINING_CONFIG, populationSize: 24 }, seeded(5));
    runGenerations(session, 2);
    session.resetTraining();
    const stats = session.getStats('paused');

    expect(stats.generation).toBe(0);
    expect(stats.bestLapTicks).toBeNull();
    expect(stats.hasChampion).toBe(false);
    expect(stats.history).toHaveLength(0);
    expect(session.ghostReplay).toHaveLength(0);
    expect(session.heatPoints).toHaveLength(0);
    expect(stats.aliveCount).toBe(24);
  });

  it('restores a saved champion as the seed of the next population', () => {
    const session = new TrainingSession(ovalTrack, DEFAULT_TRAINING_CONFIG, seeded(3));
    runGenerations(session, 6);
    const champion = session.champion;
    expect(champion).not.toBeNull();

    const restored = new TrainingSession(ovalTrack, DEFAULT_TRAINING_CONFIG, seeded(99));
    restored.restoreChampion(champion, 12);
    const stats = restored.getStats('paused');

    expect(stats.generation).toBe(12);
    expect(stats.bestLapTicks).toBe(champion?.bestLapTicks);
    expect(restored.cars[0].genome.weights).toEqual(champion?.weights);
  });

  it('runs a champion showcase lap and returns to the completed state', () => {
    const session = new TrainingSession(ovalTrack, DEFAULT_TRAINING_CONFIG, seeded(3));
    runGenerations(session, 40);
    expect(session.trainingComplete).toBe(true);
    expect(session.startChampionRun()).toBe(true);
    const showcaseCar = session.cars[0];
    expect(session.cars).toHaveLength(1);

    let event = session.step();
    for (let guard = 0; guard < 5000 && event === 'tick'; guard += 1) {
      event = session.step();
    }

    expect(event).toBe('showcaseComplete');
    expect(showcaseCar.outcome).toBe('lap');
    expect(session.getStats('paused').status).toBe('complete');
  });

  it('returns to training after a champion run started mid-training', () => {
    const session = new TrainingSession(ovalTrack, DEFAULT_TRAINING_CONFIG, seeded(3));
    runGenerations(session, 6);
    expect(session.trainingComplete).toBe(false);
    expect(session.startChampionRun()).toBe(true);

    let event = session.step();
    for (let guard = 0; guard < 5000 && event === 'tick'; guard += 1) {
      event = session.step();
    }

    expect(event).toBe('showcaseComplete');
    expect(session.lastShowcase?.outcome).toBe('lap');
    expect(session.trainingComplete).toBe(false);
    expect(session.cars).toHaveLength(DEFAULT_TRAINING_CONFIG.populationSize);
  });

  it('reports a timed-out champion run and applies a population change made during it', () => {
    const session = new TrainingSession(ovalTrack, { ...DEFAULT_TRAINING_CONFIG, populationSize: 24 }, seeded(3));
    runGenerations(session, 8);
    expect(session.startChampionRun()).toBe(true);
    session.applyConfig({ populationSize: 40, maxSteps: 300, targetLapTicks: 100 });

    let event = session.step();
    for (let guard = 0; guard < 5000 && event === 'tick'; guard += 1) {
      event = session.step();
    }

    expect(event).toBe('showcaseComplete');
    expect(session.lastShowcase?.outcome).not.toBe('running');
    if (!session.trainingComplete) {
      expect(session.cars).toHaveLength(40);
    }
  });

  it('respawns the population when its size changes', () => {
    const session = new TrainingSession(ovalTrack, { ...DEFAULT_TRAINING_CONFIG, populationSize: 24 }, seeded(5));
    expect(session.applyConfig({ populationSize: 40 })).toBe(true);
    expect(session.cars).toHaveLength(40);
    expect(session.applyConfig({ speedMultiplier: 4 })).toBe(false);
  });
});
