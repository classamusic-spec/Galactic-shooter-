/**
 * Grenade projectiles, lingering fields, and the throw preview.
 *
 * Grenades are simulated on the fixed step with real ballistics against the
 * same `CollisionWorld` everything else uses: gravity from `@/gameplay/Physics`,
 * a swept raycast per step (so a fast grenade cannot tunnel through a wall), a
 * reflection with restitution and tangential friction on bounce, and an
 * optional stick.
 *
 * The trajectory preview integrates *the same equations at the same step* as
 * the live projectile rather than a closed-form parabola, because the moment
 * the preview and the throw disagree — which a parabola does as soon as the arc
 * clips a ledge — the player stops trusting the preview and stops using it.
 */
import * as THREE from 'three';
import type { CollisionWorld, Damageable, RaycastHit } from '@/types';
import type { VfxSystem } from '@/gfx/vfx/VfxSystem';
import { GRAVITY } from '../Physics';
import { clamp, clamp01 } from '@/util/math';
import { sweepWorld, throwVelocity } from './Ballistics';
import type { GrenadeSpec } from './Definitions';

const MAX_GRENADES = 12;
const MAX_FIELDS = 10;
const PREVIEW_STEPS = 48;
const PREVIEW_DT = 1 / 30;

export interface Grenade {
  active: boolean;
  spec: GrenadeSpec | null;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  fuse: number;
  age: number;
  ownerId: number;
  stuck: boolean;
  bounces: number;
  mesh: THREE.Mesh;
  /** Pulses left for a multi-detonation grenade (Pulse). */
  pulses: number;
  pulseTimer: number;
}

export interface Field {
  active: boolean;
  spec: GrenadeSpec | null;
  position: THREE.Vector3;
  remaining: number;
  tick: number;
  ownerId: number;
  mesh: THREE.Mesh;
}

export type DetonateHandler = (
  spec: GrenadeSpec,
  position: THREE.Vector3,
  ownerId: number,
  finalBlast: boolean,
) => void;

export type FieldTickHandler = (
  spec: GrenadeSpec,
  position: THREE.Vector3,
  ownerId: number,
) => void;

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _step = new THREE.Vector3();
const _stepDir = new THREE.Vector3();
const _tmpHit: RaycastHit = {
  distance: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  surface: 'rock',
};
export class GrenadePool {
  private grenades: Grenade[] = [];
  private fields: Field[] = [];
  private group = new THREE.Group();
  private vfx: VfxSystem;
  private geometry: THREE.BufferGeometry;
  private fieldGeometry: THREE.BufferGeometry;
  private materials = new Map<number, THREE.MeshBasicMaterial>();
  private scene: THREE.Scene | null = null;

  // -- preview ------------------------------------------------------------
  private previewLine: THREE.Line;
  private previewPositions: Float32Array;
  private previewMarker: THREE.Mesh;
  private previewMaterial: THREE.LineBasicMaterial;
  private markerMaterial: THREE.MeshBasicMaterial;

  onDetonate: DetonateHandler | null = null;
  onFieldTick: FieldTickHandler | null = null;

  constructor(vfx: VfxSystem) {
    this.vfx = vfx;
    this.group.name = 'grenades';
    this.geometry = new THREE.IcosahedronGeometry(0.11, 1);
    this.fieldGeometry = new THREE.RingGeometry(0.6, 1, 32, 1);
    this.fieldGeometry.rotateX(-Math.PI / 2);

    for (let i = 0; i < MAX_GRENADES; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.material(0xffffff));
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.grenades.push({
        active: false,
        spec: null,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        fuse: 0,
        age: 0,
        ownerId: 0,
        stuck: false,
        bounces: 0,
        mesh,
        pulses: 0,
        pulseTimer: 0,
      });
    }

    for (let i = 0; i < MAX_FIELDS; i++) {
      const mesh = new THREE.Mesh(this.fieldGeometry, this.material(0xffffff));
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.fields.push({
        active: false,
        spec: null,
        position: new THREE.Vector3(),
        remaining: 0,
        tick: 0,
        ownerId: 0,
        mesh,
      });
    }

