/** Tiny typed pub/sub. Synchronous, allocation-free on emit. */
import type * as THREE from 'three';
import type { DamageInfo, DamageElement, ItemRarity, PlanetId, SurfaceKind } from '@/types';

export interface GameEvents {
  'player:damaged': { amount: number; direction: THREE.Vector3; shieldBroke: boolean };
  'player:died': { killerName: string };
  'player:respawn': void;
  'player:healed': { amount: number };
  'enemy:damaged': DamageInfo & { remaining: number; entityId: number };
  'enemy:killed': {
    entityId: number;
    position: THREE.Vector3;
    score: number;
    precision: boolean;
    name: string;
    element: DamageElement;
  };
  'enemy:shieldBroken': { entityId: number; position: THREE.Vector3; element: DamageElement };
  'weapon:fired': { weaponId: string; ammo: number; magazine: number };
  'weapon:reloaded': { weaponId: string };
  'weapon:swapped': { slot: number; weaponId: string };
  'weapon:emptied': { weaponId: string };
  'ability:used': { id: string; slot: string };
  'ability:ready': { id: string; slot: string };
  'super:ready': void;
  'super:activated': void;
  'super:ended': void;
  'impact:surface': {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    surface: SurfaceKind;
    scale: number;
  };
  'explosion': { point: THREE.Vector3; radius: number; element: DamageElement };
  'loot:pickup': { kind: string; rarity?: ItemRarity };
  'objective:updated': { text: string; progress: number; total: number };
  'objective:completed': { text: string };
  'level:loaded': { id: string };
  'level:cleared': { id: string; score: number };
  // -- campaign -------------------------------------------------------------
  /** A mission has begun. Carries everything the HUD needs to title it. */
  'mission:started': { planet: PlanetId; missionId: string; chapter: number; title: string };
  /**
   * A mission finished. This is the event the whole session loop hangs off:
   * progression records the clear, the results screen opens, and the star map
   * re-evaluates what is unlocked. `level:cleared` remains the encounter
   * director's low-level signal; this is the campaign-level one.
   */
  'mission:completed': {
    planet: PlanetId;
    missionId: string;
    score: number;
    kills: number;
    seconds: number;
    /** First time this mission has ever been finished. */
    firstClear: boolean;
  };
  /** A mission ended without completing — the player died out or withdrew. */
  'mission:failed': { planet: PlanetId; missionId: string };
  /** A new mission or world became available. Drives the star-map badge. */
  'campaign:unlocked': { planet: PlanetId; missionId: string; title: string };
  /** One line of handler traffic. The UI decides whether to queue or interrupt. */
  'briefing:line': { speaker: string; text: string; duration?: number };
  // -- loot ------------------------------------------------------------------
  /** An engram finished decoding into a concrete weapon. */
  'engram:decoded': { uid: string; name: string; rarity: ItemRarity; weaponId: string };
  /** The player changed a weapon slot. WeaponSystem applies it. */
  'loadout:changed': { slot: 0 | 1 | 2; weaponId: string };
  'ship:enter': void;
  'ship:exit': void;
  'ship:travelStarted': { to: PlanetId };
  'ship:arrived': { at: PlanetId };
  'ui:toast': { text: string; sub?: string; rarity?: ItemRarity; duration?: number };
  'ui:subtitle': { speaker: string; text: string; duration?: number };
  'camera:shake': { amount: number; duration?: number; frequency?: number };
  'hitmarker': { precision: boolean; kill: boolean; damage: number };
  /**
   * Combat intensity from the AI director, 0..1. Audio subscribes to decide when
   * the recorded score switches to its combat track; the director never calls
   * into audio directly, so the dependency stays one-way.
   */
  'combat:threat': { level: number; engaged: number };
  'settings:changed': void;
}

type Handler<K extends keyof GameEvents> = (payload: GameEvents[K]) => void;

class Bus {
  private map = new Map<string, Set<Function>>();

  on<K extends keyof GameEvents>(key: K, fn: Handler<K>): () => void {
    let set = this.map.get(key as string);
    if (!set) this.map.set(key as string, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  once<K extends keyof GameEvents>(key: K, fn: Handler<K>): () => void {
    const off = this.on(key, ((p: GameEvents[K]) => {
      off();
      fn(p);
    }) as Handler<K>);
    return off;
  }

  off<K extends keyof GameEvents>(key: K, fn: Handler<K>): void {
    this.map.get(key as string)?.delete(fn);
  }

  emit<K extends keyof GameEvents>(
    key: K,
    ...args: GameEvents[K] extends void ? [] : [GameEvents[K]]
  ): void {
    const set = this.map.get(key as string);
    if (!set || set.size === 0) return;
    const payload = args[0];
    for (const fn of set) {
      try {
        (fn as Function)(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${String(key)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export const events = new Bus();
