/**
 * Explosions — a scheduled sequence, not a puff.
 *
 * Real detonations read as a fixed order of events, and skipping any stage is
 * instantly noticeable:
 *
 *   0 ms    white flash + point light            (over before you see it)
 *   0 ms    shock ring expanding and decelerating
 *   0-120ms rolling fireball core, staggered
 *   0 ms    ember spray, gravity + drag + bounce
 *   0 ms    solid debris chunks (real geometry, lit)
 *   30 ms   ground dust wave rolling outward
 *   60-500  smoke column rising and dissipating
 *
 * Every stage is spawned in a *single call* using the particle system's `delay`
 * field, so the whole 0.5-second choreography is one burst of attribute writes
 * and costs nothing per frame afterwards. That is the entire reason this can
 * afford to be a seven-stage sequence instead of one sprite.
 */
import * as THREE from 'three';
import type { DamageElement } from '@/types';
import type { RingStyle } from './ParticlePool';
import type { EffectPools } from './Impacts';

interface ElementStyle {
  /** Blown-out centre. */
  core: number;
  /** Body of the fireball. */
  mid: number;
  smoke: number;
  ember: number;
  ring: RingStyle;
  ringColor: number;
  /** Fireball particle multiplier. */
  fire: number;
  smokeAmount: number;
  emberAmount: number;
  /** Void pulls in before it pushes out. */
  implode: boolean;
  lightColor: number;
  /** Seconds the fireball stage lasts. */
  burn: number;
}

const STYLES: Record<DamageElement, ElementStyle> = {
  kinetic: {
    core: 0xfff0cf,
    mid: 0xff8a24,
    smoke: 0x2f2b28,
    ember: 0xffb457,
    ring: 'shock',
    ringColor: 0xffe0b0,
    fire: 1,
    smokeAmount: 1,
    emberAmount: 1,
    implode: false,
    lightColor: 0xffb060,
    burn: 0.55,
  },
  solar: {
    core: 0xfff4d2,
    mid: 0xff6a12,
    smoke: 0x33241a,
    ember: 0xff9a2e,
    ring: 'shock',
    ringColor: 0xffc070,
    fire: 1.5,
    smokeAmount: 1.15,
    emberAmount: 1.4,
    implode: false,
    lightColor: 0xff8428,
    burn: 0.8,
  },
  arc: {
    core: 0xe8fbff,
    mid: 0x59c9ff,
    smoke: 0x1c2a33,
    ember: 0x9fe8ff,
    ring: 'hex',
    ringColor: 0xa8ecff,
    fire: 1.05,
    smokeAmount: 0.4,
    emberAmount: 1.6,
    implode: false,
    lightColor: 0x66d0ff,
    burn: 0.3,
  },
  void: {
    core: 0xf0d8ff,
    mid: 0x8a3ce0,
    smoke: 0x1a1024,
    ember: 0xc78cff,
    ring: 'ripple',
    ringColor: 0xb87cff,
    fire: 0.9,
    smokeAmount: 1.25,
    emberAmount: 0.8,
    implode: true,
    lightColor: 0x9d5cff,
    burn: 0.7,
  },
  stasis: {
    core: 0xeafaff,
    mid: 0x6ea8f0,
    smoke: 0x24303d,
    ember: 0xbfe4ff,
    ring: 'ripple',
    ringColor: 0xbfe0ff,
    fire: 0.85,
    smokeAmount: 0.55,
    emberAmount: 1.1,
    implode: false,
    lightColor: 0x8ec2ff,
    burn: 0.35,
  },
};

const _v = new THREE.Vector3();
const _col = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _debrisColor = new THREE.Color();
const _ground = new THREE.Vector3();

export class Explosions {
  constructor(private readonly pools: EffectPools) {}

  style(element: DamageElement): ElementStyle {
    return STYLES[element] ?? STYLES.kinetic;
  }

