#!/usr/bin/env node
/**
 * Audit the generated sound bank and name the files that need regenerating.
 *
 * The generator cannot check its own output. Node has no MP3 decoder, and the
 * failures are not HTTP failures — the API returns 200 with a valid file that
 * happens to hold near-silence, or a gunshot that only arrives a fifth of a
 * second in. Both are only visible once decoded.
 *
 * This boots the real game and reads `GF.debug.audio().sfxMetrics`, which is
 * measured on the buffers that actually ship, *after* the runtime's trim,
 * downmix and re-level. An earlier version re-derived the numbers here and
 * quietly disagreed with the engine — it measured channel 0 where the runtime
 * measures the mono downmix, which for a wide-stereo file is a 3 ms attack
 * against a 95 ms one. Reading the engine's own metric makes that class of bug
 * impossible.
 *
 * Usage:
 *   node tools/audio/qa-sfx.mjs [--url http://localhost:5233]
 */
import { launchBrowser } from '../critic/browser.mjs';

const argv = process.argv.slice(2);
const URL_ = (argv.indexOf('--url') >= 0 && argv[argv.indexOf('--url') + 1]) || 'http://localhost:5233';

/**
 * Attack is gated by what the sound is supposed to do.
 *
 * A gun has to crack: past ~40 ms a discharge stops reading as an impact and
 * starts reading as mush, and it no longer feels connected to the trigger. An
 * explosion, a melee whoosh or a shield collapse legitimately swell, so they are
 * only checked for being audible at all. Onset latency is not gated because the
 * runtime's transient trim drives it to the 2 ms pre-roll by construction.
 */
const MAX_ATTACK_MS = { 'gun_': 40, 'impact_': 40, 'step_': 60 };
/** Below this peak the file is a failed generation. Mirrors MIN_USABLE_PEAK. */
const MIN_PEAK = 0.02;

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.GF?.debug?.audio, null, { timeout: 300000 });
await page.mouse.click(200, 150);
await page.waitForTimeout(1500);
const d = await page.evaluate(() => window.GF.debug.audio());
await browser.close();

const ids = Object.keys(d.sfxMetrics);
console.log(`installed ${d.sfxPack.loaded}, failed ${d.sfxPack.failed}, rejected ${d.sfxPack.rejected}`);
if (!ids.length) {
  console.log('no recorded effects installed — is public/sfx populated and the build fresh?');
  process.exit(1);
}

const limitFor = (id) => {
  for (const [prefix, ms] of Object.entries(MAX_ATTACK_MS)) if (id.startsWith(prefix)) return ms;
  return null;
};
const reason = (id) => {
  const m = d.sfxMetrics[id];
  if (m.peak < MIN_PEAK) return `near-silent (peak ${m.peak})`;
  const limit = limitFor(id);
  if (limit != null && m.attackMs > limit) return `mushy (${m.attackMs} ms to full, limit ${limit})`;
  return null;
};
const bad = ids.filter(reason);
for (const id of bad) console.log(`  ✗ ${id.padEnd(28)} ${reason(id)}`);
console.log(`\n${ids.length - bad.length}/${ids.length} pass`);
if (d.sfxPack.rejected) {
  console.log(`${d.sfxPack.rejected} file(s) were rejected as unusable and kept their synthesised version.`);
}
if (bad.length) {
  console.log(`\nregenerate with:\n\n  node tools/audio/gen-sfx.mjs --force --ids ${bad.join(',')}`);
  process.exitCode = 1;
}
