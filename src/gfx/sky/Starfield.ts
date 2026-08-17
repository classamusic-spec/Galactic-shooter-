/**
 * Starfield — instanced points with real stellar colour, plus a procedural
 * Milky Way band.
 *
 * Two details separate a believable star field from white dots on black:
 *
 * 1. **Colour comes from temperature.** Stars are blackbodies; the population is
 *    dominated by cool red dwarfs while the *bright* end is hot and blue-white.
 *    Sampling temperature and magnitude from correlated distributions is what
 *    makes the field read as a sky rather than as noise.
 * 2. **Extinction and scintillation are atmospheric.** A star low on the horizon
 *    looks through ~12 air masses: it dims and reddens. Twinkle is refraction in
 *    that same air, so in vacuum (orbit, near-airless Zeta) it must be *off* —
 *    rock-steady points are one of the strongest "this is space" cues there is.
 *
 * The whole field is one draw call; the Milky Way is a second.
 */
import * as THREE from 'three';
import { GLSL_NOISE } from '@/gfx/materials/glsl';
import { Rng, clamp, clamp01, lerp } from '@/util/math';
import type { ResolvedAtmosphere } from './AtmosphereProfile';

/** Hard ceiling on stored stars; `setProfile` draws a prefix of these. */
const MAX_STARS = 6000;

/**
 * Blackbody colour, sRGB, from a colour temperature in kelvin. Piecewise fit to
 * the Planckian locus — accurate enough for stars between 1500 K and 40000 K.
 */
export function blackbodySrgb(kelvin: number, out: THREE.Color): THREE.Color {
  const t = clamp(kelvin, 1500, 40000) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return out.setRGB(clamp01(r / 255), clamp01(g / 255), clamp01(b / 255), THREE.SRGBColorSpace);
}

export class Starfield {
  readonly object = new THREE.Group();

  private stars: THREE.Points;
  private starGeo: THREE.BufferGeometry;
  private starMat: THREE.ShaderMaterial;
  private band: THREE.Mesh;
  private bandGeo: THREE.SphereGeometry;
  private bandMat: THREE.ShaderMaterial;
  private radius: number;

  constructor(res: ResolvedAtmosphere, radius: number, renderOrder: number) {
    this.radius = radius;
    this.object.name = 'starfield';

    // -- the population ------------------------------------------------------
    // Seeded so the constellations are identical every session; a sky that
    // reshuffles between loads reads as noise, not as a place.
    const rng = new Rng(0x51a7b3d);
    const pos = new Float32Array(MAX_STARS * 3);
    const col = new Float32Array(MAX_STARS * 3);
    const star = new Float32Array(MAX_STARS * 2);
    const phase = new Float32Array(MAX_STARS);
    const dir = new THREE.Vector3();
    const tint = new THREE.Color();

    for (let i = 0; i < MAX_STARS; i++) {
      rng.onSphere(dir);
      // Slight clustering towards the galactic plane so the band has a real
      // over-density of stars in it rather than just a painted glow.
      const gal = dir.dot(GALACTIC_NORMAL);
      if (Math.abs(gal) > 0.25 && rng.next() < 0.35) {
        dir.addScaledVector(GALACTIC_NORMAL, -gal * rng.range(0.3, 0.85)).normalize();
      }
      pos[i * 3] = dir.x;
      pos[i * 3 + 1] = dir.y;
      pos[i * 3 + 2] = dir.z;

      // Apparent magnitude: many faint, very few bright. mag -1.4 .. 6.4
      const mag = -1.4 + 7.8 * Math.pow(rng.next(), 0.62);
      // Temperature correlates with brightness: the naked-eye sky's brightest
      // members are hot giants, the faint tail is red dwarfs.
      const hotBias = clamp01(1 - (mag + 1.4) / 7.8);
      const tK = Math.exp(
        lerp(Math.log(2600), Math.log(22000), Math.pow(rng.next(), 1.6) * 0.45 + hotBias * 0.55),
      );
      blackbodySrgb(tK, tint);
      // Normalise hue so `brightness` alone controls exposure.
      const peak = Math.max(tint.r, tint.g, tint.b, 1e-4);
      col[i * 3] = tint.r / peak;
      col[i * 3 + 1] = tint.g / peak;
      col[i * 3 + 2] = tint.b / peak;

      // Pogson: each magnitude is 2.512x. Clamped so mag -1 is not 300x mag 6.
      const brightness = clamp(Math.pow(2.512, -mag) * 0.55, 0.012, 6);
      star[i * 2] = clamp(1.15 + (5.4 - mag) * 0.42, 1.0, 5.2);
      star[i * 2 + 1] = brightness;
      phase[i] = rng.next();
    }

    this.starGeo = new THREE.BufferGeometry();
    this.starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    this.starGeo.setAttribute('aStar', new THREE.BufferAttribute(star, 2));
    this.starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.starGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);

