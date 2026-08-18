/**
 * SkyDome — physically-based atmospheric scattering, and the owner of the whole
 * celestial stack (clouds, stars, aurora, deep space) plus the level's key light.
 *
 * ## How the scattering works, and why it is built this way
 *
 * The radiance of a sky direction is the single-scattering integral along the
 * view ray:
 *
 *     L(v) = E_sun * integral[ rho_r(h) T(x) beta_r P_r(theta)
 *                            + rho_m(h) T(x) beta_m P_m(theta) ] dx
 *
 * The two phase functions `P` depend *only* on the angle between the view ray
 * and the sun. Everything else — the density profile, the transmittance to the
 * camera, the transmittance to the sun, ground shadowing — depends only on the
 * ray's geometry. Since the sun does not move within a level, that geometric
 * part is a fixed function of two angles, so it is integrated **once on the CPU**
 * into a small (64 x 128) two-texture LUT: Rayleigh path integral in one,
 * Mie path integral in the other.
 *
 * The consequences are the whole point:
 *  - the expensive part (24 view steps x 8 light steps, with ray-sphere
 *    intersections and ground shadowing) is paid once per level, not per pixel;
 *  - the *phase* functions are still evaluated per pixel at full resolution, so
 *    the Mie aureole hugging the sun stays razor sharp instead of being blurred
 *    by a low-resolution LUT;
 *  - the same CPU data can be sampled directly to derive the IBL colours, the
 *    fog colour, the cloud ambient and the star visibility, which is why the
 *    sky, the reflections and the fog can never disagree with each other.
 *
 * A cheap multiple-scattering term (an unshadowed, unattenuated copy of the same
 * integral) is added on top. Without it a pure single-scattering sky crushes to
 * black the moment the sun gets low — which is exactly the condition three of
 * the five worlds ship in.
 *
 * ## Layer ordering
 *
 * Every sky layer is `depthTest: false`, `depthWrite: false` and deliberately
 * kept **out** of the transparent queue (`transparent: false` with explicit
 * blend factors). That puts the whole stack in the opaque pass at a very
 * negative `renderOrder`, so it draws before any world geometry: terrain then
 * overwrites it, giving correct occlusion by mountains without the sky ever
 * fighting the depth buffer or the far plane.
 */
import * as THREE from 'three';
import { settings } from '@/core/Settings';
import { clamp, clamp01, invLerp, smoothstep, scratch } from '@/util/math';
import {
  resolveAtmosphere,
  type AtmosphereProfile,
  type ResolvedAtmosphere,
} from './AtmosphereProfile';
import { CloudLayer } from './CloudLayer';
import { Starfield } from './Starfield';
import { AuroraLayer } from './AuroraLayer';
import { SpaceBackdrop } from './SpaceBackdrop';

// -- model constants --------------------------------------------------------

/** Reference planet radius, metres. Earth-like, which sets the horizon curve. */
const PLANET_R = 6360e3;
/** Top of the atmosphere. */
const ATMO_R = 6420e3;
/** Camera altitude the LUT is integrated for. */
const CAM_ALT = 4;

/** LUT resolution: azimuth-from-sun x view zenith. */
const LUT_AZ = 64;
const LUT_ZE = 128;
const VIEW_STEPS = 24;
const LIGHT_STEPS = 8;

/**
 * Radius the sky geometry is built at. Only needs to sit comfortably inside the
 * camera's far plane; depth testing is off so it has no ordering role.
 */
const SKY_RADIUS = 400;

/** Render order chain. Negative so the stack lands ahead of world geometry. */
const ORDER_DOME = -1200;
const ORDER_STARS = -1190;
const ORDER_SPACE = -1180;
const ORDER_AURORA = -1170;
const ORDER_CLOUDS = -1160;

/** Solar limb-darkening coefficients, per channel (blue darkens fastest). */
const LIMB_A = new THREE.Vector3(0.397, 0.503, 0.652);
const LIMB_B = new THREE.Vector3(0.156, 0.126, 0.089);

const WHITE_COLOR = new THREE.Color(1, 1, 1);

// ---------------------------------------------------------------------------
// The scattering LUT
// ---------------------------------------------------------------------------

/**
 * CPU-integrated single-scattering tables. Holds the *path* integrals with the
 * scattering coefficients folded in but the phase functions factored out.
 */
class ScatterLut {
  /** rgb = Rayleigh path integral * beta_r, a = transmittance to a ground hit. */
  readonly texR: THREE.DataTexture;
  /** rgb = Mie path integral * beta_m. */
  readonly texM: THREE.DataTexture;

  /** Radiance of the sun disc after atmospheric extinction, linear. */
  readonly sunDiscColor = new THREE.Color();
  /** Lambertian radiance of the distant ground, linear. */
  readonly groundRadiance = new THREE.Color();
  /** Per-channel transmittance along the sun ray from the ground. */
  readonly sunTransmittance = new THREE.Color(1, 1, 1);

  private fR = new Float32Array(LUT_AZ * LUT_ZE * 4);
  private fM = new Float32Array(LUT_AZ * LUT_ZE * 4);
  private hR = new Uint16Array(LUT_AZ * LUT_ZE * 4);
  private hM = new Uint16Array(LUT_AZ * LUT_ZE * 4);
  private mieG = 0.76;

