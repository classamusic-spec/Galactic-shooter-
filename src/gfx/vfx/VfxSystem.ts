/**
 * VfxSystem — the single entry point for everything that flashes, sparks,
 * burns, splatters or lingers.
 *
 * Architecture in one paragraph: every effect resolves to writes into a small
 * set of GPU-simulated families (`ParticlePool`), plus four specialised pools
 * (tracers, ribbons, decals, muzzle flashes) and one CPU-simulated debris mesh.
 * Each family is exactly one draw call regardless of how many particles are
 * live, and every trajectory is closed-form in the vertex shader, so the CPU
 * cost of an effect is paid once at spawn and never again. Total steady-state
 * cost of the whole VFX layer is ~11 draw calls.
 *
 * Public entry points come in two flavours by necessity: the design-doc order
 * (`tracer(from, to, color, width)`) and the order the weapon system actually
 * calls with (`tracer(from, to, width, color)`). Both are accepted and
 * disambiguated numerically — a tracer width is always well under 4 and a
 * packed sRGB colour is always well over it — because a silently swapped
 * argument here means white tracers and 0.03-wide "colours", and no compiler
 * can catch it across a structural interface.
 */
import * as THREE from 'three';
import type { EngineSystem } from '@/core/Engine';
import type {
  DamageElement,
  FactionId,
  FrameContext,
  SurfaceKind,
} from '@/types';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import { clamp, Rng } from '@/util/math';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import {
  DebrisPool,
  DustField,
  ParticleFamily,
  RingFamily,
  SpawnDesc,
} from './ParticlePool';
import { TracerPool } from './Tracers';
import { DecalSystem, type DecalKind } from './DecalSystem';
import { RibbonPool, type TrailHandle } from './TrailRibbon';
import { MuzzleFlashPool } from './MuzzleFlash';
import { Impacts, type EffectPools } from './Impacts';
import { Explosions } from './Explosions';
import { ElementalVfx } from './ElementalVfx';

export type { TrailHandle } from './TrailRibbon';
export type { DecalKind } from './DecalSystem';

/** Matches `GRAVITY` in @/gameplay/Physics. Duplicated to keep gfx below gameplay. */
const GRAVITY = 24;

/** Reference budget the family weights are tuned against (the `high` tier). */
const REFERENCE_BUDGET = 9000;

const DECAL_KINDS: readonly string[] = [
  'bulletHole',
  'scorch',
  'blood',
  'ichor',
  'crack',
  'energyBurn',
];

/** Sensible ink for each mark when the caller does not name a surface. */
const DECAL_DEFAULT_COLOR: Record<DecalKind, number> = {
  bulletHole: 0x2b2723,
  scorch: 0x181310,
  blood: 0x5e0d0a,
  ichor: 0x2f7a18,
  crack: 0xdfeef7,
  energyBurn: 0x6fd8ff,
};

const DECAL_LIFE: Record<DecalKind, number> = {
  bulletHole: 55,
  scorch: 50,
  blood: 30,
  ichor: 30,
  crack: 45,
  energyBurn: 22,
};

const NULL_TRAIL: TrailHandle = {
  stop() {
    /* nothing to stop */
  },
  get alive() {
    return false;
  },
  setColor() {
    /* no-op */
  },
  push() {
    /* no-op */
  },
};

interface DistortionHost {
  requestDistortion(pos: THREE.Vector3, radius: number, strength: number, life: number): void;
}

const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _colA = new THREE.Color();
const _box = new THREE.Box3();
const _white = new THREE.Color(1, 1, 1);

export class VfxSystem implements EngineSystem {
  readonly name = 'vfx';
  readonly materials: MaterialLibrary;

  /** The scene the pools are currently parented to. */
  scene: THREE.Scene | null = null;

  private group = new THREE.Group();
  private pools: EffectPools;
  private impacts: Impacts;
  private explosions: Explosions;
  private elemental: ElementalVfx;

