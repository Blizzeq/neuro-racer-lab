/**
 * Headless training benchmark. Runs the exact browser training loop (TrainingSession) in Node
 * on several tracks and seeds, and reports how fast drivers learn a full lap.
 *
 * Usage: npm run train:headless -- --generations=40 --seeds=3 --tracks=preset,oval --mode=smartCoach
 */
import { performance } from 'node:perf_hooks';
import { DEFAULT_TRAINING_CONFIG, type TrainingMode } from '../src/types';
import { createPresetTrack, generateTrack } from '../src/lib/geometry';
import { TrainingSession } from '../src/lib/trainingSession';
import { BENCHMARK_TRACKS } from '../src/lib/benchmarkTracks';

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, value] = arg.slice(2).split('=');
      return [key, value ?? 'true'];
    }),
);

const generations = Number(args.generations ?? 40);
const seeds = Number(args.seeds ?? 3);
const mode = (args.mode ?? 'smartCoach') as TrainingMode;
const trackNames = String(args.tracks ?? Object.keys(BENCHMARK_TRACKS).join(',')).split(',');
const population = Number(args.population ?? DEFAULT_TRAINING_CONFIG.populationSize);
const verbose = args.verbose === 'true';

type RunResult = {
  track: string;
  seed: number;
  firstLapGeneration: number | null;
  bestLapTicks: number | null;
  goalTicks: number;
  completedAt: number | null;
  ticks: number;
  seconds: number;
};

const results: RunResult[] = [];

for (const trackName of trackNames) {
  const points = BENCHMARK_TRACKS[trackName];
  const track = trackName === 'preset' ? createPresetTrack() : points ? generateTrack(points, undefined, trackName) : null;
  if (!track) {
    throw new Error(`Unknown track "${trackName}". Known: ${Object.keys(BENCHMARK_TRACKS).join(', ')}`);
  }

  for (let seed = 1; seed <= seeds; seed += 1) {
    const session = new TrainingSession(track, { ...DEFAULT_TRAINING_CONFIG, trainingMode: mode, populationSize: population }, mulberry32(seed * 7919));
    const started = performance.now();
    let ticks = 0;
    let firstLapGeneration: number | null = null;
    let completedAt: number | null = null;

    while (session.generation < generations && completedAt === null) {
      const event = session.step();
      ticks += 1;
      if (event === 'generation' || event === 'complete') {
        const stats = session.getStats('running');
        if (firstLapGeneration === null && stats.bestLapTicks !== null) {
          firstLapGeneration = stats.generation - 1;
        }
        if (verbose) {
          console.log(`${trackName} s${seed} gen ${String(stats.generation).padStart(3)} ${stats.trainingPhase.padEnd(18)} lap ${fmt(stats.bestLapTicks)} goal ${fmt(stats.goalTargetLapTicks)} cover ${Math.round(stats.segmentCoverage * 100)}%`);
        }
        if (event === 'complete') {
          completedAt = stats.generation;
        }
      }
    }

    const stats = session.getStats('running');
    results.push({
      track: trackName,
      seed,
      firstLapGeneration,
      bestLapTicks: stats.bestLapTicks,
      goalTicks: stats.goalTargetLapTicks,
      completedAt,
      ticks,
      seconds: (performance.now() - started) / 1000,
    });
  }
}

console.log(`\nmode=${mode} population=${population} generations<=${generations}`);
console.log('track        seed  first-lap  best-lap  goal     pace   complete  ticks/s');
for (const result of results) {
  console.log([
    result.track.padEnd(12),
    String(result.seed).padStart(4),
    String(result.firstLapGeneration ?? '--').padStart(10),
    fmt(result.bestLapTicks).padStart(9),
    fmt(result.goalTicks).padStart(7),
    (result.bestLapTicks ? `${Math.round((result.goalTicks / result.bestLapTicks) * 100)}%` : '--').padStart(6),
    String(result.completedAt ?? '--').padStart(9),
    String(Math.round(result.ticks / result.seconds)).padStart(8),
  ].join(' '));
}

const learned = results.filter((result) => result.bestLapTicks !== null);
console.log(`\nlearned a full lap: ${learned.length}/${results.length}`);
if (learned.length > 0) {
  const meanFirst = learned.reduce((sum, result) => sum + (result.firstLapGeneration ?? 0), 0) / learned.length;
  const meanPace = learned.reduce((sum, result) => sum + result.goalTicks / (result.bestLapTicks ?? 1), 0) / learned.length;
  console.log(`mean first-lap generation: ${meanFirst.toFixed(1)}  mean pace vs goal: ${Math.round(meanPace * 100)}%`);
}

function fmt(ticks: number | null): string {
  return ticks ? `${(ticks / 60).toFixed(2)}s` : '--';
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
