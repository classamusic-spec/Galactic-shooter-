import { launchBrowser, openPage } from './tools/critic/browser.mjs';
const b = await launchBrowser();
const { page, errors } = await openPage(b, { width: 700, height: 420 });
page.setDefaultTimeout(240000);
await page.goto('http://127.0.0.1:5199/enemy-test.html?species=biped&mode=death&view=close&count=2&tier=high', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.ENEMY_TEST?.ready === true);
await page.waitForTimeout(6000);
const probe = () => page.evaluate(() => {
  const a = window.__AGENTS[0];
  const r = a.ragdoll;
  return { state: a.state, stagger: +a.staggerTime.toFixed(3), deathT: +a.deathTime.toFixed(2),
    active: r.active, settled: r.settled, age: +r.age.toFixed(2),
    rootY: +r.rootPosition.y.toFixed(3), posY: +a.position.y.toFixed(3),
    motion: +r.motionEstimate.toFixed(5), n: r.particleCount, flash: +a.hitFlash.toFixed(2) };
});
await page.evaluate(() => window.ENEMY_TEST.kill());
for (let i = 0; i < 6; i++) { await page.waitForTimeout(900); console.log(JSON.stringify(await probe())); }
console.log('ERR', errors.slice(0,3).join('\n'));
await b.close();
