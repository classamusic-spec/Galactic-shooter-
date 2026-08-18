/**
 * Temporary capture harness for the enemy framework. Delete when done.
 *
 * ?species=biped|quadruped|hexapod|flyer  ?count=40  ?mode=walk|combat|death
 * ?view=front|wide|close|top
 */
import * as THREE from 'three';
import { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { VfxSystem } from '@/gfx/vfx/VfxSystem';
import { EnemyManager } from '@/gameplay/enemies/EnemyManager';
import { ARCHETYPES } from '@/gameplay/enemies/Archetypes';
import { settings } from '@/core/Settings';
import type { Engine } from '@/core/Engine';
import type { CapsuleResolveResult, CollisionWorld, DamageInfo, FrameContext, RaycastHit } from '@/types';
import type { HitProxy } from '@/gameplay/Physics';

const params = new URLSearchParams(location.search);
const speciesKey = params.get('species') ?? 'biped';
const COUNT = Number(params.get('count') ?? '40');
const MODE = params.get('mode') ?? 'walk';
const VIEW = params.get('view') ?? 'front';
const tier = params.get('tier');
if (tier) settings.setTier(tier as never);

const label = document.getElementById('boot')!;
const say = (s: string): void => {
  label.textContent = s;
};

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14202e);
scene.fog = new THREE.Fog(0x1b2a3c, 40, 220);
const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 900);

say('baking materials');
const materials = new MaterialLibrary(renderer);
await materials.warmup((t, l) => say(`${l} ${Math.round(t * 100)}%`));
scene.environment = materials.environment;

