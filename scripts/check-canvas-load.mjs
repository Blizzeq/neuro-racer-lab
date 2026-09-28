import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? 'http://127.0.0.1:5173';
const runs = Number(args.runs ?? 8);
const chromePath = args.chrome ?? process.env.CHROME_PATH ?? findChrome();

if (!chromePath) {
  throw new Error('Chrome was not found. Set CHROME_PATH or install Chrome.');
}

const browser = await chromium.launch({
  headless: !args.headed,
  executablePath: chromePath,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 980 },
});

const results = [];

try {
  for (let run = 1; run <= runs; run += 1) {
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      consoleErrors.push(`pageerror: ${error.message}`);
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitForScene(page);
      await page.waitForTimeout(250);

      // The simulator renders with WebGL, so sample the composited pixels from a real screenshot.
      const screenshot = await page.locator('.racer-stage').screenshot();
      const health = await page.evaluate(async (base64) => {
        const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context2d = canvas.getContext('2d');
        if (!context2d) {
          return { ok: false, reason: '2d canvas context unavailable' };
        }
        context2d.drawImage(bitmap, 0, 0);
        const positions = [
          [24, 24],
          [Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2)],
          [Math.max(0, bitmap.width - 24), Math.max(0, bitmap.height - 24)],
        ];
        const samples = positions.map(([x, y]) => {
          const [r, g, b, a] = context2d.getImageData(x, y, 1, 1).data;
          return { r, g, b, a, luma: (r + g + b) / 3 };
        });
        const whiteSamples = samples.filter((sample) => sample.r > 240 && sample.g > 240 && sample.b > 240).length;
        const opaqueSamples = samples.filter((sample) => sample.a > 220).length;
        const averageLuma = samples.reduce((sum, sample) => sum + sample.luma, 0) / samples.length;
        const stageCanvas = document.querySelector('.racer-stage canvas');
        return {
          ok: whiteSamples < samples.length && opaqueSamples === samples.length && averageLuma < 120,
          width: stageCanvas instanceof HTMLCanvasElement ? stageCanvas.width : 0,
          height: stageCanvas instanceof HTMLCanvasElement ? stageCanvas.height : 0,
          whiteSamples,
          opaqueSamples,
          averageLuma,
          samples,
        };
      }, screenshot.toString('base64'));

      assert.equal(health.ok, true, `canvas health failed on run ${run}: ${JSON.stringify(health)}`);
      assert.deepEqual(consoleErrors, [], `console errors on run ${run}: ${consoleErrors.join('\n')}`);
      assert.ok(health.width > 0 && health.width <= 4096, `canvas backing store should match the viewport, got ${health.width}x${health.height}`);
      results.push({
        run,
        width: health.width,
        height: health.height,
        averageLuma: Number(health.averageLuma.toFixed(2)),
      });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({
  status: 'ok',
  url,
  runs,
  results,
}, null, 2));

async function waitForScene(page) {
  await page.waitForFunction(() => Boolean(window.__NEURO_RACER_DEBUG__?.sceneReady), null, { timeout: 30_000 });
  await page.waitForFunction(() => (window.__NEURO_RACER_DEBUG__?.stats?.aliveCount ?? 0) > 0, null, { timeout: 30_000 });
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
