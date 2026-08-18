/**
 * ElementalVfx — the five damage types, each with its own physical language.
 *
 * Colour alone is not an element. Destiny's elements read because their *motion*
 * differs: solar clings and rises, arc jumps in straight jittered lines, void
 * collapses inward before it pushes out, stasis grows outward as rigid crystal
 * and then shatters. This module owns those signatures so every weapon, ability
 * and shield break in the game speaks the same visual grammar.
 */
import * as THREE from 'three';
import type { DamageElement } from '@/types';
import type { EffectPools } from './Impacts';

export interface ElementPalette {
  primary: number;
  hot: number;
  dark: number;
}

export const ELEMENT_PALETTE: Record<DamageElement, ElementPalette> = {
  kinetic: { primary: 0xffd8a2, hot: 0xfff6e2, dark: 0x6b6055 },
  solar: { primary: 0xff8a2c, hot: 0xfff0c0, dark: 0x40200c },
  arc: { primary: 0x7fdcff, hot: 0xeafcff, dark: 0x13303d },
  void: { primary: 0xb887ff, hot: 0xf0dcff, dark: 0x1d0f2e },
  stasis: { primary: 0x8ec6ff, hot: 0xf0f8ff, dark: 0x1b2c40 },
};

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _perp1 = new THREE.Vector3();
const _perp2 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

const MAX_NODES = 24;

export class ElementalVfx {
  /** Scratch node buffer for polyline ribbons; never reallocated. */
  private nodes = new Float32Array(MAX_NODES * 3);

  constructor(private readonly pools: EffectPools) {}

  palette(element: DamageElement): ElementPalette {
    return ELEMENT_PALETTE[element] ?? ELEMENT_PALETTE.kinetic;
  }

  /** The generic `elementalBurst` — dispatches to the per-element signature. */
  burst(point: THREE.Vector3, element: DamageElement, scale = 1): void {
    if (this.pools.intensity <= 0) return;
    switch (element) {
      case 'solar':
        this.ignite(point, scale);
        break;
      case 'arc':
        this.arcDischarge(point, scale);
        break;
      case 'void':
        this.implode(point, scale);
        break;
      case 'stasis':
        this.crystallise(point, scale);
        break;
      default:
        this.kineticPulse(point, scale);
        break;
    }
  }

  // -- solar ---------------------------------------------------------------

  /**
   * Ignition: a low clinging flame bed that rises and thins, plus lofted embers
   * that keep burning after the flame dies. Solar's tell is *persistence*.
   */
  ignite(point: THREE.Vector3, scale = 1): void {
    const p = this.pools;
    const d = p.desc;
    const rng = p.rng;
    const s = Math.max(0.2, scale);
    const pal = this.palette('solar');

    for (let i = 0; i < Math.max(2, Math.round(8 * s * p.quality)); i++) {
      rng.onSphere(_v);
      d.reset()
        .atXyz(point.x + _v.x * 0.25 * s, point.y + 0.05 * s, point.z + _v.z * 0.25 * s)
        .vel(_v.x * 0.5 * s, rng.range(1.2, 2.6) * s, _v.z * 0.5 * s)
        .tint(i % 3 === 0 ? pal.hot : pal.primary, rng.range(1.6, 3))
        .size(0.22 * s, 0.55 * s)
        .live(rng.range(0.5, 1.0), 1);
      d.drag = 2.6;
      d.gravity = -1.6;
      d.turbulence = 0.35 * s;
      d.delay = rng.next() * 0.35;
      p.fire.spawn(d);
    }

    for (let i = 0; i < Math.max(3, Math.round(12 * s * p.quality)); i++) {
      rng.onSphere(_v);
      d.reset()
        .at(point)
        .vel(_v.x * 2.5 * s, Math.abs(_v.y) * 3.5 * s + 1.5, _v.z * 2.5 * s)
        .tint(pal.primary, rng.range(2, 4))
        .size(0.035 * s, 0.010 * s)
        .live(rng.range(0.9, 2.0), 1);
      d.drag = 0.55;
      d.gravity = 8;
      d.stretch = 0.35;
      d.floorY = point.y;
      p.spark.spawn(d);
    }

    // Rising heat haze, drawn as very faint dark smoke so it darkens the sky
    // behind it rather than glowing.
    for (let i = 0; i < Math.max(1, Math.round(3 * s * p.quality)); i++) {
      d.reset()
        .atXyz(point.x, point.y + 0.2 * s, point.z)
        .vel(rng.range(-0.3, 0.3), rng.range(1.0, 2.0) * s, rng.range(-0.3, 0.3))
        .tint(pal.dark, 1.2)
        .size(0.3 * s, 1.3 * s)
        .live(rng.range(1.2, 2.0), 0.30);
      d.drag = 1.4;
      d.gravity = -0.6;
      d.turbulence = 0.4;
      d.delay = rng.next() * 0.4;
      p.smoke.spawn(d);
    }

    p.decals.place(point, _up, 'scorch', 1.4 * s, pal.dark, 40, 0.85);
    p.flashes.light(point, pal.primary, 10 * s, 0.5);
  }

