/**
 * Impacts — surface-specific hit reactions.
 *
 * The single most important readability rule in a shooter: the player must know
 * what they hit without looking at it directly. Rock throws grey dust and chips,
 * metal throws orange sparks that bounce, sand puffs and produces nothing else,
 * ice glitters, flesh sprays wet and dark. Every recipe below is tuned so the
 * *colour and motion signature* differs at a glance, not just the particle count.
 *
 * Each recipe is a handful of `SpawnDesc` writes into shared families, so a
 * 12-pellet shotgun blast into rock is ~90 attribute writes and still one draw
 * call per family.
 */
import * as THREE from 'three';
import type { SurfaceKind, FactionId } from '@/types';
import { Rng } from '@/util/math';
import { ParticleFamily, RingFamily, SpawnDesc, DebrisPool } from './ParticlePool';
import { DecalSystem } from './DecalSystem';
import type { RibbonPool } from './TrailRibbon';
import type { MuzzleFlashPool } from './MuzzleFlash';

/** Everything the effect recipes are allowed to touch. */
export interface EffectPools {
  smoke: ParticleFamily;
  fire: ParticleFamily;
  spark: ParticleFamily;
  glow: ParticleFamily;
  chip: ParticleFamily;
  mote: ParticleFamily;
  rings: RingFamily;
  decals: DecalSystem;
  debris: DebrisPool;
  gibs: DebrisPool;
  ribbons: RibbonPool;
  flashes: MuzzleFlashPool;
  desc: SpawnDesc;
  rng: Rng;
  /** Count multiplier from the quality tier, ~0.35 (low) to ~1.5 (ultra). */
  quality: number;
  /** Global effect intensity, dropped to 0 by reduced-motion. */
  intensity: number;
  requestDistortion(pos: THREE.Vector3, radius: number, strength: number, life: number): void;
}

/** Faction fluid colours. Emissive for the synthetic factions. */
export const FLUID_COLOR: Record<FactionId, number> = {
  nordic: 0x7fb8d8,
  grey: 0xa774e8,
  mantis: 0x93e024,
  insectoid: 0xd98a1c,
  reptilian: 0x9c0f0b,
  federation: 0x8c1a12,
};

const FLUID_GLOW: Record<FactionId, number> = {
  nordic: 0.35,
  grey: 0.9,
  mantis: 0.75,
  insectoid: 0.3,
  reptilian: 0,
  federation: 0,
};

const _n = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fx = new THREE.Color();

export class Impacts {
  constructor(private readonly pools: EffectPools) {}

  /**
   * Emit a hemisphere-biased direction around `normal`, written into `_p`.
   * `spread` 0 = along the normal, 1 = full hemisphere, >1 leans toward the wall.
   */
  private cone(normal: THREE.Vector3, spread: number, speed: number): void {
    const rng = this.pools.rng;
    // Tangent basis around the normal.
    if (Math.abs(normal.y) > 0.92) _t1.set(1, 0, 0);
    else _t1.copy(_up);
    _t2.crossVectors(_t1, normal).normalize();
    _t1.crossVectors(normal, _t2);
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * spread;
    _p.copy(normal)
      .addScaledVector(_t2, Math.cos(a) * r)
      .addScaledVector(_t1, Math.sin(a) * r)
      .normalize()
      .multiplyScalar(speed * rng.range(0.55, 1.35));
  }

  private count(base: number, scale: number): number {
    const p = this.pools;
    return Math.max(1, Math.round(base * scale * p.quality * p.intensity));
  }

  /** The public entry point: one hit, one surface. */
  surface(point: THREE.Vector3, normal: THREE.Vector3, kind: SurfaceKind, scale = 1): void {
    const p = this.pools;
    if (p.intensity <= 0) return;
    _n.copy(normal);
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();
    const floorY = _n.y > 0.55 ? point.y : point.y - 1.6;
    const s = Math.max(0.15, scale);

    switch (kind) {
      case 'rock':
      case 'concrete':
        this.rock(point, floorY, s, kind === 'concrete');
        break;
      case 'metal':
        this.metal(point, floorY, s);
        break;
      case 'sand':
        this.sand(point, floorY, s);
        break;
      case 'ice':
        this.ice(point, floorY, s);
        break;
      case 'glass':
        this.glass(point, floorY, s);
        break;
      case 'energy':
        this.energy(point, s);
        break;
      case 'water':
        this.water(point, s);
        break;
      case 'foliage':
        this.foliage(point, floorY, s);
        break;
      case 'organic':
      case 'chitin':
      case 'flesh':
        this.organic(point, floorY, s, kind);
        break;
      default:
        this.rock(point, floorY, s, false);
        break;
    }

    // Every impact gets a mark and a one-frame kick of light.
    const decalKind = DecalSystem.kindForSurface(kind);
    p.decals.place(
      point,
      _n,
      decalKind,
      (0.22 + 0.34 * s) * (decalKind === 'bulletHole' ? 1 : 1.4),
      DecalSystem.colorForSurface(kind),
      decalKind === 'bulletHole' ? 55 : 30,
      1,
      kind,
    );
  }

