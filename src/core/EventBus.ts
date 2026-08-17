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
  'ship:enter': void;
  'ship:exit': void;
  'ship:travelStarted': { to: PlanetId };
  'ship:arrived': { at: PlanetId };
  'ui:toast': { text: string; sub?: string; rarity?: ItemRarity; duration?: number };
  'ui:subtitle': { speaker: string; text: string; duration?: number };
  'camera:shake': { amount: number; duration?: number; frequency?: number };
  'hitmarker': { precision: boolean; kill: boolean; damage: number };
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