  // -- arc -----------------------------------------------------------------

  /**
   * A single lightning bolt as a jittered polyline ribbon. `chaos` scales the
   * perpendicular displacement; branches are shorter bolts hanging off the
   * midpoints, which is what stops a bolt reading as a bent wire.
   */
  chainLightning(
    from: THREE.Vector3,
    to: THREE.Vector3,
    color: number,
    width = 0.06,
    life = 0.14,
    chaos = 1,
    branches = 2,
  ): void {
    const p = this.pools;
    const rng = p.rng;
    _v.subVectors(to, from);
    const len = _v.length();
    if (len < 0.05) return;
    _v.divideScalar(len);

    // Stable perpendicular basis for the jitter.
    if (Math.abs(_v.y) > 0.92) _perp1.set(1, 0, 0);
    else _perp1.copy(_up);
    _perp2.crossVectors(_perp1, _v).normalize();
    _perp1.crossVectors(_v, _perp2);

    const segs = Math.min(MAX_NODES, Math.max(6, Math.round(len * 2.2) + 4));
    const amp = Math.min(len * 0.16, 0.9) * chaos;
    for (let i = 0; i < segs; i++) {
      const u = i / (segs - 1);
      // Pin the endpoints; bulge in the middle.
      const k = Math.sin(u * Math.PI) * amp;
      const o1 = rng.gaussian() * k;
      const o2 = rng.gaussian() * k;
      this.nodes[i * 3] = from.x + _v.x * len * u + _perp1.x * o1 + _perp2.x * o2;
      this.nodes[i * 3 + 1] = from.y + _v.y * len * u + _perp1.y * o1 + _perp2.y * o2;
      this.nodes[i * 3 + 2] = from.z + _v.z * len * u + _perp1.z * o1 + _perp2.z * o2;
    }
    p.ribbons.polyline(this.nodes, segs, color, width, life, 1);

    // Core + halo: a second thinner, brighter pass over the same path reads as
    // an over-exposed filament once bloom gets hold of it.
    p.ribbons.polyline(this.nodes, segs, 0xffffff, width * 0.4, life * 0.8, 1);

    for (let b = 0; b < branches; b++) {
      const at = rng.int(2, segs - 2);
      _a.set(this.nodes[at * 3], this.nodes[at * 3 + 1], this.nodes[at * 3 + 2]);
      rng.onSphere(_b);
      _b.multiplyScalar(len * rng.range(0.15, 0.4)).add(_a);
      const bsegs = 6;
      for (let i = 0; i < bsegs; i++) {
        const u = i / (bsegs - 1);
        const k = Math.sin(u * Math.PI) * amp * 0.6;
        this.nodes[i * 3] = _a.x + (_b.x - _a.x) * u + rng.gaussian() * k;
        this.nodes[i * 3 + 1] = _a.y + (_b.y - _a.y) * u + rng.gaussian() * k;
        this.nodes[i * 3 + 2] = _a.z + (_b.z - _a.z) * u + rng.gaussian() * k;
      }
      p.ribbons.polyline(this.nodes, bsegs, color, width * 0.55, life * 0.7, 1);
    }
  }

