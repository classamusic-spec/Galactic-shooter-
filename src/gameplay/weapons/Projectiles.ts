/**
 * Projectiles — a fixed-capacity pool for everything that travels: fusion
 * bolts, rockets, grenades and arrows.
 *
 * Design notes:
 *  - **Fixed capacity.** `spawn()` returns null when full rather than growing.
 *    A pool that grows is a pool that stutters.
 *  - **Sub-stepped.** Each simulation step is split so no projectile ever moves
 *    more than `SUBSTEP_METRES` between collision queries. A 150 m/s fusion bolt
 *    covers 1.25 m per 120 Hz tick, which would sail straight through a 0.2 m
 *    wall on a single swept query; at 0.12 m per substep it cannot.
 *  - **Two draw calls, always.** Glowing ordnance goes into one InstancedMesh
 *    and solid ordnance into another, both with per-instance colour. Adding more
 *    projectile *kinds* costs zero extra draw calls.
 *  - **Zero per-frame allocation.** Every vector lives on the pooled record.
 */
import * as THREE from 'three';
import type { DamageElement, Damageable, RaycastHit } from '@/types';
import { settings } from '@/core/Settings';
import { clamp, scratch } from '@/util/math';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import type { WeaponCollision } from './WeaponDefs';

/** Maximum distance a projectile may travel between collision queries. */
const SUBSTEP_METRES = 0.12;
/** Hard cap on substeps per tick so a pathological speed cannot stall a frame. */
const MAX_SUBSTEPS = 16;

export type ProjectileLook = 'bolt' | 'rocket' | 'grenade' | 'arrow';

/** Everything needed to launch one round. Copied into the pooled record. */
export interface ProjectileSpec {
  weaponId: string;
  element: DamageElement;
  look: ProjectileLook;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  speed: number;
  /** m/s², applied downward. */
  gravity: number;
  /** Linear drag coefficient, 1/s. */
  drag: number;
  /** Collision radius, metres. Also inflated by `proximity`. */
  radius: number;
  damage: number;
  precisionMultiplier: number;
  splashRadius: number;
  splashDamage: number;
  falloffStart: number;
  falloffEnd: number;
  falloffFloor: number;
  impulse: number;
  /** Seconds until forced detonation. 0 = never. */
  fuse: number;
  /** Restitution, 0 = detonate on first contact. */
  bounce: number;
  maxBounces: number;
  /** Extra radius that triggers detonation near a hostile. */
  proximity: number;
  /** Turn authority, rad/s. 0 = dumb-fire. */
  homing: number;
  /** Visual tumble, rad/s. */
  spin: number;
  lifetime: number;
  color: number;
  /** Visual radius multiplier. */
  width: number;
  sourceId: number;
  /** Perk-driven flags forwarded to the impact handler. */
  tags: number;
}

/** A live projectile. Fields are public so the impact callbacks can read them. */
export interface Projectile {
  readonly index: number;
  active: boolean;
  weaponId: string;
  element: DamageElement;
  look: ProjectileLook;
  position: THREE.Vector3;
  prevPosition: THREE.Vector3;
  velocity: THREE.Vector3;
  origin: THREE.Vector3;
  gravity: number;
  drag: number;
  radius: number;
  damage: number;
  precisionMultiplier: number;
  splashRadius: number;
  splashDamage: number;
  falloffStart: number;
  falloffEnd: number;
  falloffFloor: number;
  impulse: number;
  fuse: number;
  bounce: number;
  bouncesLeft: number;
  proximity: number;
  homing: number;
  homingTarget: Damageable | null;
  spin: number;
  roll: number;
  age: number;
  lifetime: number;
  color: number;
  width: number;
  sourceId: number;
  tags: number;
  /** Metres travelled, used for damage falloff at the point of impact. */
  travelled: number;
  /** Set to true by a hook to suppress the default detonation. */
  consumed: boolean;
}

export interface ProjectileHooks {
  /** Current collision world, or null while unbound. */
  collision(): WeaponCollision | null;
  /** Called when the projectile strikes geometry or an entity. */
  onImpact(p: Projectile, hit: RaycastHit): void;
  /** Called when a fuse, proximity trigger or lifetime ends the flight. */
  onDetonate(p: Projectile, point: THREE.Vector3, normal: THREE.Vector3): void;
  /** Called on a bounce so the caller can play a ricochet. */
  onBounce?(p: Projectile, point: THREE.Vector3, normal: THREE.Vector3, speed: number): void;
  /** Optional trail emission, throttled by the pool. */
  onTrail?(p: Projectile): void;
  /** Acquire a homing target inside a cone. */
  acquire?(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    cone: number,
    maxDistance: number,
  ): Damageable | null;
}

