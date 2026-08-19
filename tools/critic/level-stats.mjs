/**
 * Static budget + cover probe.
 *
 * Loads every world at a given tier and reports the hardware-independent
 * numbers the perf gate is written against, plus the cover map's point count —
 * which is the only direct measure of whether the new geometry actually became
 * cover rather than just scenery.
 */
import { launchBrowser, openPage } from './browser.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const URL_BASE = arg('url', 'http://localhost:5520');
const TIER = arg('tier', 'high');
const WORLDS = arg('worlds', 'aurvangr,zeta-reticuli,khepri,hive-prime,draco-ix').split(',');

const browser = await launchBrowser();
const { page, errors } = await openPage(browser, { width: 1280, height: 720 });
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!(window.GF && window.GF.debug), null, { timeout: 240000 });
await page.evaluate((t) => window.GF.debug.setTier(t), TIER);

const rows = [];
for (const world of WORLDS) {
  await page.evaluate((id) => window.GF.game.travelTo(id), world);
  await page.waitForFunction(
    (id) => window.GF.engine.level && window.GF.engine.level.id === `planet:${id}`,
    world,
    { timeout: 300000 },
  );
  // Real frames, so the renderer's stats reflect a drawn frame and the nav /
  // cover builds get their time slices.
  const t0 = await page.evaluate(() => window.GF.engine.tick);
  await page.waitForFunction((t) => window.GF.engine.tick > t + 40, t0, {
    timeout: 300000,
    polling: 1000,
  });
  await page.waitForFunction(
    () => {
      const s = window.GF.game.ai.debugSnapshot();
      return s.navReady && s.coverReady;
    },
    null,
    { timeout: 300000, polling: 1000 },
  );
  const r = await page.evaluate((id) => {
    const gf = window.GF;
    const lvl = gf.engine.level;
    const p = gf.game.player.position;
    return {
      world: id,
      calls: gf.engine.host.stats.calls,
      triangles: gf.engine.host.stats.triangles,
      programs: gf.engine.host.stats.programs,
      geometries: gf.engine.host.stats.geometries,
      propMeshes: lvl.stats().propMeshes,
      propTriangles: Math.round(lvl.stats().propTriangles),
      terrainTriangles: lvl.stats().terrainTriangles,
      coverPoints: gf.game.ai.cover.points.length,
      navWalkable: gf.game.ai.debugSnapshot().navWalkable,
      destructibles: (lvl.destructibles ?? []).map((d) => `${d.id}:${d.maxHealth}`),
      spawnDy: +(p.y - lvl.heightField.height(p.x, p.z)).toFixed(2),
      proxies: lvl.collision.proxyCount,
    };
  }, world);
  rows.push(r);
  console.log(JSON.stringify(r));
}
console.log('\ntier=' + TIER);
console.table(
  rows.map((r) => ({
    world: r.world,
    calls: r.calls,
    tris: r.triangles,
    programs: r.programs,
    propMeshes: r.propMeshes,
    propTris: r.propTriangles,
    cover: r.coverPoints,
    navWalk: r.navWalkable,
    spawnDy: r.spawnDy,
  })),
);
console.log('errors', errors.length);
for (const e of errors.slice(0, 6)) console.log('  ' + e.split('\n')[0]);
await browser.close();