  detonate(
    point: THREE.Vector3,
    radius: number,
    element: DamageElement,
    groundY = point.y - radius * 0.5,
  ): void {
    const p = this.pools;
    if (p.intensity <= 0) return;
    const st = this.style(element);
    const rng = p.rng;
    const d = p.desc;
    const R = Math.max(0.4, radius);
    const q = p.quality * p.intensity;
    const n = (base: number, mul = 1): number =>
      Math.max(1, Math.round(base * mul * q * Math.min(1.6, 0.55 + R * 0.22)));

    // -- stage 0: the flash ---------------------------------------------------
    d.reset().at(point).tint(st.core, 3.2).size(R * 0.7, R * 1.8).live(0.075, 1);
    d.drag = 6;
    p.glow.spawn(d);
    _col.setHex(st.ringColor, THREE.SRGBColorSpace);
    p.rings.spawn(point, null, R * 0.05, R * 0.75, 0.10, _col.r * 2.5, _col.g * 2.5, _col.b * 2.5, 'flash', 0.3, 0.9);
    p.flashes.light(point, st.lightColor, 30 + R * 26, 0.28);

    // -- stage 1: shock front -------------------------------------------------
    p.rings.spawn(point, null, R * 0.25, R * 2.3, 0.26, _col.r * 1.3, _col.g * 1.3, _col.b * 1.3, st.ring, 0.035, 0.85);
    p.rings.spawn(point, null, R * 0.15, R * 1.5, 0.20, _col.r * 0.9, _col.g * 0.9, _col.b * 0.9, 'shock', 0.08, 0.18, 0.04);
    p.requestDistortion(point, R * 2.2, 0.55 + R * 0.06, 0.42);

    // -- stage 2: implosion (void only) --------------------------------------
    if (st.implode) {
      for (let i = 0; i < n(14); i++) {
        rng.onSphere(_v);
        const r0 = R * rng.range(1.1, 2.0);
        d.reset()
          .atXyz(point.x + _v.x * r0, point.y + _v.y * r0 * 0.7, point.z + _v.z * r0)
          // Velocity pointing back at the centre: matter falling in.
          .vel(-_v.x * r0 * 3.2, -_v.y * r0 * 3.2, -_v.z * r0 * 3.2)
          .tint(st.ember, rng.range(1.5, 3))
          .size(R * 0.05, R * 0.012)
          .live(0.30, 1);
        d.drag = 0.05;
        d.stretch = 0.10;
        p.spark.spawn(d);
      }
    }

    // -- stage 3a: the core mass ---------------------------------------------
    //
    // The fireball used to be one shell, every particle thrown outward at up to
    // 4.2 radii a second. Captured a fifth of a second into a six-metre blast,
    // that shell has already passed the blast radius: what is left on screen is
    // eight sparse puffs around an empty middle, which reads as smoke rather
    // than a detonation. Real fireballs do the opposite -- an opaque churning
    // mass that sits and boils while its *edges* tear away.
    //
    // So the mass comes first: large, slow, bright, overlapping, and gone
    // before the smoke arrives. The shell below is now the tearing edge rather
    // than the whole event, which is also why it lost some of its brightness --
    // it is no longer pretending to be the core.
    const coreCount = n(9, st.fire);
    for (let i = 0; i < coreCount; i++) {
      rng.onSphere(_v);
      const spd = R * rng.range(0.15, 0.8);
      d.reset()
        .atXyz(
          point.x + _v.x * R * 0.1,
          point.y + _v.y * R * 0.1,
          point.z + _v.z * R * 0.1,
        )
        .vel(_v.x * spd, _v.y * spd * 0.6 + R * 0.35, _v.z * spd)
        .tint(i % 3 === 0 ? st.core : st.mid, rng.range(1.7, 2.8))
        .size(R * rng.range(0.42, 0.72), R * rng.range(0.95, 1.45))
        .live(st.burn * rng.range(0.42, 0.7), 1);
      d.drag = 5.5;
      d.gravity = -R * 0.35;
      d.spin = rng.range(-1.4, 1.4);
      d.turbulence = R * 0.09;
      d.delay = st.implode ? 0.14 + rng.next() * 0.03 : rng.next() * 0.025;
      p.fire.spawn(d);
    }

    // -- stage 3b: the tearing edge -------------------------------------------
    const fireCount = n(14, st.fire);
    for (let i = 0; i < fireCount; i++) {
      rng.onSphere(_v);
      const spd = R * rng.range(1.6, 4.2);
      const delay = st.implode ? 0.14 + rng.next() * 0.06 : rng.next() * 0.09;
      d.reset()
        .atXyz(
          point.x + _v.x * R * 0.18,
          point.y + _v.y * R * 0.18,
          point.z + _v.z * R * 0.18,
        )
        .vel(_v.x * spd, _v.y * spd * 0.8 + R * 0.9, _v.z * spd)
        .tint(i % 4 === 0 ? st.core : st.mid, rng.range(0.7, 1.25))
        .size(R * rng.range(0.16, 0.40), R * rng.range(0.7, 1.6))
        .live(st.burn * rng.range(0.7, 1.25), 1);
      d.drag = 3.4;
      d.gravity = -R * 0.5;
      d.spin = rng.range(-2, 2);
      d.turbulence = R * 0.12;
      d.delay = delay;
      p.fire.spawn(d);
    }

    // -- stage 4: embers ------------------------------------------------------
    const emberCount = n(16, st.emberAmount);
    for (let i = 0; i < emberCount; i++) {
      rng.onSphere(_v);
      const spd = R * rng.range(3, 9);
      d.reset()
        .at(point)
        .vel(_v.x * spd, Math.abs(_v.y) * spd * 0.8 + R * 2.2, _v.z * spd)
        .tint(st.ember, rng.range(2, 4.5))
        .size(R * 0.05, R * 0.012)
        .live(rng.range(0.6, 1.6), 1);
      d.drag = 0.5;
      d.gravity = 20;
      d.stretch = 0.45;
      d.floorY = groundY;
      d.delay = st.implode ? 0.16 : 0;
      p.spark.spawn(d);
    }

    // -- stage 5: solid debris ------------------------------------------------
    _debrisColor.setHex(st.smoke, THREE.SRGBColorSpace).multiplyScalar(2.2);
    const chunks = Math.min(10, n(5));
    for (let i = 0; i < chunks; i++) {
      rng.onSphere(_v);
      const spd = R * rng.range(2.5, 6);
      _v.set(_v.x * spd, Math.abs(_v.y) * spd + R * 3, _v.z * spd);
      p.debris.spawn(
        point,
        _v,
        R * rng.range(0.06, 0.16),
        rng.range(1.8, 3.2),
        groundY,
        _debrisColor,
      );
    }

    // -- stage 6: ground dust wave -------------------------------------------
    _col.setHex(st.smoke, THREE.SRGBColorSpace);
    _ground.set(point.x, groundY + 0.05, point.z);
    p.rings.spawn(
      _ground,
      _up,
      R * 0.3,
      R * 3.4,
      0.85,
      0.5,
      0.46,
      0.40,
      'ripple',
      0.05,
      0.16,
      0.03,
    );
    const waveCount = n(7);
    for (let i = 0; i < waveCount; i++) {
      const a = (i / waveCount) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const spd = R * rng.range(3.5, 6.5);
      d.reset()
        .atXyz(point.x, groundY + R * 0.12, point.z)
        .vel(Math.cos(a) * spd, R * 0.35, Math.sin(a) * spd)
        .tint(0x9b9184, 0.55)
        .size(R * 0.3, R * rng.range(1.6, 2.6))
        .live(rng.range(1.2, 2.2), 0.4);
      d.drag = 2.2;
      d.gravity = -0.2;
      d.spin = rng.range(-1.2, 1.2);
      d.turbulence = R * 0.1;
      d.delay = 0.03 + rng.next() * 0.05;
      p.smoke.spawn(d);
    }

    // -- stage 7: rising smoke column ----------------------------------------
    const smokeCount = n(8, st.smokeAmount);
    for (let i = 0; i < smokeCount; i++) {
      rng.onSphere(_v);
      const spd = R * rng.range(0.8, 2.2);
      d.reset()
        .atXyz(point.x + _v.x * R * 0.3, point.y + _v.y * R * 0.3, point.z + _v.z * R * 0.3)
        .vel(_v.x * spd, Math.abs(_v.y) * spd * 0.6 + R * 1.4, _v.z * spd)
        .tint(st.smoke, rng.range(1.4, 2.6))
        .size(R * rng.range(0.35, 0.6), R * rng.range(1.8, 3.0))
        .live(rng.range(1.6, 3.2), 0.55);
      d.drag = 1.5;
      d.gravity = -R * 0.35;
      d.spin = rng.range(-0.9, 0.9);
      d.turbulence = R * 0.18;
      d.delay = 0.06 + rng.next() * 0.42;
      p.smoke.spawn(d);
    }

    // Scorch the ground under the blast.
    _v.set(point.x, groundY + 0.02, point.z);
    p.decals.place(
      _v,
      _up,
      element === 'kinetic' || element === 'solar' ? 'scorch' : 'energyBurn',
      R * 2.1,
      st.smoke,
      50,
      0.9,
    );
  }
}