  /** A radial arc discharge: several bolts leaving one point. */
  arcDischarge(point: THREE.Vector3, scale = 1): void {
    const p = this.pools;
    const rng = p.rng;
    const s = Math.max(0.2, scale);
    const pal = this.palette('arc');
    const bolts = Math.max(2, Math.round(4 * s * p.quality));
    for (let i = 0; i < bolts; i++) {
      rng.onSphere(_v);
      _a.copy(point).addScaledVector(_v, s * rng.range(1.2, 2.6));
      this.chainLightning(point, _a, pal.primary, 0.05 * s, rng.range(0.08, 0.18), 1.1, 1);
    }
    _c.setHex(pal.primary, THREE.SRGBColorSpace);
    p.rings.spawn(point, null, 0.1 * s, 1.8 * s, 0.24, _c.r * 4, _c.g * 4, _c.b * 4, 'hex', 0.16, 1);

    const d = p.desc;
    for (let i = 0; i < Math.max(4, Math.round(14 * s * p.quality)); i++) {
      rng.onSphere(_v);
      const spd = rng.range(4, 12) * s;
      d.reset()
        .at(point)
        .vel(_v.x * spd, _v.y * spd, _v.z * spd)
        .tint(pal.hot, rng.range(2.5, 5))
        .size(0.02 * s, 0.005 * s)
        .live(rng.range(0.15, 0.4), 1);
      d.drag = 3.5;
      d.gravity = 2;
      d.stretch = 0.55;
      p.spark.spawn(d);
    }
    d.reset().at(point).tint(pal.hot, 4).size(0.4 * s, 1.6 * s).live(0.16, 1);
    d.drag = 6;
    p.glow.spawn(d);
    p.flashes.light(point, pal.primary, 22 * s, 0.16);
  }

  // -- void ----------------------------------------------------------------