function makeProjectile(index: number): Projectile {
  return {
    index,
    active: false,
    weaponId: '',
    element: 'kinetic',
    look: 'bolt',
    position: new THREE.Vector3(),
    prevPosition: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    origin: new THREE.Vector3(),
    gravity: 0,
    drag: 0,
    radius: 0.06,
    damage: 0,
    precisionMultiplier: 1,
    splashRadius: 0,
    splashDamage: 0,
    falloffStart: 1e4,
    falloffEnd: 1e4,
    falloffFloor: 1,
    impulse: 0,
    fuse: 0,
    bounce: 0,
    bouncesLeft: 0,
    proximity: 0,
    homing: 0,
    homingTarget: null,
    spin: 0,
    roll: 0,
    age: 0,
    lifetime: 8,
    color: 0xffffff,
    width: 1,
    sourceId: 0,
    tags: 0,
    travelled: 0,
    consumed: false,
  };
}

const _hit: RaycastHit = {
  distance: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  surface: 'rock',
};
const _dirZ = new THREE.Vector3(0, 0, 1);
const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _col = new THREE.Color();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Elongated bipyramid — six triangles, reads as a hot bolt at any angle and is
 * cheaper than a capsule by an order of magnitude.
 */
function boltGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, false);
  g.rotateX(Math.PI / 2); // long axis becomes +Z
  return g;
}

/** Chamfered body for rockets, grenades and arrow shafts. */
function bodyGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.42, 0.5, 1, 8, 1, false);
  g.rotateX(Math.PI / 2);
  return g;
}

export class ProjectilePool {
  readonly capacity: number;
  /** Root the caller adds to the level scene. */
  readonly root = new THREE.Group();

  /** Diagnostics for the verification harness. */
  spawned = 0;
  dropped = 0;

  private items: Projectile[] = [];
  private free: number[] = [];
  private hooks: ProjectileHooks;
  private glowMesh: THREE.InstancedMesh;
  private solidMesh: THREE.InstancedMesh;
  private glowGeo: THREE.BufferGeometry;
  private solidGeo: THREE.BufferGeometry;
  private glowMat: THREE.Material;
  private solidMat: THREE.Material;
  private ownsMaterials = false;
  private trailTimer = 0;