// -- lighting ---------------------------------------------------------------
const sun = new THREE.DirectionalLight(0xffe9cf, 3.4);
sun.position.set(28, 34, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera as THREE.OrthographicCamera;
sc.left = -30;
sc.right = 30;
sc.top = 30;
sc.bottom = -30;
sc.near = 1;
sc.far = 140;
sc.updateProjectionMatrix();
sun.shadow.bias = -0.0006;
scene.add(sun);
scene.add(sun.target);
const fill = new THREE.HemisphereLight(0x88b6ff, 0x2a2018, 0.9);
scene.add(fill);
const rim = new THREE.DirectionalLight(0x7fc8ff, 1.5);
rim.position.set(-24, 12, -30);
scene.add(rim);

// -- ground -----------------------------------------------------------------
const RELIEF = Number(params.get('relief') ?? '1');
const H = (x: number, z: number): number =>
  (Math.sin(x * 0.07) * 0.85 + Math.cos(z * 0.055) * 0.7 + Math.sin((x + z) * 0.023) * 1.4) * RELIEF;

const GROUND = 220;
const groundGeo = new THREE.PlaneGeometry(GROUND, GROUND, 160, 160);
groundGeo.rotateX(-Math.PI / 2);
{
  const p = groundGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, H(p.getX(i), p.getZ(i)));
  groundGeo.computeVertexNormals();
}
const groundMat = materials.surface('rock', { repeat: 26 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.receiveShadow = true;
scene.add(ground);

function groundNormal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const e = 0.35;
  const hx = H(x + e, z) - H(x - e, z);
  const hz = H(x, z + e) - H(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

// -- fake collision world ---------------------------------------------------
const proxies: HitProxy[] = [];
const collision: CollisionWorld & { addProxy(p: HitProxy): HitProxy; removeProxiesFor(id: number): void } = {
  raycast(origin, direction, maxDistance, out) {
    // March against the heightfield. Good enough for wall probes on open ground.
    const step = 0.35;
    const p = new THREE.Vector3();
    for (let t = step; t < maxDistance; t += step) {
      p.copy(origin).addScaledVector(direction, t);
      const h = H(p.x, p.z);
      if (p.y <= h) {
        const o = out ?? ({ point: new THREE.Vector3(), normal: new THREE.Vector3() } as RaycastHit);
        o.distance = t;
        o.point.copy(p);
        groundNormal(p.x, p.z, o.normal);
        o.surface = 'rock';
        o.damageable = undefined;
        o.region = undefined;
        return o;
      }
    }
    return null;
  },
  resolveCapsule(position, radius, halfHeight, velocity, dt): CapsuleResolveResult {
    position.addScaledVector(velocity, dt);
    const y = H(position.x, position.z) + halfHeight + radius;
    const grounded = position.y <= y;
    if (grounded) {
      position.y = y;
      if (velocity.y < 0) velocity.y = 0;
    }
    return {
      grounded,
      groundNormal: groundNormal(position.x, position.z, new THREE.Vector3()),
      slope: 0,
      touchedWall: false,
      wallNormal: new THREE.Vector3(),
      landingImpact: 0,
    };
  },
  sampleGround(x, z) {
    return { y: H(x, z), normal: groundNormal(x, z, new THREE.Vector3()) };
  },
  lineOfSight() {
    return true;
  },
  addProxy(p) {
    proxies.push(p);
    return p;
  },
  removeProxiesFor(id) {
    for (let i = proxies.length - 1; i >= 0; i--) if (proxies[i].damageable.entityId === id) proxies.splice(i, 1);
  },
};

// -- stubs ------------------------------------------------------------------
const playerStub = {
  name: 'player',
  entityId: 0,
  health: 300,
  maxHealth: 300,
  shield: 0,
  maxShield: 0,
  isDead: false,
  position: new THREE.Vector3(0, 0, 26),
  velocity: new THREE.Vector3(),
  eyePosition: new THREE.Vector3(0, 1.7, 26),
  applyDamage: () => 0,
  getWorldPosition: (out: THREE.Vector3) => out.copy(playerStub.position),
};

const engine = {
  host: { camera },
  get(name: string) {
    return name === 'player' ? playerStub : undefined;
  },
} as unknown as Engine;

say('building vfx');
const vfx = new VfxSystem(materials);
vfx.attach(scene);

say('building enemies');
const enemies = new EnemyManager(engine, materials, vfx);
enemies.bindLevel({
  id: 'test',
  scene,
  collision,
  load: async () => {},
  update: () => {},
  getSpawnPoint: () => ({ position: new THREE.Vector3(), yaw: 0 }),
  sunDirection: new THREE.Vector3(0, 1, 0),
  sunColor: new THREE.Color(1, 1, 1),
  fogColor: new THREE.Color(0, 0, 0),
  dispose: () => {},
});

const archetypeId = `training.${speciesKey}`;
if (params.get('shield')) {
  const a = ARCHETYPES[archetypeId];
  a.shield = 180;
  a.shieldElement = 'arc';
}
const agents = [];
const cols = Math.ceil(Math.sqrt(COUNT));
for (let i = 0; i < COUNT; i++) {
  const gx = (i % cols) - (cols - 1) / 2;
  const gz = Math.floor(i / cols) - (cols - 1) / 2;
  const x = gx * 3.0;
  const z = gz * 3.0 - 6;
  const a = enemies.spawn(archetypeId, new THREE.Vector3(x, H(x, z), z), Math.PI);
  if (a) agents.push(a);
}
say(`spawned ${agents.length}/${COUNT} ${archetypeId}`);

// In walk mode the behaviour tree is bypassed so the animation is isolated.
if (MODE === 'walk') {
  for (const a of agents) a.brain = null;
}

// -- camera -----------------------------------------------------------------
const VIEWS: Record<string, { pos: THREE.Vector3; look: THREE.Vector3; fov: number }> = {
  front: { pos: new THREE.Vector3(0, 2.4, 14), look: new THREE.Vector3(0, 1.0, -2), fov: 46 },
  close: { pos: new THREE.Vector3(2.2, 1.5, 4.4), look: new THREE.Vector3(0, 1.1, 0), fov: 40 },
  wide: { pos: new THREE.Vector3(18, 9, 26), look: new THREE.Vector3(0, 1, -4), fov: 46 },
  top: { pos: new THREE.Vector3(0, 22, 12), look: new THREE.Vector3(0, 0, -4), fov: 52 },
  feet: { pos: new THREE.Vector3(0.0, 0.55, 5.0), look: new THREE.Vector3(0, 0.35, 0), fov: 38 },
};
const view = VIEWS[VIEW] ?? VIEWS.front;
// Camera heights are relative to the terrain, or the eye ends up underground.
camera.position.copy(view.pos);
camera.position.y += H(view.pos.x, view.pos.z);
const lookAt = view.look.clone();
lookAt.y += H(view.look.x, view.look.z);
camera.lookAt(lookAt);
camera.fov = view.fov;
camera.updateProjectionMatrix();
sun.target.position.set(0, 0, 0);

// -- loop -------------------------------------------------------------------
const SIM_DT = 1 / 120;
let acc = 0;
let last = performance.now();
let elapsed = 0;
let tick = 0;
const ctx: FrameContext = { dt: SIM_DT, frameDt: SIM_DT, elapsed: 0, tick: 0 };
let animMsPeak = 0;
let animMsSum = 0;
let animFrames = 0;
let killed = false;

const _tmp = new THREE.Vector3();

function driveWalk(t: number): void {
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (a.state !== 'alive') continue;
    // A slow lissajous march so the gait sees turning, acceleration and slopes.
    const ph = t * 0.35 + i * 0.31;
    const speed = a.archetype.moveSpeed * (0.55 + 0.45 * Math.sin(t * 0.4 + i));
    a.ai.desiredVelocity.set(Math.cos(ph) * speed, 0, Math.sin(ph * 0.7) * speed);
    if (a.archetype.flying) a.ai.desiredVelocity.y = Math.sin(t * 0.6 + i) * 1.2;
    a.ai.lookValid = true;
    a.ai.lookAt.copy(playerStub.eyePosition);
  }
}

const info: DamageInfo = {
  amount: 999,
  element: 'kinetic',
  region: 'body',
  precision: false,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  direction: new THREE.Vector3(0, 0.2, -1).normalize(),
  sourceId: 0,
  impulse: 10,
};

const centroid = new THREE.Vector3();
function frameCamera(): void {
  // Follow the group so the framing stays useful while the agents wander.
  centroid.set(0, 0, 0);
  let n = 0;
  for (const a of agents) {
    centroid.add(a.position);
    n++;
  }
  if (n === 0) return;
  centroid.multiplyScalar(1 / n);
  camera.position.copy(view.pos).add(centroid);
  camera.position.y = centroid.y + view.pos.y;
  const l = view.look.clone().add(centroid);
  l.y = centroid.y + view.look.y;
  camera.lookAt(l);
  sun.target.position.copy(centroid);
  sun.position.copy(centroid).add(new THREE.Vector3(18, 26, 14));
}

function frame(): void {
  requestAnimationFrame(frame);
  frameCamera();
  const now = performance.now();
  const frameDt = Math.min((now - last) / 1000, 0.25);
  last = now;
  acc += frameDt;

  playerStub.position.set(Math.sin(elapsed * 0.25) * 6, H(0, 26), 26);
  playerStub.eyePosition.set(playerStub.position.x, playerStub.position.y + 1.7, playerStub.position.z);

  let steps = 0;
  while (acc >= SIM_DT && steps < 30) {
    acc -= SIM_DT;
    steps++;
    tick++;
    elapsed += SIM_DT;
    ctx.dt = SIM_DT;
    ctx.frameDt = frameDt;
    ctx.elapsed = elapsed;
    ctx.tick = tick;
    if (MODE === 'walk') driveWalk(elapsed);
    if (MODE === 'death' && !killed && elapsed > 1e9) {
      killed = true;
      for (const a of agents) {
        a.getWorldPosition(info.point);
        info.point.y += 0.4;
        a.health = 0.0001;
        a.applyDamage(info);
      }
    }
    enemies.update(ctx);
    vfx.update(ctx);
  }

  const t0 = performance.now();
  enemies.render(ctx, acc / SIM_DT);
  const ms = performance.now() - t0;
  animMsPeak = Math.max(animMsPeak, ms);
  animMsSum += ms;
  animFrames++;
  vfx.render(ctx, acc / SIM_DT);

  renderer.render(scene, camera);
  renderer.info.reset();
}

interface TestApi {
  stats(): Record<string, number>;
  resetSlide(): void;
  kill(): void;
  ready: boolean;
}

const api: TestApi = {
  ready: true,
  resetSlide() {
    for (const a of agents) {
      a.anim.maxFootSlide = 0;
      a.anim.maxPlantError = 0;
    }
    enemies.stats.maxFootSlide = 0;
    animMsPeak = 0;
    animMsSum = 0;
    animFrames = 0;
  },
  kill() {
    for (const a of agents) {
      a.getWorldPosition(info.point);
      a.health = 0.0001;
      a.applyDamage(info);
    }
  },
  stats() {
    let slide = 0;
    let plantErr = 0;
    let diag = { speed: 0, ratio: 0, dt: 0, lod: 0, cadence: 0 };
    let nan = 0;
    let settled = 0;
    let dying = 0;
    for (const a of agents) {
      plantErr = Math.max(plantErr, a.anim.maxPlantError);
      if (a.anim.maxFootSlide > slide) {
        slide = a.anim.maxFootSlide;
        diag = { ...a.anim.slideDiag, lod: ['full', 'reduced', 'coarse', 'distant'].indexOf(a.lod) };
      }
      if (!a.rig.validate()) nan++;
      if (a.state === 'dying') {
        dying++;
        if (a.ragdoll.settled) settled++;
      }
      for (const b of a.rig.bones) {
        b.updateWorldMatrix(false, false);
        const e = b.matrixWorld.elements;
        for (let i = 0; i < 16; i++) if (!Number.isFinite(e[i])) nan++;
      }
    }
    renderer.info.reset();
    renderer.render(scene, camera);
    return {
      agents: agents.length,
      live: enemies.stats.live,
      dying,
      settled,
      ragdollMotionMm: agents.reduce((m, a) => Math.max(m, a.state === 'dying' ? a.ragdoll.motionEstimate * 1000 : 0), 0),
      maxFootSlideCm: slide * 100,
      maxPlantErrorCm: plantErr * 100,
      slideSpeed: diag.speed,
      slideRatio: diag.ratio,
      slideDt: diag.dt,
      slideLod: diag.lod,
      slideCadence: diag.cadence,
      nanBones: nan,
      renderMsPeak: animMsPeak,
      renderMsAvg: animFrames ? animMsSum / animFrames : 0,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs?.length ?? 0,
      proxies: proxies.length,
      _tmp: _tmp.x,
    };
  },
};

(window as unknown as { ENEMY_TEST: TestApi }).ENEMY_TEST = api;
(window as unknown as { __AGENTS: unknown[] }).__AGENTS = agents;
say(`${archetypeId} x${agents.length} mode=${MODE} view=${VIEW}`);
frame();
