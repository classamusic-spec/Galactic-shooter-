/**
 * Lit material showcase.
 *
 * Flat texture thumbnails prove a recipe compiles; they do not prove the
 * material *reads* correctly. This renders every surface as a real shaded sphere
 * under the procedural IBL plus a hard sun, which is the only way to tell
 * whether metal reflects, ice looks cold, and rock has believable cavity
 * shading. It doubles as the visual baseline the critic reviews.
 */
import * as THREE from 'three';
import { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { SURFACE_NAMES } from '@/gfx/materials/SurfaceMaterials';

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
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 200);

const lib = new MaterialLibrary(renderer);
await lib.warmup((t, label) => {
  const el = document.getElementById('boot-label');
  if (el) el.textContent = `${label} ${Math.round(t * 100)}%`;
});

// Sun comes from upper-front-LEFT so cast shadows land on the backdrop wall and
// are actually visible. Lighting from behind the camera hides every shadow behind
// the object casting it, which is why the first pass looked shadowless.
const sunDir = new THREE.Vector3(0.72, 0.52, 0.45).normalize();
// Neutral studio: the IBL supplies all indirect light, one directional supplies
// the sun. No hemisphere light on top — stacking a third source is what turns a
// PBR scene into a blown-out white mess.
lib.rebuildEnvironment({
  zenith: 0x1d4470,
  horizon: 0xa8c4dc,
  ground: 0x33291f,
  sunColor: 0xfff0d8,
  sunDirection: sunDir,
  sunIntensity: 2.4,
  turbidity: 0.4,
});
scene.environment = lib.environment;
scene.background = lib.environment;

const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
sun.position.copy(sunDir).multiplyScalar(40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 120;
sun.shadow.camera.left = -26;
sun.shadow.camera.right = 26;
sun.shadow.camera.top = 26;
sun.shadow.camera.bottom = -26;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);

// Ground sits below the lowest sphere so nothing is buried, and receives shadow
// so the contact darkening is visible — a scene with no cast shadow always reads
// as flat regardless of how good the materials are.
sun.shadow.camera.updateProjectionMatrix();

const groundMat = lib.surface('concrete', { repeat: 14 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -6.0;
ground.receiveShadow = true;
scene.add(ground);

// Backdrop the shadows can land on, in a neutral mid-grey so it does not compete
// with the spheres for attention.
const wall = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 30),
  new THREE.MeshStandardMaterial({ color: 0x4a4f56, roughness: 0.92, metalness: 0 }),
);
wall.position.set(0, 0.5, -6.5);
wall.receiveShadow = true;
scene.add(wall);

// Grid of spheres, one per surface, labelled by position.
const sphere = new THREE.SphereGeometry(1, 64, 48);
const COLS = 6;
const SPACING = 2.55;
const names = SURFACE_NAMES;
const rows = Math.ceil(names.length / COLS);

// A label strip drawn into a canvas texture, so the reviewer can tell which
// sphere is which without counting grid positions.
function labelSprite(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(4,8,14,0.72)';
  g.fillRect(0, 0, 256, 48);
  g.font = '600 26px monospace';
  g.fillStyle = '#7fe8ff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 25);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, toneMapped: false }));
  s.scale.set(2.1, 0.4, 1);
  return s;
}

names.forEach((name, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = (col - (COLS - 1) / 2) * SPACING;
  const y = ((rows - 1) / 2 - row) * SPACING;
  // Foliage is an alpha-tested card material; a sphere is a meaningless test for
  // it, so show it on a quad instead.
  const isCard = name === 'foliage';
  const mat = lib.surface(name as never, { repeat: isCard ? 1 : 2 });
  const mesh = new THREE.Mesh(isCard ? new THREE.PlaneGeometry(1.9, 1.9) : sphere, mat);
  mesh.position.set(x, y, 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  const label = labelSprite(name);
  label.position.set(x, y - 1.32, 1.05);
  scene.add(label);
});

camera.position.set(0, 0, 16.2);
camera.lookAt(0, 0, 0);

let frames = 0;
function frame(): void {
  frames++;
  renderer.render(scene, camera);
  if (frames < 4) requestAnimationFrame(frame);
  else {
    document.getElementById('boot')?.remove();
    (window as unknown as { SCENETEST: unknown }).SCENETEST = {
      done: true,
      names,
      cols: COLS,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs?.length ?? 0,
      glError: renderer.getContext().getError(),
    };
  }
}
requestAnimationFrame(frame);
