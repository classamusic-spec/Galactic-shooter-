/**
 * Planet surface render test.
 *
 * Wires the three finished visual subsystems — MaterialLibrary, SkyDome and
 * TerrainBuilder — into a real planet surface with a cinematic camera, so the
 * whole pipeline can be reviewed against docs/VISUAL-REVIEW.md before the game
 * layer exists. Drive it with ?planet=<id>&view=<n>.
 */
import * as THREE from 'three';
import { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { SkyDome } from '@/gfx/sky/SkyDome';
import { ATMOSPHERES } from '@/gfx/sky/AtmosphereProfile';
import { TerrainBuilder, terrainRecipe } from '@/gfx/terrain/TerrainBuilder';
import { settings } from '@/core/Settings';
import type { PlanetId } from '@/types';

const params = new URLSearchParams(location.search);
const planet = (params.get('planet') ?? 'aurvangr') as PlanetId;
const viewIndex = Number(params.get('view') ?? '0');
const tier = params.get('tier');
if (tier) settings.setTier(tier as never);

const status = document.getElementById('boot-label');
// Stage markers, so a stall under software rasterisation can be localised
// instead of just timing out with no information.
const stages: string[] = [];
const W = window as unknown as { WORLD_STAGES: string[]; WORLD?: unknown };
W.WORLD_STAGES = stages;
const say = (s: string): void => {
  if (status) status.textContent = s;
};
const stage = (s: string): void => {
  stages.push(`${s} @${Math.round(performance.now())}ms`);
  say(s);
};

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 6000);

stage('materials');
const materials = new MaterialLibrary(renderer);
await materials.warmup((t, l) => say(`${l} ${Math.round(t * 100)}%`));

stage('sky');
const sky = new SkyDome(ATMOSPHERES[planet]);
sky.attach(scene);
sky.applyFog(scene);

// The IBL must be rebuilt from the sky, or metals reflect a generic blue sky on
// a blood-red volcanic world and the whole frame stops agreeing with itself.
materials.rebuildEnvironment(sky.environmentProfile());
scene.environment = materials.environment;

stage('terrain-start');
const builder = new TerrainBuilder(materials);
const recipe = terrainRecipe(planet);
const terrain = await builder.build(recipe, (t) => say(`terrain ${Math.round(t * 100)}%`));
stage('terrain-done');
scene.add(terrain.object);

// Camera set-ups chosen for review value: a player-eye shot, a wide vista, and a
// low hero angle looking into the sun for atmosphere/god-ray evaluation.
const size = recipe.size ?? 1000;
const hf = terrain.heightField;
function place(x: number, z: number, up: number): THREE.Vector3 {
  return new THREE.Vector3(x, hf.height(x, z) + up, z);
}
const VIEWS: Array<{ pos: THREE.Vector3; look: THREE.Vector3; fov: number; name: string }> = [
  {
    name: 'eye',
    pos: place(0, 0, 1.7),
    look: place(0, -70, 6),
    fov: 62,
  },
  {
    name: 'vista',
    pos: place(size * 0.16, size * 0.16, 46),
    look: place(-size * 0.1, -size * 0.12, 0),
    fov: 52,
  },
  {
    name: 'hero-sun',
    pos: place(-size * 0.1, size * 0.05, 2.4),
    look: new THREE.Vector3()
      .copy(place(-size * 0.1, size * 0.05, 2.4))
      .addScaledVector(sky.sun.position.clone().normalize(), 200),
    fov: 70,
  },
];
const view = VIEWS[Math.min(viewIndex, VIEWS.length - 1)];
camera.position.copy(view.pos);
camera.lookAt(view.look);
camera.fov = view.fov;
camera.updateProjectionMatrix();

// Shadow frustum has to be fitted around the camera or a 1km terrain gets one
// blurry shadow texel per building.
const sun = sky.sun;
sun.target.position.copy(camera.position);
scene.add(sun.target);
const sc = sun.shadow.camera as THREE.OrthographicCamera;
sc.left = -90;
sc.right = 90;
sc.top = 90;
sc.bottom = -90;
sc.near = 0.5;
sc.far = 600;
sc.updateProjectionMatrix();
sun.shadow.mapSize.set(settings.profile.shadowMapSize, settings.profile.shadowMapSize);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.05;

stage('camera-ready');
let frames = 0;
const t0 = performance.now();
function frame(): void {
  frames++;
  const elapsed = (performance.now() - t0) / 1000;
  sky.update(elapsed, camera.position);
  stage(`frame${frames}-skyUpdated`);
  builder.update(camera, elapsed);
  stage(`frame${frames}-terrainUpdated`);
  renderer.render(scene, camera);
  stage(`frame${frames}-rendered`);
  if (frames < 3) {
    requestAnimationFrame(frame);
  } else {
    document.getElementById('boot')?.remove();
    (window as unknown as { WORLD: unknown }).WORLD = {
      done: true,
      planet,
      view: view.name,
      tier: settings.user.tier,
      stats: terrain.stats ?? null,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs?.length ?? 0,
      glError: renderer.getContext().getError(),
      camY: +camera.position.y.toFixed(2),
      groundY: +hf.height(camera.position.x, camera.position.z).toFixed(2),
    };
  }
}
requestAnimationFrame(frame);
