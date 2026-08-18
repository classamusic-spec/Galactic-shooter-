/**
 * Enemy turntable.
 *
 * Flat ground, studio lighting, no AI, no terrain — the only way to actually
 * judge creature silhouettes, proportions and foot planting. Reviewing enemies
 * inside the sandbox does not work: sloped ground and live pathing move them out
 * of frame faster than a capture can settle.
 *
 * ?species=a,b,c   explicit list (default: every registered species)
 * ?silhouette=1    black bodies on white, for pure shape review
 * ?dist=12         camera distance
 */
import * as THREE from 'three';
import type { CollisionWorld, FrameContext, Level } from '@/types';
import { Engine } from '@/core/Engine';
import { settings } from '@/core/Settings';
import { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { BvhCollisionWorld } from '@/gameplay/Physics';
import { VfxSystem } from '@/gfx/vfx/VfxSystem';
import { EnemyManager } from '@/gameplay/enemies/EnemyManager';
import { ARCHETYPES } from '@/gameplay/enemies/Archetypes';
// The faction registry (factions/index.ts) is still being written, so nothing
// pulls these in for their registerSpecies side effects yet. Import them
// directly and tolerate any that have not landed.
import { registerNordicSpecies } from '@/gameplay/enemies/factions/nordic';
import { registerGreySpecies } from '@/gameplay/enemies/factions/grey';

const q = new URLSearchParams(location.search);
const silhouette = q.get('silhouette') === '1';
const dist = Number(q.get('dist') ?? '13');
if (q.get('tier')) settings.setTier(q.get('tier') as never);

const say = (t: string): void => {
  const el = document.getElementById('boot-label');
  if (el) el.textContent = t;
};

/** Flat, featureless level: the ground is an analytic plane at y = 0. */
class FlatLevel implements Level {
  readonly id = 'enemy-turntable';
  readonly scene = new THREE.Scene();
  readonly collision = new BvhCollisionWorld();
  readonly sunDirection = new THREE.Vector3(0.5, 0.7, 0.5).normalize();
  readonly sunColor = new THREE.Color(1, 1, 1);
  readonly fogColor = new THREE.Color(0.1, 0.12, 0.16);

  async load(): Promise<void> {
    this.collision.groundFn = (_x, _z, n) => {
      n.set(0, 1, 0);
      return 0;
    };
  }
  update(_ctx: FrameContext): void {}
  getSpawnPoint(): { position: THREE.Vector3; yaw: number } {
    return { position: new THREE.Vector3(0, 0, 0), yaw: 0 };
  }
  dispose(): void {
    this.collision.clear();
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const engine = new Engine(canvas);
  const renderer = engine.host.renderer;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  say('materials');
  const materials = new MaterialLibrary(renderer);
  await materials.warmup((t, l) => say(`${l} ${Math.round(t * 100)}%`));
  materials.rebuildEnvironment({
    zenith: silhouette ? 0xffffff : 0x33507a,
    horizon: silhouette ? 0xffffff : 0x9fb8d4,
    ground: silhouette ? 0xffffff : 0x2a2622,
    sunColor: 0xfff4e2,
    sunDirection: new THREE.Vector3(0.5, 0.7, 0.5).normalize(),
    sunSize: 1,
    sunIntensity: silhouette ? 0.2 : 2.6,
    turbidity: 0.35,
  });

  say('level');
  const level = new FlatLevel();
  await level.load();
  level.scene.environment = materials.environment;
  level.scene.background = new THREE.Color(silhouette ? 0xffffff : 0x0d1420);

  const vfx = engine.add(new VfxSystem(materials));
  engine.setLevel(level);
  vfx.attach(level.scene);

  // Studio rig: key with shadows, cool fill from behind to separate the
  // silhouette from the backdrop — the standard character-review setup.
  const key = new THREE.DirectionalLight(0xfff2dc, silhouette ? 0.15 : 3.0);
  key.position.set(7, 9, 13);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const kc = key.shadow.camera as THREE.OrthographicCamera;
  kc.left = -18; kc.right = 18; kc.top = 18; kc.bottom = -18; kc.near = 1; kc.far = 60;
  kc.updateProjectionMatrix();
  key.shadow.normalBias = 0.02;
  level.scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fc8ff, silhouette ? 0 : 2.2);
  rim.position.set(-9, 4, -8);
  level.scene.add(rim);
  level.scene.add(new THREE.HemisphereLight(0x8ea8c8, 0x2a2622, silhouette ? 0.1 : 0.5));

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    silhouette
      ? new THREE.MeshBasicMaterial({ color: 0xffffff })
      : materials.surface('concrete', { repeat: 24 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = !silhouette;
  level.scene.add(ground);

  say('enemies');
  for (const [name, reg] of [
    ['nordic', registerNordicSpecies],
    ['grey', registerGreySpecies],
  ] as Array<[string, () => void]>) {
    try {
      reg();
      console.log(`[turntable] registered ${name}`);
    } catch (e) {
      console.warn(`[turntable] species registration failed for ${name}`, e);
    }
  }
  console.log('[turntable] species now registered:', EnemyManager.registered.join(','));
  const enemies = engine.add(new EnemyManager(engine, materials, vfx));
  enemies.bindLevel(level);

  const requested = (q.get('species') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const ids = requested.length ? requested : Object.keys(ARCHETYPES);
  const placed: string[] = [];
  const SPACING = 3.4;
  ids.forEach((id, i) => {
    const x = (i - (ids.length - 1) / 2) * SPACING;
    const agent = enemies.spawn(id, new THREE.Vector3(x, 0, 0), Math.PI);
    if (agent) placed.push(id);
  });

  if (silhouette) {
    const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
    level.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m !== ground) m.material = black;
    });
  }

  // A 95-degree gameplay FOV renders a 2 m creature as a handful of pixels at
  // review distance. Go through settings so RendererHost.applyFov keeps it after
  // any resize, rather than setting camera.fov directly and being overwritten.
  const fov = Number(q.get('fov') ?? '34');
  settings.patch({ fov });
  const cam = engine.host.camera;
  const span = Math.max(1, placed.length) * SPACING;
  // Frame the row: half-span over tan(halfFov) is the distance that just fits it.
  const need = span * 0.5 / Math.tan((fov * Math.PI) / 360) + 2.5;
  cam.position.set(0, 1.35, Math.max(dist, need));
  cam.lookAt(0, 1.05, 0);
  cam.updateProjectionMatrix();

  engine.state = 'playing';
  engine.start();

  // The engine's fixed-step loop drives the animator; give it real frames so
  // gait and IK settle before anyone looks at the result.
  (window as unknown as Record<string, unknown>).ENEMYSCENE = {
    ready: true,
    requested: ids,
    placed,
    missing: ids.filter((i) => !placed.includes(i)),
    engine,
    stats: () => ({ ...engine.host.stats, active: enemies.active.length }),
    freezeCamera: (x: number, y: number, z: number, tx: number, ty: number, tz: number) => {
      cam.position.set(x, y, z);
      cam.lookAt(tx, ty, tz);
    },
  };
  document.getElementById('boot')?.remove();
}

main().catch((e) => {
  say(`FAILED: ${String((e as Error)?.message ?? e)}`);
  (window as unknown as Record<string, unknown>).ENEMYSCENE_ERROR = String((e as Error)?.stack ?? e);
  console.error(e);
});
