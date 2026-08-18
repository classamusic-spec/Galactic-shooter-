import { launchBrowser, openPage } from './tools/critic/browser.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const OUT = arg('out', 'shots/enemies');
const SHOTS = arg('shots', 'biped:walk:front').split(',');
const SETTLE = Number(arg('settle', '9000'));
const HOLD = Number(arg('hold', '6000'));
const W = Number(arg('width', '1600'));
const Hh = Number(arg('height', '900'));

mkdirSync(OUT, { recursive: true });
const browser = await launchBrowser();
const { page, errors } = await openPage(browser, { width: W, height: Hh });
page.setDefaultTimeout(240000);
page.setDefaultNavigationTimeout(240000);

const report = { shots: [], errors: [] };
for (const shot of SHOTS) {
  const [species, mode, view, count] = shot.split(':');
  const url = `http://127.0.0.1:5199/enemy-test.html?species=${species}&mode=${mode}&view=${view}&count=${count ?? 40}&tier=high&${arg('extra','')}`;
  console.log(`→ ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  let ok = true;
  try {
    await page.waitForFunction(() => window.ENEMY_TEST?.ready === true, { timeout: 180000 });
  } catch (e) {
    ok = false;
    console.error(`  never became ready: ${e.message}`);
  }
  if (ok && mode === 'death') {
    await page.waitForTimeout(SETTLE);
    await page.evaluate(() => window.ENEMY_TEST.kill());
    // 3 s is the settle budget the brief asks the ragdolls to meet.
    await page.waitForTimeout(Number(arg('death', '14000')));
  } else if (ok) {
    await page.waitForTimeout(SETTLE);
    // Vite can force a reload while optimising deps; re-wait before probing.
    await page.waitForFunction(() => window.ENEMY_TEST?.ready === true, { timeout: 180000 });
    await page.evaluate(() => window.ENEMY_TEST.resetSlide());
    await page.waitForTimeout(HOLD);
    await page.waitForFunction(() => window.ENEMY_TEST?.ready === true, { timeout: 180000 });
  }
  const stats = ok ? await page.evaluate(() => window.ENEMY_TEST.stats()) : {};
  const file = `${OUT}/${shot.replace(/:/g, '-')}.png`;
  await page.screenshot({ path: file });
  console.log(`  ${file}`, JSON.stringify(stats));
  report.shots.push({ shot, stats, file });
}
report.errors = errors;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
if (errors.length) console.error(`\n${errors.length} page errors:\n${errors.slice(0, 12).join('\n')}`);
await browser.close();