  /**
   * Implosion: matter falls in for ~0.2 s, then a soft dark bloom pushes out,
   * with curved tendrils reaching away from the singularity.
   */
  implode(point: THREE.Vector3, scale = 1): void {
    const p = this.pools;
    const rng = p.rng;
    const d = p.desc;
    const s = Math.max(0.2, scale);
    const pal = this.palette('void');

    for (let i = 0; i < Math.max(6, Math.round(18 * s * p.quality)); i++) {
      rng.onSphere(_v);
      const r0 = s * rng.range(1.4, 3.0);
      d.reset()
        .atXyz(point.x + _v.x * r0, point.y + _v.y * r0, point.z + _v.z * r0)
        .vel(-_v.x * r0 * 3.6, -_v.y * r0 * 3.6, -_v.z * r0 * 3.6)
        .tint(pal.primary, rng.range(1.5, 3.2))
        .size(0.05 * s, 0.012 * s)
        .live(0.32, 1);
      d.drag = 0.05;
      d.stretch = 0.5;
      p.spark.spawn(d);
    }

    // The singularity itself: a bright pinpoint that swells then collapses.
    d.reset().at(point).tint(pal.hot, 5).size(0.12 * s, 0.9 * s).live(0.42, 1);
    d.drag = 8;
    d.delay = 0.12;
    p.glow.spawn(d);

    // Dark bloom — void's "smoke" absorbs rather than scatters, so it is drawn
    // with a near-black tint and normal alpha.
    for (let i = 0; i < Math.max(3, Math.round(9 * s * p.quality)); i++) {
      rng.onSphere(_v);
      const spd = rng.range(0.8, 2.4) * s;
      d.reset()
        .at(point)
        .vel(_v.x * spd, _v.y * spd * 0.7, _v.z * spd)
        .tint(pal.dark, 1.6)
        .size(0.3 * s, 1.8 * s)
        .live(rng.range(0.9, 1.8), 0.6);
      d.drag = 2.2;
      d.gravity = -0.3;
      d.turbulence = 0.3;
      d.delay = 0.22 + rng.next() * 0.2;
      p.smoke.spawn(d);
    }

    // Tendrils: bent polylines that whip outward as the bloom expands.
    const tendrils = Math.max(2, Math.round(4 * s * p.quality));
    for (let t = 0; t < tendrils; t++) {
      rng.onSphere(_v);
      _v.y = Math.abs(_v.y) * 0.6 + 0.2;
      _v.normalize();
      // Perpendicular used to curl the tendril away from its own axis.
      if (Math.abs(_v.y) > 0.92) _perp1.set(1, 0, 0);
      else _perp1.copy(_up);
      _perp2.crossVectors(_perp1, _v).normalize();
      _perp1.crossVectors(_v, _perp2);
      const n = 10;
      const reach = s * rng.range(1.6, 3.2);
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        // A quarter-turn curl so the tendril arcs instead of spiking.
        const curl = u * u * reach * 0.55;
        this.nodes[i * 3] = point.x + _v.x * reach * u + _perp1.x * curl * 0.5 + rng.gaussian() * 0.05;
        this.nodes[i * 3 + 1] = point.y + _v.y * reach * u - curl * 0.35;
        this.nodes[i * 3 + 2] = point.z + _v.z * reach * u + _perp1.z * curl * 0.5 + rng.gaussian() * 0.05;
      }
      p.ribbons.polyline(this.nodes, n, pal.primary, 0.09 * s, rng.range(0.35, 0.6), 1);
    }

