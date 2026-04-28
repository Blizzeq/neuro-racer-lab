# Neuro Racer Lab

Interactive browser demo where tiny neural drivers learn to race custom tracks through genetic evolution.

## What It Does

- Draw a closed route directly on the simulator canvas.
- The app generates road edges, Matter Physics walls, checkpoints, and a spawn pose.
- A population of cars drives in parallel with ray sensors and a small neural controller.
- The `geneticalgorithm` package evolves the neural weights between generations.
- Training stats, best score history, save/load, speed, population, and mutation controls are available in the UI.

## How The Learning Works

Each car owns a JSON-compatible genome: a flat array of weights for a fixed neural network.

- Inputs: 5 wall distance sensors, speed, heading error to the next checkpoint, centerline distance.
- Network: 8 inputs, 7 hidden neurons, 2 outputs.
- Outputs: steering and throttle strength.
- Fitness: checkpoint progress, speed, survival time, with penalties for crashes and stagnation.
- Evolution: selection, mutation, crossover, and elite carry-over through `geneticalgorithm@1.0.2`.

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
