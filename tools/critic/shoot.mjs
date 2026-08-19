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
//
// Boot is deliberately given far longer than `--wait`. `--wait` is the *settle*
// budget for a frame that is already rendering; boot is a different thing and now
// includes synthesising the audio bank and fetching the recorded sound pack, which
// pushed it past the old shared budget. When the two were the same number the
// harness gave up before `window.GF` existed, reported "no-hook" for every
// scenario, and captured the boot screen — which reads exactly like a broken game.
const BOOT_TIMEOUT = Math.max(WAIT, 180000);
const bootT0 = Date.now();
const ready = await page
  .waitForFunction(
    () => {
      const gf = window.GF;
      return !!(gf && gf.engine && gf.engine.level);
    },
    { timeout: BOOT_TIMEOUT },
  )
  .then(() => true)
  .catch(() => false);

if (!ready) console.warn(`! game never reported a loaded level after ${Math.round((Date.now() - bootT0) / 1000)}s; capturing anyway`);

// Software rasterisation is slow; give the renderer real frames to settle
// TAA history, streaming, lightmaps and particle warm-up.
await page.waitForTimeout(3500);

async function shoot(name) {
  const file = `${OUT}/${name}.png`;
  mkdirSync(dirname(file), { recursive: true });
  // Playwright's 30 s default is not enough here. A single frame under
  // ANGLE/SwiftShader already costs over a second, and a combat frame with
  // several rigged enemies and their shadows costs far more than that.
  const buf = await page.screenshot({ type: 'png', animations: 'disabled', timeout: 180000 });
  writeFileSync(file, buf);
  const kb = Math.round(buf.length / 1024);
  console.log(`  ✓ ${name}.png (${kb} kB)`);
  return { name, file, kb };
}

/**
 * Drive the game into a named scenario using the debug hooks.
 *
 * A scenario suffixed `:combat` also populates the frame with enemies and fires
 * a round of VFX. Without it a capture never contains either — a wave only
 * arrives after its scripted delay, and a capture advances a second or two of
 * simulation at most under the software rasteriser — so the rubric's enemy and
 * VFX axes cannot be scored at all.
 */
async function scenario(name) {
  const combat = name.endsWith(':combat');
  const base = combat ? name.slice(0, -':combat'.length) : name;
  const ok = await page.evaluate(async (n) => {
    const gf = window.GF;
    if (!gf?.debug?.scenario) return 'no-hook';
    try {
      await gf.debug.scenario(n);
      return 'ok';
    } catch (e) {
      return `error: ${String(e?.message ?? e)}`;
    }
  }, base);
  if (ok !== 'ok') console.warn(`  ! scenario "${name}": ${ok}`);
  if (combat && ok === 'ok') {
    const n = await page.evaluate(() => window.GF?.debug?.populate?.(6) ?? 0);
    // Enemies need frames to reach a pose: spawned agents start at their rig's
    // rest transform, and a T-posed enemy is an automatic failure in the rubric.
    await page.waitForFunction(
      (t) => window.GF.engine.tick > t + 60,
      await page.evaluate(() => window.GF.engine.tick),
      { timeout: 120000 },
    ).catch(() => {});
    console.log(`    populated ${n} enemies`);
  }
  await page.waitForTimeout(2600);
  if (combat && ok === 'ok') {
    // The detonation goes off *last*, after the settle above.
    //
    // It used to fire before that 2.6 s wait, and under the software rasteriser
    // a frame costs upwards of a second while the VFX clock runs on frame dt.
    // By the time the shutter opened the fireball had lived out its 0.8 s and
    // what the review scored was the smoke and dust tail - which is exactly
    // what a "flat orange mass" is. Three frames is enough to reach the burst
    // and not enough to outlive it.
    await page.evaluate(() => window.GF?.debug?.vfx?.());
    await page.waitForFunction(
      (t) => window.GF.engine.tick > t + 3,
      await page.evaluate(() => window.GF.engine.tick),
      { timeout: 60000 },
    ).catch(() => {});
  }
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