  // -- rock / concrete ------------------------------------------------------
  private rock(point: THREE.Vector3, floorY: number, s: number, pale: boolean): void {
    const p = this.pools;
    const d = p.desc;
    const dust = pale ? 0xa8a49b : 0x8a8177;
    const stone = pale ? 0x726f68 : 0x4c463d;
    // Gain is tuned per albedo: the pale concrete dust needs half the exposure
    // of the darker rock dust to land at the same on-screen brightness instead
    // of clipping to a white blob.
    const gain = pale ? 0.85 : 1.9;

    for (let i = 0; i < this.count(6, s); i++) {
      this.cone(_n, 0.9, 1.9 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 0.6, _p.z)
        .tint(dust, p.rng.range(gain * 0.8, gain * 1.25))
        .size(0.16 * s, (0.85 + p.rng.next() * 0.7) * s)
        .live(p.rng.range(0.55, 0.95), 0.8);
      d.drag = 3.2;
      d.gravity = 1.2;
      d.spin = p.rng.range(-2.5, 2.5);
      d.turbulence = 0.25;
      p.smoke.spawn(d);
    }

    // The cloud that hangs after the burst is what makes a rock hit feel heavy.
    for (let i = 0; i < this.count(2, s); i++) {
      this.cone(_n, 1.1, 0.5 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 0.25, _p.z)
        .tint(dust, gain * 0.75)
        .size(0.45 * s, (2.1 + p.rng.next() * 1.2) * s)
        .live(p.rng.range(1.6, 2.6), 0.36);
      d.drag = 1.4;
      d.gravity = -0.35;
      d.spin = p.rng.range(-0.8, 0.8);
      d.turbulence = 0.35;
      p.smoke.spawn(d);
    }

    for (let i = 0; i < this.count(6, s); i++) {
      this.cone(_n, 0.85, 7.5 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 1.5, _p.z)
        .tint(stone, p.rng.range(1.4, 2.2))
        .size(0.055 * s, 0.030 * s)
        .live(p.rng.range(0.7, 1.4), 1);
      d.drag = 0.35;
      d.gravity = 22;
      d.spin = p.rng.range(-14, 14);
      d.floorY = floorY;
      p.chip.spawn(d);
    }

    this.flashPop(point, 0xffd9a8, 0.16 * s, 0.30 * s);
  }

  // -- metal ----------------------------------------------------------------
  private metal(point: THREE.Vector3, floorY: number, s: number): void {
    const p = this.pools;
    const d = p.desc;

    // Primary spray: hot, fast, gravity-bound, bouncing.
    for (let i = 0; i < this.count(9, s); i++) {
      this.cone(_n, 0.95, 9 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 1.2, _p.z)
        .tint(0xffb452, p.rng.range(2.4, 4.5))
        .size(0.042 * s, 0.014 * s)
        .live(p.rng.range(0.35, 0.85), 1);
      d.drag = 0.55;
      d.gravity = 26;
      d.stretch = 0.55;
      d.floorY = floorY;
      p.spark.spawn(d);
    }

    // Ricochet shower: a second, tighter, faster set that skips off the surface.
    for (let i = 0; i < this.count(4, s); i++) {
      this.cone(_n, 1.5, 16 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 2.2, _p.z)
        .tint(0xfff0c0, p.rng.range(3.5, 6.5))
        .size(0.030 * s, 0.010 * s)
        .live(p.rng.range(0.5, 1.1), 1);
      d.drag = 0.28;
      d.gravity = 24;
      d.stretch = 0.8;
      d.floorY = floorY;
      p.spark.spawn(d);
    }

    // Thin dark wisp of vapourised metal.
    for (let i = 0; i < this.count(2, s); i++) {
      this.cone(_n, 0.7, 1.0 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 0.7, _p.z)
        .tint(0x6d6862, 1.1)
        .size(0.10 * s, 0.62 * s)
        .live(p.rng.range(0.5, 0.9), 0.4);
      d.drag = 2.6;
      d.gravity = -0.5;
      d.turbulence = 0.3;
      p.smoke.spawn(d);
    }

    p.rings.spawn(point, null, 0.02 * s, 0.22 * s, 0.07, 3.5, 2.6, 1.4, 'flash', 0.3, 1);
    this.flashPop(point, 0xffcf8a, 0.14 * s, 0.55 * s);
  }

