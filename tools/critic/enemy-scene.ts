/**
 * Enemy turntable.
 *
 * Flat ground, studio lighting, no AI, no terrain — the only way to actually
 * judge creature silhouettes, proportions and foot planting. Reviewing enemies
 * inside the sandbox does not work: sloped ground and live pathing move them out
 * of frame faster than a capture can settle.
 *
 * ?species=a,b,c   explicit list (default: every faction's canonical roster)
 * ?faction=id      one faction's roster (nordic grey mantis insectoid reptilian federation)
 * ?silhouette=1    black bodies on white, for pure shape review
 * ?noshield=1      strip shield shells so anatomy is visible
 * ?dist=12         camera distance
 * ?yaw=180        spawn yaw in degrees (0 faces the camera)
 * ?eye=1.35 ?look=1.05   camera height and look-at height
 */
import * as THREE from 'three';
import type { CollisionWorld, FrameContext, Level } from '@/types';
import { Engine } from '@/core/Engine';
import { settings } from '@/core/Settings';
import { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { BvhCollisionWorld } from '@/gameplay/Physics';
import { VfxSystem } from '@/gfx/vfx/VfxSystem';
import { EnemyManager } from '@/gameplay/enemies/EnemyManager';
import { FACTION_UNITS, registerAllFactions } from '@/gameplay/enemies/factions';

const q = new URLSearchParams(location.search);
const silhouette = q.get('silhouette') === '1';
// 0 = auto-frame from the tallest unit; any explicit value acts as a floor.
const dist = Number(q.get('dist') ?? '0');
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

  // A stand-in player at the camera. `EnemyManager` looks up an engine system
  // named `player` for both the behaviour target and the animator's focus
  // point, and without one every unit animates in its no-target rest stance:
  // arms hanging, head level, weapons pointed at the floor. That is not the
  // pose these bodies were authored for and not the pose a reviewer should be
  // judging, so the turntable supplies one that never moves and never dies.
  class StandInPlayer {
    readonly name = 'player';
    readonly entityId = 0;
    health = 1000;
    maxHealth = 1000;
    shield = 0;
    maxShield = 0;
    readonly isDead = false;
    readonly position = new THREE.Vector3(0, 0, 0);
    readonly velocity = new THREE.Vector3();
    readonly eyePosition = new THREE.Vector3(0, 1.7, 0);
    applyDamage(): number {
      return 0;
    }
    getWorldPosition(out: THREE.Vector3): THREE.Vector3 {
      return out.copy(this.eyePosition);
    }
  }
  const stand = engine.add(new StandInPlayer() as never) as unknown as StandInPlayer;

  say('enemies');
  registerAllFactions();
  console.log('[turntable] species now registered:', EnemyManager.registered.join(','));
  const enemies = engine.add(new EnemyManager(engine, materials, vfx));
  enemies.bindLevel(level);

  const heights: number[] = [];
  const requested = (q.get('species') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const faction = q.get('faction') as keyof typeof FACTION_UNITS | null;
  const ids = requested.length
    ? requested
    : faction
      ? [...(FACTION_UNITS[faction] ?? [])]
      : Object.values(FACTION_UNITS).flat();
  const placed: string[] = [];
  const SPACING = 3.4;
  ids.forEach((id, i) => {
    const x = (i - (ids.length - 1) / 2) * SPACING;
    const agent = enemies.spawn(id, new THREE.Vector3(x, 0, 0), (Number(q.get('yaw') ?? '180') * Math.PI) / 180);
    if (!agent) return;
    // Review affordance: a full shield shell is an opaque ellipsoid over the
    // creature, which is correct in game and useless for judging anatomy.
    if (q.get('noshield') === '1') {
      agent.shield = 0;
      agent.maxShield = 0;
      if (agent.shieldMesh) agent.shieldMesh.visible = false;
    }
    heights.push(agent.height);
    placed.push(id);
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
  // `settings.fov` is HORIZONTAL (RendererHost.applyFov converts it Hor+), so
  // the vertical half-angle — the one that decides whether a head is in frame —
  // is much narrower than it looks. Frame on both axes and take the larger.
  const aspect = Math.max(0.2, window.innerWidth / window.innerHeight);
  const halfH = Math.tan((fov * Math.PI) / 360);
  const halfV = Math.tan(Math.atan(halfH / aspect));
  const tallest = heights.length ? Math.max(...heights) : 2;
  const need = Math.max(
    (span * 0.5 + 0.5) / halfH,
    (tallest * 0.62) / halfV,
  );
  const look = Number(q.get('look') ?? String(tallest * 0.5));
  const camZ = Math.max(dist, need);
  cam.position.set(0, Number(q.get('eye') ?? String(tallest * 0.52)), camZ);
  cam.lookAt(0, look, 0);
  // Put the stand-in where the camera is, so every unit aims down the lens.
  stand.position.set(0, 0, camZ);
  stand.eyePosition.set(0, Number(q.get('aimY') ?? String(tallest * 0.62)), camZ);
  cam.updateProjectionMatrix();

  engine.state = 'playing';
  engine.start();

  // The engine's fixed-step loop drives the animator; give it real frames so
  // gait and IK settle before anyone looks at the result.
  (window as unknown as Record<string, unknown>).ENEMYSCENE = {
    ready: true,
    /** Every species id the registry actually installed. */
    registered: EnemyManager.registered,
    requested: ids,
    placed,
    missing: ids.filter((i) => !placed.includes(i)),
    engine,
    stats: () => ({ ...engine.host.stats, active: enemies.active.length }),
    freezeCamera: (x: number, y: number, z: number, tx: number, ty: number, tz: number) => {
      cam.position.set(x, y, z);
      cam.lookAt(tx, ty, tz);
    },
    /**
     * Frame whatever is actually on screen. The static estimate from
     * `archetype.height` misses everything a unit *carries* — a two-metre stave
     * or a shoulder mortar sits well above the creature's head — so the honest
     * frame comes from the union of the spawned bodies' bounds. Call it after
     * the pose has settled, then give it a few more seconds: it also moves the
     * stand-in player, so the aim pose re-solves.
     */
    autoframe: (margin = 1.15) => {
      const box = new THREE.Box3();
      for (const a of enemies.active) box.expandByObject(a.object);
      if (box.isEmpty()) return null;
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const halfV = Math.tan((cam.fov * Math.PI) / 360);
      const halfHor = halfV * cam.aspect;
      const d =
        Math.max((size.y * 0.5 * margin) / halfV, (size.x * 0.5 * margin) / halfHor) +
        size.z * 0.6;
      cam.position.set(centre.x, centre.y, centre.z + d);
      cam.lookAt(centre);
      stand.position.set(centre.x, 0, centre.z + d);
      stand.eyePosition.set(centre.x, centre.y, centre.z + d);
      return { size: size.toArray(), centre: centre.toArray(), d };
    },
  };
  document.getElementById('boot')?.remove();
}

main().catch((e) => {
  say(`FAILED: ${String((e as Error)?.message ?? e)}`);
  (window as unknown as Record<string, unknown>).ENEMYSCENE_ERROR = String((e as Error)?.stack ?? e);
  console.error(e);
});
