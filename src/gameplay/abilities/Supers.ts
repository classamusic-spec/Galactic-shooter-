/**
 * Supers.
 *
 * A super has to be a *showstopper* — the moment the player has been saving up
 * for — and that is a presentation problem at least as much as a damage one.
 * Each of the three shares one skeleton:
 *
 *   wind-up  →  active  →  end
 *
 * ...and each stage does specific work:
 *
 *  - **Wind-up** (0.7–1.0 s) is the promise. The screen flashes (only when
 *    reduced motion is off), a real `PointLight` blooms on the caster, the
 *    camera takes a rising kick, and the player is briefly slowed so the beat
 *    lands. Nothing has been damaged yet; this is entirely anticipation.
 *  - **Active** is the payoff, on a fixed damage cadence rather than per frame
 *    so the numbers are frame-rate independent. The caster carries a coloured
 *    light that genuinely lights the world, a per-super camera treatment (roll
 *    oscillation for Arc, a slow heavy sway for Void, a forward push for Solar)
 *    and a damage resistance.
 *  - **End** returns everything with a decay rather than a cut.
 *
 * Damage resistance is applied by `AbilitySystem`, which listens for
 * `player:damaged` and refunds the resisted fraction. Doing it that way keeps
 * `Player` — which is another owner's file — completely unaware that supers
 * exist.
 */
import * as THREE from 'three';
import type { Damageable, SurfaceKind } from '@/types';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import { clamp, clamp01, smoothstep } from '@/util/math';
import { sweepWorld } from './Ballistics';
import type { AbilityContext } from './Context';
import type { SuperSpec } from './Definitions';

export type SuperPhase = 'idle' | 'windup' | 'active' | 'ending';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _normal = new THREE.Vector3(0, 1, 0);

/** Enemies a single tick may hit. Bounded so a super cannot stall a frame. */
const MAX_TICK_TARGETS = 24;

export class SuperController {
  private ctx: AbilityContext;
  spec: SuperSpec;

  phase: SuperPhase = 'idle';
  private timer = 0;
  private tickTimer = 0;
  private rollPhase = 0;
  private light: THREE.PointLight;
  private flash: THREE.Mesh;
  private flashMaterial: THREE.MeshBasicMaterial;
  private scene: THREE.Scene | null = null;
  private tethered: Damageable[] = [];
  private kills = 0;
  private strikeCount = 0;