  constructor() {
    this.texR = makeLutTexture(this.hR);
    this.texM = makeLutTexture(this.hM);
  }

  /**
   * Re-integrate for a profile. ~8 k directions x 24 x 8 samples; tens of
   * milliseconds, once per level load.
   */
  build(res: ResolvedAtmosphere): void {
    const bRx = res.rayleigh.x;
    const bRy = res.rayleigh.y;
    const bRz = res.rayleigh.z;
    const bMs = res.mie;
    const bMe = res.mie / Math.max(0.05, res.mieAlbedo);
    const Hr = Math.max(200, res.rayleighScaleHeight);
    const Hm = Math.max(120, res.mieScaleHeight);
    this.mieG = res.mieG;

    const sy = clamp(res.sunDirection.y, -1, 1);
    const sxz = Math.sqrt(Math.max(0, 1 - sy * sy));

    /**
     * The multiple-scattering lift stands in for every photon that bounced more
     * than once, including light reflected off the ground and scattered back
     * down. It carries no sun shadowing and no sun-path extinction, which is
     * precisely why it keeps the anti-solar side of a low-sun sky from going
     * black — the failure mode of every pure single-scattering sky.
     *
     * It scales with how optically thick the air is (a thick atmosphere
     * multiple-scatters far more) and with the ground albedo (a bright desert
     * throws a lot of light back up into the haze).
     */
    const thickness = ((bRx + bRy + bRz) / 3) * Hr + bMe * Hm;
    const albedoLum =
      res.groundAlbedo.r * 0.2126 + res.groundAlbedo.g * 0.7152 + res.groundAlbedo.b * 0.0722;
    const msLift =
      res.multipleScattering *
      0.34 *
      smoothstep(invLerp(-0.22, 0.32, sy)) *
      (1 + 1.8 * thickness) *
      (1 + 0.8 * albedoLum);

    const oy = PLANET_R + CAM_ALT;
    const o2 = oy * oy;
    const cTop = o2 - ATMO_R * ATMO_R;
    const cGround = o2 - PLANET_R * PLANET_R;

    for (let j = 0; j < LUT_ZE; j++) {
      // Zenith parameterisation: v -> mu with a square law, so texel density is
      // highest exactly where the sky gradient is steepest — at the horizon.
      const w = j / (LUT_ZE - 1);
      const s = 2 * w - 1;
      const mu = Math.sign(s) * s * s;
      const st = Math.sqrt(Math.max(0, 1 - mu * mu));

      // Ray end: the atmosphere top, or the ground if the ray points into it.
      const b0 = oy * mu;
      let tEnd = -b0 + Math.sqrt(Math.max(b0 * b0 - cTop, 0));
      let hitGround = false;
      if (mu < 0) {
        const disc = b0 * b0 - cGround;
        if (disc > 0) {
          const t = -b0 - Math.sqrt(disc);
          if (t > 0) {
            tEnd = t;
            hitGround = true;
          }
        }
      }

      for (let i = 0; i < LUT_AZ; i++) {
        const phi = (i / (LUT_AZ - 1)) * Math.PI;
        const dx = st * Math.cos(phi);
        const dz = st * Math.sin(phi);

        let odR = 0;
        let odM = 0;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let mr = 0;
        let mg = 0;
        let mb = 0;
        let ar = 0;
        let ag = 0;
        let ab = 0;
        let br2 = 0;
        let bg2 = 0;
        let bb2 = 0;
        let prev = 0;
        let tGreen = 1;

        for (let k = 0; k < VIEW_STEPS; k++) {
          // Quadratic step distribution: density falls off exponentially with
          // height, so samples belong near the camera.
          const f = (k + 1) / VIEW_STEPS;
          const tk = tEnd * f * f;
          const ds = tk - prev;
          const tm = prev + ds * 0.5;
          prev = tk;
          if (ds <= 0) continue;

          const px = dx * tm;
          const py = oy + mu * tm;
          const pz = dz * tm;
          const r = Math.sqrt(px * px + py * py + pz * pz);
          const h = Math.max(r - PLANET_R, 0);
          const dr = Math.exp(-h / Hr) * ds;
          const dm = Math.exp(-h / Hm) * ds;
          odR += dr;
          odM += dm;

          const em = bMe * odM;
          const vr = Math.exp(-(bRx * odR + em));
          const vg = Math.exp(-(bRy * odR + em));
          const vb = Math.exp(-(bRz * odR + em));
          tGreen = vg;
          ar += dr * vr;
          ag += dr * vg;
          ab += dr * vb;
          br2 += dm * vr;
          bg2 += dm * vg;
          bb2 += dm * vb;

          // Is this sample in the planet's shadow?
          const pDotS = px * sxz + py * sy;
          const rr = r * r - PLANET_R * PLANET_R;
          if (pDotS < 0 && pDotS * pDotS - rr > 0) continue;

          // Optical depth from the sample to the top of the atmosphere.
          const cS = r * r - ATMO_R * ATMO_R;
          const tS = -pDotS + Math.sqrt(Math.max(pDotS * pDotS - cS, 0));
          let lodR = 0;
          let lodM = 0;
          let lprev = 0;
          for (let l = 0; l < LIGHT_STEPS; l++) {
            const g = (l + 1) / LIGHT_STEPS;
            const tl = tS * g * g;
            const dl = tl - lprev;
            const lm = lprev + dl * 0.5;
            lprev = tl;
            if (dl <= 0) continue;
            const qx = px + sxz * lm;
            const qy = py + sy * lm;
            const rq = Math.sqrt(qx * qx + qy * qy + pz * pz);
            const hq = Math.max(rq - PLANET_R, 0);
            lodR += Math.exp(-hq / Hr) * dl;
            lodM += Math.exp(-hq / Hm) * dl;
          }

          const tr = Math.exp(-(bRx * (odR + lodR) + bMe * (odM + lodM)));
          const tg = Math.exp(-(bRy * (odR + lodR) + bMe * (odM + lodM)));
          const tb = Math.exp(-(bRz * (odR + lodR) + bMe * (odM + lodM)));
          sr += dr * tr;
          sg += dr * tg;
          sb += dr * tb;
          mr += dm * tr;
          mg += dm * tg;
          mb += dm * tb;
        }

        // The aerosol's multiple-scattering share is folded into the Rayleigh
        // channel on purpose: the Rayleigh phase function (0.060 to 0.119) is
        // close to isotropic, which is the right character for light that has
        // already bounced several times, whereas the Mie lobe is not.
        const o = (j * LUT_AZ + i) * 4;
        this.fR[o] = sr * bRx + msLift * (ar * bRx + br2 * bMs);
        this.fR[o + 1] = sg * bRy + msLift * (ag * bRy + bg2 * bMs);
        this.fR[o + 2] = sb * bRz + msLift * (ab * bRz + bb2 * bMs);
        this.fR[o + 3] = hitGround ? tGreen : 0;
        this.fM[o] = mr * bMs;
        this.fM[o + 1] = mg * bMs;
        this.fM[o + 2] = mb * bMs;
        this.fM[o + 3] = 0;
      }
    }

    for (let i = 0; i < this.fR.length; i++) {
      this.hR[i] = THREE.DataUtils.toHalfFloat(this.fR[i]);
      this.hM[i] = THREE.DataUtils.toHalfFloat(this.fM[i]);
    }
    this.texR.needsUpdate = true;
    this.texM.needsUpdate = true;

    // -- derived quantities the rest of the stack needs ---------------------
    // Transmittance along the sun ray from the ground: this is what reddens both
    // the disc and the direct light at low elevation.
    let tSunR = 1;
    let tSunG = 1;
    let tSunB = 1;
    if (sy > -0.05) {
      const bS = oy * sy;
      const tTop = -bS + Math.sqrt(Math.max(bS * bS - cTop, 0));
      let lodR = 0;
      let lodM = 0;
      let lprev = 0;
      for (let l = 0; l < 16; l++) {
        const g = (l + 1) / 16;
        const tl = tTop * g * g;
        const dl = tl - lprev;
        const lm = lprev + dl * 0.5;
        lprev = tl;
        const qx = sxz * lm;
        const qy = oy + sy * lm;
        const hq = Math.max(Math.sqrt(qx * qx + qy * qy) - PLANET_R, 0);
        lodR += Math.exp(-hq / Hr) * dl;
        lodM += Math.exp(-hq / Hm) * dl;
      }
      tSunR = Math.exp(-(bRx * lodR + bMe * lodM));
      tSunG = Math.exp(-(bRy * lodR + bMe * lodM));
      tSunB = Math.exp(-(bRz * lodR + bMe * lodM));
    } else {
      tSunR = tSunG = tSunB = 0;
    }
    this.sunTransmittance.setRGB(tSunR, tSunG, tSunB);

    this.sunDiscColor
      .copy(res.sunColor)
      .multiply(this.sunTransmittance)
      .multiplyScalar(res.sunIntensity * res.sunDiscBrightness);

    // Ground: direct sun plus a hemisphere of sky, both Lambertian.
    const zen = this.radiance(res, 0, 1, 0, new THREE.Color());
    const skyIrradiance = ((zen.r + zen.g + zen.b) / 3) * Math.PI * 1.15;
    const cosSun = Math.max(sy, 0);
    const e = res.sunIntensity * cosSun;
    this.groundRadiance
      .copy(res.groundAlbedo)
      .multiplyScalar(1 / Math.PI)
      .multiply(
        new THREE.Color().setRGB(
          res.sunColor.r * e * tSunR + skyIrradiance,
          res.sunColor.g * e * tSunG + skyIrradiance,
          res.sunColor.b * e * tSunB + skyIrradiance,
        ),
      );
  }

