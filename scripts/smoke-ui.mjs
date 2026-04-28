import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? 'http://127.0.0.1:5173';
const chromePath = args.chrome ?? process.env.CHROME_PATH ?? findChrome();
const tempDir = join(tmpdir(), `neuro-racer-smoke-${Date.now()}`);

if (!chromePath) {
  throw new Error('Chrome was not found. Set CHROME_PATH or install Chrome.');
}

await mkdir(tempDir, { recursive: true });

const browser = await chromium.launch({
  headless: !args.headed,
  executablePath: chromePath,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({
  acceptDownloads: true,
  viewport: { width: 1440, height: 980 },
});
const page = await context.newPage();
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
  await waitForScene(page);

  assert.equal(await page.locator('h1').textContent(), 'Neuro Racer Lab');
  assert.equal(await page.getByRole('button', { name: 'Start' }).isEnabled(), true);
  assert.equal((await page.locator('body').innerText()).includes('Full laps + hard sectors'), true);

  await page.getByTitle('Zoom out').click();
  await page.getByTitle('Fit track').click();
  assert.match(await page.locator('.camera-toolbar span').textContent(), /^\d+%$/);

  await drawCustomTrack(page);
  await page.waitForFunction(() => document.body.innerText.includes('Custom Loop'), null, { timeout: 10_000 });
  const afterDraw = await debugState(page);
  assert.equal(afterDraw.stats.aliveCount, 64);
  assert.equal(afterDraw.stats.status, 'paused');

  await page.getByRole('button', { name: 'Save' }).click();
  await page.reload({ waitUntil: 'networkidle' });
  await waitForScene(page);
  await page.getByRole('button', { name: 'Load' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('Custom Loop'), null, { timeout: 10_000 });

  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export' }).click(),
  ]).then(([file]) => file);
  const exportPath = join(tempDir, 'snapshot.json');
  await download.saveAs(exportPath);
  const snapshot = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.track.name, 'Custom Loop');

  await page.getByRole('button', { name: 'Preset' }).click();
  await page.locator('.file-input').setInputFiles(exportPath);
  await page.waitForFunction(() => document.body.innerText.includes('Custom Loop'), null, { timeout: 10_000 });

  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__NEURO_RACER_DEBUG__?.stats.status === 'running', null, { timeout: 10_000 });
  const afterStart = await debugState(page);
  assert.equal(afterStart.running, true);
  assert.equal(afterStart.stats.populationSize, 64);

  const severeLogs = consoleEvents.filter((event) => !event.includes('GL_CONTEXT_LOST_KHR'));
  assert.deepEqual(severeLogs, []);

  console.log(JSON.stringify({
    status: 'ok',
    url,
    track: 'Custom Loop',
    population: afterStart.stats.populationSize,
    camera: await page.locator('.camera-toolbar span').textContent(),
  }, null, 2));
} finally {
  await browser.close();
  await rm(tempDir, { recursive: true, force: true });
}

async function waitForScene(page) {
  await page.waitForFunction(() => Boolean(window.__NEURO_RACER_DEBUG__?.sceneReady), null, { timeout: 30_000 });
  await page.waitForFunction(() => (window.__NEURO_RACER_DEBUG__?.stats?.aliveCount ?? 0) > 0, null, { timeout: 30_000 });
}

async function drawCustomTrack(page) {
  await page.getByRole('button', { name: 'Draw track' }).click();
  const box = await page.locator('.stage-panel').boundingBox();
  if (!box) {
    throw new Error('Stage panel was not found.');
  }
  const y = box.y + Math.min(520, box.height - 160);
  const points = [
    [box.x + 260, y],
    [box.x + 420, y - 150],
    [box.x + 680, y - 130],
    [box.x + 840, y + 40],
    [box.x + 720, y + 170],
    [box.x + 420, y + 130],
    [box.x + 260, y],
  ];

  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, nextY] of points.slice(1)) {
    await page.mouse.move(x, nextY, { steps: 8 });
  }
  await page.mouse.up();
}

async function debugState(page) {
  return page.evaluate(() => window.__NEURO_RACER_DEBUG__);
}

function parseArgs(raw) {
  const result = {};
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith('--')) {
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