  // -- sand -----------------------------------------------------------------
  private sand(point: THREE.Vector3, floorY: number, s: number): void {
    const p = this.pools;
    const d = p.desc;
    for (let i = 0; i < this.count(8, s); i++) {
      this.cone(_n, 1.0, 2.6 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 1.0, _p.z)
        .tint(0xc2a06a, p.rng.range(0.85, 1.35))
        .size(0.20 * s, (1.05 + p.rng.next() * 0.9) * s)
        .live(p.rng.range(0.7, 1.3), 0.75);
      d.drag = 3.6;
      d.gravity = 2.6;
      d.spin = p.rng.range(-2, 2);
      d.turbulence = 0.2;
      p.smoke.spawn(d);
    }
    // Grains, not chips: they fall out of the cloud and vanish. No sparks ever.
    for (let i = 0; i < this.count(5, s); i++) {
      this.cone(_n, 1.0, 4.5 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 1.4, _p.z)
        .tint(0x9c7c4e, 1.8)
        .size(0.028 * s, 0.016 * s)
        .live(p.rng.range(0.45, 0.8), 0.85);
      d.drag = 1.1;
      d.gravity = 20;
      d.floorY = floorY;
      p.chip.spawn(d);
    }
  }

  // -- ice ------------------------------------------------------------------
  private ice(point: THREE.Vector3, floorY: number, s: number): void {
    const p = this.pools;
    const d = p.desc;
    for (let i = 0; i < this.count(8, s); i++) {
      this.cone(_n, 0.8, 8 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 1.6, _p.z)
        .tint(0xdcf4ff, p.rng.range(1.6, 3.0))
        .size(0.048 * s, 0.024 * s)
        .live(p.rng.range(0.6, 1.2), 1);
      d.drag = 0.4;
      d.gravity = 21;
      d.spin = p.rng.range(-22, 22);
      d.floorY = floorY;
      p.chip.spawn(d);
    }
    // Glitter: short bright specular flecks catching the sun.
    for (let i = 0; i < this.count(6, s); i++) {
      this.cone(_n, 1.1, 5 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 1.0, _p.z)
        .tint(0xeaf9ff, p.rng.range(3, 6))
        .size(0.040 * s, 0.012 * s)
        .live(p.rng.range(0.25, 0.6), 1);
      d.drag = 1.2;
      d.gravity = 16;
      d.stretch = 0.28;
      d.floorY = floorY;
      p.spark.spawn(d);
    }
    // Cold vapour rises rather than settling — the opposite of dust.
    for (let i = 0; i < this.count(3, s); i++) {
      this.cone(_n, 0.9, 0.9 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 1.1, _p.z)
        .tint(0xc8e6f4, 0.6)
        .size(0.20 * s, (1.3 + p.rng.next() * 0.8) * s)
        .live(p.rng.range(1.1, 1.9), 0.38);
      d.drag = 2.0;
      d.gravity = -0.9;
      d.turbulence = 0.4;
      p.smoke.spawn(d);
    }
    this.flashPop(point, 0xbfe6ff, 0.14 * s, 0.40 * s);
  }

  // -- glass ----------------------------------------------------------------
  private glass(point: THREE.Vector3, floorY: number, s: number): void {
    const p = this.pools;
    const d = p.desc;
    for (let i = 0; i < this.count(10, s); i++) {
      this.cone(_n, 1.0, 9 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 1.4, _p.z)
        .tint(0xd8f0ff, p.rng.range(2.0, 3.6))
        .size(0.044 * s, 0.018 * s)
        .live(p.rng.range(0.7, 1.4), 1);
      d.drag = 0.3;
      d.gravity = 23;
      d.spin = p.rng.range(-28, 28);
      d.floorY = floorY;
      p.chip.spawn(d);
    }
    for (let i = 0; i < this.count(5, s); i++) {
      this.cone(_n, 1.2, 6 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y, _p.z)
        .tint(0xffffff, p.rng.range(3, 5.5))
        .size(0.022 * s, 0.007 * s)
        .live(p.rng.range(0.2, 0.5), 1);
      d.drag = 1.4;
      d.gravity = 18;
      p.spark.spawn(d);
    }
    p.rings.spawn(point, _n, 0.05 * s, 0.55 * s, 0.24, 0.9, 1.2, 1.5, 'shock', 0.07, 0.32);
  }

