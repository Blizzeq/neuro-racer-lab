import type { Point } from '../types';

/** Raw routes (before smoothing) used by the headless trainer and simulation tests. */
export const BENCHMARK_TRACKS: Record<string, Point[] | null> = {
  preset: null,
  oval: Array.from({ length: 24 }, (_value, index) => {
    const angle = (Math.PI * 2 * index) / 24;
    return { x: Math.cos(angle) * 700, y: Math.sin(angle) * 420 };
  }),
  kidney: [
    { x: 0, y: 0 },
    { x: 350, y: -330 },
    { x: 915, y: -280 },
    { x: 1260, y: 90 },
    { x: 1000, y: 370 },
    { x: 350, y: 280 },
  ],
  technical: [
    { x: 0, y: 0 },
    { x: 900, y: 0 },
    { x: 1300, y: 150 },
    { x: 1400, y: 500 },
    { x: 1150, y: 700 },
    { x: 800, y: 560 },
    { x: 520, y: 720 },
    { x: 600, y: 1000 },
    { x: 1200, y: 1100 },
    { x: 1300, y: 1400 },
    { x: 700, y: 1520 },
    { x: 0, y: 1300 },
    { x: -220, y: 700 },
  ],
};
