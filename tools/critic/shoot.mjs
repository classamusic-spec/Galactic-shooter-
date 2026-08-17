#!/usr/bin/env node
/**
 * Visual capture harness.
 *
 * Boots the built (or dev) game in headless Chromium with a real GPU-ish
 * software rasteriser, drives it through the debug hooks the game exposes on
 * `window.GF`, and writes PNGs for the critic agents to look at.
 *
 * Usage:
 *   node tools/critic/shoot.mjs --out shots/run1 [--url http://localhost:5173]
 *                               [--shots shipInterior,starmap,aurvangr]
 *                               [--width 1920] [--height 1080] [--wait 9000]
 *
 * Exit code is non-zero when the page logged an uncaught error, so an agent
 * can tell "ugly" from "broken".
 */
import { launchBrowser, openPage } from './browser.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const OUT = resolve(arg('out', 'shots/latest'));
const URL_BASE = arg('url', 'http://localhost:5173');
const WIDTH = Number(arg('width', '1920'));
const HEIGHT = Number(arg('height', '1080'));
const WAIT = Number(arg('wait', '12000'));
const SHOTS = arg('shots', 'default')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

mkdirSync(OUT, { recursive: true });

const browser = await launchBrowser();
const { page, logs, errors } = await openPage(browser, { width: WIDTH, height: HEIGHT });

console.log(`→ ${URL_BASE}`);
try {
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) {
  console.error(`FAILED to load ${URL_BASE}: ${e.message}`);
  await browser.close();
  process.exit(2);
}

// Wait for the game to report readiness, or time out and shoot anyway so the
// critic can see a broken frame rather than nothing.
const ready = await page
  .waitForFunction(
    () => {
      const gf = window.GF;
      return !!(gf && gf.engine && gf.engine.level);
    },
    { timeout: WAIT },
  )
  .then(() => true)
  .catch(() => false);

if (!ready) console.warn('! game never reported a loaded level; capturing anyway');

// Software rasterisation is slow; give the renderer real frames to settle
// TAA history, streaming, lightmaps and particle warm-up.
await page.waitForTimeout(3500);

async function shoot(name) {
  const file = `${OUT}/${name}.png`;
  mkdirSync(dirname(file), { recursive: true });
  const buf = await page.screenshot({ type: 'png', animations: 'disabled' });
  writeFileSync(file, buf);
  const kb = Math.round(buf.length / 1024);
  console.log(`  ✓ ${name}.png (${kb} kB)`);
  return { name, file, kb };
}

/** Drive the game into a named scenario using the debug hooks. */
async function scenario(name) {
  const ok = await page.evaluate(async (n) => {
    const gf = window.GF;
    if (!gf?.debug?.scenario) return 'no-hook';
    try {
      await gf.debug.scenario(n);
      return 'ok';
    } catch (e) {
      return `error: ${String(e?.message ?? e)}`;
    }
  }, name);
  if (ok !== 'ok') console.warn(`  ! scenario "${name}": ${ok}`);
  await page.waitForTimeout(2600);
}

const results = [];
if (SHOTS.length === 1 && SHOTS[0] === 'default') {
  results.push(await shoot('00-default'));
} else {
  let i = 0;
  for (const s of SHOTS) {
    await scenario(s);
    results.push(await shoot(`${String(i++).padStart(2, '0')}-${s}`));
  }
}

const perf = await page.evaluate(() => {
  const gf = window.GF;
  const e = gf?.engine;
  if (!e) return null;
  return {
    fps: Math.round(e.fps * 10) / 10,
    frameMs: Math.round(e.frameMs * 100) / 100,
    state: e.state,
    level: e.level?.id ?? null,
    drawCalls: e.host?.stats?.calls ?? null,
    triangles: e.host?.stats?.triangles ?? null,
    programs: e.host?.stats?.programs ?? null,
    resolutionScale: gf?.settings?.resolutionScale ?? null,
    tier: gf?.settings?.user?.tier ?? null,
  };
});

writeFileSync(
  `${OUT}/report.json`,
  JSON.stringify({ url: URL_BASE, ready, perf, shots: results, errors, logs: logs.slice(-160) }, null, 2),
);

console.log(`\nperf: ${JSON.stringify(perf)}`);
if (errors.length) {
  console.error(`\n${errors.length} page error(s):`);
  for (const e of errors.slice(0, 12)) console.error('  ' + e.split('\n')[0]);
}
await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
