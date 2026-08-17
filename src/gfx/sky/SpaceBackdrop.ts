/**
 * SpaceBackdrop — the deep-space frame used in orbit.
 *
 * The thing that makes a painted starfield look cheap is that everything is
 * additive: nebulae glow but never *block*. Real emission nebulae are optically
 * thick in places, and the dust lanes threading them are pure absorption — they
 * are visible only because they hide the stars behind them. So this layer writes
 * premultiplied colour with a genuine alpha (emission in RGB, absorption in A)
 * and composites with `src + dst*(1-a)`, drawn after the star field. Dust then
 * really does occult stars, which reads as depth no additive layer can fake.
 *
 * Contents, all procedural:
 *   - three domain-warped fBm nebula clouds with separate emission colours and
 *     directional extents, so the sky is composed rather than uniformly foggy;
 *   - ridged dust filaments that absorb and redden;
 *   - a distant inclined spiral galaxy with a bright bulge, log-spiral arms and
 *     its own dust lane;
 *   - the system star: an HDR core with limb darkening, a three-scale corona and
 *     restrained diffraction spikes.
 */
import * as THREE from 'three';
import { GLSL_NOISE } from '@/gfx/materials/glsl';
import { clamp01 } from '@/util/math';
import type { ResolvedAtmosphere } from './AtmosphereProfile';

export class SpaceBackdrop {
  readonly object: THREE.Mesh;

  private geo: THREE.SphereGeometry;
  private mat: THREE.ShaderMaterial;

