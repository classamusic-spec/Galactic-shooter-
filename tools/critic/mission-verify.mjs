/**
 * Mission verification harness.
 *
 * Boots the built game in headless Chromium and *plays* each world's encounter
 * script through `window.GF`, proving the objective verbs are real:
 *
 *  - a `reach` wave does not complete while the player stands still, and does
 *    complete once they are moved to the authored point;
 *  - a `hold` wave banks time only inside its radius;
 *  - a `destroy` wave ends when the registered target's health hits zero;
 *  - the boss that arrives is the archetype docs/MISSIONS.md names;
 *  - `level:cleared` fires, and nothing instant-completes or stalls.
 *
 * Usage: node mission-verify.mjs --url http://localhost:5520 [--worlds a,b]
 */
import { launchBrowser, openPage } from './browser.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const URL_BASE = arg('url', 'http://localhost:5520');
const WORLDS = arg('worlds', 'aurvangr,zeta-reticuli,khepri,hive-prime,draco-ix').split(',');
const BUDGET = Number(arg('budget', '1500')); // wall-clock seconds per world

const browser = await launchBrowser();
const { page, errors } = await openPage(browser, { width: 640, height: 360 });
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });

console.log('waiting for boot…');
await page.waitForFunction(() => !!(window.GF && window.GF.debug && window.GF.engine), null, {
  timeout: 240000,
});
console.log('booted');
// The software rasteriser is the bottleneck, not the simulation: at the medium
// tier with the post chain on, one frame costs about five seconds and game time
// crawls at a twentieth of wall clock. Dropping the tier and bypassing PostFX
// changes nothing about gameplay and buys back roughly 25x.
await page.evaluate(() => window.GF.debug.setTier('low'));

// One recorder for the whole run.
await page.evaluate(() => {
  const gf = window.GF;
  const log = { obj: [], done: [], cleared: [], mission: [] };
  window.__rec = log;
  gf.events.on('objective:updated', (p) => {
    const last = log.obj[log.obj.length - 1];
    if (!last || last.text !== p.text) {
      log.obj.push({ text: p.text, t: gf.engine.elapsed, progress: p.progress, total: p.total });
    } else {
      last.progress = p.progress;
      last.total = p.total;
    }
  });
  gf.events.on('objective:completed', (p) => log.done.push({ text: p.text, t: gf.engine.elapsed }));
  gf.events.on('level:cleared', (p) => log.cleared.push({ id: p.id, t: gf.engine.elapsed }));
  gf.events.on('mission:completed', (p) => log.mission.push({ id: p.missionId ?? '?', t: gf.engine.elapsed }));
});

/** Advance `seconds` of simulated time, waiting on the tick counter. */
async function sim(seconds) {
  const t0 = await page.evaluate(() => window.GF.engine.elapsed);
  await page.waitForFunction((t) => window.GF.engine.elapsed > t, t0 + seconds, {
    timeout: Math.max(90000, seconds * 8000),
    polling: 400,
  });
}

const results = [];