  constructor(ctx: AbilityContext, spec: SuperSpec) {
    this.ctx = ctx;
    this.spec = spec;

    this.light = new THREE.PointLight(spec.color, 0, spec.lightRange, 2);
    this.light.castShadow = false;
    this.light.visible = false;

    // The flash is a small inverted sphere carried on the camera. Inside the
    // near plane and with depth testing off it fills the frame exactly like a
    // post-process flash would, without this file needing to own a pass.
    this.flashMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHex(spec.color, THREE.SRGBColorSpace),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
      toneMapped: false,
    });
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8), this.flashMaterial);
    this.flash.frustumCulled = false;
    this.flash.renderOrder = 999;
    this.flash.visible = false;
  }

  attach(scene: THREE.Scene): void {
    this.scene = scene;
    scene.add(this.light, this.flash);
  }

  detach(): void {
    this.light.removeFromParent();
    this.flash.removeFromParent();
    this.scene = null;
  }

  setSpec(spec: SuperSpec): void {
    this.spec = spec;
    this.light.color.setHex(spec.color, THREE.SRGBColorSpace);
    this.light.distance = spec.lightRange;
    this.flashMaterial.color.setHex(spec.color, THREE.SRGBColorSpace);
  }

  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** 0..1 remaining, for the HUD's super bar while it drains. */
  get remaining01(): number {
    if (this.phase === 'active') return clamp01(1 - this.timer / this.spec.duration);
    return this.phase === 'idle' ? 0 : 1;
  }

  /** Fraction of incoming damage negated right now. */
  get resistance(): number {
    if (this.phase === 'windup') return this.spec.resistance * 0.6;
    if (this.phase === 'active') return this.spec.resistance;
    return 0;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  activate(): boolean {
    if (this.phase !== 'idle') return false;
    this.phase = 'windup';
    this.timer = 0;
    this.tickTimer = 0;
    this.kills = 0;
    this.strikeCount = 0;
    this.tethered.length = 0;
    this.light.visible = true;
    this.flash.visible = !settings.user.reducedMotion;

    const p = this.ctx.player;
    p.addShake(settings.user.reducedMotion ? 0.8 : 2.4, 0.7, 12);
    p.addViewKick(-0.11, 0, 0, 3.5);
    this.ctx.vfx.elementalBurst(p.eyePosition, this.spec.element, 2.2);
    events.emit('super:activated');
    return true;
  }

  end(): void {
    if (this.phase === 'idle' || this.phase === 'ending') return;
    this.phase = 'ending';
    this.timer = 0;
    this.tethered.length = 0;
    events.emit('super:ended');
  }

  cancel(): void {
    this.phase = 'idle';
    this.timer = 0;
    this.light.visible = false;
    this.light.intensity = 0;
    this.flash.visible = false;
    this.flashMaterial.opacity = 0;
    this.tethered.length = 0;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  update(dt: number): void {
    if (this.phase === 'idle') return;
    const spec = this.spec;
    this.timer += dt;
    this.rollPhase += dt;

    switch (this.phase) {
      case 'windup': {
        // The player is braked for the beat, then released into it.
        const p = this.ctx.player;
        const brake = 1 - Math.min(0.9, 5 * dt);
        p.velocity.x *= brake;
        p.velocity.z *= brake;
        if (this.timer >= spec.windup) {
          this.phase = 'active';
          this.timer = 0;
          this.tickTimer = 0;
          this.ctx.player.addShake(settings.user.reducedMotion ? 1 : 3.4, 0.5, 30);
        }
        break;
      }

      case 'active': {
        this.tickTimer -= dt;
        if (this.tickTimer <= 0) {
          this.tickTimer = spec.interval;
          this.fire();
        }
        this.cameraTreatment(dt);
        if (this.timer >= spec.duration) this.end();
        break;
      }

      case 'ending':
        if (this.timer > 1.1) this.cancel();
        break;

      default:
        break;
    }
  }

  /** The per-super camera signature, applied as small continuous impulses. */
  private cameraTreatment(dt: number): void {
    const spec = this.spec;
    const p = this.ctx.player;
    const scale = settings.user.reducedMotion ? 0.3 : 1;
    // A slow roll oscillation reads as "the world is tilting under you" without
    // ever taking the aim away from the player.
    const roll = Math.sin(this.rollPhase * spec.cameraRollHz * Math.PI * 2) * spec.cameraRoll;
    p.addViewKick(0, 0, roll * dt * 12 * scale, 9);
    // A low rumble underneath everything.
    p.addShake(0.22 * scale * dt * 60, 0.12, 16);
  }

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------

  private fire(): void {
    switch (this.spec.element) {
      case 'solar':
        this.fireSolar();
        break;
      case 'arc':
        this.fireArc();
        break;
      default:
        this.fireVoid();
        break;
    }
  }

  /** Daybreak: hurl an arc of fire down the aim line, detonating where it lands. */
  private fireSolar(): void {
    const ctx = this.ctx;
    const spec = this.spec;
    const p = ctx.player;
    _from.copy(p.eyePosition).addScaledVector(p.aimDirection, 0.8);

    const collision = ctx.collision();
    let dist = spec.range;
    let surface: SurfaceKind = 'sand';
    if (collision) {
      // sweepWorld, not raycast: the open ground is a height field the BVH
      // does not carry, and a blast that ignores it detonates in mid-air.
      const hit = sweepWorld(collision, p.eyePosition, p.aimDirection, spec.range, 0.2, 'sand');
      if (hit) {
        dist = hit.distance;
        surface = hit.surface;
        _normal.copy(hit.normal);
      } else {
        _normal.set(0, 1, 0);
      }
    } else {
      _normal.set(0, 1, 0);
    }
    // Stop short at the nearest enemy in the cone, so the blast lands on them.
    const target = this.nearestInCone(spec.range, spec.cone);
    if (target) {
      target.getWorldPosition(_v);
      _v.y += 0.9;
      const d = _v.distanceTo(p.eyePosition);
      if (d < dist) dist = d;
    }
    _to.copy(p.eyePosition).addScaledVector(p.aimDirection, dist);

    ctx.vfx.tracer(_from, _to, spec.color, 0.14, 90);
    // Only every third strike gets a full explosion. A super that detonates a
    // grenade-sized blast twice a second for twelve seconds buries the arena in
    // smoke — the first capture was an unreadable white wall by four seconds in.
    this.strikeCount++;
    if (this.strikeCount % 3 === 0) ctx.vfx.explosion(_to, spec.radius * 0.55, 'solar');
    else {
      ctx.vfx.elementalBurst(_to, 'solar', 1.1);
      ctx.vfx.impact(_to, _normal, surface, 1.3);
    }
    const res = ctx.damage.splash({
      center: _to,
      radius: spec.radius,
      damage: spec.damage,
      element: 'solar',
      sourceId: 0,
      edgeFraction: 0.35,
      selfFraction: 0,
      impulse: 320,
      emitEvent: false,
    });
    this.applyStatusAround(_to, spec.radius);
    this.creditKills(res.hits);
    p.addViewKick(0.024, 0, 0, 12);
  }

  /** Stormtrance: continuous lightning that chains from target to target. */
  private fireArc(): void {
    const ctx = this.ctx;
    const spec = this.spec;
    const p = ctx.player;
    _from.copy(p.eyePosition).addScaledVector(p.aimDirection, 0.6);

    const enemies = ctx.enemies();
    let chained = 0;
    let previous = _from;
    let hits = 0;

    // Primary bolt: whatever is in the cone, nearest first.
    const first = this.nearestInCone(spec.range, spec.cone);
    if (first) {
      first.getWorldPosition(_to);
      _to.y += 0.9;
      ctx.vfx.chain(previous, _to, spec.color, 0.07);
      hits += this.zap(first, spec.damage);
      previous = _v2.copy(_to);
      chained++;

      // Chain outward: three jumps, each to the nearest unstruck neighbour.
      const struck = new Set<number>([first.entityId]);
      while (chained < 4) {
        let best: Damageable | null = null;
        let bestD = 7.5;
        for (const e of enemies) {
          if (e.isDead || struck.has(e.entityId)) continue;
          const d = e.getWorldPosition(_v).distanceTo(previous);
          if (d < bestD) {
            bestD = d;
            best = e;
          }
        }
        if (!best) break;
        best.getWorldPosition(_to);
        _to.y += 0.9;
        ctx.vfx.chain(previous, _to, spec.color, 0.05);
        hits += this.zap(best, spec.damage * (0.8 - chained * 0.12));
        struck.add(best.entityId);
        previous = _v2.copy(_to);
        chained++;
      }
    } else {
      // Nothing in front: still discharge into the ground so the super reads.
      _to.copy(p.eyePosition).addScaledVector(p.aimDirection, 6);
      ctx.vfx.chain(_from, _to, spec.color, 0.05);
    }
    this.creditKills(hits);
  }

  /** Spectral Bind: tether everything in the cone, suppress it, and drain it. */
  private fireVoid(): void {
    const ctx = this.ctx;
    const spec = this.spec;
    const p = ctx.player;
    _from.copy(p.eyePosition).addScaledVector(p.aimDirection, 0.5);

    const cosCone = Math.cos(spec.cone);
    let hits = 0;
    let count = 0;
    for (const e of ctx.enemies()) {
      if (e.isDead || count >= MAX_TICK_TARGETS) continue;
      e.getWorldPosition(_to);
      _to.y += 0.9;
      _v.subVectors(_to, p.eyePosition);
      const dist = _v.length();
      if (dist > spec.range || dist < 1e-3) continue;
      _v.multiplyScalar(1 / dist);
      if (_v.dot(p.aimDirection) < cosCone) continue;
      count++;

      ctx.vfx.chain(_from, _to, spec.color, 0.045);
      const dealt = ctx.damage.resolve({
        target: e,
        amount: spec.damage,
        element: 'void',
        sourceId: 0,
        point: _to,
        region: 'body',
        impulse: 90,
        hitmarker: true,
      });
      if (dealt > 0) {
        hits++;
        // Tethered targets feed the caster: the Void kit's attrition fantasy.
        const heal = Math.min(dealt * 0.12, 6);
        p.shield = clamp(p.shield + heal, 0, p.maxShield);
      }
      ctx.status.apply(e, 'suppress', { duration: 1.2, sourceId: 0 });
      ctx.status.apply(e, 'weaken', { duration: 4, sourceId: 0 });
    }
    this.creditKills(hits);
  }

  private zap(target: Damageable, amount: number): number {
    const ctx = this.ctx;
    target.getWorldPosition(_v);
    _v.y += 0.9;
    const dealt = ctx.damage.resolve({
      target,
      amount,
      element: 'arc',
      sourceId: 0,
      point: _v,
      region: 'body',
      impulse: 120,
      hitmarker: true,
    });
    if (dealt > 0) ctx.status.apply(target, 'shock', { sourceId: 0 });
    return dealt > 0 ? 1 : 0;
  }

  private applyStatusAround(center: THREE.Vector3, radius: number): void {
    const spec = this.spec;
    if (!spec.status) return;
    for (const e of this.ctx.enemies()) {
      if (e.isDead) continue;
      if (e.getWorldPosition(_v).distanceTo(center) > radius) continue;
      this.ctx.status.apply(e, spec.status, { stacks: spec.statusStacks, sourceId: 0 });
    }
  }

  private nearestInCone(range: number, cone: number): Damageable | null {
    const p = this.ctx.player;
    const cosCone = Math.cos(cone);
    let best: Damageable | null = null;
    let bestD = range;
    for (const e of this.ctx.enemies()) {
      if (e.isDead) continue;
      e.getWorldPosition(_v);
      _v.y += 0.9;
      _v.sub(p.eyePosition);
      const d = _v.length();
      if (d > bestD || d < 1e-3) continue;
      _v.multiplyScalar(1 / d);
      if (_v.dot(p.aimDirection) < cosCone) continue;
      bestD = d;
      best = e;
    }
    return best;
  }

  private creditKills(hits: number): void {
    if (hits <= 0) return;
    // Kills during a super refund a sliver of energy, so a good super extends
    // itself slightly. Not enough to loop — enough to reward good positioning.
    this.ctx.addSuperEnergy(this.spec.refundOnKill * hits);
    this.kills += hits;
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  /** Called from the render pass, on the real frame delta. */
  render(frameDt: number, cameraPosition: THREE.Vector3): void {
    const spec = this.spec;
    const reduced = settings.user.reducedMotion;

    let lightT = 0;
    let flashT = 0;
    if (this.phase === 'windup') {
      const t = clamp01(this.timer / spec.windup);
      lightT = smoothstep(t) * 1.35;
      // The flash is a fast ramp and a slower fall, peaking at the transition.
      flashT = Math.pow(t, 3.4);
    } else if (this.phase === 'active') {
      const fade = clamp01(this.timer / 0.25);
      const tail = clamp01((spec.duration - this.timer) / 0.8);
      lightT = fade * tail * (1 + Math.sin(this.rollPhase * 7) * 0.09);
      flashT = Math.max(0, 0.45 - this.timer * 6);
    } else if (this.phase === 'ending') {
      lightT = Math.max(0, 1 - this.timer / 1.1) * 0.7;
      flashT = 0;
    }

    // The light sits a couple of metres *ahead* of the eye, not on it. Parked
    // on the camera it lit the view model from zero range, blew it to white and
    // gave bloom a full-screen source to smear — which is what washed out the
    // first super capture.
    this.light.position
      .copy(this.ctx.player.eyePosition)
      .addScaledVector(this.ctx.player.aimDirection, 2.6);
    this.light.intensity = spec.lightIntensity * lightT;
    this.light.visible = lightT > 0.001;

    if (reduced) {
      this.flash.visible = false;
      this.flashMaterial.opacity = 0;
    } else {
      // Capped low. A flash that lingers above ~0.3 stops reading as a flash
      // and starts reading as fog over the whole frame.
      const want = Math.min(0.28, flashT * 0.5);
      // Ease the opacity rather than snapping it, so a dropped frame during the
      // wind-up cannot produce a single-frame strobe.
      const cur = this.flashMaterial.opacity;
      this.flashMaterial.opacity = cur + (want - cur) * clamp01(frameDt * 14);
      this.flash.position.copy(cameraPosition);
      this.flash.visible = this.flashMaterial.opacity > 0.004;
    }
  }

  get killCount(): number {
    return this.kills;
  }

  dispose(): void {
    this.cancel();
    this.detach();
    this.flash.geometry.dispose();
    this.flashMaterial.dispose();
    this.light.dispose();
  }
}
