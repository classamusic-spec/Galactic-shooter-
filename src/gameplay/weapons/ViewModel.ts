/**
 * ViewModel — the weapon in your hands.
 *
 * Three things make a first-person weapon feel expensive, and all three are
 * here:
 *
 * 1. **It is rendered with its own projection.** The world runs at a 95°
 *    horizontal FOV, which stretches anything 30 cm from the eye into a
 *    fish-eyed mess. Rather than paying for a second render pass (PostFX owns
 *    the pipeline, and a second pass would break MRT/TAA), the view model's
 *    materials substitute a narrow-FOV projection matrix in the vertex shader
 *    and squash their NDC depth into the nearest slice of the buffer. The
 *    result is a correctly-proportioned weapon that still receives the world's
 *    lighting, IBL, shadows and post-processing, in the same pass, for free.
 *
 * 2. **Everything is a spring, not a lerp.** Fire kick, look sway and the
 *    landing dip are second-order systems with real overshoot, so the weapon
 *    lags the camera and settles past centre instead of gliding to a stop.
 *
 * 3. **The reload is a performance.** Six timed stages — dip, mag release,
 *    hand travel, insert, slap, chamber, settle — driven off the *simulation's*
 *    reload clock, so the animation and the gameplay state can never disagree.
 *
 * Animation runs in `render()` off `frameDt`; nothing here feeds gameplay.
 */
import * as THREE from 'three';
import type { WeaponFamily, WeaponStats } from '@/types';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { settings } from '@/core/Settings';
import { clamp, clamp01, damp, lerp, smoothstep, smootherstep, Rng } from '@/util/math';
import { buildWeaponModel, disposeMeshCache, type WeaponModel } from './WeaponMeshes';
import type { WeaponCollision } from './WeaponDefs';

/**
 * Horizontal FOV the view model is rendered at, degrees — hip and fully aimed.
 * The world runs at 95°; rendering the weapon at 55° is what stops the barrel
 * from shearing across the frame.
 */
const VM_FOV_HIP = 55;
const VM_FOV_ADS = 48;
/**
 * Fraction of the depth range the view model is squashed into. Small enough
 * that nothing in the world can ever intersect it, large enough that the
 * weapon's own overlapping plates do not z-fight with each other.
 */
const VM_DEPTH = 0.2;
/** Distance from the eye the aligned optic sits at, metres. */
const ADS_SIGHT_DISTANCE = 0.42;
/**
 * View-model scale. The meshes are authored at true size (a 0.9 m rifle is 0.9 m
 * so that muzzle, optic and ejection port land in physically sensible places);
 * the held pose renders them slightly reduced, which is what every shooter does
 * to keep the weapon from eating the frame.
 */
const VM_SCALE = 0.84;
/** Forward probe length used to keep the barrel out of walls. */
const WALL_PROBE = 0.85;