  /**
   * Full sky radiance for a world direction, phases included — the same value
   * the dome shader computes, so anything derived from it matches the frame.
   * `out` is returned in linear light.
   */
  radiance(
    res: ResolvedAtmosphere,
    dx: number,
    dy: number,
    dz: number,
    out: THREE.Color,
  ): THREE.Color {
    const len = Math.hypot(dx, dy, dz) || 1;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;
    const sy = res.sunDirection.y;
    const sxz = Math.sqrt(Math.max(0, 1 - sy * sy));
    const sh = scratch.v2a;
    if (sxz > 1e-5) sh.set(res.sunDirection.x / sxz, res.sunDirection.z / sxz);
    else sh.set(0, 1);

    const lh = Math.hypot(nx, nz);
    const cosPhi = lh > 1e-5 ? clamp((nx / lh) * sh.x + (nz / lh) * sh.y, -1, 1) : 1;
    const phi = Math.acos(cosPhi);
    const u = (phi / Math.PI) * (LUT_AZ - 1);
    const mu = clamp(ny, -1, 1);
    const v = (0.5 + 0.5 * Math.sign(mu) * Math.sqrt(Math.abs(mu))) * (LUT_ZE - 1);

    const i0 = Math.floor(clamp(u, 0, LUT_AZ - 1));
    const j0 = Math.floor(clamp(v, 0, LUT_ZE - 1));
    const i1 = Math.min(i0 + 1, LUT_AZ - 1);
    const j1 = Math.min(j0 + 1, LUT_ZE - 1);
    const fu = clamp(u - i0, 0, 1);
    const fv = clamp(v - j0, 0, 1);

    const ct = nx * res.sunDirection.x + ny * res.sunDirection.y + nz * res.sunDirection.z;
    const pr = 0.0596831 * (1 + ct * ct);
    const g = this.mieG;
    const g2 = g * g;
    const pm = (1 - g2) / (12.5663706 * Math.pow(Math.max(1 + g2 - 2 * g * ct, 1e-4), 1.5));

    let r = 0;
    let gg = 0;
    let b = 0;
    for (let c = 0; c < 3; c++) {
      const a00 = this.fR[(j0 * LUT_AZ + i0) * 4 + c];
      const a10 = this.fR[(j0 * LUT_AZ + i1) * 4 + c];
      const a01 = this.fR[(j1 * LUT_AZ + i0) * 4 + c];
      const a11 = this.fR[(j1 * LUT_AZ + i1) * 4 + c];
      const lr = (a00 + (a10 - a00) * fu) * (1 - fv) + (a01 + (a11 - a01) * fu) * fv;
      const m00 = this.fM[(j0 * LUT_AZ + i0) * 4 + c];
      const m10 = this.fM[(j0 * LUT_AZ + i1) * 4 + c];
      const m01 = this.fM[(j1 * LUT_AZ + i0) * 4 + c];
      const m11 = this.fM[(j1 * LUT_AZ + i1) * 4 + c];
      const lm = (m00 + (m10 - m00) * fu) * (1 - fv) + (m01 + (m11 - m01) * fu) * fv;
      const sun = c === 0 ? res.sunColor.r : c === 1 ? res.sunColor.g : res.sunColor.b;
      const val = (lr * pr + lm * pm) * sun * res.sunIntensity;
      if (c === 0) r = val;
      else if (c === 1) gg = val;
      else b = val;
    }
    const tint = res.skyTint;
    return out.setRGB(r * tint.r, gg * tint.g, b * tint.b);
  }

