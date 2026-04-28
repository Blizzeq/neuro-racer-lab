# Neuro Racer Lab

Interactive browser demo where tiny neural drivers learn to race custom tracks through genetic evolution.

## What It Does

- Draw a closed route directly on the simulator canvas.
- The app generates road edges, Matter Physics walls, checkpoints, and a spawn pose.
- A population of cars drives in parallel with ray sensors and a small neural controller.
- The `geneticalgorithm` package evolves the neural weights between generations.
- Zoom, pan, fit-to-track, and follow-best camera controls support longer custom routes.
- Training stats, fastest lap timing, save/load, JSON export/import, speed, population, mutation, and training mode controls are available in the UI.
- Ghost replay and line heat make the strongest driving line visible between generations.

## How The Learning Works

Each car owns a JSON-compatible genome: a flat array of weights for a fixed neural network.

- Inputs: 5 wall distance sensors, speed, heading error to the next checkpoint, centerline distance.
- Network: 8 inputs, 7 hidden neurons, 2 outputs.
- Outputs: steering and throttle strength.
- Fitness: continuous centerline progress, checkpoint progress, speed, survival time, fastest completed lap bonus, with penalties for crashes, reversing, wall scraping, and stagnation.
- Selection: once any car completes a lap, the best run is the shortest lap time. Progress-based fitness is only the fallback until the first finish.
- Evolution: top elites are retained, the best historical driver seeds teacher mutations, crossover samples from the strongest parents, and random immigrants keep exploration alive.
- Modes: Explore, Balanced, and Exploit adjust mutation, elitism, teacher cloning, and random immigrants.

This is a neuroevolution project, not a formal reinforcement learning benchmark. The goal is a clear ML mechanism with an impressive interactive result.

## Local Development

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal.

## Validation

```bash
npm test
npm run build
```

The production build outputs a static site in `dist/`, ready for Vercel.

## Stack

- Vite 8
- React 19
- TypeScript
- Phaser 3.90 with Matter Physics
- geneticalgorithm
- Vitest