  private smoke: ParticleFamily;
  private fire: ParticleFamily;
  private spark: ParticleFamily;
  private glow: ParticleFamily;
  private chip: ParticleFamily;
  private mote: ParticleFamily;
  private rings: RingFamily;
  private tracers: TracerPool;
  private decals: DecalSystem;
  private ribbons: RibbonPool;
  private flashes: MuzzleFlashPool;
  private debris: DebrisPool;
  private gibs: DebrisPool;
  private dust: DustField;

  private simTime = 0;
  private renderTime = 0;
  private depth: THREE.Texture | null = null;
  private postfx: DistortionHost | null = null;
  private postfxProbe = 0;
  private unsubs: Array<() => void> = [];
  private disposed = false;

  /** Barrel-heat tracking: the last muzzle we saw fire, and how hard. */
  private lastMuzzle = new THREE.Vector3();
  private lastMuzzleDir = new THREE.Vector3(0, 0, -1);
  private muzzleHeat = 0;
  private muzzleValid = false;
  private trailCounter = 0;
  private dustConfigured = false;

  constructor(materials: MaterialLibrary) {
    this.materials = materials;
    this.group.name = 'vfx';
    this.group.matrixAutoUpdate = false;

    const profile = settings.profile;
    const budget = Math.max(600, profile.particleBudget);
    const q = clamp(budget / REFERENCE_BUDGET, 0.35, 1.6);
    const cap = (w: number): number => Math.max(48, Math.round(budget * w));

    // Soften distances are per-family: smoke needs a metre of fade to stop it
    // slicing through geometry, a spark needs almost none or it disappears.
    this.smoke = new ParticleFamily({
      capacity: cap(0.2),
      shape: 'puff',
      soften: 1.2,
      renderOrder: 10,
    });
    this.fire = new ParticleFamily({
      capacity: cap(0.13),
      shape: 'fire',
      soften: 0.8,
      renderOrder: 11,
    });
    this.spark = new ParticleFamily({
      capacity: cap(0.26),
      shape: 'spark',
      stretch: true,
      bounce: true,
      soften: 0.08,
      renderOrder: 15,
    });
    this.glow = new ParticleFamily({
      capacity: cap(0.08),
      shape: 'glow',
      soften: 0.5,
      renderOrder: 15,
    });
    this.chip = new ParticleFamily({
      capacity: cap(0.16),
      shape: 'chip',
      bounce: true,
      soften: 0.05,
      renderOrder: 11,
    });
    this.mote = new ParticleFamily({
      capacity: cap(0.05),
      shape: 'mote',
      soften: 0.4,
      renderOrder: 9,
    });

    this.rings = new RingFamily(Math.max(24, Math.round(48 * q)));
    this.tracers = new TracerPool(Math.max(64, Math.round(160 * q)));
    this.decals = new DecalSystem(profile.decalBudget);
    this.ribbons = new RibbonPool(Math.max(6, Math.round(14 * q)));
    this.flashes = new MuzzleFlashPool(Math.max(32, Math.round(96 * q)), 3);
    this.dust = new DustField(Math.max(96, Math.round(budget * 0.12)));

    // Debris uses real lit geometry, so its cap is deliberately small — this is
    // the only part of the VFX layer that costs vertex work per instance.
    const debrisMat = materials.surface('rock', { repeat: 1, roughness: 0.92 });
    const gibMat = materials.surface('flesh', { repeat: 1, roughness: 0.42 });
    this.debris = new DebrisPool(Math.max(12, Math.round(28 * q)), debrisMat, 1.7);
    this.gibs = new DebrisPool(Math.max(10, Math.round(24 * q)), gibMat, 9.3);

    this.pools = {
      smoke: this.smoke,
      fire: this.fire,
      spark: this.spark,
      glow: this.glow,
      chip: this.chip,
      mote: this.mote,
      rings: this.rings,
      decals: this.decals,
      debris: this.debris,
      gibs: this.gibs,
      ribbons: this.ribbons,
      flashes: this.flashes,
      desc: new SpawnDesc(),
      rng: new Rng(0x5eed17),
      quality: q,
      intensity: 1,
      requestDistortion: (pos, radius, strength, life) =>
        this.requestDistortion(pos, radius, strength, life),
    };

    this.impacts = new Impacts(this.pools);
    this.explosions = new Explosions(this.pools);
    this.elemental = new ElementalVfx(this.pools);

    for (const o of this.objects()) this.group.add(o);
    for (const l of this.flashes.lights) this.group.add(l);

    this.applySettings();
    this.subscribe();
  }