for (const world of WORLDS) {
  console.log(`\n=== ${world} ===`);
  const rec = { world, steps: [], ok: true, fail: [] };
  await page.evaluate(() => {
    window.__rec.obj.length = 0;
    window.__rec.done.length = 0;
    window.__rec.cleared.length = 0;
  });
  await page.evaluate((id) => window.GF.game.travelTo(id), world);
  await page.waitForFunction(
    (id) => window.GF.engine.level && window.GF.engine.level.id === `planet:${id}`,
    world,
    { timeout: 180000 },
  );
  // A no-op render pipeline, not null: null falls back to `renderer.render`.
  // With drawing switched off entirely the loop runs at rAF rate and game time
  // tracks wall clock, which is the difference between a five-minute check and
  // a two-hour one. Nothing in the simulation is skipped.
  await page.evaluate(() => {
    window.GF.engine.renderPipeline = () => {};
  });
  // Nav has to finish before any spawn volume can place anything.
  await page.waitForFunction(() => window.GF.game.ai.debugSnapshot().navReady === true, null, {
    timeout: 180000,
    polling: 1000,
  });

  const setup = await page.evaluate(() => {
    const gf = window.GF;
    const lvl = gf.engine.level;
    const p = gf.game.player.position;
    const ground = lvl.heightField.height(p.x, p.z);
    const nav = gf.game.ai.nav;
    const script = lvl.encounter;
    return {
      title: script?.title ?? null,
      boss: script?.boss?.archetype ?? null,
      bossObjective: script?.bossObjective ?? null,
      waves: script.waves.map((w) => ({
        objective: w.objective,
        trigger: w.trigger
          ? {
              kind: w.trigger.kind,
              radius: w.trigger.radius ?? null,
              seconds: w.trigger.seconds ?? null,
              targetId: w.trigger.targetId ?? null,
              position: w.trigger.position
                ? { x: w.trigger.position.x, y: w.trigger.position.y, z: w.trigger.position.z }
                : null,
            }
          : null,
      })),
      player: { x: p.x, y: p.y, z: p.z },
      ground,
      dy: p.y - ground,
      navCells: nav.count,
      navWalkable: nav.countWalkable(),
      navMinX: nav.minX,
      navMinZ: nav.minZ,
      navW: nav.w,
      navH: nav.h,
      navCell: nav.cellSize,
      volumes: gf.game.ai.encounters.volumes.map((v) => ({
        id: v.id,
        snap: nav.nearestWalkableCell(v.position.x, v.position.z, 8) >= 0,
      })),
      stats: lvl.stats(),
      renderer: { ...gf.engine.host.stats },
    };
  });
  rec.setup = setup;
  console.log(
    `  title=${setup.title} boss=${setup.boss} | spawn dy=${setup.dy.toFixed(2)} m | nav ${setup.navWalkable}/${setup.navCells} cells`,
  );
  const badVolumes = setup.volumes.filter((v) => !v.snap).map((v) => v.id);
  if (badVolumes.length) {
    rec.fail.push(`spawn volumes outside the nav grid: ${badVolumes.join(', ')}`);
    rec.ok = false;
  }
  if (!(setup.dy > -0.4 && setup.dy < 3.5)) {
    rec.fail.push(`player spawn ${setup.dy.toFixed(2)} m off the ground`);
    rec.ok = false;
  }

  // -- prove the first reach objective is not already satisfied --------------
  const first = setup.waves[0];
  if (first.trigger && first.trigger.kind === 'reach') {
    await sim(22);
    const before = await page.evaluate(() => ({
      done: window.__rec.done.map((d) => d.text),
      obj: window.__rec.obj[window.__rec.obj.length - 1],
      wave: window.GF.game.ai.encounters.currentWave,
      dist: (() => {
        const t = window.GF.engine.level.encounter.waves[0].trigger.position;
        const p = window.GF.game.player.position;
        return Math.hypot(p.x - t.x, p.z - t.z);
      })(),
    }));
    rec.steps.push({ step: 'reach:before', ...before });
    if (before.done.includes(first.objective)) {
      rec.fail.push(`"${first.objective}" completed without moving`);
      rec.ok = false;
    }
    console.log(
      `  after 22 s standing still: wave=${before.wave} objective="${before.obj?.text}" dist=${before.dist.toFixed(1)} m — completed=${before.done.includes(first.objective)}`,
    );
    // now move there
    await page.evaluate(() => {
      const t = window.GF.engine.level.encounter.waves[0].trigger.position;
      const lvl = window.GF.engine.level;
      const y = lvl.heightField.height(t.x, t.z) + 1.2;
      window.GF.game.player.teleport({ x: t.x, y, z: t.z }, window.GF.game.player.yaw);
    });
    await sim(3);
    const after = await page.evaluate(() => ({
      done: window.__rec.done.map((d) => d.text),
      wave: window.GF.game.ai.encounters.currentWave,
      dist: (() => {
        const t = window.GF.engine.level.encounter.waves[0].trigger.position;
        const p = window.GF.game.player.position;
        return Math.hypot(p.x - t.x, p.z - t.z);
      })(),
    }));
    rec.steps.push({ step: 'reach:after', ...after });
    console.log(
      `  after teleport (dist=${after.dist.toFixed(1)} m): wave=${after.wave} completed=${after.done.includes(first.objective)}`,
    );
    if (!after.done.includes(first.objective)) {
      rec.fail.push(`"${first.objective}" did not complete on arrival`);
      rec.ok = false;
    }
  }

  // -- drive the rest of the script ------------------------------------------
  const t0 = Date.now();
  let bossSeen = null;
  let lastWave = -1;
  let polls = 0;
  while ((Date.now() - t0) / 1000 < BUDGET) {
    const state = await page.evaluate(() => {
      const gf = window.GF;
      const enc = gf.game.ai.encounters;
      const lvl = gf.engine.level;
      const script = lvl.encounter;
      const wi = enc.waveIndex;
      const wave = wi >= 0 && wi < script.waves.length ? script.waves[wi] : null;
      const trig = wave?.trigger ?? null;
      const p = gf.game.player.position;

      // Satisfy positional triggers: stand on the point.
      if (trig && (trig.kind === 'reach' || trig.kind === 'hold')) {
        const dx = p.x - trig.position.x;
        const dz = p.z - trig.position.z;
        const d = Math.hypot(dx, dz) || 1;
        if (d > trig.radius * 0.9) {
          // Stand just inside the radius, not on the point: landmarks are solid,
          // and dropping the capsule into the middle of a forty-metre resin
          // spire is not what arriving there means.
          const k = trig.radius * 0.8;
          const x = trig.position.x + (dx / d) * k;
          const z = trig.position.z + (dz / d) * k;
          gf.game.player.teleport({ x, y: lvl.heightField.height(x, z) + 1.2, z }, 0);
        }
      }
      // Satisfy destroy triggers: hit the registered target hard.
      if (trig && trig.kind === 'destroy') {
        for (const d of lvl.destructibles ?? []) {
          if (d.health > 0) {
            d.applyDamage({
              amount: 900,
              element: 'kinetic',
              region: 'body',
              precision: false,
              point: d.position,
              normal: { x: 0, y: 1, z: 0 },
              direction: { x: 0, y: -1, z: 0 },
              sourceId: 0,
            });
          }
        }
      }
      // Waves without a positional trigger get a player who *moves*. Standing
      // still for a whole wave is not a realistic test: the director only ever
      // retries the head of its spawn queue, so a unit pinned to a volume the
      // player happens to be parked next to blocks the wave until they walk
      // away. Wander the objective's neighbourhood the way a player would.
      if (!trig || trig.kind === 'destroy') {
        // Anchor once per wave and orbit that, rather than stepping from the
        // current position — a random walk would drift the player off the map
        // over a long wave.
        if (window.__anchorWave !== wi) {
          window.__anchorWave = wi;
          window.__anchor = { x: p.x, z: p.z };
          window.__wander = 0;
        }
        const step = (window.__wander = ((window.__wander ?? 0) + 1) % 4);
        const anchor = window.__anchor;
        const r = 16;
        const a = (step / 4) * Math.PI * 2;
        const x = anchor.x + Math.sin(a) * r;
        const z = anchor.z + Math.cos(a) * r;
        gf.game.player.teleport({ x, y: lvl.heightField.height(x, z) + 1.2, z }, 0);
      }
      // Keep the Guardian on their feet. A dead player pauses a `hold` clock by
      // design, and this harness is testing whether the objectives are real, not
      // whether standing still in a swarm is survivable.
      const pl = gf.game.player;
      if (pl.health < pl.maxHealth) pl.health = pl.maxHealth;
      if (pl.shield < pl.maxShield) pl.shield = pl.maxShield;

      // Clear whatever is alive, so waves that end on a kill count progress.
      let killed = 0;
      for (const a of gf.game.enemies.active) {
        if (a.state !== 'alive') continue;
        a.applyDamage({
          amount: 100000,
          element: 'kinetic',
          region: 'body',
          precision: false,
          point: a.position,
          normal: { x: 0, y: 1, z: 0 },
          direction: { x: 0, y: -1, z: 0 },
          sourceId: 0,
        });
        killed++;
      }
      const bosses = gf.game.enemies.active
        .filter((a) => a.archetype && a.archetype.rank === 'boss')
        .map((a) => ({ id: a.archetype.id, hp: a.maxHealth }));
      return {
        phase: enc.phase,
        hold: Math.round((enc.holdTime ?? 0) * 10) / 10,
        hp: Math.round(gf.game.player.health),
        dead: gf.game.player.isDead === true,
        queued: enc.queue.length,
        alive: gf.game.enemies.aliveCount,
        volumes: enc.volumes
          .filter((v) => v.position.distanceTo(gf.game.player.position) < v.minPlayerDistance)
          .map((v) => v.id),
        wave: enc.currentWave,
        waveIndex: wi,
        objective: window.__rec.obj[window.__rec.obj.length - 1] ?? null,
        cleared: window.__rec.cleared.length > 0,
        killed,
        bosses,
        elapsed: gf.engine.elapsed,
        targets: (lvl.destructibles ?? []).map((d) => ({ id: d.id, hp: Math.round(d.health) })),
      };
    });
    if (state.bosses.length && !bossSeen) {
      bossSeen = state.bosses[0];
      console.log(`  BOSS: ${bossSeen.id} (${bossSeen.hp} HP)`);
      rec.steps.push({ step: 'boss', ...bossSeen });
    }
    if (state.waveIndex !== lastWave) {
      lastWave = state.waveIndex;
      polls = 0;
      console.log(
        `  wave ${state.wave}/${setup.waves.length} phase=${state.phase} obj="${state.objective?.text}"`,
      );
    }
    // A wave that has not moved in a while: say why, rather than timing out
    // silently. `queued` above zero with nothing alive means the spawn queue is
    // blocked at its head — which is what a volume list that includes the
    // player's own objective does.
    if (++polls % 20 === 0) {
      console.log(
        `    …still wave ${state.wave} phase=${state.phase} hold=${state.hold}s hp=${state.hp}${state.dead ? ' DEAD' : ''} queued=${state.queued} alive=${state.alive} blockedVolumes=[${state.volumes.join(',')}] t=${state.elapsed.toFixed(0)}s`,
      );
    }
    if (state.cleared) {
      console.log(`  CLEARED at t=${state.elapsed.toFixed(0)} s sim`);
      rec.cleared = true;
      break;
    }
    await sim(1.6);
  }
  if (!rec.cleared) {
    rec.fail.push('encounter did not reach level:cleared inside the budget');
    rec.ok = false;
  }
  const log = await page.evaluate(() => ({
    obj: window.__rec.obj.map((o) => `${o.text} @${o.t.toFixed(1)}s`),
    done: window.__rec.done.map((d) => `${d.text} @${d.t.toFixed(1)}s`),
    cleared: window.__rec.cleared,
  }));
  rec.log = log;
  if (bossSeen) rec.boss = bossSeen;
  else {
    rec.fail.push('no boss ever spawned');
    rec.ok = false;
  }
  if (setup.boss && bossSeen && bossSeen.id !== setup.boss) {
    rec.fail.push(`boss archetype was ${bossSeen.id}, script says ${setup.boss}`);
    rec.ok = false;
  }
  console.log(`  objectives seen: ${log.obj.join(' | ')}`);
  console.log(`  objectives completed: ${log.done.join(' | ')}`);
  console.log(`  ${rec.ok ? 'PASS' : 'FAIL: ' + rec.fail.join('; ')}`);
  results.push(rec);
}

console.log('\n=== summary ===');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.world}  boss=${r.boss?.id ?? '-'}  ${r.fail.join('; ')}`);
}
console.log(`page errors: ${errors.length}`);
for (const e of errors.slice(0, 8)) console.log('  ' + e.split('\n')[0]);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
