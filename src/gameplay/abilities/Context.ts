/**
 * The service bundle every ability sub-controller is handed.
 *
 * Grenades, melee and supers all need the same six things — the player, the
 * VFX layer, the damage resolver, the status system, the current enemy list and
 * the collision world — plus a couple of callbacks back into the owning
 * `AbilitySystem`. Passing one context object keeps their constructors from
 * turning into eight-argument signatures, and keeps the sub-controllers from
 * reaching into the engine's system registry themselves.
 */
import type * as THREE from 'three';
import type { CollisionWorld, Damageable } from '@/types';
import type { VfxSystem } from '@/gfx/vfx/VfxSystem';
import type { Player } from '../Player';
import type { DamageResolver } from '../Damage';
import type { StatusEffectSystem } from '../StatusEffects';
import type { Subclass } from './Definitions';

export interface AbilityContext {
  readonly player: Player;
  readonly vfx: VfxSystem;
  readonly damage: DamageResolver;
  readonly status: StatusEffectSystem;
  /** Live enemy list. Never mutate it. */
  enemies(): readonly Damageable[];
  collision(): CollisionWorld | null;
  scene(): THREE.Scene | null;
  /** Grant super energy (0..1 of the bar). */
  addSuperEnergy(amount: number): void;
  subclass(): Subclass;
  /** Freeze the world briefly. See `AbilitySystem.hitStop`. */
  hitStop(seconds: number): void;
  /** Simulation time, seconds. */
  readonly elapsed: number;
}