    // -- preview geometry --------------------------------------------------
    this.previewPositions = new Float32Array(PREVIEW_STEPS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.previewPositions, 3));
    geo.setDrawRange(0, 0);
    this.previewMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.75,
      depthTest: false,
      toneMapped: false,
    });
    this.previewLine = new THREE.Line(geo, this.previewMaterial);
    this.previewLine.frustumCulled = false;
    this.previewLine.renderOrder = 900;
    this.previewLine.visible = false;
    this.group.add(this.previewLine);

    this.markerMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const ring = new THREE.RingGeometry(0.35, 0.5, 28, 1);
    ring.rotateX(-Math.PI / 2);
    this.previewMarker = new THREE.Mesh(ring, this.markerMaterial);
    this.previewMarker.renderOrder = 901;
    this.previewMarker.frustumCulled = false;
    this.previewMarker.visible = false;
    this.group.add(this.previewMarker);
  }

  private material(color: number): THREE.MeshBasicMaterial {
    let m = this.materials.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHex(color, THREE.SRGBColorSpace),
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      this.materials.set(color, m);
    }
    return m;
  }

  attach(scene: THREE.Scene): void {
    this.scene = scene;
    scene.add(this.group);
  }

  detach(): void {
    this.group.removeFromParent();
    this.scene = null;
    this.clear();
  }

  clear(): void {
    for (const g of this.grenades) {
      g.active = false;
      g.mesh.visible = false;
    }
    for (const f of this.fields) {
      f.active = false;
      f.mesh.visible = false;
    }
    this.hidePreview();
  }

  // -------------------------------------------------------------------------
  // Throwing
  // -------------------------------------------------------------------------

  /** `charge` is 0..1; it scales the throw speed between the spec's bounds. */
  throwGrenade(
    spec: GrenadeSpec,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    charge: number,
    ownerId: number,
    inherit?: THREE.Vector3,
  ): Grenade | null {
    const g = this.grenades.find((q) => !q.active);
    if (!g) return null;
    g.active = true;
    g.spec = spec;
    g.position.copy(origin);
    throwVelocity(spec, direction, charge, g.velocity);
    if (inherit) g.velocity.addScaledVector(inherit, 0.4);
    g.fuse = spec.fuse > 0 ? spec.fuse : Infinity;
    g.age = 0;
    g.ownerId = ownerId;
    g.stuck = false;
    g.bounces = 0;
    g.pulses = spec.fieldDuration > 0 && spec.id === 'grenade.pulse' ? 4 : 0;
    g.pulseTimer = 0;
    g.mesh.material = this.material(spec.color);
    g.mesh.position.copy(origin);
    g.mesh.visible = true;
    return g;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  update(
    dt: number,
    collision: CollisionWorld | null,
    enemies: readonly Damageable[],
    elapsed: number,
  ): void {
    for (const g of this.grenades) {
      if (!g.active || !g.spec) continue;
      const spec = g.spec;
      g.age += dt;

      if (!g.stuck) {
        g.velocity.y -= GRAVITY * dt;
        const step = _v.copy(g.velocity).multiplyScalar(dt);
        const dist = step.length();
        if (dist > 1e-5 && collision) {
          _dir.copy(step).multiplyScalar(1 / dist);
          const hit = sweepWorld(collision, g.position, _dir, dist, spec.radius, 'sand');
          if (hit) {
            // Land just off the surface so the next sweep does not start inside it.
            g.position.copy(hit.point).addScaledVector(hit.normal, spec.radius + 0.02);
            if (spec.fuse === 0) {
              this.detonate(g, true);
              continue;
            }
            if (spec.sticky) {
              g.stuck = true;
              g.velocity.set(0, 0, 0);
              if (g.fuse === Infinity) g.fuse = 0.5;
            } else {
              const vn = g.velocity.dot(hit.normal);
              // Reflect the normal component, damp the tangential one.
              g.velocity.addScaledVector(hit.normal, -vn * (1 + spec.restitution));
              g.velocity.multiplyScalar(1 - spec.friction * 0.35);
              g.bounces++;
              this.vfx.impact(hit.point, hit.normal, hit.surface, 0.25);
              if (g.velocity.lengthSq() < 0.6 && hit.normal.y > 0.6) g.velocity.set(0, 0, 0);
            }
          } else {
            g.position.add(step);
          }
        } else {
          g.position.add(step);
        }
      }

      // Proximity arming: ignore the first moment so it cannot trip on the
      // thrower's own position as it leaves the hand.
      if (spec.proximity > 0 && g.age > 0.45) {
        for (const e of enemies) {
          if (e.isDead) continue;
          if (e.getWorldPosition(_v).distanceTo(g.position) < spec.proximity) {
            this.detonate(g, true);
            break;
          }
        }
        if (!g.active) continue;
      }

      // Multi-pulse grenades fire a smaller blast repeatedly before the last.
      if (g.pulses > 0 && g.fuse !== Infinity) {
        g.pulseTimer -= dt;
        if (g.fuse <= 0 && g.pulseTimer <= 0) {
          g.pulseTimer = spec.fieldTick;
          g.pulses--;
          this.onDetonate?.(spec, g.position, g.ownerId, g.pulses <= 0);
          this.vfx.elementalBurst(g.position, spec.element, 0.8);
          if (g.pulses <= 0) {
            this.retire(g);
            continue;
          }
        }
      }

      if (g.fuse !== Infinity) {
        g.fuse -= dt;
        if (g.fuse <= 0 && g.pulses <= 0) {
          this.detonate(g, true);
          continue;
        }
      }

      g.mesh.position.copy(g.position);
      g.mesh.rotation.y = elapsed * 6 + g.age * 3;
      g.mesh.rotation.x = elapsed * 4.3;
      // A blinking core as the fuse runs out is the clearest possible warning.
      const urgency = g.fuse === Infinity ? 0 : clamp01(1 - g.fuse / Math.max(0.2, spec.fuse));
      const blink = 1 + Math.sin(elapsed * (8 + urgency * 40)) * 0.25 * (0.3 + urgency);
      g.mesh.scale.setScalar(blink);
      this.vfx.trail(g.position, spec.color, 0.1);
    }

    // -- lingering fields ---------------------------------------------------
    for (const f of this.fields) {
      if (!f.active || !f.spec) continue;
      f.remaining -= dt;
      if (f.remaining <= 0) {
        f.active = false;
        f.mesh.visible = false;
        continue;
      }
      f.tick -= dt;
      if (f.tick <= 0) {
        f.tick = f.spec.fieldTick;
        this.onFieldTick?.(f.spec, f.position, f.ownerId);
        this.vfx.elementalBurst(f.position, f.spec.element, 0.5);
      }
      const life = clamp01(f.remaining / Math.max(0.1, f.spec.fieldDuration));
      const r = f.spec.fieldRadius * (0.8 + 0.2 * Math.sin(elapsed * 2.2));
      f.mesh.position.copy(f.position);
      f.mesh.position.y += 0.06;
      f.mesh.scale.setScalar(r);
      f.mesh.rotation.y = elapsed * 0.6;
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = 0.18 + life * 0.3;
    }
  }

  private detonate(g: Grenade, final: boolean): void {
    const spec = g.spec;
    if (!spec) return;
    this.onDetonate?.(spec, g.position, g.ownerId, final);
    if (spec.fieldDuration > 0 && spec.id !== 'grenade.pulse') this.spawnField(spec, g.position, g.ownerId);
    this.retire(g);
  }

  private retire(g: Grenade): void {
    g.active = false;
    g.spec = null;
    g.mesh.visible = false;
  }

  private spawnField(spec: GrenadeSpec, position: THREE.Vector3, ownerId: number): void {
    const f = this.fields.find((q) => !q.active);
    if (!f) return;
    f.active = true;
    f.spec = spec;
    f.position.copy(position);
    f.remaining = spec.fieldDuration;
    f.tick = 0;
    f.ownerId = ownerId;
    f.mesh.material = this.material(spec.color);
    f.mesh.visible = true;
  }

  // -------------------------------------------------------------------------
  // Trajectory preview
  // -------------------------------------------------------------------------

  /**
   * Integrate the arc the throw *would* take and draw it. Returns the predicted
   * impact point, or null if the arc left the world without hitting anything.
   */
  showPreview(
    spec: GrenadeSpec,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    charge: number,
    collision: CollisionWorld | null,
  ): THREE.Vector3 | null {
    const p = _v.copy(origin);
    const vel = throwVelocity(spec, direction, charge, _dir);

    const pos = this.previewPositions;
    let count = 0;
    let impact: THREE.Vector3 | null = null;
    const step = _step;
    const dirStep = _stepDir;

    for (let i = 0; i < PREVIEW_STEPS; i++) {
      pos[count * 3] = p.x;
      pos[count * 3 + 1] = p.y;
      pos[count * 3 + 2] = p.z;
      count++;

      vel.y -= GRAVITY * PREVIEW_DT;
      step.copy(vel).multiplyScalar(PREVIEW_DT);
      const dist = step.length();
      if (dist < 1e-5) break;
      dirStep.copy(step).multiplyScalar(1 / dist);
      const hit = collision ? sweepWorld(collision, p, dirStep, dist, spec.radius, 'sand') : null;
      if (hit) {
        p.copy(hit.point);
        pos[count * 3] = p.x;
        pos[count * 3 + 1] = p.y;
        pos[count * 3 + 2] = p.z;
        count++;
        impact = this.previewMarker.position.copy(hit.point).addScaledVector(hit.normal, 0.05);
        // Non-bouncing grenades stop at the first surface; bouncing ones keep
        // going, so the preview shows the bank shot the player is aiming for.
        if (spec.fuse === 0 || spec.sticky) break;
        const vn = vel.dot(hit.normal);
        vel.addScaledVector(hit.normal, -vn * (1 + spec.restitution));
        vel.multiplyScalar(1 - spec.friction * 0.35);
        p.addScaledVector(hit.normal, spec.radius + 0.03);
      } else {
        p.add(step);
      }
      if (count >= PREVIEW_STEPS - 1) break;
    }

    const attr = this.previewLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.previewLine.geometry.setDrawRange(0, count);
    this.previewMaterial.color.setHex(spec.color, THREE.SRGBColorSpace);
    this.markerMaterial.color.setHex(spec.color, THREE.SRGBColorSpace);
    this.previewMaterial.opacity = 0.35 + charge * 0.5;
    this.previewLine.visible = count > 1;
    this.previewMarker.visible = impact != null;
    if (impact) this.previewMarker.scale.setScalar(0.7 + charge * 0.6);
    return impact;
  }

  hidePreview(): void {
    this.previewLine.visible = false;
    this.previewMarker.visible = false;
  }

  get activeCount(): number {
    let n = 0;
    for (const g of this.grenades) if (g.active) n++;
    return n;
  }

  get fieldCount(): number {
    let n = 0;
    for (const f of this.fields) if (f.active) n++;
    return n;
  }

  dispose(): void {
    this.detach();
    this.geometry.dispose();
    this.fieldGeometry.dispose();
    this.previewLine.geometry.dispose();
    this.previewMarker.geometry.dispose();
    this.previewMaterial.dispose();
    this.markerMaterial.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    this.grenades.length = 0;
    this.fields.length = 0;
  }
}

/** Exported so tuning code and the HUD can talk about charge in one place. */
export const chargeFraction = (held: number, spec: GrenadeSpec): number =>
  clamp(held / Math.max(0.05, spec.chargeTime), 0, 1);