const CHUNK = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = uVmProjection * mvPosition;
// Squash into the near sliver of the depth range: the weapon can never be
// intersected by world geometry, but its own parts still self-occlude.
gl_Position.z = mix( -gl_Position.w, gl_Position.z, uVmDepth );
`;

/**
 * The view model's private three-point rig, injected into the fragment shader.
 *
 * A first-person weapon is the largest object in every frame and it is 30 cm
 * from the eye, which means the world's lighting is exactly wrong for it. The
 * world's key is a directional sun somewhere out in the level; if the player
 * turns their back on it — which Aurvangr's own composition does deliberately,
 * to show the aurora — the weapon receives no direct light at all and renders as
 * a flat black cut-out. Before this, that is what it did on four of the five
 * worlds, including reading cold blue-black inside Hive Prime's amber cavern.
 *
 * Every shooter solves this the same way film does: the hero prop gets its own
 * rig, locked to the camera rather than to the world, so it is always modelled.
 * Three terms, all in *view* space so they never swing:
 *
 *  - **Key** over the player's left shoulder. Tinted with the world's sun colour,
 *    so the weapon still belongs to the planet it is on.
 *  - **Fill** from below and to the right, tinted with the world's ground bounce,
 *    which is what stops the underside of the receiver going to pure black.
 *  - **Rim**, a Fresnel term tinted with the sky's own horizon radiance. This is
 *    what separates the barrel from the background and puts the amber back on
 *    the weapon in a Hive Prime frame.
 *
 * The rim is scaled by `1 - roughness` so machined trim rims hard and polymer
 * grips barely at all — a flat Fresnel over everything reads as a plastic toy.
 * Costs no extra lights (so the program set and the light-loop length are both
 * unchanged) and no extra draw calls.
 */
const LIGHT_CHUNK = /* glsl */ `
#include <aomap_fragment>
{
  vec3 vmN = normalize( normal );
  vec3 vmV = normalize( vViewPosition );
  // Half-lambert on the key: a hard terminator on a 5 cm receiver reads as a
  // shading bug rather than as light.
  float vmKey = dot( vmN, uVmKeyDir ) * 0.5 + 0.5;
  vmKey *= vmKey;
  // Plain lambert, not wrapped: the fill must reach zero somewhere or the weapon
  // has no unlit side at all, and a weapon with no darks in it reads as plastic.
  float vmFill = clamp( dot( vmN, uVmFillDir ), 0.0, 1.0 );
  float vmRim = pow( clamp( 1.0 - dot( vmN, vmV ), 0.0, 1.0 ), uVmRimPower );
  reflectedLight.directDiffuse += diffuseColor.rgb * ( uVmKeyColor * vmKey + uVmFillColor * vmFill );
  // A specular lobe on the key, not just a diffuse one. The weapon's structural
  // materials run metalness 0.7-1.0, where diffuseColor is almost black and a
  // diffuse key therefore does nothing at all — which is why the receiver read
  // as one flat value taken straight from the environment map. The highlight is
  // what gives a machined plate its edge and its form.
  vec3 vmH = normalize( uVmKeyDir + vmV );
  float vmGloss = 1.0 - roughnessFactor;
  float vmSpec = pow( clamp( dot( vmN, vmH ), 0.0, 1.0 ), mix( 6.0, 190.0, vmGloss ) );
  reflectedLight.directSpecular +=
    uVmKeyColor * vmSpec * mix( 0.18, 1.1, vmGloss )
    + uVmRimColor * vmRim * mix( 0.12, 0.8, vmGloss );
}
`;

export interface ViewModelState {
  camera: THREE.PerspectiveCamera;
  /** Wall-clock delta for this rendered frame. */
  frameDt: number;
  elapsed: number;
  /** Horizontal speed, m/s, and the sprint reference speed. */
  speed: number;
  maxSpeed: number;
  grounded: boolean;
  sprinting: boolean;
  crouching: boolean;
  /** Simulation-authoritative ADS blend, 0..1. */
  ads: number;
  /** Simulation-authoritative reload progress, 0..1, or -1 when not reloading. */
  reload: number;
  reloadEmpty: boolean;
  /** Charge/draw progress, 0..1. */
  charge: number;
  /** True on the frame a perfect-draw window opens (bow). */
  perfectDraw: boolean;
  /** Rounds left, for the empty-bolt-hold pose. */
  magazine: number;
  collision: WeaponCollision | null;
  visible: boolean;
}

interface Shell {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  quat: THREE.Quaternion;
  life: number;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _scaleOne = new THREE.Vector3(1, 1, 1);
const _hiddenShell = new THREE.Matrix4().makeScale(0, 0, 0);
const _fwd = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);

/** Families that visibly eject a case. */
const EJECTS: Partial<Record<WeaponFamily, boolean>> = {
  autoRifle: true,
  pulseRifle: true,
  scoutRifle: true,
  handCannon: false,
  sidearm: true,
  submachineGun: true,
  shotgun: true,
  sniperRifle: true,
  machineGun: true,
};

/** Families whose reciprocating part rides the whole shot (open bolt / slide). */
const SLIDE_FAMILIES: Partial<Record<WeaponFamily, number>> = {
  sidearm: 0.026,
  submachineGun: 0.022,
  autoRifle: 0.012,
  pulseRifle: 0.011,
  machineGun: 0.018,
};

/** Families with a manual action cycled after each shot. */
const BOLT_FAMILIES: Partial<Record<WeaponFamily, number>> = {
  sniperRifle: 0.055,
  scoutRifle: 0.026,
  shotgun: 0.07,
};

export class ViewModel {
  /** Root added to the level scene; its matrix is driven from the camera. */
  readonly root = new THREE.Group();

  private lib: MaterialLibrary | null;
  private models = new Map<string, WeaponModel>();
  private model: WeaponModel | null = null;
  private stats: WeaponStats | null = null;

  // -- projection override ---------------------------------------------------
  private vmCamera = new THREE.PerspectiveCamera(VM_FOV_HIP, 1, 0.02, 12);
  private projUniform = { value: new THREE.Matrix4() };
  private depthUniform = { value: VM_DEPTH };
  private lastAspect = 0;
  private lastFov = -1;

  // -- private lighting rig --------------------------------------------------
  // View-space directions, so the rig is welded to the camera and the weapon is
  // modelled the same no matter which way the player is facing. +x right,
  // +y up, +z toward the viewer.
  private keyDirUniform = { value: new THREE.Vector3(-0.46, 0.66, 0.6).normalize() };
  private fillDirUniform = { value: new THREE.Vector3(0.55, -0.55, 0.63).normalize() };
  private keyColorUniform = { value: new THREE.Color(0.5, 0.48, 0.44) };
  private fillColorUniform = { value: new THREE.Color(0.09, 0.09, 0.1) };
  private rimColorUniform = { value: new THREE.Color(0.5, 0.6, 0.75) };
  // A rifle is mostly flat plates seen close to edge-on, so a soft Fresnel
  // covers most of its surface rather than its edges. Measured at power 3.2 the
  // whole weapon took the sky's hue and read as lavender plastic on Zeta and
  // blew to white on Khepri; 5.0 keeps the term on the silhouette where a rim
  // belongs.
  private rimPowerUniform = { value: 5.0 };
  /** Every material the view model owns, for env-map refresh. */
  private ownMaterials: THREE.MeshStandardMaterial[] = [];
  /** Identity of the IBL these materials were last pointed at. */
  private lastEnvironment: THREE.Texture | null = null;
  /**
   * Identity of the sky the rig was last tinted from. Three separate fields
   * rather than a composed key: this is compared every rendered frame, and a
   * template string there would allocate in a hot path.
   */
  private lastEnvSun: THREE.ColorRepresentation | null = null;
  private lastEnvHorizon: THREE.ColorRepresentation | null = null;
  private lastEnvGround: THREE.ColorRepresentation | null = null;

  // -- pose ------------------------------------------------------------------
  // Stock exits the bottom-right corner, barrel converges on the crosshair.
  private hipPos = new THREE.Vector3(0.128, -0.138, -0.47);
  private hipRot = new THREE.Euler(0.018, 0.15, -0.045, 'YXZ');
  private adsPos = new THREE.Vector3();
  private adsRot = new THREE.Euler(0, 0, 0, 'YXZ');
  private curPos = new THREE.Vector3();
  private curRot = new THREE.Euler(0, 0, 0, 'YXZ');

  // -- springs ---------------------------------------------------------------
  private kickPos = new THREE.Vector3();
  private kickVel = new THREE.Vector3();
  private kickRot = new THREE.Vector3();
  private kickRotVel = new THREE.Vector3();
  private swayPos = new THREE.Vector3();
  private swayVel = new THREE.Vector3();
  private swayRot = new THREE.Vector3();
  private swayRotVel = new THREE.Vector3();
  private bobPhase = 0;
  private bobAmount = 0;
  private landDip = 0;
  private landDipVel = 0;
  private wasGrounded = true;

  // -- action ----------------------------------------------------------------
  private cycle = 0; // 0..1 bolt/slide cycle
  private cycleSpeed = 8;
  private inspectT = -1;
  private lowerT = 0; // 0 = raised, 1 = fully stowed
  private lowerTarget = 0;
  private swapPhase: 'idle' | 'out' | 'in' = 'idle';
  private swapTimer = 0;
  private swapOutTime = 0.22;
  private swapInTime = 0.26;
  private pendingWeapon: WeaponStats | null = null;
  private wallPush = 0;

  // -- camera tracking -------------------------------------------------------
  private prevCamQuat = new THREE.Quaternion();
  private hasPrevQuat = false;

  // -- muzzle light + shells -------------------------------------------------
  private muzzleLight = new THREE.PointLight(0xffd9a0, 0, 9, 2);
  private muzzleFlash = 0;
  private shells: Shell[] = [];
  private shellMesh: THREE.InstancedMesh;
  private shellGeo: THREE.BufferGeometry;
  private shellMat: THREE.MeshStandardMaterial;
  private shellCursor = 0;
  private rng = new Rng(0x1f37c5);

  private scene: THREE.Scene | null = null;
  private decorate: (m: THREE.Material) => void;
  private placedOnce = false;

  constructor(materials: MaterialLibrary | null) {
    this.lib = materials;
    this.root.name = 'viewModel';
    this.root.matrixAutoUpdate = false;
    this.root.frustumCulled = false;
    // Tell any G-buffer/override-material pass to skip us: our vertex shader
    // writes a bespoke projection that an override material would not honour.
    this.root.userData.viewModel = true;
    this.root.userData.noGBuffer = true;

    const proj = this.projUniform;
    const depth = this.depthUniform;
    const keyDir = this.keyDirUniform;
    const fillDir = this.fillDirUniform;
    const keyColor = this.keyColorUniform;
    const fillColor = this.fillColorUniform;
    const rimColor = this.rimColorUniform;
    const rimPower = this.rimPowerUniform;
    this.decorate = (m: THREE.Material): void => {
      const prev = m.onBeforeCompile;
      m.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
        prev?.call(this, shader, renderer);
        shader.uniforms.uVmProjection = proj;
        shader.uniforms.uVmDepth = depth;
        shader.vertexShader =
          'uniform mat4 uVmProjection;\nuniform float uVmDepth;\n' +
          shader.vertexShader.replace('#include <project_vertex>', CHUNK);
        // Only lit materials carry `reflectedLight` and `roughnessFactor`; the
        // unlit ones (there are none today, but a tracer material would be one)
        // are left alone rather than failing to compile.
        if (shader.fragmentShader.includes('#include <aomap_fragment>')) {
          shader.uniforms.uVmKeyDir = keyDir;
          shader.uniforms.uVmFillDir = fillDir;
          shader.uniforms.uVmKeyColor = keyColor;
          shader.uniforms.uVmFillColor = fillColor;
          shader.uniforms.uVmRimColor = rimColor;
          shader.uniforms.uVmRimPower = rimPower;
          shader.fragmentShader =
            'uniform vec3 uVmKeyDir;\nuniform vec3 uVmFillDir;\n' +
            'uniform vec3 uVmKeyColor;\nuniform vec3 uVmFillColor;\n' +
            'uniform vec3 uVmRimColor;\nuniform float uVmRimPower;\n' +
            shader.fragmentShader.replace('#include <aomap_fragment>', LIGHT_CHUNK);
        }
      };
      const prevKey = m.customProgramCacheKey;
      m.customProgramCacheKey = function (this: THREE.Material) {
        return `vm|${prevKey ? prevKey.call(this) : ''}`;
      };
      // Remembered so the per-planet IBL rebuild can be forwarded to them. The
      // library only auto-updates materials *it* created; these are built
      // privately by WeaponMeshes (deliberately — see the note there), so
      // nothing was re-pointing them and after the first planet load every one
      // of them held a texture whose render target had already been disposed.
      // That is why the weapon rendered flat black at metalness 0.7-1.0.
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        this.ownMaterials.push(m as THREE.MeshStandardMaterial);
      }
      m.needsUpdate = true;
    };

    // Muzzle light lives in the scene permanently at zero intensity, so the
    // light count — and therefore the shader program set — never changes.
    this.muzzleLight.name = 'muzzleFlash';
    this.muzzleLight.castShadow = false;

    // Shell pool: one instanced draw call for every case in flight.
    const shellCap = Math.round(clamp(settings.profile.particleBudget / 300, 8, 28));
    this.shellGeo = new THREE.CylinderGeometry(0.0042, 0.0046, 0.019, 6, 1, false);
    this.shellMat = new THREE.MeshStandardMaterial({
      color: 0xd8a24a,
      roughness: 0.28,
      metalness: 1,
      envMapIntensity: 1.6,
    });
    if (materials) this.shellMat.envMap = materials.environment;
    // Ejected cases fly into the world and are rendered with the world camera,
    // so they get the IBL refresh but not the view model's projection or rig.
    this.ownMaterials.push(this.shellMat);
    this.shellMesh = new THREE.InstancedMesh(this.shellGeo, this.shellMat, shellCap);
    for (let i = 0; i < shellCap; i++) {
      this.shells.push({
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        life: 0,
      });
      this.shellMesh.setMatrixAt(i, _hiddenShell);
    }
    this.shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shellMesh.frustumCulled = false;
    this.shellMesh.castShadow = false;
  }

  // -- lifecycle -------------------------------------------------------------

  attach(scene: THREE.Scene): void {
    if (this.scene === scene) return;
    this.detach();
    this.scene = scene;
    scene.add(this.root);
    scene.add(this.muzzleLight);
    scene.add(this.shellMesh);
  }

  detach(): void {
    if (!this.scene) return;
    this.scene.remove(this.root);
    this.scene.remove(this.muzzleLight);
    this.scene.remove(this.shellMesh);
    this.scene = null;
  }

  /** Swap the held weapon immediately (no stow animation). */
  setWeapon(stats: WeaponStats): void {
    if (this.stats?.id === stats.id && this.model) return;
    if (this.model) this.root.remove(this.model.root);
    let m = this.models.get(stats.id);
    if (!m) {
      m = buildWeaponModel(stats, this.lib, this.decorate);
      this.models.set(stats.id, m);
    }
    this.model = m;
    this.stats = stats;
    m.root.scale.setScalar(VM_SCALE);
    m.root.updateMatrix();
    this.root.add(m.root);
    this.computeAdsPose();
    this.cycle = 0;
    this.inspectT = -1;
  }

  /** Begin a stow → swap → raise sequence. `next` is applied at the midpoint. */
  beginSwap(next: WeaponStats, outTime: number, inTime: number): void {
    this.pendingWeapon = next;
    this.swapOutTime = Math.max(0.05, outTime);
    this.swapInTime = Math.max(0.05, inTime);
    this.swapPhase = 'out';
    this.swapTimer = 0;
    this.inspectT = -1;
  }

  get swapping(): boolean {
    return this.swapPhase !== 'idle';
  }

  inspect(): void {
    if (this.swapPhase !== 'idle') return;
    this.inspectT = 0;
  }

  get inspecting(): boolean {
    return this.inspectT >= 0;
  }

  /** Called on every shot: kick spring, flash, case, action cycle. */
  fire(stats: WeaponStats, adsProgress: number): void {
    const ads = clamp01(adsProgress);
    const scale = lerp(1, 0.55, ads);
    const kick = stats.modelKick * scale;
    // Straight back, a touch down-right, with a random smear so a long burst
    // never repeats exactly.
    this.kickVel.x += (this.rng.next() * 2 - 1) * kick * 5;
    this.kickVel.y += (-0.25 - this.rng.next() * 0.3) * kick * 9;
    this.kickVel.z += kick * 34;
    this.kickRotVel.x -= kick * 46; // muzzle rises
    this.kickRotVel.y += (this.rng.next() * 2 - 1) * kick * 18;
    this.kickRotVel.z += (this.rng.next() * 2 - 1) * kick * 26;

    this.muzzleFlash = 1;
    this.muzzleLight.color.setHex(stats.tracerColor);

    const slide = SLIDE_FAMILIES[stats.family];
    const bolt = BOLT_FAMILIES[stats.family];
    if (slide != null) {
      this.cycle = 1;
      this.cycleSpeed = clamp((stats.rpm / 60) * 2.6, 6, 26);
    } else if (bolt != null) {
      this.cycle = 1;
      this.cycleSpeed = clamp((stats.rpm / 60) * 2.2, 3.2, 9);
    }
    if (EJECTS[stats.family]) this.ejectShell();
    if (stats.family === 'handCannon' || stats.family === 'grenadeLauncher') {
      // Index the cylinder one chamber.
      const cyl = this.model?.nodes.cylinder;
      if (cyl) cyl.userData.targetRoll = (cyl.userData.targetRoll ?? 0) + Math.PI / 3;
    }
  }

  get adsPoseReady(): boolean {
    return this.model != null;
  }

  /** True once `render()` has positioned the model in the world at least once. */
  get placed(): boolean {
    return this.placedOnce;
  }

  get triangles(): number {
    return this.model?.triangles ?? 0;
  }

  /** World-space muzzle position, for tracer and muzzle-flash spawning. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    if (!this.model) return out.set(0, 0, 0);
    this.model.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.model.muzzle.matrixWorld);
  }

  // -- per-frame -------------------------------------------------------------

  render(s: ViewModelState): void {
    const dt = Math.min(s.frameDt, 1 / 30);
    this.root.visible = s.visible;
    this.shellMesh.visible = s.visible;
    if (!s.visible) {
      this.muzzleLight.intensity = 0;
      return;
    }
    if (!this.model || !this.stats) return;

    this.syncToWorld();
    this.updateProjection(s);
    this.updateSwap(dt);
    this.updateSprings(s, dt);
    this.composePose(s, dt);
    this.updateActionNodes(s, dt);
    this.updateMuzzle(s, dt);
    this.updateShells(dt);
  }

  /**
   * Re-point the IBL and re-tint the private rig when the planet changes.
   *
   * Both are identity checks against values the library owns, so this is a
   * couple of compares in the common case and allocates nothing. It runs every
   * frame rather than off an event because `MaterialLibrary` has no event and
   * `ViewModel` must not start importing the level layer to get one.
   */
  private syncToWorld(): void {
    const lib = this.lib;
    if (!lib) return;

    if (lib.environment !== this.lastEnvironment) {
      this.lastEnvironment = lib.environment;
      for (const m of this.ownMaterials) {
        m.envMap = lib.environment;
        m.needsUpdate = true;
      }
    }

    const p = lib.environmentProfile;
    if (
      p.sunColor === this.lastEnvSun &&
      p.horizon === this.lastEnvHorizon &&
      p.ground === this.lastEnvGround
    ) {
      return;
    }
    this.lastEnvSun = p.sunColor;
    this.lastEnvHorizon = p.horizon;
    this.lastEnvGround = p.ground;

    // `.set(hex).convertSRGBToLinear()` mirrors what MaterialLibrary does with
    // the same profile, so the weapon's rig and the world's IBL are lit from
    // one description of the sky rather than two that drift apart.
    this.keyColorUniform.value.set(p.sunColor).convertSRGBToLinear();
    // Normalised then re-levelled: the profile's sun colour carries the world's
    // hue but an arbitrary magnitude, and the key's *brightness* is a fixed
    // art-direction choice, not a physical quantity.
    const keyPeak = Math.max(
      this.keyColorUniform.value.r,
      this.keyColorUniform.value.g,
      this.keyColorUniform.value.b,
      1e-4,
    );
    // Modest on purpose. The IBL is the weapon's main light source now that it
    // is reaching the materials again; this rig exists to guarantee modelling
    // when the world's own key is behind the player, not to replace it.
    this.keyColorUniform.value.multiplyScalar(0.22 / keyPeak);

    this.rimColorUniform.value.set(p.horizon).convertSRGBToLinear();
    const rimPeak = Math.max(
      this.rimColorUniform.value.r,
      this.rimColorUniform.value.g,
      this.rimColorUniform.value.b,
      1e-4,
    );
    this.rimColorUniform.value.multiplyScalar(0.2 / rimPeak);

    this.fillColorUniform.value.set(p.ground).convertSRGBToLinear();
    const fillPeak = Math.max(
      this.fillColorUniform.value.r,
      this.fillColorUniform.value.g,
      this.fillColorUniform.value.b,
      1e-4,
    );
    this.fillColorUniform.value.multiplyScalar(0.08 / fillPeak);
  }

  private updateProjection(s: ViewModelState): void {
    const cam = s.camera;
    const fov = lerp(VM_FOV_HIP, VM_FOV_ADS, smoothstep(s.ads));
    if (cam.aspect !== this.lastAspect || Math.abs(fov - this.lastFov) > 0.01) {
      this.lastAspect = cam.aspect;
      this.lastFov = fov;
      this.vmCamera.aspect = cam.aspect;
      // Hor+ like the world camera, so ultrawide does not crop the weapon.
      const hFov = fov * (Math.PI / 180);
      const halfH = Math.tan(hFov / 2) / Math.max(cam.aspect, 1e-4);
      this.vmCamera.fov = 2 * Math.atan(halfH) * (180 / Math.PI);
      this.vmCamera.updateProjectionMatrix();
    }
    this.projUniform.value.copy(this.vmCamera.projectionMatrix);
  }

  /** Solve the pose that puts the optic dead centre at ADS_SIGHT_DISTANCE. */
  private computeAdsPose(): void {
    if (!this.model) return;
    const sight = this.model.sight;
    // Markers are direct children of the model root, which is a direct child of
    // the view-model root, so the local offset is the marker's position scaled
    // by the view-model reduction.
    _v.copy(sight.position).multiplyScalar(VM_SCALE).add(this.model.root.position);
    this.adsRot.set(0, 0, 0);
    _q.setFromEuler(this.adsRot);
    _v2.copy(_v).applyQuaternion(_q);
    this.adsPos.set(-_v2.x, -_v2.y, -ADS_SIGHT_DISTANCE - _v2.z);
  }

  private updateSwap(dt: number): void {
    if (this.swapPhase === 'out') {
      this.swapTimer += dt;
      this.lowerTarget = 1;
      if (this.swapTimer >= this.swapOutTime) {
        if (this.pendingWeapon) this.setWeapon(this.pendingWeapon);
        this.pendingWeapon = null;
        this.swapPhase = 'in';
        this.swapTimer = 0;
        this.lowerT = 1;
      }
    } else if (this.swapPhase === 'in') {
      this.swapTimer += dt;
      this.lowerTarget = 0;
      if (this.swapTimer >= this.swapInTime) this.swapPhase = 'idle';
    } else {
      this.lowerTarget = 0;
    }
    const rate = this.swapPhase === 'out' ? 1 / this.swapOutTime : 1 / this.swapInTime;
    this.lowerT = damp(this.lowerT, this.lowerTarget, rate * 3.2, dt);
  }

  private updateSprings(s: ViewModelState, dt: number): void {
    // -- fire kick: critically-ish damped, tuned to overshoot slightly ------
    springVec(this.kickPos, this.kickVel, 260, 22, dt);
    springVec(this.kickRot, this.kickRotVel, 210, 19, dt);

    // -- look sway: the weapon lags the camera, then overshoots -------------
    s.camera.getWorldQuaternion(_q);
    if (!this.hasPrevQuat) {
      this.prevCamQuat.copy(_q);
      this.hasPrevQuat = true;
    }
    _q2.copy(this.prevCamQuat).invert().premultiply(_q);
    _e.setFromQuaternion(_q2, 'YXZ');
    this.prevCamQuat.copy(_q);
    const invDt = dt > 1e-5 ? 1 / dt : 0;
    const yawRate = clamp(_e.y * invDt, -14, 14);
    const pitchRate = clamp(_e.x * invDt, -14, 14);
    const swayGain = lerp(1, 0.22, s.ads);

    this.swayVel.x += (yawRate * 0.011 * swayGain - this.swayPos.x) * 300 * dt;
    this.swayVel.y += (pitchRate * 0.009 * swayGain - this.swayPos.y) * 300 * dt;
    this.swayVel.multiplyScalar(Math.exp(-17 * dt));
    this.swayPos.x += this.swayVel.x * dt;
    this.swayPos.y += this.swayVel.y * dt;
    this.swayPos.x = clamp(this.swayPos.x, -0.05, 0.05);
    this.swayPos.y = clamp(this.swayPos.y, -0.05, 0.05);

    this.swayRotVel.y += (-yawRate * 0.05 * swayGain - this.swayRot.y) * 260 * dt;
    this.swayRotVel.x += (-pitchRate * 0.04 * swayGain - this.swayRot.x) * 260 * dt;
    this.swayRotVel.z += (yawRate * 0.055 * swayGain - this.swayRot.z) * 220 * dt;
    this.swayRotVel.multiplyScalar(Math.exp(-15 * dt));
    this.swayRot.addScaledVector(this.swayRotVel, dt);
    this.swayRot.x = clamp(this.swayRot.x, -0.28, 0.28);
    this.swayRot.y = clamp(this.swayRot.y, -0.32, 0.32);
    this.swayRot.z = clamp(this.swayRot.z, -0.3, 0.3);

    // -- bob ---------------------------------------------------------------
    const speedN = clamp01(s.speed / Math.max(1, s.maxSpeed));
    const target = s.grounded ? speedN : 0;
    this.bobAmount = damp(this.bobAmount, target, 7, dt);
    this.bobPhase += dt * lerp(5.4, 9.4, speedN) * (s.sprinting ? 1.18 : 1);
    if (this.bobPhase > Math.PI * 2) this.bobPhase -= Math.PI * 2;

    // -- landing dip -------------------------------------------------------
    if (s.grounded && !this.wasGrounded) this.landDipVel -= 1.9;
    this.wasGrounded = s.grounded;
    const dipAccel = -this.landDip * 190 - this.landDipVel * 17;
    this.landDipVel += dipAccel * dt;
    this.landDip += this.landDipVel * dt;
  }

  private composePose(s: ViewModelState, dt: number): void {
    const model = this.model!;
    const stats = this.stats!;
    const ads = smootherstep(s.ads);

    // Base pose: hip → aligned optic.
    this.curPos.lerpVectors(this.hipPos, this.adsPos, ads);
    this.curRot.set(
      lerp(this.hipRot.x, this.adsRot.x, ads),
      lerp(this.hipRot.y, this.adsRot.y, ads),
      lerp(this.hipRot.z, this.adsRot.z, ads),
    );

    const free = 1 - ads * 0.86; // how much idle motion survives aiming

    // -- breathing ---------------------------------------------------------
    const br = s.elapsed * 2.1;
    this.curPos.y += Math.sin(br) * 0.0032 * free;
    this.curPos.x += Math.sin(br * 0.53) * 0.0022 * free;
    this.curRot.x += Math.sin(br * 0.71) * 0.006 * free;

    // -- walk / sprint bob (figure of eight) -------------------------------
    const amp = this.bobAmount * free;
    this.curPos.x += Math.sin(this.bobPhase) * 0.022 * amp;
    this.curPos.y += Math.sin(this.bobPhase * 2) * 0.014 * amp - 0.006 * amp;
    this.curRot.z += Math.sin(this.bobPhase) * 0.055 * amp;
    this.curRot.x += Math.sin(this.bobPhase * 2) * 0.024 * amp;

    // -- sway, kick, dip ----------------------------------------------------
    this.curPos.x += this.swayPos.x;
    this.curPos.y += this.swayPos.y + this.landDip * 0.05;
    this.curPos.add(this.kickPos);
    this.curRot.x += this.swayRot.x + this.kickRot.x + this.landDip * 0.12;
    this.curRot.y += this.swayRot.y + this.kickRot.y;
    this.curRot.z += this.swayRot.z + this.kickRot.z;

    // -- sprint pose: canted out of the way, forward and low ---------------
    const sprintPose = s.sprinting && s.speed > 1 && s.reload < 0 ? 1 : 0;
    this.sprintBlend = damp(this.sprintBlend, sprintPose * (1 - ads), 9, dt);
    if (this.sprintBlend > 1e-3) {
      const b = smoothstep(this.sprintBlend);
      this.curPos.x += 0.035 * b;
      this.curPos.y += -0.055 * b;
      this.curPos.z += 0.06 * b;
      this.curRot.x += 0.34 * b;
      this.curRot.y += 0.55 * b;
      this.curRot.z += -0.42 * b;
    }

    // -- reload performance -------------------------------------------------
    if (s.reload >= 0) this.applyReloadPose(s, model, stats);
    else this.restIdleNodes(dt);

    // -- charge / draw ------------------------------------------------------
    if (s.charge > 0) this.applyChargePose(s, model, stats);
    else if (stats.family === 'bow') this.applyBowString(model, 0);

    // -- inspect ------------------------------------------------------------
    if (this.inspectT >= 0) {
      this.inspectT += dt;
      const t = this.inspectT / 1.9;
      if (t >= 1) this.inspectT = -1;
      else {
        const w = Math.sin(clamp01(t) * Math.PI); // ease in and back out
        this.curPos.x += -0.045 * w;
        this.curPos.y += 0.03 * w;
        this.curPos.z += 0.09 * w;
        this.curRot.y += 1.15 * w;
        this.curRot.z += -0.62 * w;
        this.curRot.x += 0.22 * Math.sin(t * Math.PI * 2) * w;
      }
    }

    // -- stow / raise -------------------------------------------------------
    if (this.lowerT > 1e-3) {
      const l = smoothstep(this.lowerT);
      this.curPos.y += -0.30 * l;
      this.curPos.z += 0.07 * l;
      this.curRot.x += 1.05 * l;
      this.curRot.z += 0.4 * l;
    }

    // -- wall avoidance -----------------------------------------------------
    this.applyWallPush(s, dt);

    // Compose into the root matrix in camera space.
    _q.setFromEuler(this.curRot);
    _m.compose(this.curPos, _q, _scaleOne);
    s.camera.updateWorldMatrix(true, false);
    this.root.matrix.multiplyMatrices(s.camera.matrixWorld, _m);
    this.root.matrixWorldNeedsUpdate = true;
    this.root.updateMatrixWorld(true);
    this.placedOnce = true;
  }

  private sprintBlend = 0;

  /**
   * Keep the barrel out of geometry: probe forward from the eye and, when
   * something is close, pull the weapon back toward the camera and rotate the
   * muzzle up — the same trick every console shooter uses.
   */
  private applyWallPush(s: ViewModelState, dt: number): void {
    let target = 0;
    if (s.collision) {
      s.camera.getWorldDirection(_fwd);
      s.camera.getWorldPosition(_v3);
      const hit = s.collision.raycast(_v3, _fwd, WALL_PROBE);
      if (hit) target = clamp01(1 - hit.distance / WALL_PROBE);
    }
    this.wallPush = damp(this.wallPush, target, 16, dt);
    if (this.wallPush > 1e-3) {
      const w = smoothstep(this.wallPush);
      this.curPos.z += 0.19 * w;
      this.curPos.y += -0.03 * w;
      this.curRot.x += 0.5 * w;
      this.curRot.y += 0.24 * w;
    }
  }

  /**
   * Six-stage reload. `t` is the simulation's normalised progress, so the
   * animation cannot drift from the gameplay state by even a frame.
   */
  private applyReloadPose(s: ViewModelState, model: WeaponModel, stats: WeaponStats): void {
    const t = clamp01(s.reload);
    const empty = s.reloadEmpty;
    // Stage boundaries. The empty variant spends its extra time on the chamber
    // cycle at the end, which is exactly where a real one does.
    const dipEnd = 0.11;
    const dropEnd = 0.3;
    const travelEnd = 0.5;
    const insertEnd = 0.68;
    const slapEnd = 0.8;
    const chamberEnd = empty ? 0.92 : 0.84;

    // Whole-weapon motion: dip and cant so the magwell faces the camera.
    const dip = t < dipEnd ? smoothstep(t / dipEnd) : t > chamberEnd ? 1 - smoothstep((t - chamberEnd) / (1 - chamberEnd)) : 1;
    // Enough dip and cant to sell the magwell turning toward the camera, but
    // not so much that the weapon leaves the frame — the player is meant to
    // watch the magazine change, not a corner of a receiver.
    // The weapon comes *up* and *in*, not down and away: the whole point of a
    // reload animation is that the player watches the magazine change.
    this.curPos.y += 0.032 * dip;
    this.curPos.x += -0.058 * dip;
    this.curPos.z += 0.055 * dip;
    this.curRot.x += 0.16 * dip;
    this.curRot.z += -0.34 * dip;
    this.curRot.y += 0.22 * dip;

    // The slap: a sharp jolt back up as the magazine seats.
    if (t > insertEnd && t < slapEnd) {
      const k = Math.sin(((t - insertEnd) / (slapEnd - insertEnd)) * Math.PI);
      this.curPos.y += 0.024 * k;
      this.curRot.x += -0.12 * k;
    }

    const mag = model.magazine;
    if (mag) {
      let drop = 0;
      if (t > dipEnd && t < travelEnd) drop = smoothstep((t - dipEnd) / (dropEnd - dipEnd));
      else if (t >= travelEnd && t < insertEnd) drop = 1 - smoothstep((t - travelEnd) / (insertEnd - travelEnd));
      mag.position.y = mag.userData.baseY ?? (mag.userData.baseY = mag.position.y);
      mag.position.y -= drop * 0.26;
      mag.position.z = (mag.userData.baseZ ?? (mag.userData.baseZ = mag.position.z)) + drop * 0.04;
      mag.rotation.x = (mag.userData.baseRX ?? (mag.userData.baseRX = mag.rotation.x)) + drop * 0.5;
      mag.visible = drop < 0.98 || t < travelEnd;
    }

    // Chamber: cycle the bolt at the end (always for an empty reload).
    if (model.bolt && t > slapEnd && t < chamberEnd) {
      const k = Math.sin(((t - slapEnd) / (chamberEnd - slapEnd)) * Math.PI);
      this.cycle = Math.max(this.cycle, k);
      if (empty && k > 0.9) this.ejectShell();
    }
    // Shotgun/GL: work the pump or swing the drum out at the same beat.
    const pump = model.nodes.pump;
    if (pump && t > dipEnd && t < insertEnd) {
      const k = Math.sin(((t - dipEnd) / (insertEnd - dipEnd)) * Math.PI);
      pump.position.z = (pump.userData.baseZ ?? (pump.userData.baseZ = pump.position.z)) + k * 0.075;
    }
    const drum = model.nodes.cylinder;
    if (drum && t > dipEnd && t < slapEnd) {
      const k = Math.sin(((t - dipEnd) / (slapEnd - dipEnd)) * Math.PI);
      drum.position.x = (drum.userData.baseX ?? (drum.userData.baseX = drum.position.x)) - k * 0.055;
      drum.rotation.z = (drum.userData.targetRoll ?? 0) + k * 2.4;
    }
    const belt = model.nodes.belt;
    if (belt) belt.position.y = (belt.userData.baseY ?? (belt.userData.baseY = belt.position.y)) - (1 - dip) * 0.0;
  }

  /** Return magazine/pump/drum to rest after a reload finishes. */
  private restIdleNodes(dt: number): void {
    const model = this.model;
    if (!model) return;
    const mag = model.magazine;
    if (mag && mag.userData.baseY != null) {
      mag.position.y = damp(mag.position.y, mag.userData.baseY as number, 22, dt);
      mag.position.z = damp(mag.position.z, mag.userData.baseZ as number, 22, dt);
      mag.rotation.x = damp(mag.rotation.x, mag.userData.baseRX as number, 22, dt);
      mag.visible = true;
    }
    const pump = model.nodes.pump;
    if (pump && pump.userData.baseZ != null) {
      pump.position.z = damp(pump.position.z, pump.userData.baseZ as number, 24, dt);
    }
    const drum = model.nodes.cylinder;
    if (drum) {
      if (drum.userData.baseX != null) {
        drum.position.x = damp(drum.position.x, drum.userData.baseX as number, 20, dt);
      }
      drum.rotation.z = damp(drum.rotation.z, (drum.userData.targetRoll as number) ?? 0, 16, dt);
    }
  }

  /** Charge weapons: coils spin up; the bow draws, flexes and nocks. */
  private applyChargePose(s: ViewModelState, model: WeaponModel, stats: WeaponStats): void {
    const c = clamp01(s.charge);
    if (stats.family === 'bow') {
      const draw = smoothstep(c);
      const arrow = model.nodes.arrow;
      if (arrow) arrow.position.z = (arrow.userData.baseZ ?? (arrow.userData.baseZ = arrow.position.z)) + draw * 0.2;
      const top = model.nodes.limbTop;
      const bot = model.nodes.limbBottom;
      if (top) top.rotation.x = -draw * 0.26;
      if (bot) bot.rotation.x = draw * 0.26;
      this.applyBowString(model, draw);
      // Draw weight: the bow is hauled in toward the cheek and tips up.
      this.curPos.z += draw * 0.03;
      this.curPos.x += -draw * 0.012;
      this.curRot.x += -draw * 0.05;
      return;
    }
    const coils = model.nodes.coils;
    if (coils) {
      coils.rotation.z += s.frameDt * (2 + c * 22);
      const pulse = 1 + Math.sin(s.elapsed * (8 + c * 40)) * 0.02 * c;
      coils.scale.setScalar(pulse);
    }
    // The whole weapon tenses as the charge builds.
    this.curPos.z += c * 0.022;
    this.curRot.x += -c * 0.05;
    this.curPos.y += Math.sin(s.elapsed * 42) * 0.0022 * c;
    if (s.perfectDraw) this.kickRotVel.x -= 2.4;
  }

  /** Re-aim the two string segments at the nock point. */
  private applyBowString(model: WeaponModel, draw: number): void {
    const top = model.nodes.stringTop;
    const bot = model.nodes.stringBottom;
    const arrow = model.nodes.arrow;
    if (!top || !bot) return;
    const nockZ = (arrow ? (arrow.userData.baseZ as number | undefined) ?? arrow.position.z : 0) + draw * 0.2 + 0.02;
    _v.set(0.006, 0.048, nockZ);
    for (const seg of [top, bot]) {
      _v2.copy(_v).sub(seg.position);
      const len = _v2.length();
      if (len < 1e-4) continue;
      _v2.multiplyScalar(1 / len);
      seg.quaternion.setFromUnitVectors(_zAxis, _v2);
      seg.scale.set(1, 1, len);
    }
  }

  /** Bolt/slide reciprocation and cylinder settle. */
  private updateActionNodes(s: ViewModelState, dt: number): void {
    const model = this.model!;
    const stats = this.stats!;
    const bolt = model.bolt;
    if (this.cycle > 0) this.cycle = Math.max(0, this.cycle - dt * this.cycleSpeed);
    if (bolt) {
      const travel = SLIDE_FAMILIES[stats.family] ?? BOLT_FAMILIES[stats.family] ?? 0;
      if (bolt.userData.baseZ == null) bolt.userData.baseZ = bolt.position.z;
      // A hard snap back and a slower return reads as mechanical, not springy.
      const c = this.cycle;
      const shape = c > 0.55 ? (1 - c) / 0.45 : c / 0.55;
      const held = s.magazine <= 0 && travel > 0 && stats.fireMode !== 'beam' ? 1 : 0;
      const t = Math.max(clamp01(shape), held);
      bolt.position.z = (bolt.userData.baseZ as number) + t * travel;
    }
    const glow = model.nodes.coils;
    if (glow && s.charge <= 0 && stats.family !== 'traceRifle') {
      glow.scale.setScalar(damp(glow.scale.x, 1, 12, dt));
    }
  }

  private updateMuzzle(s: ViewModelState, dt: number): void {
    const model = this.model!;
    const stats = this.stats!;
    this.muzzleFlash = Math.max(0, this.muzzleFlash - dt * 26);
    if (this.muzzleFlash > 0) {
      model.muzzle.updateWorldMatrix(true, false);
      this.muzzleLight.position.setFromMatrixPosition(model.muzzle.matrixWorld);
      // Bright and extremely short: it should read as a flash, not a lamp.
      this.muzzleLight.intensity =
        this.muzzleFlash * this.muzzleFlash * 26 * stats.muzzleIntensity;
      this.muzzleLight.distance = 5 + stats.muzzleIntensity * 4;
    } else {
      this.muzzleLight.intensity = 0;
    }
  }

  // -- shells ---------------------------------------------------------------

  private ejectShell(): void {
    const model = this.model;
    if (!model || this.shells.length === 0) return;
    const s = this.shells[this.shellCursor];
    this.shellCursor = (this.shellCursor + 1) % this.shells.length;
    model.ejectPort.updateWorldMatrix(true, false);
    _m2.copy(model.ejectPort.matrixWorld);
    s.pos.setFromMatrixPosition(_m2);
    // Eject along the port's local +X, kicked up and slightly forward.
    _v.set(1, 0.55, 0.18).normalize().transformDirection(_m2);
    s.vel.copy(_v).multiplyScalar(2.1 + this.rng.next() * 0.9);
    s.spin.set(
      (this.rng.next() * 2 - 1) * 24,
      (this.rng.next() * 2 - 1) * 24,
      (this.rng.next() * 2 - 1) * 30,
    );
    s.quat.setFromRotationMatrix(_m2);
    s.life = 1.15;
  }

  private updateShells(dt: number): void {
    let any = false;
    for (let i = 0; i < this.shells.length; i++) {
      const s = this.shells[i];
      if (s.life <= 0) continue;
      any = true;
      s.life -= dt;
      s.vel.y -= 24 * dt;
      s.pos.addScaledVector(s.vel, dt);
      _e.set(s.spin.x * dt, s.spin.y * dt, s.spin.z * dt, 'YXZ');
      _q.setFromEuler(_e);
      s.quat.multiply(_q);
      const fade = clamp01(s.life * 3);
      _v.setScalar(fade);
      _m.compose(s.pos, s.quat, _v);
      this.shellMesh.setMatrixAt(i, s.life > 0 ? _m : _hiddenShell);
      if (s.life <= 0) this.shellMesh.setMatrixAt(i, _hiddenShell);
    }
    if (any) this.shellMesh.instanceMatrix.needsUpdate = true;
  }

  // -- teardown -------------------------------------------------------------

  dispose(): void {
    this.detach();
    for (const m of this.models.values()) m.dispose();
    this.models.clear();
    this.model = null;
    this.shellGeo.dispose();
    this.shellMat.dispose();
    this.shellMesh.dispose();
    // References only — every one of these is owned and disposed by the model it
    // came from (or, for the shell material, by the line above). Dropping them
    // stops a torn-down view model from keeping disposed materials alive.
    this.ownMaterials.length = 0;
    this.lastEnvironment = null;
    this.lastEnvSun = null;
    this.lastEnvHorizon = null;
    this.lastEnvGround = null;
    disposeMeshCache();
  }
}

/** Damped harmonic spring on a vector, integrated semi-implicitly. */
function springVec(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  stiffness: number,
  damping: number,
  dt: number,
): void {
  // Sub-step so a long frame cannot make the spring explode.
  const steps = dt > 1 / 90 ? 2 : 1;
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    vel.x += (-pos.x * stiffness - vel.x * damping) * h;
    vel.y += (-pos.y * stiffness - vel.y * damping) * h;
    vel.z += (-pos.z * stiffness - vel.z * damping) * h;
    pos.x += vel.x * h;
    pos.y += vel.y * h;
    pos.z += vel.z * h;
  }
}
