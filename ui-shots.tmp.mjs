/** Scratch capture harness for the UI layer. Delete when done. */
import { launchBrowser, openPage } from './tools/critic/browser.mjs';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'shots/ui';
const SIZES = [
  { w: 1920, h: 1080, tag: '1080' },
  { w: 1280, h: 720, tag: '720' },
];
mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launchBrowser();
const allErrors = [];

for (const { w, h, tag } of SIZES) {
  const { page, errors } = await openPage(browser, { width: w, height: h });
  page.on('console', (m) => {
    if (m.type() === 'error') allErrors.push(`[${tag}] ${m.text()}`);
  });
  await page.goto('http://127.0.0.1:5199/ui-test.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => !!window.T && !!window.GFUI, null, { timeout: 90000 });
  await wait(2500);

  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}/${name}-${tag}.png` });
    console.log(`  ${name}-${tag}.png`);
  };

  // 1 — HUD over a bright sky, mid-firefight.
  await page.evaluate(() => {
    window.T.bright();
    window.T.combat();
  });
  await wait(300);
  await page.evaluate(() => window.GFUI.demo());
  await wait(260);
  await shot('hud-bright');

  // 2 — HUD over a dark cave, mid-reload with a low magazine.
  await page.evaluate(() => {
    window.T.dark();
    window.T.combat();
    window.GFUI.demo();
    const s = window.GFUI.state;
    s.ammo = 4;
    s.reload = 0.46;
    s.reloadLength = 2;
  });
  await wait(300);
  await shot('hud-dark');

  // 3 — Pause menu.
  await page.evaluate(() => window.GFUI.pause());
  await wait(700);
  await shot('pause');

  // 4 — Settings.
  await page.evaluate(() => window.GFUI.settings());
  await wait(700);
  await shot('settings');
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('.gf-tab');
    tabs[1]?.click();
  });
  await wait(400);
  await shot('settings-image');

  // 5 — Star map (driven through the real engine state, as the game does).
  await page.evaluate(() => {
    window.GFUI.resume();
    window.T.bright();
    window.T.engine.state = 'starmap';
  });
  await wait(1000);
  await shot('starmap');

  // 6 — Death screen.
  await page.evaluate(() => {
    window.T.engine.state = 'playing';
    window.GFUI.death('Skoll, Warband Chief');
  });
  await wait(700);
  await shot('death');

  // 7 — Loading screen.
  await page.evaluate(() => {
    window.GFUI.revive();
    window.GFUI.loading(true, 'Approaching Khepri');
    window.GFUI.loadingProgress(0.62, 'Building collision');
  });
  await wait(900);
  await shot('loading');

  await page.evaluate(() => window.GFUI.loading(false, ''));
  await page.close();
  allErrors.push(...errors.map((e) => `[${tag}] ${e}`));
}

await browser.close();
if (allErrors.length) {
  console.log('\nPAGE ERRORS:');
  for (const e of allErrors.slice(0, 30)) console.log('  ' + e);
} else {
  console.log('\nno page errors');
}