  dispose(): void {
    this.texR.dispose();
    this.texM.dispose();
  }
}

function makeLutTexture(data: Uint16Array): THREE.DataTexture {
  const t = new THREE.DataTexture(data, LUT_AZ, LUT_ZE, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// SkyDome
// ---------------------------------------------------------------------------

export interface SkyEnvironmentProfile {
  zenith: number;
  horizon: number;
  ground: number;
  sunColor: number;
  sunDirection: THREE.Vector3;
  sunSize: number;
  sunIntensity: number;
  turbidity: number;
}

export class SkyDome {
  /** Add this to the level's scene. Contains the lights and the sky stack. */
  readonly object = new THREE.Group();
  /** The level's primary light, shadow-configured for this world's sun angle. */
  readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  /** Coloured sky fill. Kept modest so it complements the IBL, not fights it. */
  readonly ambient = new THREE.HemisphereLight(0xffffff, 0x404040, 0.4);

  private res: ResolvedAtmosphere;
  private raw: AtmosphereProfile;
  private lut = new ScatterLut();

  /** Follows the camera so every layer sits at optical infinity. */
  private skyGroup = new THREE.Group();
  private dome: THREE.Mesh;
  private domeGeo: THREE.SphereGeometry;
  private domeMat: THREE.ShaderMaterial;

  private stars: Starfield;
  private aurora: AuroraLayer;
  private space: SpaceBackdrop;
  private clouds: CloudLayer | null = null;

  private sunDistance = 220;
  private starVisibility = 1;
  private tier = settings.profile.tier;
  private skyAmbientColor = new THREE.Color();
  private groundAmbientColor = new THREE.Color();

  constructor(profile: AtmosphereProfile) {
    this.raw = profile;
    this.res = resolveAtmosphere(profile);
    this.object.name = 'skyDome';

    // -- the scattering dome -------------------------------------------------
    this.domeGeo = new THREE.SphereGeometry(SKY_RADIUS, 48, 32);
    this.domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uLutR: { value: this.lut.texR },
        uLutM: { value: this.lut.texM },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunHoriz: { value: new THREE.Vector2(0, 1) },
        uSunDiscColor: { value: new THREE.Color(1, 1, 1) },
        uSunAngR: { value: 0.0075 },
        uSunDiscOn: { value: 1 },
        uGroundRadiance: { value: new THREE.Color(0, 0, 0) },
        uSkyTint: { value: new THREE.Color(1, 1, 1) },
        uMieG: { value: 0.76 },
        uAzScale: { value: (LUT_AZ - 1) / LUT_AZ },
        uAzBias: { value: 0.5 / LUT_AZ },
        uZeScale: { value: (LUT_ZE - 1) / LUT_ZE },
        uZeBias: { value: 0.5 / LUT_ZE },
        uLimbA: { value: LIMB_A },
        uLimbB: { value: LIMB_B },
        uDither: { value: 0.012 },
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      transparent: false,
      depthTest: false,
      depthWrite: false,
    });
    this.dome = new THREE.Mesh(this.domeGeo, this.domeMat);
    this.dome.name = 'skyScattering';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = ORDER_DOME;
    this.dome.castShadow = false;
    this.dome.receiveShadow = false;
    this.skyGroup.add(this.dome);

    // -- celestial layers ----------------------------------------------------
    this.stars = new Starfield(this.res, SKY_RADIUS, ORDER_STARS);
    this.skyGroup.add(this.stars.object);
    this.space = new SpaceBackdrop(this.res, SKY_RADIUS, ORDER_SPACE);
    this.skyGroup.add(this.space.object);
    this.aurora = new AuroraLayer(this.res, ORDER_AURORA);
    this.skyGroup.add(this.aurora.object);

    this.object.add(this.skyGroup);

    // -- lights --------------------------------------------------------------
    this.sun.castShadow = true;
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.bias = 0;
    this.sun.shadow.normalBias = 0.035;
    this.object.add(this.sun);
    this.object.add(this.sun.target);
    this.object.add(this.ambient);

    this.rebuild();
  }

  /** The profile currently in force, with every optional field filled in. */
  get atmosphere(): Readonly<ResolvedAtmosphere> {
    return this.res;
  }

  setProfile(p: AtmosphereProfile): void {
    this.raw = p;
    this.res = resolveAtmosphere(p);
    this.rebuild();
  }

  /**
   * Sky radiance for a world direction, in linear light — the exact value the
   * dome renders (phases included, sun disc excluded). Other systems use this
   * for god-ray tint, aerial perspective and ambient probes; nothing else needs
   * to guess what colour the sky is.
   */
  skyRadiance(direction: THREE.Vector3, out: THREE.Color): THREE.Color {
    return this.lut.radiance(this.res, direction.x, direction.y, direction.z, out);
  }

  /**
   * Install this world's fog. The *brightness* comes from the integrated horizon
   * radiance and only the *hue* from the authored `fogColor` — a fog colour that
   * disagrees with the sky is the single fastest way to make distant geometry
   * read as flat cardboard glowing against a dark sky.
   */
  applyFog(scene: THREE.Scene): void {
    const f = this.res.fogDensity;
    if (f <= 0) {
      scene.fog = null;
      return;
    }
    // Blended a third of the way to the zenith: distant geometry is rarely all
    // on the horizon line, and pure horizon radiance makes anything standing
    // above it read as a glowing cardboard cut-out.
    const col = this.horizonRadiance(new THREE.Color());
    col.lerp(this.lut.radiance(this.res, 0, 1, 0, new THREE.Color()), 0.42);
    const tint = this.res.fogColor.clone();
    const lum = tint.r * 0.2126 + tint.g * 0.7152 + tint.b * 0.0722;
    tint.multiplyScalar(1 / Math.max(lum, 1e-3));
    // 65% of the authored hue, 35% of the sky's own — enough art control to
    // push a world's fog green or amber without ever losing the sky match.
    col.multiply(tint.lerp(WHITE_COLOR, 0.35));
    if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.color.copy(col);
      scene.fog.density = f;
    } else {
      scene.fog = new THREE.FogExp2(0x000000, f);
      (scene.fog as THREE.FogExp2).color.copy(col);
    }
  }

  /** Azimuth-averaged radiance just above the horizon. */
  private horizonRadiance(out: THREE.Color): THREE.Color {
    const r = this.res;
    const sxz = Math.hypot(r.sunDirection.x, r.sunDirection.z) || 1;
    const hx = r.sunDirection.x / sxz;
    const hz = r.sunDirection.z / sxz;
    // Sampled a little above the horizon line as well as on it: FogExp2 has one
    // colour for every direction, and using the pure horizon glow makes distant
    // geometry that sits *above* the horizon glow brighter than the sky behind it.
    const near = this.lut.radiance(r, hx, 0.14, hz, new THREE.Color());
    const side = this.lut.radiance(r, -hz, 0.10, hx, new THREE.Color());
    const far = this.lut.radiance(r, -hx, 0.10, -hz, new THREE.Color());
    // Weighted away from the sunward glow: that glare is a local feature of one
    // azimuth, and letting it set the fog colour makes every distant object in
    // the level glow brighter than the sky behind it.
    return out.setRGB(
      near.r * 0.18 + side.r * 0.44 + far.r * 0.38,
      near.g * 0.18 + side.g * 0.44 + far.g * 0.38,
      near.b * 0.18 + side.b * 0.44 + far.b * 0.38,
    );
  }

  /** Adds the sky stack and the lights to a scene, and installs the fog. */
  attach(scene: THREE.Scene): void {
    scene.add(this.object);
    this.applyFog(scene);
  }

  // -- per-frame ------------------------------------------------------------

  update(elapsed: number, cameraPosition: THREE.Vector3): void {
    // Every layer rides with the camera, so parallax is zero and the sky reads
    // as infinitely distant no matter how far the player walks.
    this.skyGroup.position.copy(cameraPosition);

    if (settings.profile.tier !== this.tier) {
      this.tier = settings.profile.tier;
      this.configureShadow();
      this.clouds?.applyQuality();
    }

    const pixelScale =
      clamp(window.devicePixelRatio || 1, 0.5, settings.profile.maxPixelRatio) *
      settings.resolutionScale;
    this.stars.update(elapsed, pixelScale);
    this.aurora.update(elapsed);
    this.clouds?.update(elapsed, cameraPosition.y);

    // Sun and shadow frustum ride with the camera, snapped to the shadow map's
    // texel grid so the shadow edge does not crawl as the player walks.
    const d = this.res.sunDirection;
    const extent = this.res.shadowExtent;
    const texel = (2 * extent) / Math.max(1, settings.profile.shadowMapSize);
    const right = scratch.v3a.set(0, 1, 0).cross(d);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = scratch.v3b.crossVectors(d, right).normalize();
    const px = Math.round(cameraPosition.dot(right) / texel) * texel;
    const py = Math.round(cameraPosition.dot(up) / texel) * texel;
    const pz = cameraPosition.dot(d);
    const target = scratch.v3c
      .copy(right)
      .multiplyScalar(px)
      .addScaledVector(up, py)
      .addScaledVector(d, pz);
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(d, this.sunDistance);
  }

  // -- environment ----------------------------------------------------------

  /**
   * Sky/ground description for `MaterialLibrary.rebuildEnvironment()`, derived
   * from the *same* integral the dome renders so reflections match the sky.
   *
   * Note on the hex values: `MaterialLibrary` runs `.set(hex)` (which already
   * decodes sRGB to linear under three's colour management) and then
   * `convertSRGBToLinear()` again. To land the linear radiance this sky actually
   * produces, the extra encode is applied here — hence `convertLinearToSRGB()`
   * before `getHex()`, which encodes a second time.
   */
  environmentProfile(): SkyEnvironmentProfile {
    const r = this.res;
    const zen = this.lut.radiance(r, 0, 1, 0, new THREE.Color());
    const hor = this.horizonRadiance(new THREE.Color());

    // Vacuum integrates to nothing. Fall back to the authored colours so a ship
    // in orbit still has *something* to reflect instead of a void.
    if (zen.r + zen.g + zen.b + hor.r + hor.g + hor.b < 1e-4) {
      zen.copy(r.zenith);
      hor.copy(r.horizon);
    }

    // Normalise together so a bright sky keeps its hue relationship instead of
    // clipping one channel and shifting colour.
    const peak = Math.max(zen.r, zen.g, zen.b, hor.r, hor.g, hor.b, 1);
    zen.multiplyScalar(1 / peak);
    hor.multiplyScalar(1 / peak);

    const ground = new THREE.Color().copy(this.lut.groundRadiance).multiplyScalar(1 / peak);
    const gp = Math.max(ground.r, ground.g, ground.b, 1);
    ground.multiplyScalar(1 / gp);

    // Sun disc for the IBL: a soft-box, widened by haze and cloud.
    //
    // Deliberately dim. `MeshStandardMaterial` takes both its diffuse irradiance
    // *and* its specular from the environment map, and the level already has a
    // real DirectionalLight for the sun — so a full-energy env sun would light
    // every surface twice. The disc here exists to give metal a highlight with
    // the right *shape* and *position*, carrying about a quarter of the sun's
    // energy. Total energy (intensity x solid angle) is held constant as the
    // disc widens, so an overcast world gets a soft big highlight instead of a
    // dim one.
    const sunSize = clamp(0.13 + 0.55 * r.cloudCoverage + 0.18 * r.turbidity, 0.12, 0.9);
    const halfAngle = 1.4137 * sunSize;
    const omega = Math.max(2 * Math.PI * (1 - Math.cos(halfAngle)), 1e-4);
    const sunIntensity = clamp((0.28 * r.sunIntensity) / omega, 0.1, 90);

    return {
      zenith: zen.convertLinearToSRGB().getHex(),
      horizon: hor.convertLinearToSRGB().getHex(),
      ground: ground.convertLinearToSRGB().getHex(),
      sunColor: new THREE.Color()
        .copy(r.sunColor)
        .multiply(this.lut.sunTransmittance)
        .convertLinearToSRGB()
        .getHex(),
      sunDirection: r.sunDirection.clone(),
      sunSize,
      sunIntensity,
      turbidity: r.turbidity,
    };
  }

  dispose(): void {
    this.domeGeo.dispose();
    this.domeMat.dispose();
    this.lut.dispose();
    this.stars.dispose();
    this.aurora.dispose();
    this.space.dispose();
    this.clouds?.dispose();
    this.clouds = null;
    this.sun.dispose();
    this.ambient.dispose();
    this.object.clear();
    this.skyGroup.clear();
  }

  // -- internals ------------------------------------------------------------

  private rebuild(): void {
    const r = this.res;
    this.lut.build(r);

    // Zenith radiance drives the ambient rig, the cloud top light and how much
    // of the star field survives.
    const zen = this.lut.radiance(r, 0, 1, 0, new THREE.Color());
    const lum = zen.r * 0.2126 + zen.g * 0.7152 + zen.b * 0.0722;
    this.starVisibility = 1 / (1 + 90 * Math.max(lum, 0));
    this.skyAmbientColor.copy(zen);
    this.groundAmbientColor.copy(this.lut.groundRadiance);

    // -- dome uniforms -----------------------------------------------------
    const u = this.domeMat.uniforms;
    (u.uSunColor.value as THREE.Color).copy(r.sunColor).multiplyScalar(r.sunIntensity);
    (u.uSunDir.value as THREE.Vector3).copy(r.sunDirection);
    const sxz = Math.hypot(r.sunDirection.x, r.sunDirection.z);
    if (sxz > 1e-5) {
      (u.uSunHoriz.value as THREE.Vector2).set(r.sunDirection.x / sxz, r.sunDirection.z / sxz);
    } else {
      (u.uSunHoriz.value as THREE.Vector2).set(0, 1);
    }
    (u.uSunDiscColor.value as THREE.Color).copy(this.lut.sunDiscColor);
    u.uSunAngR.value = r.sunAngularRadius;
    u.uSunDiscOn.value = r.sunDisc ? 1 : 0;
    /**
     * Below-horizon radiance, floored against the world's own fog colour.
     *
     * Rays that point under the horizon hit the *model* planet's ground, and the
     * LUT returns its albedo attenuated by the atmosphere. On a world with a
     * dark ground and a thick one - Draco IX's ash - that integrates to near
     * black, and because real terrain never reaches the model horizon the result
     * is a hard black band sitting between the ridgeline and the sky. Whatever
     * is actually down there is buried in aerial perspective, so the honest
     * value is the fog colour, not the ground's own.
     */
    (u.uGroundRadiance.value as THREE.Color)
      .copy(this.lut.groundRadiance)
      .lerp(r.fogColor, 0.82);
    (u.uSkyTint.value as THREE.Color).copy(r.skyTint);
    u.uMieG.value = r.mieG;

    // -- layers ------------------------------------------------------------
    this.stars.setProfile(r, this.starVisibility);
    this.aurora.setProfile(r);
    this.space.setProfile(r);

    if (r.cloudCoverage > 0.01 && !this.clouds) {
      this.clouds = new CloudLayer(r, SKY_RADIUS, ORDER_CLOUDS);
      this.skyGroup.add(this.clouds.object);
    }
    this.clouds?.setProfile(
      r,
      scratch.colA.copy(this.skyAmbientColor).multiplyScalar(1.5),
      new THREE.Color().copy(this.groundAmbientColor).multiplyScalar(0.9),
    );

    // -- lights ------------------------------------------------------------
    // The direct light is the solar irradiance *after* atmospheric extinction,
    // which is what makes a low sun warm and weak without hand-tinting it.
    this.sun.color.copy(r.sunColor).multiply(this.lut.sunTransmittance);
    const peak = Math.max(this.sun.color.r, this.sun.color.g, this.sun.color.b, 1e-4);
    this.sun.color.multiplyScalar(1 / peak);
    // Cloud cover attenuates the direct beam; the ambient picks the energy up.
    const cloudBlock = 1 - clamp01(r.cloudCoverage) * 0.72;
    this.sun.intensity = r.sunIntensity * peak * cloudBlock;

    // Hemisphere fill: hue from the integrated sky, magnitude from its radiance.
    // A vacuum sky integrates to nothing, so fall back to the authored zenith
    // colour rather than leaving the level with a black fill light.
    this.ambient.color.copy(this.skyAmbientColor);
    let ap = Math.max(this.ambient.color.r, this.ambient.color.g, this.ambient.color.b);
    if (ap < 1e-4) {
      this.ambient.color.copy(r.zenith);
      ap = Math.max(this.ambient.color.r, this.ambient.color.g, this.ambient.color.b, 1e-4);
    }
    this.ambient.color.multiplyScalar(1 / ap);
    this.ambient.groundColor.copy(this.groundAmbientColor);
    let gp = Math.max(
      this.ambient.groundColor.r,
      this.ambient.groundColor.g,
      this.ambient.groundColor.b,
    );
    if (gp < 1e-4) {
      this.ambient.groundColor.copy(r.groundAlbedo);
      gp = Math.max(
        this.ambient.groundColor.r,
        this.ambient.groundColor.g,
        this.ambient.groundColor.b,
        1e-4,
      );
    }
    this.ambient.groundColor.multiplyScalar(1 / gp);
    this.ambient.intensity =
      r.ambientIntensity >= 0
        ? r.ambientIntensity
        : clamp(ap * Math.PI * 0.55 + r.cloudCoverage * r.sunIntensity * 0.16, 0.02, 2.2);

    this.configureShadow();
  }

  private configureShadow(): void {
    const p = settings.profile;
    const r = this.res;
    const extent = r.shadowExtent;
    const s = this.sun.shadow;
    s.mapSize.setScalar(p.shadowMapSize);
    s.camera.left = -extent;
    s.camera.right = extent;
    s.camera.top = extent;
    s.camera.bottom = -extent;
    // A grazing sun casts shadows many times longer than the frustum is wide,
    // so the depth range has to cover the full standoff, not just the extent.
    this.sunDistance = Math.max(extent * 2.2, 200);
    s.camera.near = 0.5;
    s.camera.far = this.sunDistance * 2.1;
    s.camera.updateProjectionMatrix();
    // VSM wants a real blur radius rather than a depth bias.
    s.radius = r.shadowSoftness;
    s.blurSamples = p.tier === 'low' ? 4 : p.tier === 'medium' ? 8 : 12;
    s.needsUpdate = true;
  }
}