  private objectList: THREE.Object3D[] = [];

  private objects(): THREE.Object3D[] {
    if (this.objectList.length) return this.objectList;
    this.objectList = [
      this.decals.object,
      this.dust.object,
      this.mote.object,
      this.smoke.object,
      this.chip.object,
      this.fire.object,
      this.rings.object,
      this.ribbons.object,
      this.tracers.object,
      this.spark.object,
      this.glow.object,
      this.flashes.object,
      this.debris.object,
      this.gibs.object,
    ];
    return this.objectList;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Re-parent every pool into a new level's scene. Called on each level load. */
  attach(scene: THREE.Scene): void {
    if (this.scene === scene) return;
    this.scene = scene;
    this.clear();
    scene.add(this.group);
    this.dustConfigured = false;
    // Atmosphere is not optional in a AAA frame: if the level has fog it has
    // air, and air has particulate. Levels can override with ambientDust().
    if (scene.fog) {
      _colA.copy((scene.fog as THREE.Fog | THREE.FogExp2).color).lerp(_white, 0.35);
      this.dust.configure(null, Math.round(this.dust.capacity * 0.7), _colA, 0.03, 30);
    } else {
      this.dust.configure(null, 0, _colA.setRGB(1, 1, 1), 0.03, 30);
    }
  }

  /**
   * Enable depth-aware soft particles. The texture MUST NOT be the depth
   * attachment currently bound for writing while the particles draw — sampling
   * a live attachment is a feedback loop. Pass a resolved copy.
   */
  setDepthTexture(t: THREE.Texture | null): void {
    this.depth = t;
    this.smoke.setDepthTexture(t);
    this.fire.setDepthTexture(t);
    this.spark.setDepthTexture(t);
    this.glow.setDepthTexture(t);
    this.chip.setDepthTexture(t);
    this.mote.setDepthTexture(t);
    this.rings.setDepthTexture(t);
  }

  get depthTexture(): THREE.Texture | null {
    return this.depth;
  }

  update(ctx: FrameContext): void {
    this.simTime = ctx.elapsed;
    this.smoke.setSimTime(this.simTime);
    this.fire.setSimTime(this.simTime);
    this.spark.setSimTime(this.simTime);
    this.glow.setSimTime(this.simTime);
    this.chip.setSimTime(this.simTime);
    this.mote.setSimTime(this.simTime);
    this.rings.setSimTime(this.simTime);
    this.tracers.setSimTime(this.simTime);
    this.decals.setSimTime(this.simTime);
    this.flashes.setSimTime(this.simTime);

    this.debris.update(ctx.dt, GRAVITY);
    this.gibs.update(ctx.dt, GRAVITY);

    // Barrel heat decays whether or not the trigger is held.
    this.muzzleHeat = Math.max(0, this.muzzleHeat - ctx.dt * 1.6);

    if (!this.postfx && ctx.elapsed > this.postfxProbe) {
      this.postfxProbe = ctx.elapsed + 2;
      this.resolvePostFx();
    }
  }

  render(ctx: FrameContext, alpha: number): void {
    // Particles are evaluated against a render-time clock so they move smoothly
    // between the 120 Hz simulation steps instead of stepping.
    this.renderTime = Math.max(this.renderTime, ctx.elapsed + alpha * ctx.dt);
    const t = this.renderTime;
    this.smoke.flush(t);
    this.fire.flush(t);
    this.spark.flush(t);
    this.glow.flush(t);
    this.chip.flush(t);
    this.mote.flush(t);
    this.rings.flush(t);
    this.tracers.flush(t);
    this.decals.flush(t);
    this.dust.flush(t);
    this.flashes.flush(t, ctx.frameDt);
    this.ribbons.flush(ctx.frameDt);
    this.debris.flush();
    this.gibs.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.group.removeFromParent();
    this.smoke.dispose();
    this.fire.dispose();
    this.spark.dispose();
    this.glow.dispose();
    this.chip.dispose();
    this.mote.dispose();
    this.rings.dispose();
    this.tracers.dispose();
    this.decals.dispose();
    this.ribbons.dispose();
    this.flashes.dispose();
    this.dust.dispose();
    this.debris.dispose();
    this.gibs.dispose();
    this.scene = null;
  }

  /** Drop every live effect. Used on level change and on respawn. */
  clear(): void {
    this.smoke.clear();
    this.fire.clear();
    this.spark.clear();
    this.glow.clear();
    this.chip.clear();
    this.mote.clear();
    this.rings.clear();
    this.tracers.clear();
    this.decals.clear();
    this.ribbons.clear();
    this.flashes.clear();
    this.debris.clear();
    this.gibs.clear();
  }

  // -------------------------------------------------------------------------
  // Public effect API
  // -------------------------------------------------------------------------

  /**
   * A travelling bullet streak. Accepts `(from, to, color, width, speed)` and
   * the weapon system's `(from, to, width, color, speed)` — see the class note.
   */
  tracer(
    from: THREE.Vector3,
    to: THREE.Vector3,
    colorOrWidth: number,
    widthOrColor: number,
    speed = 900,
  ): void {
    if (this.pools.intensity <= 0) return;
    let color = colorOrWidth;
    let width = widthOrColor;
    if (colorOrWidth < 4 && widthOrColor >= 4) {
      color = widthOrColor;
      width = colorOrWidth;
    }
    const w = clamp(width, 0.008, 0.6);
    this.tracers.fire(from, to, color, w, Math.max(40, speed));

    // Heavy rounds leave a wake. Puffs are spawned along the flight path with a
    // delay equal to their arrival time, so the smoke appears *behind* the
    // tracer as it travels rather than all at once.
    if (w > 0.042) {
      const dist = _vA.subVectors(to, from).length();
      const steps = Math.min(6, Math.max(2, Math.round(dist / 9)));
      _vA.divideScalar(Math.max(dist, 1e-4));
      const d = this.pools.desc;
      for (let i = 1; i <= steps; i++) {
        const travel = (dist * i) / (steps + 1);
        d.reset()
          .atXyz(
            from.x + _vA.x * travel,
            from.y + _vA.y * travel,
            from.z + _vA.z * travel,
          )
          .vel(0, 0.25, 0)
          .tint(0x8f8c88, 0.5)
          .size(0.05, 0.42)
          .live(0.5, 0.24);
        d.drag = 2.5;
        d.gravity = -0.2;
        d.turbulence = 0.2;
        d.delay = travel / Math.max(40, speed);
        this.smoke.spawn(d);
      }
    }
  }

  /** Continuous beam (trace rifle). Accepts either argument order. */
  beam(from: THREE.Vector3, to: THREE.Vector3, a: number, b: number): void {
    if (this.pools.intensity <= 0) return;
    let color = a;
    let width = b;
    if (a < 4 && b >= 4) {
      color = b;
      width = a;
    }
    this.tracers.beam(from, to, color, clamp(width, 0.008, 0.6));
  }

  impact(point: THREE.Vector3, normal: THREE.Vector3, surface: SurfaceKind, scale = 1): void {
    this.impacts.surface(point, normal, surface, scale);
  }

  explosion(point: THREE.Vector3, radius: number, element: DamageElement): void {
    this.explosions.detonate(point, radius, element);
    // Element signature layered on top of the physical blast.
    if (element === 'arc' || element === 'void' || element === 'stasis') {
      this.elemental.burst(point, element, Math.min(2, radius * 0.35));
    }
  }

  muzzle(
    position: THREE.Vector3,
    direction: THREE.Vector3,
    intensity: number,
    color: number,
  ): void {
    if (this.pools.intensity <= 0) return;
    this.flashes.flash(position, direction, intensity, color);
    this.lastMuzzle.copy(position);
    this.lastMuzzleDir.copy(direction);
    this.muzzleValid = true;
    this.muzzleHeat = Math.min(6, this.muzzleHeat + 1);

    // Propellant gas: a couple of fast grey wisps pushed down the barrel line.
    const d = this.pools.desc;
    const rng = this.pools.rng;
    for (let i = 0; i < 2; i++) {
      d.reset()
        .at(position)
        .vel(
          direction.x * rng.range(1.5, 3.5) + rng.range(-0.4, 0.4),
          direction.y * rng.range(1.5, 3.5) + rng.range(-0.2, 0.5),
          direction.z * rng.range(1.5, 3.5) + rng.range(-0.4, 0.4),
        )
        .tint(0xa8a49c, 0.45)
        .size(0.035, 0.24 + intensity * 0.09)
        .live(rng.range(0.22, 0.4), 0.30);
      d.drag = 5.5;
      d.gravity = -0.5;
      d.turbulence = 0.25;
      this.smoke.spawn(d);
    }
  }

  /**
   * Place a mark. Accepts a `DecalKind` directly, or a `SurfaceKind` (which the
   * weapon system passes) and picks the right mark and colour for that material.
   */
  decal(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    kind: DecalKind | SurfaceKind,
    size: number,
  ): void {
    if (this.pools.intensity <= 0) return;
    if (DECAL_KINDS.indexOf(kind) >= 0) {
      const k = kind as DecalKind;
      this.decals.place(point, normal, k, size, DECAL_DEFAULT_COLOR[k], DECAL_LIFE[k], 1);
      return;
    }
    const surface = kind as SurfaceKind;
    this.decals.place(
      point,
      normal,
      DecalSystem.kindForSurface(surface),
      size,
      DecalSystem.colorForSurface(surface),
      45,
      1,
      surface,
    );
  }

  /**
   * Fluid hit on a creature. Accepts `(point, normal, faction, amount)` and the
   * weapon system's `(point, normal, amount)`.
   */
  bloodOrIchor(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    faction: FactionId | number,
    amount = 1,
  ): void {
    let f: FactionId = 'reptilian';
    let amt = amount;
    if (typeof faction === 'number') amt = faction;
    else f = faction;
    this.impacts.bloodOrIchor(point, normal, f, amt);
  }

  shieldBreak(point: THREE.Vector3, element: DamageElement, radius: number): void {
    this.elemental.shieldBreak(point, element, radius);
  }

  elementalBurst(point: THREE.Vector3, element: DamageElement, scale = 1): void {
    this.elemental.burst(point, element, scale);
  }

  /** Arc chain lightning between two points. Exposed for abilities. */
  chain(from: THREE.Vector3, to: THREE.Vector3, color = 0x7fdcff, width = 0.06): void {
    if (this.pools.intensity <= 0) return;
    this.elemental.chainLightning(from, to, color, width, 0.15, 1, 2);
  }

  /**
   * Attach a ribbon trail to an object. Also accepts the projectile system's
   * per-frame `(position, color, scale)` form, which emits a throttled trail
   * puff instead and returns an inert handle.
   */
  trail(
    follow: THREE.Object3D | THREE.Vector3,
    color: number,
    width: number,
    life = 0.45,
  ): TrailHandle {
    if (this.pools.intensity <= 0) return NULL_TRAIL;
    if ((follow as THREE.Vector3).isVector3) {
      const pos = follow as THREE.Vector3;
      // Called every simulation step per projectile: sample it down hard.
      if (this.trailCounter++ % 3 !== 0) return NULL_TRAIL;
      const d = this.pools.desc;
      const s = Math.max(0.03, width * 0.5);
      d.reset()
        .at(pos)
        .tint(color, 2.2)
        .size(s, s * 2.4)
        .live(0.22, 0.85);
      d.drag = 5;
      this.glow.spawn(d);
      d.reset()
        .at(pos)
        .vel(0, 0.4, 0)
        .tint(color, 0.35)
        .size(s * 1.1, s * 4.5)
        .live(0.5, 0.3);
      d.drag = 3;
      d.gravity = -0.4;
      d.turbulence = 0.2;
      this.smoke.spawn(d);
      return NULL_TRAIL;
    }
    return this.ribbons.follow(follow as THREE.Object3D, color, width, life, 1);
  }

  /**
   * Fill a volume with drifting motes. `bounds` may be null for a camera-follow
   * field, which is what an open outdoor level wants.
   */
  ambientDust(
    bounds: THREE.Box3 | null,
    density: number,
    color: number | THREE.Color,
    moteSize = 0.03,
  ): void {
    if (typeof color === 'number') _colA.setHex(color, THREE.SRGBColorSpace);
    else _colA.copy(color);
    let count: number;
    if (bounds) {
      _box.copy(bounds);
      const size = _box.getSize(_vA);
      const volume = Math.max(1, size.x * size.y * size.z);
      count = clamp(volume * density, 0, this.dust.capacity);
      this.dust.configure(_box, count, _colA, moteSize);
    } else {
      count = clamp(this.dust.capacity * clamp(density, 0, 1), 0, this.dust.capacity);
      this.dust.configure(null, count, _colA, moteSize, 30);
    }
    this.dustConfigured = true;
  }

  /** A single lit chunk of a destroyed body. */
  spawnGib(position: THREE.Vector3, velocity: THREE.Vector3, faction: FactionId): void {
    if (this.pools.intensity <= 0) return;
    const rng = this.pools.rng;
    _colA.setHex(FACTION_GIB[faction] ?? 0x5a3a30, THREE.SRGBColorSpace);
    this.gibs.spawn(
      position,
      velocity,
      rng.range(0.16, 0.34),
      rng.range(2.2, 4.0),
      position.y - 2.2,
      _colA,
    );
    // A gib that leaves no trail reads as a floating prop.
    const d = this.pools.desc;
    d.reset()
      .at(position)
      .vel(velocity.x * 0.3, velocity.y * 0.3, velocity.z * 0.3)
      .tint(FLUID_BY_FACTION[faction] ?? 0x6b0f0b, 0.9)
      .size(0.05, 0.02)
      .live(0.5, 1);
    d.drag = 0.6;
    d.gravity = 24;
    d.floorY = position.y - 2.2;
    this.chip.spawn(d);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private subscribe(): void {
    this.unsubs.push(
      events.on('impact:surface', (p) => {
        this.impact(p.point, p.normal, p.surface, p.scale ?? 1);
      }),
      events.on('explosion', (p) => {
        this.explosion(p.point, p.radius, p.element);
      }),
      events.on('enemy:killed', (p) => {
        this.onKill(p.position, p.element, p.precision);
      }),
      events.on('enemy:shieldBroken', (p) => {
        this.shieldBreak(p.position, p.element, 1.1);
      }),
      events.on('weapon:fired', () => {
        this.onWeaponFired();
      }),
      events.on('settings:changed', () => {
        this.applySettings();
      }),
    );
  }

  private onKill(position: THREE.Vector3, element: DamageElement, precision: boolean): void {
    if (this.pools.intensity <= 0) return;
    const rng = this.pools.rng;
    _vA.copy(position);
    this.elemental.burst(_vA, element, precision ? 1.25 : 0.95);
    // Death spray plus a few chunks; the faction is not carried on this event,
    // so the neutral dark-organic set is used (see report).
    this.impacts.fluidBurst(_vA, _vA.y - 1.5, precision ? 1.4 : 1.0, 0x5c1410, 0);
    const chunks = Math.round(3 * this.pools.quality) + (precision ? 2 : 0);
    for (let i = 0; i < chunks; i++) {
      rng.onSphere(_vB);
      _vB.multiplyScalar(rng.range(2.5, 6));
      _vB.y = Math.abs(_vB.y) + 2.5;
      this.spawnGib(_vA, _vB, 'reptilian');
    }
  }

  /**
   * Sustained fire heats the barrel. After a burst the muzzle keeps venting for
   * a second or two — a small thing, but it is the difference between a weapon
   * that fires and a weapon that is *hot*.
   */
  private onWeaponFired(): void {
    if (!this.muzzleValid || this.pools.intensity <= 0) return;
    if (this.muzzleHeat < 3.5) return;
    const rng = this.pools.rng;
    if (!rng.bool(0.35)) return;
    const d = this.pools.desc;
    d.reset()
      .at(this.lastMuzzle)
      .vel(
        this.lastMuzzleDir.x * 0.35 + rng.range(-0.15, 0.15),
        0.55 + rng.range(0, 0.35),
        this.lastMuzzleDir.z * 0.35 + rng.range(-0.15, 0.15),
      )
      .tint(0x9aa0a6, 0.30)
      .size(0.04, 0.32)
      .live(rng.range(0.7, 1.2), 0.22);
    d.drag = 2.2;
    d.gravity = -0.55;
    d.turbulence = 0.3;
    this.smoke.spawn(d);
  }

  private applySettings(): void {
    const reduced = settings.user.reducedMotion;
    this.pools.intensity = reduced ? 0.6 : 1;
    const fade = reduced ? 0.55 : 1;
    this.smoke.setFade(fade);
    this.fire.setFade(fade);
    this.spark.setFade(fade);
    this.glow.setFade(reduced ? 0.35 : 1);
    this.chip.setFade(fade);
    this.mote.setFade(fade);
    this.rings.setFade(reduced ? 0.4 : 1);
    this.tracers.setFade(fade);
    this.decals.setFade(1);
    this.ribbons.setFade(fade);
    this.flashes.setFade(reduced ? 0.4 : 1);
    this.dust.setFade(fade);
  }

  // -------------------------------------------------------------------------
  // PostFX bridge
  // -------------------------------------------------------------------------

  /** Wire the distortion sink explicitly. Optional — see `resolvePostFx`. */
  setPostFX(host: DistortionHost | null): void {
    this.postfx = host;
  }

  private requestDistortion(
    pos: THREE.Vector3,
    radius: number,
    strength: number,
    life: number,
  ): void {
    if (!this.postfx) return;
    this.postfx.requestDistortion(pos, radius, strength, life);
  }

  /**
   * PostFX is constructed before this system but is not handed to it, so the
   * heat-haze sink is discovered through the debug bridge Game installs. Failing
   * to find it costs nothing: explosions simply do not warp the frame.
   */
  private resolvePostFx(): void {
    const gf = (globalThis as { GF?: { game?: { postfx?: unknown } } }).GF;
    const candidate = gf?.game?.postfx as DistortionHost | undefined;
    if (candidate && typeof candidate.requestDistortion === 'function') {
      this.postfx = candidate;
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics (used by the capture harness)
  // -------------------------------------------------------------------------

  stats(): Record<string, number> {
    return {
      smoke: this.smoke.drawn,
      fire: this.fire.drawn,
      spark: this.spark.drawn,
      glow: this.glow.drawn,
      chip: this.chip.drawn,
      mote: this.mote.drawn,
      rings: this.rings.object.visible ? 1 : 0,
      decals: (this.decals.object.geometry as THREE.InstancedBufferGeometry).instanceCount,
      tracers: (this.tracers.object.geometry as THREE.InstancedBufferGeometry).instanceCount,
      drawCalls: this.objects().length,
      dustConfigured: this.dustConfigured ? 1 : 0,
      depth: this.depth ? 1 : 0,
    };
  }
}

/** Chunk colours per faction — armour and carapace, not fluid. */
const FACTION_GIB: Record<FactionId, number> = {
  nordic: 0x6d7c88,
  grey: 0x51486a,
  mantis: 0x4a5c22,
  insectoid: 0x5a3d1c,
  reptilian: 0x54332a,
  federation: 0x6a6f74,
};

const FLUID_BY_FACTION: Record<FactionId, number> = {
  nordic: 0x7fb8d8,
  grey: 0xa774e8,
  mantis: 0x93e024,
  insectoid: 0xd98a1c,
  reptilian: 0x9c0f0b,
  federation: 0x8c1a12,
};