    this.starMat = new THREE.ShaderMaterial({
      uniforms: {
        uRadius: { value: radius },
        uTime: { value: 0 },
        uPixelScale: { value: 1 },
        uTwinkle: { value: 0 },
        uExtinction: { value: 0.1 },
        uVisibility: { value: 1 },
        uReddening: { value: 0.35 },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.stars = new THREE.Points(this.starGeo, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = renderOrder + 1;
    this.object.add(this.stars);

    // -- the Milky Way -------------------------------------------------------
    this.bandGeo = new THREE.SphereGeometry(radius * 0.99, 40, 24);
    this.bandMat = new THREE.ShaderMaterial({
      uniforms: {
        uStrength: { value: 0 },
        uVisibility: { value: 1 },
        uExtinction: { value: 0.1 },
        uCore: { value: new THREE.Color(0xffe6c0) },
        uOuter: { value: new THREE.Color(0x8fa8e8) },
        uDust: { value: new THREE.Color(0x2a1408) },
        uNormal: { value: GALACTIC_NORMAL.clone() },
        uCentre: { value: GALACTIC_CENTRE.clone() },
      },
      vertexShader: SKY_VERT,
      fragmentShader: BAND_FRAG,
      side: THREE.BackSide,
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.band = new THREE.Mesh(this.bandGeo, this.bandMat);
    this.band.frustumCulled = false;
    this.band.renderOrder = renderOrder;
    this.object.add(this.band);

    this.setProfile(res, 1);
  }

  /**
   * @param visibility how much of the star field survives the sky's own
   *        brightness, 0..1 — computed by `SkyDome` from the integrated zenith
   *        radiance so stars vanish in daylight without a magic threshold.
   */
  setProfile(res: ResolvedAtmosphere, visibility: number): void {
    const count = Math.round(clamp(res.starDensity, 0, 2) * 0.72 * MAX_STARS);
    this.starGeo.setDrawRange(0, Math.min(count, MAX_STARS));
    const vis = clamp01(visibility) * clamp(res.starDensity, 0, 2);
    this.starMat.uniforms.uVisibility.value = vis;
    this.starMat.uniforms.uTwinkle.value = res.starTwinkle;
    // Airmass extinction grows with how much air there is to look through.
    this.starMat.uniforms.uExtinction.value = 0.06 + res.turbidity * 1.9;
    this.starMat.uniforms.uReddening.value = 0.15 + res.turbidity * 0.75;

    this.bandMat.uniforms.uStrength.value = res.milkyWay;
    this.bandMat.uniforms.uVisibility.value = vis > 0 ? clamp01(visibility) : 0;
    this.bandMat.uniforms.uExtinction.value = 0.1 + res.turbidity * 2.4;
    this.band.visible = res.milkyWay > 0.001 && visibility > 0.002;
    this.stars.visible = count > 0 && vis > 0.0005;
    this.object.visible = this.band.visible || this.stars.visible;
  }

  /** `pixelScale` converts logical star sizes into framebuffer pixels. */
  update(elapsed: number, pixelScale: number): void {
    this.starMat.uniforms.uTime.value = elapsed;
    this.starMat.uniforms.uPixelScale.value = pixelScale;
  }

  dispose(): void {
    this.starGeo.dispose();
    this.starMat.dispose();
    this.bandGeo.dispose();
    this.bandMat.dispose();
    this.object.clear();
  }
}

/** Galactic plane orientation. Tilted so the band cuts the frame diagonally. */
const GALACTIC_NORMAL = new THREE.Vector3(0.36, 0.66, -0.66).normalize();
/** Direction of the bulge — the band is brightest and widest here. */
const GALACTIC_CENTRE = new THREE.Vector3(-0.78, 0.16, -0.6).normalize();

const STAR_VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec2 aStar;    // x = logical pixel size, y = linear brightness
attribute float aPhase;
uniform float uRadius, uTime, uPixelScale, uTwinkle, uExtinction, uVisibility, uReddening;
varying vec3 vCol;
varying float vSpike;

void main(){
  vec3 dir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(dir * uRadius, 1.0);

  float elev = clamp(dir.y, -1.0, 1.0);
  // Airmass ~ 1/sin(altitude), softened so the horizon does not blow up.
  float airmass = 1.0 / max(0.10, elev * 0.5 + 0.5) - 0.6;
  airmass = max(airmass, 0.0) * 2.2 + 1.0;
  float ext = exp(-uExtinction * (airmass - 1.0));

  // Scintillation: two beat frequencies so it never looks like a sine.
  float tw = 1.0;
  if (uTwinkle > 0.0001) {
    float amp = uTwinkle * (0.16 + 0.84 * pow(1.0 - clamp(elev, 0.0, 1.0), 1.7));
    float s = sin(uTime * 6.3 + aPhase * 71.0) * 0.62 + sin(uTime * 12.9 + aPhase * 143.0) * 0.38;
    tw = max(0.0, 1.0 + amp * s);
  }

  float b = aStar.y * ext * uVisibility * tw;
  // Reddening through air mass: blue is scattered out of the line of sight.
  float rd = uReddening * (airmass - 1.0);
  vec3 red = vec3(1.0, exp(-rd * 0.35), exp(-rd * 0.85));
  vCol = aColor * red * b;

  float size = aStar.x * uPixelScale * (0.72 + 0.5 * sqrt(max(b, 0.0)));
  gl_PointSize = clamp(size, 0.85, 22.0);
  vSpike = smoothstep(2.1, 4.6, size);
}
`;

const STAR_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vSpike;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 6.5);
  float glow = exp(-r2 * 1.7) * 0.24;
  // Four-point diffraction cross, bright stars only.
  float sx = exp(-abs(q.x) * 13.0 - abs(q.y) * 2.2);
  float sy = exp(-abs(q.y) * 13.0 - abs(q.x) * 2.2);
  float spike = vSpike * 0.22 * (sx + sy);
  float a = core + glow + spike;
  if (a < 0.0025) discard;
  gl_FragColor = vec4(vCol * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Shared "direction from an inverted sphere" vertex shader. */
export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BAND_FRAG = /* glsl */ `
${GLSL_NOISE}
varying vec3 vDir;
uniform float uStrength, uVisibility, uExtinction;
uniform vec3 uCore, uOuter, uDust, uNormal, uCentre;

void main(){
  vec3 d = normalize(vDir);
  float lat = dot(d, uNormal);              // 0 on the galactic plane
  float toCentre = dot(d, uCentre);         // 1 towards the bulge

  // The band narrows and dims away from the core; near the bulge it is a wide,
  // bright, structured wedge. Its *edge* is modulated by noise and given a
  // sub-gaussian falloff: a clean gaussian arc across the sky reads as a dome
  // seam, which is exactly what a real ragged band does not look like.
  float widthNoise = 0.62 + 0.76 * (fbm3(d * 2.4 + 5.0, 3, 2.02, 0.55) * 0.5 + 0.5);
  float width = mix(0.075, 0.20, smoothstep(-0.4, 1.0, toCentre)) * widthNoise;
  float band = exp(-pow(abs(lat) / width, 1.35));

  // Star clouds: fBm along the plane, stretched hard so structure runs *with*
  // the band instead of blobbing across it.
  vec3 q = d * 4.2 + uNormal * lat * 9.0;
  float clouds = fbm3(q, 5, 2.03, 0.55) * 0.5 + 0.5;
  clouds = pow(clamp(clouds, 0.0, 1.0), 1.5);
  float fine = fbm3(d * 15.0, 4, 2.11, 0.5) * 0.5 + 0.5;

  // Dust lanes: dark ridged filaments hugging the plane, strongest towards the
  // core. This is what stops the band reading as an airbrushed smear.
  float lane = 1.0 - abs(fbm3(d * 7.5 + vec3(11.0, 3.0, 7.0), 3, 2.05, 0.55) * 2.2);
  lane = pow(clamp(lane, 0.0, 1.0), 3.0);
  float laneMask = exp(-pow(abs(lat) / 0.06, 1.5)) * smoothstep(-0.2, 0.9, toCentre);

  float bulge = pow(clamp(toCentre, 0.0, 1.0), 22.0) * exp(-(lat * lat) / 0.006);

  float intensity = band * (0.34 + 0.66 * clouds) * (0.7 + 0.3 * fine);
  intensity = intensity * (1.0 - 0.82 * lane * laneMask) + bulge * 0.85;

  vec3 col = mix(uOuter, uCore, smoothstep(-0.2, 0.9, toCentre) * 0.75 + clouds * 0.25);
  col = mix(col, uDust, lane * laneMask * 0.55);

  // Atmospheric extinction: the band is the first thing haze eats.
  float elev = clamp(d.y, -1.0, 1.0);
  float airmass = max(1.0 / max(0.10, elev * 0.5 + 0.5) - 0.6, 0.0) * 2.2 + 1.0;
  float ext = exp(-uExtinction * (airmass - 1.0));

  vec3 outCol = col * intensity * uStrength * uVisibility * ext * 0.09;
  gl_FragColor = vec4(max(outCol, vec3(0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