  constructor(res: ResolvedAtmosphere, radius: number, renderOrder: number) {
    this.geo = new THREE.SphereGeometry(radius * 0.98, 48, 32);

    // Composition: three clouds placed around the sphere so the frame has a
    // dominant mass, a complementary counterweight and a cool accent, instead
    // of nebula smeared evenly over 4pi steradians.
    const c1 = new THREE.Vector3(-0.55, 0.28, -0.79).normalize();
    const c2 = new THREE.Vector3(0.72, -0.18, 0.67).normalize();
    const c3 = new THREE.Vector3(0.12, 0.86, -0.5).normalize();

    // Placed above the horizon so the galaxy is part of the composition from a
    // ship or a surface, not only from below.
    const galZ = new THREE.Vector3(-0.46, 0.40, -0.79).normalize();
    const galX = new THREE.Vector3().crossVectors(galZ, new THREE.Vector3(0, 1, 0)).normalize();
    const galY = new THREE.Vector3().crossVectors(galZ, galX).normalize();

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uWeight: { value: 1 },
        uC1: { value: c1 },
        uC2: { value: c2 },
        uC3: { value: c3 },
        uCol1: { value: new THREE.Color(0x5f2ea8) },
        uCol2: { value: new THREE.Color(0xa8324a) },
        uCol3: { value: new THREE.Color(0x1d6ea8) },
        uDustCol: { value: new THREE.Color(0x1a0d08) },
        uGalZ: { value: galZ },
        uGalX: { value: galX },
        uGalY: { value: galY },
        uGalCore: { value: new THREE.Color(0xffe0a8) },
        uGalArm: { value: new THREE.Color(0xa8c8ff) },
        uStarDir: { value: new THREE.Vector3(0, 0, 1) },
        uStarX: { value: new THREE.Vector3(1, 0, 0) },
        uStarY: { value: new THREE.Vector3(0, 1, 0) },
        uStarColor: { value: new THREE.Color(1, 1, 1) },
        uStarRadius: { value: 0.012 },
        uStarBrightness: { value: 90 },
      },
      vertexShader: SPACE_VERT,
      fragmentShader: SPACE_FRAG,
      side: THREE.BackSide,
      // Premultiplied emission + absorption, outside the transparent queue.
      transparent: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthTest: false,
      depthWrite: false,
    });

    this.object = new THREE.Mesh(this.geo, this.mat);
    this.object.name = 'spaceBackdrop';
    this.object.frustumCulled = false;
    this.object.renderOrder = renderOrder;
    this.setProfile(res);
  }

  setProfile(res: ResolvedAtmosphere): void {
    const u = this.mat.uniforms;
    u.uWeight.value = clamp01(res.space);
    const dir = u.uStarDir.value as THREE.Vector3;
    dir.copy(res.sunDirection).normalize();
    // Tangent frame for the diffraction spikes.
    const x = u.uStarX.value as THREE.Vector3;
    const y = u.uStarY.value as THREE.Vector3;
    x.set(0, 1, 0).cross(dir);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    x.normalize();
    y.crossVectors(dir, x).normalize();
    (u.uStarColor.value as THREE.Color).copy(res.sunColor);
    u.uStarRadius.value = res.sunAngularRadius;
    u.uStarBrightness.value = res.sunIntensity * res.sunDiscBrightness * 0.6;
    this.object.visible = res.space > 0.004;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

const SPACE_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SPACE_FRAG = /* glsl */ `
${GLSL_NOISE}
varying vec3 vDir;
uniform float uWeight, uStarRadius, uStarBrightness;
uniform vec3 uC1, uC2, uC3, uCol1, uCol2, uCol3, uDustCol;
uniform vec3 uGalZ, uGalX, uGalY, uGalCore, uGalArm;
uniform vec3 uStarDir, uStarX, uStarY, uStarColor;

/**
 * One nebula cloud. The domain warp is what turns fBm from "grey clouds" into
 * the sheared, filamentary structure real emission nebulae have.
 */
float nebula(vec3 d, vec3 centre, float spread, float scale, float warpAmt, float thresh, float seed){
  float mask = smoothstep(1.0 - spread, 1.0 - spread * 0.22, dot(d, centre));
  if (mask <= 0.002) return 0.0;
  vec3 q = d * scale + vec3(seed, seed * 1.7, seed * 2.3);
  float w1 = fbm3(q * 0.5 + 3.1, 2, 2.05, 0.55);
  float w2 = fbm3(q * 0.5 + 17.7, 2, 2.05, 0.55);
  q += vec3(w1, w2, w1 * 0.6 - w2 * 0.8) * warpAmt;
  float n = fbm3(q, 5, 2.09, 0.55) * 0.5 + 0.5;
  return smoothstep(thresh, thresh + 0.26, n) * mask;
}

void main(){
  vec3 d = normalize(vDir);

  vec3 emission = vec3(0.0);
  float absorb = 0.0;

  float n1 = nebula(d, uC1, 0.95, 3.1, 0.85, 0.46, 4.0);
  float n2 = nebula(d, uC2, 0.80, 4.4, 0.70, 0.52, 19.0);
  float n3 = nebula(d, uC3, 0.62, 6.2, 0.55, 0.56, 41.0);

  emission += uCol1 * n1 * 0.30;
  emission += uCol2 * n2 * 0.26;
  emission += uCol3 * n3 * 0.20;
  // Hot cores: the densest parts of each cloud are much brighter than linear.
  emission += uCol1 * pow(n1, 4.0) * 0.62;
  emission += uCol2 * pow(n2, 4.0) * 0.52;
  emission += uCol3 * pow(n3, 5.0) * 0.34;
  absorb += n1 * 0.34 + n2 * 0.26 + n3 * 0.16;

  // -- dust lanes ------------------------------------------------------------
  // Ridged filaments. Pure absorption plus a faint reddened rim where they are
  // backlit by the cloud they sit in front of.
  float dr = 1.0 - abs(fbm3(d * 5.4 + vec3(31.0, 7.0, 13.0), 3, 2.06, 0.55) * 2.1);
  float dust = pow(clamp(dr, 0.0, 1.0), 2.6);
  float dustMask = clamp(n1 + n2 * 0.8 + 0.22, 0.0, 1.0);
  dust *= dustMask;
  emission *= 1.0 - dust * 0.72;
  emission += uDustCol * dust * 0.025;
  absorb = clamp(absorb + dust * 0.85, 0.0, 1.0);

  // -- distant spiral galaxy -------------------------------------------------
  float zz = dot(d, uGalZ);
  if (zz > 0.22) {
    // r = 1 lands at ~9.5 degrees, so with the disc's exponential falloff the
    // whole galaxy spans 40-odd degrees and reads as a composition element
    // rather than a speck.
    vec2 uv = vec2(dot(d, uGalX), dot(d, uGalY)) / zz / 0.17;
    vec2 e = vec2(uv.x, uv.y / 0.34);          // inclination squash
    float r = length(e);
    if (r < 6.0) {
      float ang = atan(e.y, e.x);
      float sp = 2.0 * ang - log(max(r, 0.05)) * 3.4;
      float arms = pow(0.5 + 0.5 * cos(sp), 2.0);
      float lane = pow(0.5 + 0.5 * cos(sp + 1.15), 4.0);
      float disc = exp(-r * 0.95);
      float bulge = exp(-r * r * 5.0);
      float grain = 0.72 + 0.28 * (fbm3(vec3(e * 1.4, 0.0), 3, 2.1, 0.5) * 0.5 + 0.5);
      float g = disc * (0.28 + 0.72 * arms) * grain * (1.0 - 0.5 * lane) + bulge * 1.5;
      g *= smoothstep(0.22, 0.36, zz);
      vec3 gc = mix(uGalArm, uGalCore, clamp(bulge * 1.6 + 0.15, 0.0, 1.0));
      emission += gc * g * 0.20;
      absorb = clamp(absorb + disc * 0.10, 0.0, 1.0);
    }
  }

  // -- the system star -------------------------------------------------------
  float ct = clamp(dot(d, uStarDir), -1.0, 1.0);
  float ang = acos(ct);
  if (ang < 0.9) {
    float aa = max(fwidth(ang), 1e-6);
    float disc = 1.0 - smoothstep(uStarRadius - aa, uStarRadius + aa, ang);
    // Limb darkening: blue falls off faster than red, so the rim goes warm.
    float rr = clamp(ang / max(uStarRadius, 1e-5), 0.0, 1.0);
    float mu = sqrt(max(0.0, 1.0 - rr * rr));
    vec3 limb = 1.0 - vec3(0.397, 0.503, 0.652) * (1.0 - mu)
                    - vec3(0.156, 0.126, 0.089) * (1.0 - mu) * (1.0 - mu);
    vec3 core = uStarColor * max(limb, vec3(0.0)) * disc * uStarBrightness;

    // Corona: three exponential scales. Kept tight — a broad halo at this
    // brightness would put a bloom wash across a quarter of the frame.
    float corona = exp(-ang / max(uStarRadius * 0.7, 1e-4)) * 0.5
                 + exp(-ang / 0.022) * 0.055
                 + exp(-ang / 0.085) * 0.011;
    // Diffraction spikes, deliberately thin and short.
    float px = dot(d, uStarX), py = dot(d, uStarY);
    float spikes = exp(-abs(px) / 0.0022 - abs(py) / 0.035)
                 + exp(-abs(py) / 0.0022 - abs(px) / 0.035);
    emission += core + uStarColor * uStarBrightness * (corona * 0.075 + spikes * 0.010);
  }

  // Faint deep-field glow so the void is never pure 0,0,0 — an absolutely black
  // sky crushes and bands the moment bloom or grain touches it.
  emission += uCol3 * 0.0035 + vec3(0.0016, 0.0018, 0.0026);

  emission *= uWeight;
  absorb *= uWeight;

  gl_FragColor = vec4(max(emission, vec3(0.0)), clamp(absorb, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
