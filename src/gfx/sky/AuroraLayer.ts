/**
 * AuroraLayer — the signature shot of the frozen world.
 *
 * Real aurorae are electrons spiralling down field lines and exciting oxygen at
 * 100-300 km, which gives three properties this layer reproduces and which most
 * fake aurorae miss:
 *
 *  1. **The structure is vertical.** Every ray runs along the field line, so the
 *     fine detail varies *across* the curtain and is nearly constant up it. Any
 *     effect whose noise is isotropic instantly reads as smoke, not aurora.
 *  2. **The bottom edge is sharp, the top is diffuse.** Emission cuts off hard
 *     where the atmosphere becomes dense enough to quench it; above, it fades
 *     over a hundred kilometres.
 *  3. **The colour is altitude-banded**: 557 nm green low down, ionised nitrogen
 *     giving violet-magenta at the top, with a cyan transition between.
 *
 * Curtains are real geometry — folded ribbon sheets displaced by a divergence
 * free (curl) noise field in the vertex shader, so the folds slide and shear
 * like a hanging drape instead of wobbling in place. Everything is additive and
 * unlit; the sheets are deliberately given depth-order rather than depth-test so
 * terrain occludes them but they never intersect the sky dome.
 */
import * as THREE from 'three';
import { GLSL_NOISE } from '@/gfx/materials/glsl';
import { Rng, TAU, clamp01 } from '@/util/math';
import type { ResolvedAtmosphere } from './AtmosphereProfile';

/** Curtains, samples along each curtain, rows up each curtain. */
const CURTAINS = 8;
const ALONG = 72;
const ROWS = 12;

export class AuroraLayer {
  readonly object: THREE.Mesh;

  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private builtAltitude: number;