  // -- energy shield / force field -----------------------------------------
  private energy(point: THREE.Vector3, s: number, color = 0x6fd8ff): void {
    const p = this.pools;
    const d = p.desc;
    const c = _fx.setHex(color, THREE.SRGBColorSpace);
    p.rings.spawn(point, _n, 0.05 * s, 0.85 * s, 0.40, c.r * 1.5, c.g * 1.5, c.b * 1.5, 'hex', 0.13, 0.6);
    p.rings.spawn(point, _n, 0.03 * s, 0.35 * s, 0.16, c.r * 2.2, c.g * 2.2, c.b * 2.2, 'shock', 0.12, 0.45);
    for (let i = 0; i < this.count(7, s); i++) {
      this.cone(_n, 1.2, 6 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y, _p.z)
        .tintRgb(c.r, c.g, c.b, p.rng.range(2.5, 5))
        .size(0.016 * s, 0.005 * s)
        .live(p.rng.range(0.25, 0.6), 1);
      d.drag = 2.2;
      d.gravity = 3;
      d.stretch = 0.4;
      p.spark.spawn(d);
    }
    d.reset()
      .at(point)
      .tintRgb(c.r, c.g, c.b, 1.4)
      .size(0.12 * s, 0.42 * s)
      .live(0.20, 0.8);
    d.drag = 4;
    p.glow.spawn(d);
    p.flashes.light(point, color, 6 * s, 0.14);
  }

  // -- water ----------------------------------------------------------------
  private water(point: THREE.Vector3, s: number): void {
    const p = this.pools;
    const d = p.desc;
    // Crown: droplets launched straight up in a ring, not a hemisphere.
    for (let i = 0; i < this.count(10, s); i++) {
      const a = (i / Math.max(1, this.count(10, s))) * Math.PI * 2 + p.rng.range(-0.3, 0.3);
      const r = p.rng.range(1.5, 3.4) * s;
      d.reset()
        .at(point)
        .vel(Math.cos(a) * r, p.rng.range(3.5, 6.5) * s, Math.sin(a) * r)
        .tint(0xcfe8f2, p.rng.range(1.1, 1.8))
        .size(0.055 * s, 0.026 * s)
        .live(p.rng.range(0.5, 0.9), 0.9);
      d.drag = 0.5;
      d.gravity = 24;
      d.floorY = point.y;
      p.chip.spawn(d);
    }
    for (let i = 0; i < this.count(3, s); i++) {
      d.reset()
        .atXyz(point.x, point.y + 0.05, point.z)
        .vel(p.rng.range(-0.6, 0.6), p.rng.range(0.8, 1.8), p.rng.range(-0.6, 0.6))
        .tint(0xdff0f7, 0.55)
        .size(0.18 * s, 1.1 * s)
        .live(p.rng.range(0.6, 1.1), 0.48);
      d.drag = 2.4;
      d.gravity = -0.4;
      d.turbulence = 0.3;
      p.smoke.spawn(d);
    }
    p.rings.spawn(point, _up, 0.08 * s, 1.5 * s, 0.75, 1.1, 1.5, 1.8, 'ripple', 0.09, 0.7);
    p.rings.spawn(point, _up, 0.05 * s, 0.9 * s, 0.5, 1.4, 1.8, 2.1, 'ripple', 0.12, 0.5, 0.08);
  }

  // -- foliage --------------------------------------------------------------
  private foliage(point: THREE.Vector3, floorY: number, s: number): void {
    const p = this.pools;
    const d = p.desc;
    for (let i = 0; i < this.count(8, s); i++) {
      this.cone(_n, 1.3, 3.5 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 0.8, _p.z)
        .tint(p.rng.bool(0.6) ? 0x4e7a2c : 0x77913a, p.rng.range(1.5, 2.4))
        .size(0.085 * s, 0.062 * s)
        .live(p.rng.range(1.0, 2.0), 1);
      // Leaves flutter: high drag, low gravity, fast spin.
      d.drag = 2.6;
      d.gravity = 3.5;
      d.spin = p.rng.range(-9, 9);
      d.turbulence = 0.55;
      d.floorY = floorY;
      p.chip.spawn(d);
    }
    for (let i = 0; i < this.count(2, s); i++) {
      this.cone(_n, 1.0, 1.0 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y, _p.z)
        .tint(0x9db06a, 1.3)
        .size(0.14 * s, 0.7 * s)
        .live(0.8, 0.32);
      d.drag = 3;
      d.gravity = 1.5;
      p.smoke.spawn(d);
    }
  }

