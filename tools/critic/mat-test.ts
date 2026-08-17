/**
 * Material bake verification.
 *
 * Renders every baked surface's albedo/normal/ORM to a thumbnail and measures
 * luminance variance. A flat fill (variance ~0) means the recipe failed to
 * compile or produced a constant, which is the failure mode that would otherwise
 * silently ship as "grey plastic everywhere".
 */
import * as THREE from 'three';
import { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { SURFACE_NAMES } from '@/gfx/materials/SurfaceMaterials';

const log = document.getElementById('log')!;
const grid = document.getElementById('grid')!;

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(64, 64);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const glErrors: string[] = [];
const gl = renderer.getContext();
const origCompile = console.error;
console.error = (...args: unknown[]) => {
  glErrors.push(args.map(String).join(' '));
  origCompile(...args);
};

const lib = new MaterialLibrary(renderer);

/** Blit a texture into a small canvas so we can eyeball the bake. */
function thumb(tex: THREE.Texture, size = 128, srgb = false): HTMLCanvasElement {
  const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false });
  const scene = new THREE.Scene();
  const cam = new THREE.Camera();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: 'in vec3 position; in vec2 uv; out vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader:
      'precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D t; uniform float s;' +
      'void main(){ vec4 c = texture(t, vUv); if(s>0.5) c.rgb = pow(c.rgb, vec3(1.0/2.2)); o = vec4(c.rgb,1.0); }',
    uniforms: { t: { value: tex }, s: { value: srgb ? 1 : 0 } },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  const buf = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
  renderer.setRenderTarget(null);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  // readRenderTargetPixels is bottom-up; flip into canvas order.
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    img.data.set(buf.subarray(src, src + size * 4), y * size * 4);
  }
  ctx.putImageData(img, 0, 0);
  rt.dispose();
  geo.dispose();
  mat.dispose();
  return canvas;
}

function variance(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d')!;
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let mean = 0;
  const n = canvas.width * canvas.height;
  for (let i = 0; i < n; i++) mean += (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const l = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
    v += (l - mean) ** 2;
  }
  return Math.sqrt(v / n);
}

const results: Record<string, { albedo: number; normal: number; orm: number; ok: boolean }> = {};

await lib.warmup((t, label) => {
  log.textContent = `baking ${label} (${Math.round(t * 100)}%)`;
});

for (const name of SURFACE_NAMES) {
  const set = lib.pbr(name);
  const a = thumb(set.albedo, 128, true);
  const nrm = thumb(set.normal, 128);
  const orm = thumb(set.orm, 128);
  const va = variance(a);
  const vn = variance(nrm);
  const vo = variance(orm);
  // A real material has detail in albedo AND relief in the normal map.
  const ok = va > 1.5 && vn > 0.8;
  results[name] = { albedo: +va.toFixed(2), normal: +vn.toFixed(2), orm: +vo.toFixed(2), ok };

  const cell = document.createElement('div');
  cell.className = 'cell' + (ok ? '' : ' bad');
  const label = document.createElement('div');
  label.className = 'n';
  label.textContent = `${name} ${ok ? '' : '✗ FLAT'}`;
  cell.appendChild(label);
  cell.appendChild(a);
  const row = document.createElement('div');
  row.style.display = 'flex';
  nrm.style.width = '50%';
  orm.style.width = '50%';
  row.appendChild(nrm);
  row.appendChild(orm);
  cell.appendChild(row);
  const stats = document.createElement('div');
  stats.textContent = `a:${va.toFixed(1)} n:${vn.toFixed(1)} o:${vo.toFixed(1)}`;
  cell.appendChild(stats);
  grid.appendChild(cell);
}

const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
const glErr = gl.getError();
log.textContent =
  `MRT: ${lib.hasMrt}\nGL error: ${glErr}\n` +
  `failed (flat) surfaces: ${failed.length ? failed.join(', ') : 'none'}\n` +
  `shader/console errors: ${glErrors.length}\n` +
  (glErrors.length ? glErrors.slice(0, 3).join('\n---\n') : '');

(window as unknown as { MATTEST: unknown }).MATTEST = {
  results,
  failed,
  hasMrt: lib.hasMrt,
  glError: glErr,
  shaderErrors: glErrors,
  done: true,
};