    _c.setHex(pal.primary, THREE.SRGBColorSpace);
    p.rings.spawn(point, null, 2.4 * s, 0.15 * s, 0.24, _c.r * 3, _c.g * 3, _c.b * 3, 'ripple', 0.14, 1);
    p.rings.spawn(point, null, 0.2 * s, 2.6 * s, 0.5, _c.r * 2, _c.g * 2, _c.b * 2, 'ripple', 0.18, 0.8, 0.2);
    p.requestDistortion(point, 3 * s, 0.9, 0.5);
    p.flashes.light(point, pal.primary, 16 * s, 0.45);
  }

  // -- stasis --------------------------------------------------------------

  /**
   * Crystal growth: shards that *grow* in place (zero velocity, size ramp) with
   * a cold ring, then a delayed shatter that throws the same shards outward.
   */
  crystallise(point: THREE.Vector3, scale = 1): void {
    const p = this.pools;
    const rng = p.rng;
    const d = p.desc;
    const s = Math.max(0.2, scale);
    const pal = this.palette('stasis');

    for (let i = 0; i < Math.max(4, Math.round(12 * s * p.quality)); i++) {
      rng.onSphere(_v);
      const r0 = s * rng.range(0.15, 0.7);
      d.reset()
        .atXyz(point.x + _v.x * r0, point.y + Math.abs(_v.y) * r0, point.z + _v.z * r0)
        .vel(_v.x * 0.25, Math.abs(_v.y) * 0.3, _v.z * 0.25)
        .tint(pal.primary, rng.range(1.3, 2.6))
        // Zero start size growing to full: crystal accreting, not debris flying.
        .size(0.005, rng.range(0.10, 0.26) * s)
        .live(rng.range(0.9, 1.6), 1);
      d.drag = 6;
      d.spin = rng.range(-1.5, 1.5);
      p.chip.spawn(d);
    }

    for (let i = 0; i < Math.max(2, Math.round(6 * s * p.quality)); i++) {
      rng.onSphere(_v);
      d.reset()
        .at(point)
        .vel(_v.x * 0.9 * s, Math.abs(_v.y) * 0.5 * s, _v.z * 0.9 * s)
        .tint(pal.hot, 0.7)
        .size(0.2 * s, 1.1 * s)
        .live(rng.range(0.8, 1.4), 0.34);
      d.drag = 2.4;
      d.gravity = 0.6;
      d.turbulence = 0.2;
      p.smoke.spawn(d);
    }

    _c.setHex(pal.primary, THREE.SRGBColorSpace);
    p.rings.spawn(point, _up, 0.1 * s, 2.2 * s, 0.55, _c.r * 3, _c.g * 3, _c.b * 3, 'ripple', 0.13, 0.9);
    d.reset().at(point).tint(pal.hot, 3).size(0.3 * s, 1.1 * s).live(0.3, 0.9);
    d.drag = 5;
    p.glow.spawn(d);
    p.flashes.light(point, pal.primary, 12 * s, 0.35);
  }

  /** Freeze shatter: the crystal breaking. Sharp, bright, gravity-bound. */
  shatter(point: THREE.Vector3, scale = 1, floorY = point.y - 1.5): void {
    const p = this.pools;
    const rng = p.rng;
    const d = p.desc;
    const s = Math.max(0.2, scale);
    const pal = this.palette('stasis');

    for (let i = 0; i < Math.max(6, Math.round(20 * s * p.quality)); i++) {
      rng.onSphere(_v);
      const spd = rng.range(4, 11) * s;
      d.reset()
        .at(point)
        .vel(_v.x * spd, Math.abs(_v.y) * spd * 0.7 + 2, _v.z * spd)
        .tint(pal.primary, rng.range(1.4, 3))
        .size(rng.range(0.03, 0.09) * s, rng.range(0.015, 0.04) * s)
        .live(rng.range(0.7, 1.5), 1);
      d.drag = 0.4;
      d.gravity = 22;
      d.spin = rng.range(-26, 26);
      d.floorY = floorY;
      p.chip.spawn(d);
    }
    for (let i = 0; i < Math.max(4, Math.round(12 * s * p.quality)); i++) {
      rng.onSphere(_v);
      const spd = rng.range(3, 9) * s;
      d.reset()
        .at(point)
        .vel(_v.x * spd, _v.y * spd, _v.z * spd)
        .tint(pal.hot, rng.range(2, 4))
        .size(0.014 * s, 0.004 * s)
        .live(rng.range(0.2, 0.5), 1);
      d.drag = 1.6;
      d.gravity = 12;
      d.stretch = 0.3;
      p.spark.spawn(d);
    }
    _c.setHex(pal.hot, THREE.SRGBColorSpace);
    p.rings.spawn(point, null, 0.1 * s, 1.6 * s, 0.22, _c.r * 5, _c.g * 5, _c.b * 5, 'flash', 0.3, 1);
    p.flashes.light(point, pal.primary, 18 * s, 0.2);
  }

  // -- kinetic -------------------------------------------------------------

  /** Physical: no glow, just displaced matter and a pressure ring. */
  kineticPulse(point: THREE.Vector3, scale = 1): void {
    const p = this.pools;
    const rng = p.rng;
    const d = p.desc;
    const s = Math.max(0.2, scale);

    for (let i = 0; i < Math.max(4, Math.round(10 * s * p.quality)); i++) {
      rng.onSphere(_v);
      const spd = rng.range(2, 6) * s;
      d.reset()
        .at(point)
        .vel(_v.x * spd, Math.abs(_v.y) * spd * 0.6, _v.z * spd)
        .tint(0x9a9086, rng.range(0.7, 1.2))
        .size(0.14 * s, 0.85 * s)
        .live(rng.range(0.6, 1.2), 0.6);
      d.drag = 2.8;
      d.gravity = 1.2;
      d.turbulence = 0.25;
      p.smoke.spawn(d);
    }
    for (let i = 0; i < Math.max(3, Math.round(8 * s * p.quality)); i++) {
      rng.onSphere(_v);
      const spd = rng.range(4, 10) * s;
      d.reset()
        .at(point)
        .vel(_v.x * spd, Math.abs(_v.y) * spd, _v.z * spd)
        .tint(0x6a6055, 1)
        .size(0.03 * s, 0.018 * s)
        .live(rng.range(0.6, 1.2), 1);
      d.drag = 0.4;
      d.gravity = 22;
      d.floorY = point.y - 1.5;
      p.chip.spawn(d);
    }
    p.rings.spawn(point, null, 0.15 * s, 1.4 * s, 0.2, 1.4, 1.3, 1.15, 'shock', 0.2, 0.6);
  }

  // -- shields -------------------------------------------------------------

  /**
   * Shield break: the hex lattice failing. A hex ring at the shield radius, a
   * shower of lattice fragments, and arcs earthing to the ground — readable at
   * 40 m, which matters because shield breaks are a combat-priority signal.
   */
  shieldBreak(point: THREE.Vector3, element: DamageElement, radius: number): void {
    const p = this.pools;
    if (p.intensity <= 0) return;
    const rng = p.rng;
    const d = p.desc;
    const pal = this.palette(element);
    const R = Math.max(0.4, radius);
    _c.setHex(pal.primary, THREE.SRGBColorSpace);

    p.rings.spawn(point, null, R * 0.55, R * 2.4, 0.42, _c.r * 2.2, _c.g * 2.2, _c.b * 2.2, 'hex', 0.11, 1);
    p.rings.spawn(point, null, R * 0.3, R * 1.1, 0.14, _c.r * 1.6, _c.g * 1.6, _c.b * 1.6, 'flash', 0.35, 0.55);

    // Lattice fragments: flat shards that spin off the sphere surface.
    for (let i = 0; i < Math.max(8, Math.round(22 * p.quality)); i++) {
      rng.onSphere(_v);
      const spd = rng.range(3, 9) * R;
      d.reset()
        .atXyz(point.x + _v.x * R, point.y + _v.y * R, point.z + _v.z * R)
        .vel(_v.x * spd, _v.y * spd + 1.5, _v.z * spd)
        .tint(pal.primary, rng.range(1.8, 3.5))
        .size(rng.range(0.05, 0.13) * R, 0.01)
        .live(rng.range(0.35, 0.8), 1);
      d.drag = 1.8;
      d.gravity = 6;
      d.spin = rng.range(-20, 20);
      p.chip.spawn(d);
    }

    for (let i = 0; i < Math.max(6, Math.round(16 * p.quality)); i++) {
      rng.onSphere(_v);
      const spd = rng.range(5, 14) * R;
      d.reset()
        .at(point)
        .vel(_v.x * spd, _v.y * spd, _v.z * spd)
        .tint(pal.hot, rng.range(2.5, 5))
        .size(0.022 * R, 0.006 * R)
        .live(rng.range(0.2, 0.55), 1);
      d.drag = 2.5;
      d.gravity = 4;
      d.stretch = 0.5;
      p.spark.spawn(d);
    }

    d.reset().at(point).tint(pal.hot, 2.0).size(R * 0.35, R * 1.3).live(0.2, 0.9);
    d.drag = 6;
    p.glow.spawn(d);

    // Earthing arcs, one per quadrant.
    for (let i = 0; i < 3; i++) {
      rng.onSphere(_v);
      _a.copy(point).addScaledVector(_v, R * rng.range(1.5, 2.6));
      this.chainLightning(point, _a, pal.primary, 0.05 * R, rng.range(0.1, 0.2), 1.2, 1);
    }

    p.flashes.light(point, pal.primary, 24 * R, 0.28);
    p.requestDistortion(point, R * 2.5, 0.5, 0.3);
  }
}
