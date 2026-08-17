/** Shared maths helpers. Allocation-free where it matters. */
import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : (v - a) / (b - a);

export const remap = (v: number, a: number, b: number, c: number, d: number): number =>
  lerp(c, d, clamp01(invLerp(a, b, v)));

export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export const smootherstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/**
 * Frame-rate independent exponential approach. `rate` is the fraction of the
 * remaining distance covered per second (0.99 ≈ very snappy).
 */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  target + (current - target) * Math.exp(-rate * dt);

/** Critically damped spring smoothing — the good `Vector3.lerp` replacement. */
export function dampVec3(
  current: THREE.Vector3,
  target: THREE.Vector3,
  rate: number,
  dt: number,
): THREE.Vector3 {
  const f = Math.exp(-rate * dt);
  current.x = target.x + (current.x - target.x) * f;
  current.y = target.y + (current.y - target.y) * f;
  current.z = target.z + (current.z - target.z) * f;
  return current;
}

/** Shortest-arc angle difference in radians, result in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function dampAngle(current: number, target: number, rate: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-rate * dt));
}

/** Move `current` toward `target` by at most `maxDelta`. */
export const moveTowards = (current: number, target: number, maxDelta: number): number => {
  const d = target - current;
  return Math.abs(d) <= maxDelta ? target : current + Math.sign(d) * maxDelta;
};

/** Deterministic 32-bit hash → [0,1). Great for stable per-instance variation. */
export function hash1(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export function hash2(x: number, y: number): number {
  return hash1(Math.imul(x | 0, 0x27d4eb2d) ^ (y | 0));
}

/** Mulberry32 — small, fast, seedable PRNG. */
export class Rng {
  private s: number;

  constructor(seed = 0x2f6e2b1) {
    this.s = seed >>> 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }

  /** Uniform point on the unit sphere. */
  onSphere(out: THREE.Vector3): THREE.Vector3 {
    const z = this.range(-1, 1);
    const a = this.range(0, TAU);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return out.set(r * Math.cos(a), r * Math.sin(a), z);
  }

  /** Uniform point in a disc of radius 1 (x,y). */
  inDisc(out: THREE.Vector2): THREE.Vector2 {
    const r = Math.sqrt(this.next());
    const a = this.range(0, TAU);
    return out.set(r * Math.cos(a), r * Math.sin(a));
  }

  /** Approximately gaussian, mean 0 stddev 1 (sum of 3 uniforms, cheap). */
  gaussian(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 1.1547;
  }
}

/** Shared scratch vectors. Never hold a reference across a function boundary. */
export const scratch = {
  v3a: new THREE.Vector3(),
  v3b: new THREE.Vector3(),
  v3c: new THREE.Vector3(),
  v3d: new THREE.Vector3(),
  v2a: new THREE.Vector2(),
  v2b: new THREE.Vector2(),
  qa: new THREE.Quaternion(),
  qb: new THREE.Quaternion(),
  ma: new THREE.Matrix4(),
  mb: new THREE.Matrix4(),
  colA: new THREE.Color(),
};

/**
 * Sample a direction inside a cone around `dir` with half-angle `spread`.
 * Uniform over the spherical cap, which matters for shotgun feel.
 */
export function coneDirection(
  dir: THREE.Vector3,
  spread: number,
  rng: Rng,
  out: THREE.Vector3,
): THREE.Vector3 {
  if (spread <= 0) return out.copy(dir);
  const cosMax = Math.cos(spread);
  const z = rng.range(cosMax, 1);
  const phi = rng.range(0, TAU);
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  // Build an orthonormal basis around dir without trig.
  const t = scratch.v3a;
  if (Math.abs(dir.z) < 0.9) t.set(0, 0, 1);
  else t.set(1, 0, 0);
  const bx = scratch.v3b.crossVectors(t, dir).normalize();
  const by = scratch.v3c.crossVectors(dir, bx);
  return out
    .copy(dir)
    .multiplyScalar(z)
    .addScaledVector(bx, s * Math.cos(phi))
    .addScaledVector(by, s * Math.sin(phi))
    .normalize();
}

/** Solve the ballistic launch pitch to hit a target. Returns null if out of range. */
export function ballisticPitch(
  horizontalDistance: number,
  heightDelta: number,
  speed: number,
  gravity: number,
): number | null {
  const s2 = speed * speed;
  const g = gravity;
  const disc = s2 * s2 - g * (g * horizontalDistance * horizontalDistance + 2 * heightDelta * s2);
  if (disc < 0) return null;
  return Math.atan((s2 - Math.sqrt(disc)) / (g * horizontalDistance));
}

/** Predict where a moving target will be, for AI leading. */
export function interceptPoint(
  shooter: THREE.Vector3,
  target: THREE.Vector3,
  targetVel: THREE.Vector3,
  projectileSpeed: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  if (projectileSpeed <= 0) return out.copy(target);
  const rel = scratch.v3d.subVectors(target, shooter);
  const a = targetVel.lengthSq() - projectileSpeed * projectileSpeed;
  const b = 2 * rel.dot(targetVel);
  const c = rel.lengthSq();
  let t: number;
  if (Math.abs(a) < 1e-4) {
    t = Math.abs(b) < 1e-6 ? 0 : -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return out.copy(target);
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    t = t1 > 0 && t2 > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  }
  if (!(t > 0) || !Number.isFinite(t)) return out.copy(target);
  return out.copy(target).addScaledVector(targetVel, Math.min(t, 4));
}

/** Damage falloff curve matching the WeaponStats contract. */
export function rangeFalloff(
  distance: number,
  start: number,
  end: number,
  floor: number,
): number {
  if (distance <= start) return 1;
  if (distance >= end) return floor;
  return lerp(1, floor, smoothstep(invLerp(start, end, distance)));
}