  // -- organic / chitin / flesh --------------------------------------------
  private organic(point: THREE.Vector3, floorY: number, s: number, kind: SurfaceKind): void {
    // Carapace throws pale shell fragments over a dark ichor mist; flesh throws
    // dark wet matter. Using one colour for both made a chitin hit invisible.
    if (kind === 'chitin') this.fluidBurst(point, floorY, s, 0x35200f, 0.25, kind, 0xb08a4c);
    else if (kind === 'organic') this.fluidBurst(point, floorY, s, 0x5a2a20, 0.1, kind, 0x8a4a34);
    else this.fluidBurst(point, floorY, s, 0x6b0f0b, 0, kind, 0x9c1a12);
  }

  /**
   * Blood, ichor, hydraulic fluid — one shape, retinted per faction. Wet spray
   * (fast droplets), chunks (slow, bouncing), and a dark low mist that hangs
   * for a moment so the hit reads even at range.
   */
  fluidBurst(
    point: THREE.Vector3,
    floorY: number,
    s: number,
    color: number,
    glow: number,
    surface: SurfaceKind = 'flesh',
    chunkColor = color,
  ): void {
    const p = this.pools;
    const d = p.desc;

    for (let i = 0; i < this.count(9, s); i++) {
      this.cone(_n, 1.15, 7 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 1.0, _p.z)
        .tint(chunkColor, p.rng.range(1.4, 2.4) + glow * 2)
        .size(0.038 * s, 0.018 * s)
        .live(p.rng.range(0.5, 1.0), 1);
      d.drag = 0.7;
      d.gravity = 25;
      d.floorY = floorY;
      p.chip.spawn(d);
    }

    for (let i = 0; i < this.count(3, s); i++) {
      this.cone(_n, 0.9, 3.5 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 1.2, _p.z)
        .tint(chunkColor, p.rng.range(1.0, 1.7) + glow)
        .size(0.085 * s, 0.062 * s)
        .live(p.rng.range(0.8, 1.5), 1);
      d.drag = 0.5;
      d.gravity = 24;
      d.spin = p.rng.range(-12, 12);
      d.floorY = floorY;
      p.chip.spawn(d);
    }

    for (let i = 0; i < this.count(3, s); i++) {
      this.cone(_n, 1.0, 1.6 * s);
      d.reset()
        .at(point)
        .vel(_p.x, _p.y + 0.4, _p.z)
        .tint(color, 1.6 + glow * 1.6)
        .size(0.17 * s, (1.0 + p.rng.next() * 0.7) * s)
        .live(p.rng.range(0.5, 0.9), 0.6);
      d.drag = 3.0;
      d.gravity = 1.6;
      d.turbulence = 0.3;
      p.smoke.spawn(d);
    }

    if (glow > 0.2) {
      d.reset()
        .at(point)
        .tint(color, 2.5)
        .size(0.25 * s, 0.7 * s)
        .live(0.28, 0.8);
      d.drag = 4;
      p.glow.spawn(d);
    }
    void surface;
  }

  /** Faction-aware fluid hit, with a matching splat decal. */
  bloodOrIchor(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    faction: FactionId,
    amount: number,
  ): void {
    const p = this.pools;
    if (p.intensity <= 0) return;
    _n.copy(normal);
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();
    const color = FLUID_COLOR[faction] ?? FLUID_COLOR.reptilian;
    const glow = FLUID_GLOW[faction] ?? 0;
    const s = Math.max(0.2, amount);
    this.fluidBurst(point, point.y - 1.4, s, color, glow);

    // The splat lands *behind* the target along the shot direction, which is
    // what the normal points away from — so mirror it onto the surface behind.
    _t1.copy(point).addScaledVector(_n, -0.35);
    p.decals.place(
      _t1,
      _n,
      glow > 0.2 ? 'ichor' : 'blood',
      (0.28 + 0.5 * s) * 1.4,
      color,
      28,
      0.85,
    );
  }

  /** A small additive pop of light + glow at a hit point. */
  flashPop(point: THREE.Vector3, color: number, size: number, intensity: number): void {
    const p = this.pools;
    const d = p.desc;
    d.reset().at(point).tint(color, 1.6 * intensity).size(size, size * 2.0).live(0.10, 0.85);
    d.drag = 5;
    p.glow.spawn(d);
  }
}