  constructor(res: ResolvedAtmosphere, renderOrder: number) {
    this.builtAltitude = res.auroraAltitude;
    this.geo = buildCurtains(this.builtAltitude);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uStrength: { value: 1 },
        uAmp: { value: 72 },
        uFold: { value: 46 },
        uTint: { value: new THREE.Color(1, 1, 1) },
        uRayScale: { value: 1 },
      },
      vertexShader: AURORA_VERT,
      fragmentShader: AURORA_FRAG,
      side: THREE.DoubleSide,
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.object = new THREE.Mesh(this.geo, this.mat);
    this.object.name = 'auroraLayer';
    this.object.frustumCulled = false;
    this.object.renderOrder = renderOrder;
    this.setProfile(res);
  }

  setProfile(res: ResolvedAtmosphere): void {
    if (
      res.auroraStrength > 0.004 &&
      Math.abs(res.auroraAltitude - this.builtAltitude) > this.builtAltitude * 0.02
    ) {
      this.builtAltitude = res.auroraAltitude;
      this.geo.dispose();
      this.geo = buildCurtains(this.builtAltitude);
      this.object.geometry = this.geo;
    }
    const u = this.mat.uniforms;
    u.uStrength.value = clamp01(res.auroraStrength) * 1.35;
    // Normalise the authored tint so a profile can shift the hue without also
    // changing the overall exposure of the curtain.
    const t = res.auroraColor;
    const peak = Math.max(t.r, t.g, t.b, 1e-4);
    (u.uTint.value as THREE.Color).setRGB(
      0.68 + 0.32 * (t.r / peak),
      0.68 + 0.32 * (t.g / peak),
      0.68 + 0.32 * (t.b / peak),
    );
    this.object.visible = res.auroraStrength > 0.004;
  }

  update(elapsed: number): void {
    this.mat.uniforms.uTime.value = elapsed;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/**
 * Ribbon sheets. Each curtain is a smooth serpentine path on the XZ plane
 * extruded upward; the path itself is built from two sine harmonics so the
 * silhouette already has the characteristic S-fold before noise touches it.
 */
function buildCurtains(baseAltitude: number): THREE.BufferGeometry {
  const rng = new Rng(0x9c31f7);
  const vertCount = CURTAINS * ALONG * ROWS;
  const quadCount = CURTAINS * (ALONG - 1) * (ROWS - 1);
  const position = new Float32Array(vertCount * 3);
  const normalOut = new Float32Array(vertCount * 3);
  const param = new Float32Array(vertCount * 2);
  const meta = new Float32Array(vertCount * 3);
  const index = new Uint32Array(quadCount * 6);

  let vi = 0;
  let ii = 0;
  for (let c = 0; c < CURTAINS; c++) {
    const ci = c / (CURTAINS - 1);
    // Standoff has to be several times the base altitude or the nearest curtain
    // hangs at 60 degrees elevation and reads as a ceiling instead of a distant
    // sheet. Successive curtains recede and rise so the set has real depth.
    // Everything must also stay inside the camera's far plane, hence the caps.
    const dist = 760 + ci * 1900 + rng.range(-110, 110);
    const length = 1500 + ci * 1500;
    const base = baseAltitude * (0.34 + ci * 0.5) + rng.range(-40, 40);
    const height = baseAltitude * (0.8 + rng.range(0, 0.75));
    const yaw = rng.range(-0.4, 0.4) + (c % 2 === 0 ? -0.14 : 0.18);
    const f1 = rng.range(0.7, 1.5);
    const f2 = rng.range(2.1, 3.6);
    const a1 = length * rng.range(0.05, 0.13);
    const a2 = length * rng.range(0.015, 0.05);
    const ph1 = rng.range(0, TAU);
    const ph2 = rng.range(0, TAU);
    const phase = rng.next();
    const colourOffset = rng.range(-0.1, 0.14);

    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);

    for (let a = 0; a < ALONG; a++) {
      const s = a / (ALONG - 1);
      // Path point and analytic tangent, in the curtain's local frame.
      const lx = (s - 0.5) * length;
      const lz = a1 * Math.sin(s * TAU * f1 + ph1) + a2 * Math.sin(s * TAU * f2 + ph2);
      const dlx = length;
      const dlz =
        a1 * TAU * f1 * Math.cos(s * TAU * f1 + ph1) + a2 * TAU * f2 * Math.cos(s * TAU * f2 + ph2);
      const tl = Math.hypot(dlx, dlz);
      // Horizontal normal to the sheet.
      const nlx = -dlz / tl;
      const nlz = dlx / tl;

      // Rotate the local frame into world yaw and offset to the curtain's
      // standoff distance.
      const px = lx * cy - lz * sy;
      const pz = lx * sy + lz * cy + dist;
      const nx = nlx * cy - nlz * sy;
      const nz = nlx * sy + nlz * cy;

      for (let r = 0; r < ROWS; r++) {
        // Bias rows towards the base: that is where all the contrast lives.
        const h = Math.pow(r / (ROWS - 1), 2.2);
        const o = vi * 3;
        position[o] = px;
        position[o + 1] = base + h * height;
        position[o + 2] = pz;
        normalOut[o] = nx;
        normalOut[o + 1] = 0;
        normalOut[o + 2] = nz;
        param[vi * 2] = s;
        param[vi * 2 + 1] = h;
        meta[o] = ci;
        meta[o + 1] = phase;
        meta[o + 2] = colourOffset;
        vi++;
      }
    }

    const curtainBase = c * ALONG * ROWS;
    for (let a = 0; a < ALONG - 1; a++) {
      for (let r = 0; r < ROWS - 1; r++) {
        const v0 = curtainBase + a * ROWS + r;
        const v1 = v0 + ROWS;
        index[ii++] = v0;
        index[ii++] = v1;
        index[ii++] = v0 + 1;
        index[ii++] = v1;
        index[ii++] = v1 + 1;
        index[ii++] = v0 + 1;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('aSheetNormal', new THREE.BufferAttribute(normalOut, 3));
  geo.setAttribute('aParam', new THREE.BufferAttribute(param, 2));
  geo.setAttribute('aMeta', new THREE.BufferAttribute(meta, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3600);
  return geo;
}

const AURORA_VERT = /* glsl */ `
${GLSL_NOISE}
attribute vec3 aSheetNormal;
attribute vec2 aParam;
attribute vec3 aMeta;
uniform float uTime, uAmp, uFold;
varying vec2 vParam;
varying vec3 vMeta;

/**
 * 2D curl of a scalar potential: rotating the gradient 90 degrees gives a
 * divergence-free field, which is why the folds shear along the curtain instead
 * of pumping in and out of it.
 */
vec2 curl2(vec2 p, float t){
  const float e = 0.09;
  float n0 = fbm3(vec3(p + vec2(0.0, e), t), 3, 2.03, 0.55);
  float n1 = fbm3(vec3(p - vec2(0.0, e), t), 3, 2.03, 0.55);
  float n2 = fbm3(vec3(p + vec2(e, 0.0), t), 3, 2.03, 0.55);
  float n3 = fbm3(vec3(p - vec2(e, 0.0), t), 3, 2.03, 0.55);
  return vec2(n0 - n1, n3 - n2) / (2.0 * e);
}

void main(){
  vParam = aParam;
  vMeta = aMeta;
  vec3 p = position;
  float s = aParam.x;
  float h = aParam.y;
  float t = uTime * 0.055 + aMeta.y * 13.0;

  vec2 c = curl2(vec2(s * 2.6 + aMeta.x * 17.0, h * 0.55), t);
  // Folds open out with height: the drape is pinned along its bottom edge.
  float grow = 0.22 + 0.78 * h;
  p += aSheetNormal * (c.x * uAmp * grow);
  p.y += c.y * uAmp * 0.16;

  // One slow travelling fold on top of the noise, which is what gives a real
  // curtain its long coherent S-curves.
  float fold = sin(s * 8.0 + uTime * 0.28 + aMeta.y * 6.283)
             + 0.5 * sin(s * 17.0 - uTime * 0.44 + aMeta.x * 9.0);
  p += aSheetNormal * fold * uFold * grow;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const AURORA_FRAG = /* glsl */ `
${GLSL_NOISE}
varying vec2 vParam;
varying vec3 vMeta;
uniform float uTime, uStrength, uRayScale;
uniform vec3 uTint;

/** Altitude-banded emission: 557 nm green, cyan transition, N2+ violet on top. */
vec3 ramp(float x){
  vec3 c1 = vec3(0.030, 0.42, 0.24);
  vec3 c2 = vec3(0.170, 1.00, 0.52);
  vec3 c3 = vec3(0.150, 0.80, 0.98);
  vec3 c4 = vec3(0.720, 0.26, 0.96);
  vec3 c = mix(c1, c2, smoothstep(0.0, 0.16, x));
  c = mix(c, c3, smoothstep(0.22, 0.58, x));
  c = mix(c, c4, smoothstep(0.56, 0.98, x));
  return c;
}

void main(){
  float s = vParam.x;
  float h = vParam.y;
  float ci = vMeta.x;
  float ph = vMeta.y;

  // -- vertical ray structure ------------------------------------------------
  // All of the high-frequency detail varies across the curtain and none up it.
  float jitter = fbm(vec2(s * 26.0 + ph * 40.0, ci * 5.0), 4, 2.07, 0.5);
  // Two ray frequencies multiplied: fine filaments gathered into wider bundles,
  // which is how real rays group along the field.
  float fine = 0.5 + 0.5 * sin(s * 620.0 * uRayScale + jitter * 9.0);
  float coarse = 0.5 + 0.5 * sin(s * 132.0 * uRayScale - jitter * 4.0);
  float rays = pow(fine, 2.6) * (0.35 + 0.65 * pow(coarse, 1.6));
  float clump = 0.5 + 0.5 * fbm(vec2(s * 14.0, uTime * 0.16 + ci * 7.0), 3, 2.05, 0.55);
  rays = rays * (0.30 + 0.70 * clump) + 0.055 * clump * clump;

  // -- height profile --------------------------------------------------------
  // Sharp lower cutoff, exponential body, long diffuse magenta tail.
  float bottom = smoothstep(0.0, 0.030, h);
  float body = exp(-h * 2.1);
  float tail = exp(-h * 0.75) * (1.0 - smoothstep(0.62, 1.0, h));
  float profile = bottom * (body * 0.82 + tail * 0.30);

  // -- ends and surges -------------------------------------------------------
  float ends = smoothstep(0.0, 0.09, s) * (1.0 - smoothstep(0.90, 1.0, s));
  float surge = 0.5 + 0.5 * sin(s * 3.0 - uTime * 0.7 + ph * 6.283);
  surge *= 0.72 + 0.28 * sin(s * 7.3 + uTime * 1.35 + ci * 4.0);
  surge = 0.42 + 0.75 * surge;

  vec3 col = ramp(clamp(h * 1.55 + vMeta.z, 0.0, 1.0)) * uTint;
  // Sharp rays plus a broad soft glow, so the sheet has body instead of reading
  // as a cut-out card.
  float soft = bottom * exp(-h * 2.9) * 0.5;
  vec3 outCol = col * (rays * profile + soft * 0.42) * ends * surge;
  // Distance dimming so the far curtains sit behind the near ones.
  outCol *= mix(1.0, 0.28, ci);
  // Per-curtain brightness varies a lot: a real display has two or three bright
  // arcs and several barely-there ones.
  outCol *= 0.35 + 0.9 * fract(ph * 7.31);
  // Eight sheets overlap additively; per-sheet energy has to stay low or the
  // stack saturates to a flat cyan-white mass instead of reading as curtains.
  outCol *= uStrength * 0.15;

  gl_FragColor = vec4(max(outCol, vec3(0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
