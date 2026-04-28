import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? 'http://127.0.0.1:5173';
const seconds = Number(args.seconds ?? args.duration ?? 45);
const mode = args.mode ?? 'smartCoach';
const speed = Number(args.speed ?? 8);
const chromePath = args.chrome ?? process.env.CHROME_PATH ?? findChrome();

if (!chromePath) {
  throw new Error('Chrome was not found. Set CHROME_PATH or install Chrome.');
}

const browser = await chromium.launch({
  headless: !args.headed,
  executablePath: chromePath,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});

const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const consoleEvents = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    consoleEvents.push(`${message.type()}: ${message.text()}`);
  }
});
page.on('pageerror', (error) => {
  consoleEvents.push(`pageerror: ${error.message}`);
});

try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__NEURO_RACER_DEBUG__?.sceneReady), null, { timeout: 30_000 });
  await page.waitForFunction(() => (window.__NEURO_RACER_DEBUG__?.stats?.aliveCount ?? 0) > 0, null, { timeout: 30_000 });

  await setTrainingMode(page, mode);
  await setSpeed(page, speed);
  if (!args.noStart) {
    await page.getByRole('button', { name: 'Start' }).click();
  }

  console.log(`Observing ${mode} for ${seconds}s at ${url}`);
  console.log('time  gen  phase                 alive   crash  best-lap  goal  attempts');

  const startedAt = Date.now();
  const samples = [];
  let lastLine = '';

  while (Date.now() - startedAt < seconds * 1000) {
    const sample = await readDebugSnapshot(page);
    if (sample) {
      samples.push(sample);
      const line = formatSample(sample, Date.now() - startedAt);
      if (line !== lastLine) {
        console.log(line);
        lastLine = line;
      }
    }
    await page.waitForTimeout(1000);
  }

  const summary = summarize(samples);
  console.log('\nSummary');
  console.log(`generations: ${summary.firstGeneration} -> ${summary.lastGeneration}`);
  console.log(`record attempts: ${summary.recordAttempts}`);
  console.log(`best lap: ${formatTicks(summary.bestLapTicks)}`);
  console.log(`best goal progress: ${Math.round(summary.goalProgress * 100)}%`);
  console.log(`max sector coverage: ${Math.round(summary.segmentCoverage * 100)}%`);
  console.log(`last crash rate: ${Math.round(summary.crashRate * 100)}%`);
  if (consoleEvents.length > 0) {
    console.log('\nConsole warnings/errors');
    for (const event of consoleEvents.slice(-10)) {
      console.log(`- ${event}`);
    }
  }
} finally {
  if (args.keepOpen) {
    console.log('Browser left open because --keep-open was set.');
  } else {
    await browser.close();
  }
}

async function setTrainingMode(page, selectedMode) {
  await page.selectOption('#mode', selectedMode);
}

async function setSpeed(page, selectedSpeed) {
  await page.locator('#speed').evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, selectedSpeed);
}

async function readDebugSnapshot(page) {
  return page.evaluate(() => {
    const debug = window.__NEURO_RACER_DEBUG__;
    if (!debug) return null;
    const stats = debug.stats;
    return {
      mode: debug.config.trainingMode,
      notice: debug.notice,
      status: stats.status,
      generation: stats.generation,
      phase: stats.trainingPhase,
      alive: stats.aliveCount,
      population: stats.populationSize,
      crashRate: stats.crashRate,
      bestLapTicks: stats.bestLapTicks,
      currentBestLapTicks: stats.currentBestLapTicks,
      bestProgress: stats.bestProgress,
      goalProgress: stats.goalProgress,
      recordAttempts: stats.recordAttempts,
      segmentCoverage: stats.segmentCoverage,
      hardestSegmentIndex: stats.hardestSegmentIndex,
      trainingComplete: stats.trainingComplete,
    };
  });
}

function parseArgs(raw) {
  const result = {};
  const positional = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const [key, inlineValue] = item.slice(2).split('=');
    if (inlineValue !== undefined) {
      result[toCamel(key)] = inlineValue;
    } else if (raw[index + 1] && !raw[index + 1].startsWith('--')) {
      result[toCamel(key)] = raw[index + 1];
      index += 1;
    } else {
      result[toCamel(key)] = true;
    }
  }
  if (positional[0] && !result.seconds && !result.duration) result.seconds = positional[0];
  if (positional[1] && !result.mode) result.mode = positional[1];
  if (positional[2] && !result.speed) result.speed = positional[2];
  return result;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function formatSample(sample, elapsedMs) {
  const elapsed = `${Math.round(elapsedMs / 1000).toString().padStart(4, ' ')}s`;
  const gen = String(sample.generation).padStart(4, ' ');
  const phase = formatPhase(sample.phase).padEnd(21, ' ');
  const alive = `${sample.alive}/${sample.population}`.padEnd(7, ' ');
  const crash = `${Math.round(sample.crashRate * 100)}%`.padStart(5, ' ');
  const lap = formatTicks(sample.bestLapTicks).padStart(8, ' ');
  const goal = `${Math.round(sample.goalProgress * 100)}%`.padStart(4, ' ');
  const attempts = String(sample.recordAttempts).padStart(8, ' ');
  return `${elapsed} ${gen}  ${phase} ${alive} ${crash} ${lap} ${goal} ${attempts}`;
}

function summarize(samples) {
  const first = samples[0];
  const last = samples.at(-1);
  return {
    firstGeneration: first?.generation ?? 0,
    lastGeneration: last?.generation ?? 0,
    recordAttempts: Math.max(0, ...samples.map((sample) => sample.recordAttempts ?? 0)),
    bestLapTicks: minDefined(samples.map((sample) => sample.bestLapTicks)),
    goalProgress: Math.max(0, ...samples.map((sample) => sample.goalProgress ?? 0)),
    segmentCoverage: Math.max(0, ...samples.map((sample) => sample.segmentCoverage ?? 0)),
    crashRate: last?.crashRate ?? 0,
  };
}

function minDefined(values) {
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return finite.length ? Math.min(...finite) : null;
}

function formatPhase(phase) {
  return String(phase ?? 'unknown')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatTicks(ticks) {
  return typeof ticks === 'number' && Number.isFinite(ticks) && ticks > 0
    ? `${(ticks / 60).toFixed(2)}s`
    : '--';
}
