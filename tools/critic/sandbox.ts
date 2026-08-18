/**
 * Combat sandbox.
 *
 * Wires every finished subsystem into a playable scene without waiting for the
 * modules still being written (abilities, loot, audio, star map). Its job is to
 * surface cross-system integration failures — and to produce real gameplay
 * frames for visual review — rather than to be the game.
 *
 * Query params: ?planet=<id>&tier=<t>&enemies=<n>&steps=<n>&shot=<name>
 */
import * as THREE from 'three';
import type { CollisionWorld, FrameContext, Level, PlanetId } from '@/types';
import { Engine } from '@/core/Engine';
import { settings } from '@/core/Settings';
import { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { SkyDome } from '@/gfx/sky/SkyDome';
import { ATMOSPHERES } from '@/gfx/sky/AtmosphereProfile';
import { TerrainBuilder, terrainRecipe } from '@/gfx/terrain/TerrainBuilder';
import { BvhCollisionWorld } from '@/gameplay/Physics';
import { PostFX } from '@/gfx/PostFX';
import { VfxSystem } from '@/gfx/vfx/VfxSystem';
import { Player } from '@/gameplay/Player';
import { WeaponSystem } from '@/gameplay/weapons/WeaponSystem';
import { EnemyManager } from '@/gameplay/enemies/EnemyManager';
import { AiDirector } from '@/gameplay/ai/AiDirector';
import { UiRoot } from '@/ui/UiRoot';

const q = new URLSearchParams(location.search);
const planet = (q.get('planet') ?? 'aurvangr') as PlanetId;
const enemyCount = Number(q.get('enemies') ?? '8');
if (q.get('tier')) settings.setTier(q.get('tier') as never);

const marks: string[] = [];
const W = window as unknown as Record<string, unknown>;
W.SANDBOX_MARKS = marks;
const mark = (s: string): void => {
  marks.push(`${s}@${Math.round(performance.now())}`);
  const el = document.getElementById('boot-label');
  if (el) el.textContent = s;
};

/** A Level backed by the real terrain + sky, so collision and lighting are real. */
class SandboxLevel implements Level {
  readonly id = `sandbox:${planet}`;
  readonly scene = new THREE.Scene();
  readonly collision = new BvhCollisionWorld();
  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  readonly sunColor = new THREE.Color(1, 1, 1);
  readonly fogColor = new THREE.Color(0.5, 0.6, 0.7);

  sky!: SkyDome;
  builder!: TerrainBuilder;
  terrain!: Awaited<ReturnType<TerrainBuilder['build']>>;
  private spawn = new THREE.Vector3();

  constructor(private materials: MaterialLibrary) {}

  async load(onProgress?: (t: number, label: string) => void): Promise<void> {
    onProgress?.(0.05, 'atmosphere');
    this.sky = new SkyDome(ATMOSPHERES[planet]);
    this.sky.attach(this.scene);
    this.sky.applyFog(this.scene);
    // IBL must come from this world's own sky or every metal reflects the wrong planet.
    this.materials.rebuildEnvironment(this.sky.environmentProfile());
    this.scene.environment = this.materials.environment;
    this.sunDirection.copy(this.sky.sun.position).normalize();
    this.sunColor.copy(this.sky.sun.color);
    const fog = this.scene.fog as THREE.Fog | THREE.FogExp2 | null;
    if (fog) this.fogColor.copy(fog.color);

    onProgress?.(0.25, 'terrain');
    this.builder = new TerrainBuilder(this.materials);
    this.terrain = await this.builder.build(terrainRecipe(planet), (t) =>
      onProgress?.(0.25 + t * 0.65, 'terrain'),
    );
    if (new URLSearchParams(location.search).get('noterrain') !== '1') {
      this.scene.add(this.terrain.object);
    }

    // Analytic ground: exact, allocation-free, and far cheaper than raycasting.
    const hf = this.terrain.heightField;
    this.collision.groundFn = hf.groundFn;
    for (const m of this.terrain.colliders) this.collision.addMesh(m, 'rock');

    onProgress?.(0.95, 'spawn');
    this.spawn.copy(pickSpawn(hf, this.sky.sun.position));
  }

  update(ctx: FrameContext): void {
    if (this.camera) this.camera.getWorldPosition(this.cameraPos);
    this.sky.update(ctx.elapsed, this.cameraPos);
    this.builder.update(this.camera as THREE.Camera, ctx.elapsed);
  }

  camera: THREE.Camera | null = null;
  cameraPos = new THREE.Vector3();

  getSpawnPoint(): { position: THREE.Vector3; yaw: number } {
    return { position: this.spawn.clone(), yaw: 0 };
  }

  dispose(): void {
    this.terrain?.dispose();
    this.sky?.dispose();
    this.collision.clear();
  }
}


/**
 * Choose a spawn with a view.
 *
 * Dropping the player at the world origin put them in a bowl ringed by 300 m
 * peaks: the sky was almost entirely occluded and the whole frame read as a
 * black wall. Prefer a local high point with open ground toward the sun, which
 * is what a level designer would hand-place.
 */
function pickSpawn(hf: { height(x: number, z: number): number }, sunPos: THREE.Vector3): THREE.Vector3 {
  const sunDir = sunPos.clone().normalize();
  let best: THREE.Vector3 | null = null;
  let bestScore = -Infinity;
  const R = 340;
  for (let i = 0; i < 220; i++) {
    // Golden-angle spiral: even coverage without a grid's directional bias.
    const t = i / 220;
    const a = i * 2.399963;
    const r = Math.sqrt(t) * R;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = hf.height(x, z);

    // Prominence: how far above the surrounding land this point sits.
    let around = 0;
    for (let k = 0; k < 8; k++) {
      const ka = (k / 8) * Math.PI * 2;
      around += hf.height(x + Math.cos(ka) * 90, z + Math.sin(ka) * 90);
    }
    const prominence = y - around / 8;

    // Sky openness toward the sun: march outward and penalise anything that
    // rises above the horizon line from here.
    let block = 0;
    for (let d = 40; d <= 400; d += 40) {
      const hx = x + sunDir.x * d;
      const hz = z + sunDir.z * d;
      const rise = (hf.height(hx, hz) - y) / d;
      if (rise > 0.12) block += rise;
    }

    const score = prominence * 1.0 - block * 60 - Math.abs(y) * 0.02;
    if (score > bestScore) {
      bestScore = score;
      best = new THREE.Vector3(x, y + 1.2, z);
    }
  }
  return best ?? new THREE.Vector3(0, hf.height(0, 0) + 1.2, 0);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const engine = new Engine(canvas);

  mark('materials');
  const materials = new MaterialLibrary(engine.host.renderer);
  await materials.warmup((t, l) => {
    const el = document.getElementById('boot-label');
    if (el) el.textContent = `${l} ${Math.round(t * 100)}%`;
  });

  // Per-pass bisection switches. settings.profile returns the live tier object,
  // so mutating it before PostFX is constructed disables the pass at build time.
  const prof = settings.profile as unknown as Record<string, unknown>;
  if (q.get('nossao') === '1') prof.ssaoEnabled = false;
  if (q.get('novol') === '1') prof.volumetricLightEnabled = false;
  if (q.get('nobloom') === '1') prof.bloomEnabled = false;

  mark('postfx');
  // ?nopost=1 bypasses the chain entirely, to tell "the pass is wrong" apart
  // from "the scene is wrong".
  const usePost = q.get('nopost') !== '1';
  const postfx = usePost ? new PostFX(engine) : null;

  mark('vfx');
  const vfx = engine.add(new VfxSystem(materials));

  mark('level');
  const level = new SandboxLevel(materials);
  await level.load((t, l) => {
    const el = document.getElementById('boot-label');
    if (el) el.textContent = `${l} ${Math.round(t * 100)}%`;
  });
  level.camera = engine.host.camera;
  engine.setLevel(level);
  postfx?.onLevelChanged(level);
  vfx.attach(level.scene);

  if (q.get('noshadow') === '1') engine.host.renderer.shadowMap.enabled = false;

  mark('player');
  const player = engine.add(new Player(engine));
  player.bindCollision(level.collision as CollisionWorld);
  const sp = level.getSpawnPoint();
  player.teleport(sp.position, sp.yaw + (Number(q.get('yaw') ?? '0') * Math.PI) / 180);

  mark('weapons');
  const weapons = engine.add(new WeaponSystem(engine, player, vfx));
  weapons.bindLevel(level);

  mark('enemies');
  const enemies = engine.add(new EnemyManager(engine, materials, vfx));
  enemies.bindLevel(level);

  mark('ai');
  // ?noai=1 leaves enemies exactly where they are placed, so a review shot can
  // actually frame them instead of chasing units that path away mid-settle.
  const ai = q.get('noai') === '1' ? null : engine.add(new AiDirector(engine, enemies as never, player));
  ai?.bindLevel(level);

  mark('ui');
  const ui = engine.add(new UiRoot(engine));
  ui.showLoading(false, '');

  // Ring of enemies around the spawn, on real ground.
  mark('spawn-enemies');
  const kinds = ['training.biped', 'training.quadruped', 'training.hexapod', 'training.flyer'];
  const hf = level.terrain.heightField;
  let spawned = 0;
  for (let i = 0; i < enemyCount; i++) {
    const a = (i / enemyCount) * Math.PI * 2;
    const r = 14 + (i % 3) * 6;
    const x = sp.position.x + Math.cos(a) * r;
    const z = sp.position.z + Math.sin(a) * r;
    const pos = new THREE.Vector3(x, hf.height(x, z) + 1.0, z);
    if (enemies.spawn(kinds[i % kinds.length], pos, a + Math.PI)) spawned++;
  }

  // Close-up review camera: park the player a few metres from the first enemy
  // and look at it, so the procedural bodies and gait can actually be judged.
  if (q.get('enemycam') === '1') {
    // Move the subjects to the camera rather than the camera to the subjects:
    // the player's pitch is driven internally, so on sloped ground an uphill
    // enemy ends up out of frame. Lining them up ahead at the player's own
    // ground height keeps them centred with pitch at zero.
    const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), sp.yaw);
    const side = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), sp.yaw);
    enemies.active.forEach((e, i) => {
      const lane = (i - (enemies.active.length - 1) / 2) * 2.6;
      const p = sp.position.clone().addScaledVector(fwd, 7.5).addScaledVector(side, lane);
      p.y = hf.height(p.x, p.z) + (e.archetype?.capsuleHalfHeight ?? 0.9);
      e.position.copy(p);
    });
  }

  engine.state = 'playing';
  engine.start();

  W.SANDBOX = {
    ready: true,
    planet,
    spawned,
    enemyCount,
    tier: settings.user.tier,
    engine,
    diag: () => {
      const cam = engine.host.camera;
      const p = new THREE.Vector3();
      cam.getWorldPosition(p);
      const g = level.terrain.heightField.height(p.x, p.z);
      return {
        camPos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
        groundAtCam: +g.toFixed(1),
        aboveGround: +(p.y - g).toFixed(2),
        playerPos: player.position.toArray().map((n) => +n.toFixed(1)),
        grounded: player.grounded,
        camFar: cam.far,
        skyVisible: level.sky.object.visible,
        sunIntensity: level.sky.sun.intensity,
        sunPos: level.sky.sun.position.toArray().map((n) => +n.toFixed(1)),
        ambIntensity: level.sky.ambient.intensity,
        fog: level.scene.fog ? (level.scene.fog as THREE.FogExp2).density ?? 'linear' : null,
      };
    },
    stats: () => ({
      fps: Math.round(engine.fps * 10) / 10,
      ...engine.host.stats,
      activeEnemies: enemies.active.length,
      glError: engine.host.gl.getError(),
    }),
  };
  document.getElementById('boot')?.remove();
}

main().catch((e) => {
  const el = document.getElementById('boot-label');
  if (el) {
    el.textContent = `FAILED: ${String((e as Error)?.message ?? e)}`;
    el.style.color = '#ff8080';
  }
  W.SANDBOX_ERROR = String((e as Error)?.stack ?? e);
  console.error('[sandbox]', e);
});