/** Convenience: a dome for a named sky, with the table's profile. */
export function skyForProfile(profile: AtmosphereProfile): SkyDome {
  return new SkyDome(profile);
}

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAG = /* glsl */ `
precision highp float;

varying vec3 vDir;

uniform sampler2D uLutR;
uniform sampler2D uLutM;
uniform vec3 uSunColor, uSunDir, uSunDiscColor, uGroundRadiance, uSkyTint, uLimbA, uLimbB;
uniform vec2 uSunHoriz;
uniform float uSunAngR, uSunDiscOn, uMieG;
uniform float uAzScale, uAzBias, uZeScale, uZeBias, uDither;

void main(){
  vec3 d = normalize(vDir);

  // -- LUT lookup ------------------------------------------------------------
  // Azimuth is measured from the sun, and the table is symmetric about it, so
  // only 0..PI is stored.
  float mu = clamp(d.y, -1.0, 1.0);
  vec2 dh = d.xz;
  float lh = length(dh);
  float cosPhi = (lh > 1e-5) ? clamp(dot(dh / lh, uSunHoriz), -1.0, 1.0) : 1.0;
  float u = acos(cosPhi) * 0.3183098862 * uAzScale + uAzBias;
  float v = (0.5 + 0.5 * sign(mu) * sqrt(abs(mu))) * uZeScale + uZeBias;

  vec4 R = texture2D(uLutR, vec2(u, v));
  vec3 M = texture2D(uLutM, vec2(u, v)).rgb;

  // -- phase functions, evaluated at full resolution --------------------------
  float ct = clamp(dot(d, uSunDir), -1.0, 1.0);
  float phaseR = 0.0596831 * (1.0 + ct * ct);
  float g2 = uMieG * uMieG;
  float phaseM = (1.0 - g2) / (12.5663706 * pow(max(1.0 + g2 - 2.0 * uMieG * ct, 1e-4), 1.5));

  vec3 L = (R.rgb * phaseR + M * phaseM) * uSunColor;

  // Distant ground, weighted by the transmittance to it. R.a is zero for any
  // ray that leaves the atmosphere, so this term switches itself off above the
  // horizon without needing a mask.
  L += uGroundRadiance * R.a;

  // -- the sun disc ----------------------------------------------------------
  if (uSunDiscOn > 0.5) {
    float ang = acos(ct);
    if (ang < uSunAngR * 3.0) {
      float aa = max(fwidth(ang), 1e-6);
      float disc = 1.0 - smoothstep(uSunAngR - aa, uSunAngR + aa, ang);
      if (disc > 0.0) {
        // Limb darkening: the rim of the disc is dimmer and warmer than the
        // centre because we look through a shallower slice of photosphere.
        float rr = clamp(ang / max(uSunAngR, 1e-6), 0.0, 1.0);
        float m = sqrt(max(0.0, 1.0 - rr * rr));
        vec3 limb = 1.0 - uLimbA * (1.0 - m) - uLimbB * (1.0 - m) * (1.0 - m);
        L += uSunDiscColor * disc * max(limb, vec3(0.0));
      }
    }
  }

  L *= uSkyTint;

  // Dither. A sky is the one place in a frame with a smooth 300-pixel gradient,
  // which is exactly where 8-bit quantisation shows as banding: multiplicative
  // noise breaks up the bright end, a tiny additive term the near-black end.
  float n1 = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float n2 = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 17.0, vec2(0.00583715, 0.06711056))));
  L *= 1.0 + (n1 - 0.5) * uDither;
  L += (n2 - 0.5) * 0.0009;

  gl_FragColor = vec4(max(L, vec3(0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