  constructor(hooks: ProjectileHooks, materials: MaterialLibrary | null) {
    this.hooks = hooks;

    // Capacity scales with the quality tier's particle budget — a low-end
    // machine simply cannot afford a hundred live rockets' worth of trails.
    const budget = settings.profile.particleBudget;
    this.capacity = Math.round(clamp(budget / 90, 24, 160));

    for (let i = 0; i < this.capacity; i++) {
      this.items.push(makeProjectile(i));
      this.free.push(i);
    }

    this.glowGeo = boltGeometry();
    this.solidGeo = bodyGeometry();

    if (materials) {
      this.glowMat = materials.additive(0xffffff, 0.95);
      this.solidMat = materials.surface('metal', { roughness: 0.42, metalness: 1 });
    } else {
      this.ownsMaterials = true;
      this.glowMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      this.solidMat = new THREE.MeshStandardMaterial({
        color: 0x8d949c,
        roughness: 0.42,
        metalness: 1,
      });
    }

    this.glowMesh = new THREE.InstancedMesh(this.glowGeo, this.glowMat, this.capacity);
    this.solidMesh = new THREE.InstancedMesh(this.solidGeo, this.solidMat, this.capacity);
    for (const m of [this.glowMesh, this.solidMesh]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.count = this.capacity;
      this.root.add(m);
    }
    this.glowMesh.renderOrder = 6;
    // instanceColor lets one draw call carry every element's palette.
    this.glowMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(this.capacity * 3).fill(1),
      3,
    );
    this.solidMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(this.capacity * 3).fill(1),
      3,
    );
    for (let i = 0; i < this.capacity; i++) {
      this.glowMesh.setMatrixAt(i, _hidden);
      this.solidMesh.setMatrixAt(i, _hidden);
    }
    this.root.name = 'projectiles';
  }

  get activeCount(): number {
    return this.capacity - this.free.length;
  }

  /** Launch a round. Returns null when the pool is saturated. */
  spawn(spec: ProjectileSpec): Projectile | null {
    const idx = this.free.pop();
    if (idx === undefined) {
      this.dropped++;
      return null;
    }
    const p = this.items[idx];
    p.active = true;
    p.weaponId = spec.weaponId;
    p.element = spec.element;
    p.look = spec.look;
    p.position.copy(spec.origin);
    p.prevPosition.copy(spec.origin);
    p.origin.copy(spec.origin);
    p.velocity.copy(spec.direction).normalize().multiplyScalar(spec.speed);
    p.gravity = spec.gravity;
    p.drag = spec.drag;
    p.radius = spec.radius;
    p.damage = spec.damage;
    p.precisionMultiplier = spec.precisionMultiplier;
    p.splashRadius = spec.splashRadius;
    p.splashDamage = spec.splashDamage;
    p.falloffStart = spec.falloffStart;
    p.falloffEnd = spec.falloffEnd;
    p.falloffFloor = spec.falloffFloor;
    p.impulse = spec.impulse;
    p.fuse = spec.fuse;
    p.bounce = spec.bounce;
    p.bouncesLeft = spec.maxBounces;
    p.proximity = spec.proximity;
    p.homing = spec.homing;
    p.homingTarget = null;
    p.spin = spec.spin;
    p.roll = 0;
    p.age = 0;
    p.lifetime = spec.lifetime;
    p.color = spec.color;
    p.width = spec.width;
    p.sourceId = spec.sourceId;
    p.tags = spec.tags;
    p.travelled = 0;
    p.consumed = false;

    if (p.homing > 0 && this.hooks.acquire) {
      p.homingTarget = this.hooks.acquire(p.position, spec.direction, 0.22, 120);
    }
    this.spawned++;
    return p;
  }

  /** Fixed-step integration. */
  update(dt: number): void {
    if (this.free.length === this.capacity) return;
    const collision = this.hooks.collision();
    this.trailTimer += dt;
    const emitTrail = this.trailTimer >= 1 / 60;
    if (emitTrail) this.trailTimer = 0;

    for (const p of this.items) {
      if (!p.active) continue;
      p.prevPosition.copy(p.position);
      p.age += dt;

      // -- homing steering --------------------------------------------------
      if (p.homing > 0 && p.homingTarget && !p.homingTarget.isDead) {
        p.homingTarget.getWorldPosition(_to);
        _dir.subVectors(_to, p.position);
        const d = _dir.length();
        if (d > 0.05) {
          _dir.multiplyScalar(1 / d);
          const speed = p.velocity.length();
          if (speed > 1e-4) {
            _tmp.copy(p.velocity).multiplyScalar(1 / speed);
            // Rotate the heading toward the target by at most `homing * dt`.
            const maxTurn = p.homing * dt;
            const cosA = clamp(_tmp.dot(_dir), -1, 1);
            const angle = Math.acos(cosA);
            const t = angle > 1e-5 ? Math.min(1, maxTurn / angle) : 1;
            _tmp.lerp(_dir, t).normalize();
            p.velocity.copy(_tmp).multiplyScalar(speed);
          }
        }
      }

      // -- forces -----------------------------------------------------------
      if (p.gravity !== 0) p.velocity.y -= p.gravity * dt;
      if (p.drag > 0) p.velocity.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.roll += p.spin * dt;

      // -- sub-stepped sweep ------------------------------------------------
      const speed = p.velocity.length();
      const travel = speed * dt;
      const steps = clamp(Math.ceil(travel / SUBSTEP_METRES), 1, MAX_SUBSTEPS);
      const sub = dt / steps;
      let ended = false;

      for (let s = 0; s < steps && !ended; s++) {
        const stepLen = p.velocity.length() * sub;
        if (stepLen > 1e-7 && collision) {
          _dir.copy(p.velocity).multiplyScalar(1 / p.velocity.length());
          const probe = p.radius + p.proximity;
          const hit = collision.sphereSweep
            ? collision.sphereSweep(p.position, _dir, probe, stepLen, p.sourceId, _hit)
            : collision.raycast(p.position, _dir, stepLen + probe, _hit);
          if (hit && hit.distance <= stepLen + 1e-4) {
            p.travelled += hit.distance;
            p.position.addScaledVector(_dir, Math.max(0, hit.distance - 0.001));
            ended = this.resolveHit(p, hit);
            if (!ended) continue; // bounced; keep integrating this tick
          }
        }
        p.position.addScaledVector(p.velocity, sub);
        p.travelled += stepLen;
      }
      if (ended) continue;

      // -- fuse / lifetime --------------------------------------------------
      if (p.fuse > 0 && p.age >= p.fuse) {
        _tmp.set(0, 1, 0);
        this.detonate(p, p.position, _tmp);
        continue;
      }
      if (p.age >= p.lifetime) {
        _tmp.set(0, 1, 0);
        this.detonate(p, p.position, _tmp);
        continue;
      }
      if (!Number.isFinite(p.position.x) || !Number.isFinite(p.position.y) || !Number.isFinite(p.position.z)) {
        // Defensive: never let a NaN escape into the scene graph.
        this.release(p);
        continue;
      }
      if (emitTrail) this.hooks.onTrail?.(p);
    }
  }

  /**
   * Returns true when the projectile's flight ended. A bouncing round reflects
   * and keeps going.
   */
  private resolveHit(p: Projectile, hit: RaycastHit): boolean {
    const speed = p.velocity.length();
    const into = -_dir.dot(hit.normal);

    // Damageable contact always detonates, regardless of restitution.
    if (!hit.damageable && p.bounce > 0 && p.bouncesLeft > 0 && speed * into > 2.5) {
      p.bouncesLeft--;
      // Reflect, damp the normal component by restitution and shave the
      // tangential component so grenades settle instead of skating forever.
      const vn = p.velocity.dot(hit.normal);
      p.velocity.addScaledVector(hit.normal, -vn * (1 + p.bounce));
      p.velocity.multiplyScalar(0.86);
      p.position.addScaledVector(hit.normal, p.radius * 1.2 + 0.01);
      p.spin = (p.spin + speed * 0.8) * 0.6;
      this.hooks.onBounce?.(p, hit.point, hit.normal, speed);
      return false;
    }

    this.hooks.onImpact(p, hit);
    if (!p.consumed) this.hooks.onDetonate(p, hit.point, hit.normal);
    this.release(p);
    return true;
  }

  private detonate(p: Projectile, point: THREE.Vector3, normal: THREE.Vector3): void {
    this.hooks.onDetonate(p, point, normal);
    this.release(p);
  }

  private release(p: Projectile): void {
    if (!p.active) return;
    p.active = false;
    p.homingTarget = null;
    this.free.push(p.index);
  }

  /** Visual update, interpolated between the last two simulation states. */
  render(alpha: number): void {
    let glowDirty = false;
    let solidDirty = false;
    for (const p of this.items) {
      const glow = p.look === 'bolt';
      const mesh = glow ? this.glowMesh : this.solidMesh;
      if (!p.active) {
        mesh.setMatrixAt(p.index, _hidden);
        if (glow) glowDirty = true;
        else solidDirty = true;
        continue;
      }
      _tmp.lerpVectors(p.prevPosition, p.position, alpha);
      const speed = p.velocity.length();
      if (speed > 1e-4) _dir.copy(p.velocity).multiplyScalar(1 / speed);
      else _dir.copy(_dirZ);
      const r = p.radius * p.width;
      switch (p.look) {
        case 'bolt':
          _scale.set(r * 1.1, r * 1.1, r * 6.5);
          break;
        case 'arrow':
          _scale.set(r * 0.5, r * 0.5, r * 9);
          break;
        case 'rocket':
          _scale.set(r * 1.15, r * 1.15, r * 3.4);
          break;
        default:
          _scale.set(r * 1.3, r * 1.3, r * 1.5);
          break;
      }
      // The geometry's long axis is +Z, so aim +Z down the velocity vector.
      _quat.setFromUnitVectors(_dirZ, _dir);
      if (p.spin !== 0) {
        scratch.qa.setFromAxisAngle(_dir, p.roll);
        _quat.premultiply(scratch.qa);
      }
      _mat.compose(_tmp, _quat, _scale);
      mesh.setMatrixAt(p.index, _mat);
      _col.setHex(p.color);
      mesh.instanceColor!.setXYZ(p.index, _col.r, _col.g, _col.b);
      if (glow) glowDirty = true;
      else solidDirty = true;
    }
    if (glowDirty) {
      this.glowMesh.instanceMatrix.needsUpdate = true;
      this.glowMesh.instanceColor!.needsUpdate = true;
    }
    if (solidDirty) {
      this.solidMesh.instanceMatrix.needsUpdate = true;
      this.solidMesh.instanceColor!.needsUpdate = true;
    }
  }

  /** Retire everything without firing detonation hooks (level change). */
  clear(): void {
    for (const p of this.items) {
      if (p.active) this.release(p);
      this.glowMesh.setMatrixAt(p.index, _hidden);
      this.solidMesh.setMatrixAt(p.index, _hidden);
    }
    this.glowMesh.instanceMatrix.needsUpdate = true;
    this.solidMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.clear();
    this.root.removeFromParent();
    this.glowMesh.dispose();
    this.solidMesh.dispose();
    this.glowGeo.dispose();
    this.solidGeo.dispose();
    if (this.ownsMaterials) {
      this.glowMat.dispose();
      this.solidMat.dispose();
    }
    this.items.length = 0;
    this.free.length = 0;
  }
}
