/**
 * Reptilian Aliens — the Ash Legions of Draco IX.
 *
 * ## Art direction
 *
 * Saurian warriors bred on a volcanic world: heavy, muscular, **digitigrade**,
 * with a counterbalancing tail and a crested skull carried low and forward on a
 * thick neck. Hide is oxblood over charcoal scute; armour is *scavenged* —
 * knapped obsidian slabs lashed to bronze frames, no two pieces from the same
 * war. The one saturated thing on the body is the heat: fissures in the hide
 * glow like cooling lava, and they get **brighter as the unit enrages**, so the
 * player reads a Warbrute's second wind from across the arena.
 *
 * Value contract — every body carries four values before any light touches it:
 * near-black obsidian, dark oxblood hide, mid charcoal scute, bright bronze
 * trim. That is what keeps them legible against Draco's orange sky, where a
 * body built out of one warm material would vanish.
 *
 * ## Silhouette contract (readable as a black shape at 40 m, no nameplate)
 *
 * | unit        | h    | stance                        | the read                            |
 * |-------------|------|-------------------------------|-------------------------------------|
 * | Skirmisher  | 1.95 | deep crouch, tail straight out| bare crested skull, stubby carbine  |
 * | Legionary   | 2.35 | upright, square pauldrons     | slab pauldrons + long plasma rifle  |
 * | Pyroclast   | 2.30 | hunched under a back tank     | twin fuel drums, wide flame nozzle  |
 * | Warbrute    | 3.25 | wide, arms out, low head      | horn crown + two arm cannons + disc |
 * | Ashpriest   | 2.80 | tall, thin, staff held high   | antler crown + brazier on a stave   |
 * | Tyrant      | 8.00 | colossal, forward-leaning     | shoulder mortar breaking the outline|
 *
 * Height, mass distribution and *head carriage* do the work: the Skirmisher's
 * skull is level with its hips, the Ashpriest's is above its shoulders, the
 * Warbrute's is sunk between them. You can tell all six apart in pure black.
 *
 * ## Anatomy that the animator can actually walk
 *
 * Legs are four-span digitigrade chains — `hip → knee → hock → ankle → toe`.
 * The animator's FABRIK path biases alternate joints toward and away from the
 * pole vector, which produces the Z-shaped saurian leg for free; the trailing
 * `ankle → toe` span is the plantar surface, which is what the footstep planner
 * plants. Rest bends put the hip–ankle distance at ~86% of the chain's reach,
 * so there is real compliance at every speed and the feet never slide or
 * straighten into an IK singularity.
 *
 * ## Faction mechanic: solar pressure
 *
 * The Reptilians are the faction that punishes passive play. They do not hold
 * ground and trade — they close, they burn the cover you are hiding behind, and
 * their damage is *area* far more often than it is precision. Every unit has a
 * ≥0.35 s wind-up with a distinct pose (jaw opens, body coils, heat flares) and
 * a bark, so pressure never becomes unfairness.
 *
 * ## Integration seams this module needs from other owners
 *
 * - `bindReptilianSpawner(enemies)` — lets the Ashpriest raise fallen Legionaries
 *   and the Tyrant call its guard. Unbound, both beats degrade gracefully.
 * - `registerReptilianBehaviours(director)` — installs the compiled AI-layer
 *   trees for the units the `AiDirector` drives.
 * - `disposeReptilianEffects()` — releases the shared fire field and the Tyrant's
 *   arena props on level teardown.
 */
import * as THREE from 'three';
import type {
  CollisionWorld,
  DamageInfo,
  Damageable,
  EnemyArchetype,
  FactionId,
  SurfaceKind,
} from '@/types';
import { clamp, clamp01, damp, lerp, smoothstep, TAU } from '@/util/math';
import { settings } from '@/core/Settings';
import { events } from '@/core/EventBus';
import type { HitProxy } from '@/gameplay/Physics';
import type { VfxSystem } from '@/gfx/vfx/VfxSystem';
import { ARCHETYPES, FACTION_ACCENT } from '../Archetypes';
import { DOWN, FORWARD, UP, type ChainRuntime, type Rig, type RigInstance } from '../Rig';
import type { BodyBuilder } from '../BodyBuilder';
import { EnemyManager } from '../EnemyManager';
import {
  action,
  condition,
  parallel,
  selector,
  sequence,
  standardCombatBehaviour,
  type BehaviourContext,
  type BehaviourNode,
  type BodyBuildContext,
  type BuiltBody,
  type EnemyAgent,
  type ProxySpec,
  type SpeciesDefinition,
} from '../EnemyAgent';
import type { AnimationContext, AnimatorTuning } from '../ProceduralAnimator';
import {
  FAILURE,
  RUNNING,
  SUCCESS,
  advanceToRange,
  action as btAction,
  bark as btBark,
  cond as btCond,
  compileTree,
  fail,
  faceTarget,
  guard,
  holdCover,
  holdPosition,
  leaveCover,
  moveToFlank,
  par,
  patrolArea,
  repositionFiring,
  scanArea,
  searchLastKnown,
  sel,
  seq,
  strafeAtRange,
  takeCover,
  telegraph,
  timeout,
  withAttackToken,
  type BehaviorTree,
  type BtContext,
  type BtNode,
} from '@/gameplay/ai/BehaviorTree';
// The ballistic bio/fire field and the FK pose helpers live in `mantis.ts`.
// Both are already general (colour and pool behaviour are constructor
// parameters), and a sixth shared file is outside this module's ownership, so
// the Mantis module is the kit's home and this one imports rather than forking.
import { BioField, attackPose, fkBend, vGet, vSet, type FactionSpawner } from './mantis';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * Faction colour identity. The accent matches `FACTION_ACCENT.reptilian` so
 * shields, dissolve edges, tracers and gibs all agree without a second table.
 */
export const REPTILIAN = {
  accent: FACTION_ACCENT.reptilian,
  /** Oxblood hide — the body's dominant dark value. */
  hide: 0x5c2119,
  /** Paler ventral scute, the only place the hide lightens. */
  belly: 0x8a5236,
  /** Charcoal dorsal scute; the mid value that catches the sun. */
  scute: 0x35302c,
  /** Knapped obsidian plate — near black, glassy, the darkest value. */
  obsidian: 0x17161b,
  /** Scavenged bronze frame and rivets; the one bright value. */
  bronze: 0xb07a34,
  /** Cooling-lava fissures. Brightens on enrage. */
  heat: 0xff5a14,
  /** Full-enrage fissure colour — pushed toward white-hot. */
  heatHot: 0xffb347,
  /** Blood: dark arterial, almost brown until it catches the light. */
  ichor: 0x7d120a,
} as const;

const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Rest position of a bone, as a fresh vector (build-time only). */
function at(rig: Rig, name: string): THREE.Vector3 {
  return rig.restPosition(name, new THREE.Vector3());
}

/** Rest position of the tip past the last bone of a chain. */
function tipOf(rig: Rig, chainId: string): THREE.Vector3 {
  const c = rig.chainById(chainId);
  return c ? c.restTip.clone() : new THREE.Vector3();
}

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------

function reptArchetype(
  o: Partial<EnemyArchetype> & Pick<EnemyArchetype, 'id' | 'rank' | 'displayName'>,
): EnemyArchetype {
  return {
    faction: 'reptilian',
    health: 100,
    shield: 0,
    shieldElement: null,
    moveSpeed: 3.4,
    sprintSpeed: 6,
    preferredRange: 14,
    eyeHeight: 1.9,
    capsuleRadius: 0.42,
    capsuleHalfHeight: 0.78,
    attackDamage: 10,
    attackInterval: 0.9,
    accuracy: 0.04,
    aggression: 0.85,
    caution: 0.25,
    flying: false,
    score: 20,
    abilities: [],
    ...o,
  };
}

/**
 * Every Reptilian unit, with every `EnemyArchetype` field filled.
 *
 * Tuning intent: a Skirmisher dies to four or five auto-rifle body shots (or
 * two precision), a Legionary needs most of a magazine once its solar shield is
 * up, and the Warbrute is a genuine encounter — 780 effective HP, a shield that
 * only strips fast to solar, and an enrage that removes the option of trading.
 */
export const REPT_ARCHETYPES: Record<string, EnemyArchetype> = {
  rept_skirmisher: reptArchetype({
    id: 'rept_skirmisher',
    rank: 'minor',
    displayName: 'Ash Skirmisher',
    health: 72,
    moveSpeed: 4.6,
    sprintSpeed: 7.8,
    preferredRange: 11,
    eyeHeight: 1.62,
    capsuleRadius: 0.34,
    capsuleHalfHeight: 0.62,
    attackDamage: 7,
    attackInterval: 0.55,
    accuracy: 0.062,
    aggression: 0.95,
    caution: 0.15,
    score: 12,
    abilities: ['fireSpit', 'flank'],
  }),
  rept_legionary: reptArchetype({
    id: 'rept_legionary',
    rank: 'standard',
    displayName: 'Ash Legionary',
    health: 165,
    shield: 55,
    shieldElement: 'solar',
    moveSpeed: 3.3,
    sprintSpeed: 5.6,
    preferredRange: 17,
    eyeHeight: 2.05,
    capsuleRadius: 0.44,
    capsuleHalfHeight: 0.82,
    attackDamage: 11,
    attackInterval: 0.22,
    accuracy: 0.034,
    aggression: 0.7,
    caution: 0.45,
    score: 30,
    abilities: ['plasmaRifle', 'incendiaryCharge'],
  }),
  rept_pyroclast: reptArchetype({
    id: 'rept_pyroclast',
    rank: 'standard',
    displayName: 'Pyroclast',
    health: 210,
    shield: 0,
    moveSpeed: 3.1,
    sprintSpeed: 5.4,
    // It has to be inside 9 m to threaten anything, and that is the whole unit:
    // it forces the player to break line of sight or kill it while it closes.
    preferredRange: 8,
    eyeHeight: 2,
    capsuleRadius: 0.5,
    capsuleHalfHeight: 0.8,
    attackDamage: 9,
    attackInterval: 0.12,
    accuracy: 0.09,
    aggression: 0.95,
    caution: 0.2,
    score: 38,
    abilities: ['flamethrower', 'fuelTank'],
  }),
  rept_warbrute: reptArchetype({
    id: 'rept_warbrute',
    rank: 'elite',
    displayName: 'Warbrute',
    health: 520,
    shield: 260,
    shieldElement: 'solar',
    moveSpeed: 3,
    sprintSpeed: 6.8,
    preferredRange: 13,
    eyeHeight: 2.85,
    capsuleRadius: 0.72,
    capsuleHalfHeight: 1.1,
    attackDamage: 19,
    attackInterval: 0.3,
    accuracy: 0.03,
    aggression: 0.9,
    caution: 0.2,
    score: 110,
    abilities: ['dualCannon', 'shoulderCharge', 'enrage'],
  }),
  rept_ashpriest: reptArchetype({
    id: 'rept_ashpriest',
    rank: 'champion',
    displayName: 'Ashpriest',
    health: 980,
    shield: 420,
    shieldElement: 'solar',
    moveSpeed: 2.7,
    sprintSpeed: 4.6,
    preferredRange: 21,
    eyeHeight: 2.5,
    capsuleRadius: 0.55,
    capsuleHalfHeight: 0.98,
    attackDamage: 26,
    attackInterval: 1.5,
    accuracy: 0.028,
    aggression: 0.5,
    caution: 0.55,
    score: 260,
    abilities: ['lavaGeyser', 'fireBarrier', 'raiseDead'],
  }),
  rept_tyrant: reptArchetype({
    id: 'rept_tyrant',
    rank: 'boss',
    displayName: 'Tyrant Vorrakh',
    health: 6200,
    shield: 2000,
    shieldElement: 'solar',
    moveSpeed: 2.6,
    sprintSpeed: 5.4,
    preferredRange: 16,
    eyeHeight: 6.4,
    capsuleRadius: 1.5,
    capsuleHalfHeight: 2.1,
    attackDamage: 46,
    attackInterval: 0.8,
    accuracy: 0.025,
    aggression: 0.9,
    caution: 0.1,
    score: 1400,
    abilities: ['shoulderMortar', 'sunderCharge', 'lavaFloor', 'mortarClub'],
  }),
};

/**
 * The shared catalogue in `Archetypes.ts` ships four Reptilian entries under
 * older names. Registering the same bodies against those ids keeps existing
 * level scripts and the encounter director working while the roster above is
 * the one the design brief names.
 */
const REPT_ALIASES: Array<[catalogueId: string, unitId: string]> = [
  ['reptilian.skink', 'rept_skirmisher'],
  ['reptilian.saurian', 'rept_legionary'],
  ['reptilian.warlord', 'rept_warbrute'],
  ['reptilian.tyrant', 'rept_ashpriest'],
];

// ---------------------------------------------------------------------------
// Shared runtime effects
// ---------------------------------------------------------------------------

/**
 * The faction's fire. Lobbed incendiary charges, mortar shells and lava geysers
 * all fly through this one pooled field, so forty burning things on screen cost
 * two instanced draw calls and no allocation.
 */
export const REPT_FIRE = new BioField(0xff6a1e, 'reptilian-fire');

let spawner: FactionSpawner | null = null;

/**
 * Give the Ashpriest and the Tyrant a way to put bodies on the field. The level
 * owner calls `bindReptilianSpawner(enemies)` after `enemies.bindLevel(level)`.
 * Unbound, the Ashpriest's revive beat becomes an extra geyser and the Tyrant
 * fights alone — both encounters still work, they are just poorer.
 */
export function bindReptilianSpawner(host: FactionSpawner | null): void {
  spawner = host;
}

/**
 * Where Legionaries have recently fallen. The Ashpriest's revive needs corpse
 * positions and nothing in the enemy framework exposes them, so the module
 * subscribes to the kill event once at load. Four slots, overwritten oldest
 * first: a priest that could resurrect an entire wave is not a fight, it is a
 * stalemate.
 */
const CORPSES: THREE.Vector3[] = [
  new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
];
/** Simulation clock at each death. `-1e9` marks an empty slot. */
const CORPSE_T = [-1e9, -1e9, -1e9, -1e9];
let corpseCursor = 0;
/**
 * Simulation time, refreshed by the always-on lane of every Reptilian's
 * fallback tree. The event bus does not carry a timestamp and this module must
 * not call `performance.now()` for gameplay timing.
 */
let reptClock = 0;

events.on('enemy:killed', (e) => {
  if (e.name !== REPT_ARCHETYPES.rept_legionary.displayName) return;
  CORPSES[corpseCursor].copy(e.position);
  CORPSE_T[corpseCursor] = reptClock;
  corpseCursor = (corpseCursor + 1) % CORPSES.length;
});

/** Claim the freshest corpse under 22 s old within `radius`. Consumes it. */
function claimCorpse(from: THREE.Vector3, radius: number, out: THREE.Vector3): boolean {
  let best = -1;
  let bestT = reptClock - 22;
  for (let i = 0; i < CORPSES.length; i++) {
    if (CORPSE_T[i] < bestT) continue;
    if (CORPSES[i].distanceTo(from) > radius) continue;
    bestT = CORPSE_T[i];
    best = i;
  }
  if (best < 0) return false;
  out.copy(CORPSES[best]);
  CORPSE_T[best] = -1e9;
  return true;
}

interface ProxyHostLike {
  addProxy(p: HitProxy): HitProxy;
  removeProxiesFor(entityId: number): void;
}

/** `BvhCollisionWorld` exposes proxy registration; a stub world may not. */
function proxyHost(world: CollisionWorld | null): ProxyHostLike | null {
  const h = world as unknown as Partial<ProxyHostLike> | null;
  return h && typeof h.addProxy === 'function' && typeof h.removeProxiesFor === 'function'
    ? (h as ProxyHostLike)
    : null;
}

/** Entity ids for the non-agent damageables this module owns. */
let nextPropId = 740000;

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _qA = new THREE.Quaternion();
const _mA = new THREE.Matrix4();
const _cA = new THREE.Color();

const _reptDamage: DamageInfo = {
  amount: 0,
  element: 'solar',
  region: 'body',
  precision: false,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  direction: new THREE.Vector3(0, 0, -1),
  sourceId: 0,
  splash: true,
};

/** Merge a throwaway list of prop geometries. Local props only, never bodies. */
function mergeSimple(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vTotal = 0;
  let iTotal = 0;
  for (const g of list) {
    vTotal += g.getAttribute('position').count;
    const idx = g.getIndex();
    iTotal += idx ? idx.count : g.getAttribute('position').count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nor = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const out = new THREE.BufferGeometry();
  const indices: number[] = [];
  let vo = 0;
  for (const g of list) {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    const t = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    pos.set(p.array as Float32Array, vo * 3);
    nor.set(n.array as Float32Array, vo * 3);
    if (t) uv.set(t.array as Float32Array, vo * 2);
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) indices.push(ix.getX(i) + vo);
    else for (let i = 0; i < p.count; i++) indices.push(i + vo);
    vo += p.count;
    g.dispose();
  }
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(indices);
  out.computeBoundingSphere();
  return out;
}

/**
 * The Ashpriest's fire barrier: a curtain of flame that is a **real** blocker.
 * Four capsule hit proxies across its face are registered with the collision
 * world, so the player's rounds burn up in it and damage *the wall* rather than
 * the priest behind it. It is solar, so solar weapons tear it down fast and
 * kinetic barely scratches it — flank it, or bring the right element. Those are
 * the only two answers, which is the decision the unit exists to force.
 */
class FireBarrier implements Damageable {
  readonly entityId = nextPropId++;
  health = 520;
  maxHealth = 520;
  shield = 0;
  maxShield = 0;
  readonly group = new THREE.Group();
  active = false;
  /** Seconds until it can be raised again after being broken or expiring. */
  cooldown = 0;
  life = 0;

  private proxies: HitProxy[] = [];
  private host: ProxyHostLike | null = null;
  private vfx: VfxSystem;
  private sheet: THREE.Mesh;
  private embers: THREE.Mesh;
  private posts: THREE.Mesh;
  private sheetMat: THREE.MeshBasicMaterial;
  private emberMat: THREE.MeshBasicMaterial;
  private postMat: THREE.Material;
  private flash = 0;
  private readonly width: number;
  private readonly height: number;

  constructor(vfx: VfxSystem, width: number, height: number) {
    this.vfx = vfx;
    this.width = width;
    this.height = height;
    const mats = vfx.materials;
    this.postMat = mats.get('obsidian');
    this.sheetMat = mats.additive(0xff6a18, 0.4);
    this.sheetMat.side = THREE.DoubleSide;
    this.sheetMat.depthWrite = false;
    this.emberMat = mats.additive(0xffc061, 0.7);
    this.emberMat.side = THREE.DoubleSide;
    this.emberMat.depthWrite = false;

    // Three offset sheets rather than one: a single quad reads as a decal, and
    // parallax between layers is what sells depth in a flame curtain.
    const sheets: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.CylinderGeometry(
        4.2, 4.2, height * (1 - i * 0.13), 16, 3, true,
        -width / 8.4, width / 4.2,
      );
      g.translate(0, i * height * 0.05, -4.2 + i * 0.09);
      sheets.push(g);
    }
    this.sheet = new THREE.Mesh(mergeSimple(sheets), this.sheetMat);
    this.sheet.renderOrder = 6;
    this.sheet.frustumCulled = false;
    this.group.add(this.sheet);

    const tongues: THREE.BufferGeometry[] = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n - 0.5) * width;
      const h = height * (0.34 + ((i * 7) % 5) * 0.07);
      const g = new THREE.ConeGeometry(width / (n * 1.7), h, 5, 1, true);
      g.translate(x, -height * 0.5 + h * 0.5, 0.03);
      tongues.push(g);
    }
    this.embers = new THREE.Mesh(mergeSimple(tongues), this.emberMat);
    this.embers.renderOrder = 7;
    this.embers.frustumCulled = false;
    this.group.add(this.embers);

    const bars: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      const g = new THREE.CylinderGeometry(0.11, 0.16, height + 0.3, 6);
      g.translate((sx * width) / 2, 0, 0);
      bars.push(g);
      const cap = new THREE.ConeGeometry(0.17, 0.34, 6);
      cap.translate((sx * width) / 2, height * 0.5 + 0.3, 0);
      bars.push(cap);
    }
    this.posts = new THREE.Mesh(mergeSimple(bars), this.postMat);
    this.posts.castShadow = true;
    this.posts.frustumCulled = false;
    this.group.add(this.posts);

    this.group.visible = false;
    const count = 4;
    for (let i = 0; i < count; i++) {
      this.proxies.push({
        damageable: this,
        region: 'body',
        offset: new THREE.Vector3((i / (count - 1) - 0.5) * width * 0.92, 0, 0),
        radius: width / (count * 1.5),
        halfHeight: height * 0.4,
        multiplier: 0.35,
        enabled: false,
        world: new THREE.Vector3(),
      });
    }
  }

  get isDead(): boolean {
    return !this.active;
  }

  getWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.setFromMatrixPosition(this.group.matrixWorld);
  }

  applyDamage(info: DamageInfo): number {
    if (!this.active) return 0;
    const mult = info.element === 'solar' ? 2.6 : info.element === 'kinetic' ? 0.55 : 1;
    const dealt = Math.min(this.health, info.amount * mult);
    this.health -= dealt;
    this.flash = 1;
    this.vfx.impact(info.point, info.normal, 'energy', 0.5);
    if (this.health <= 0) this.collapse(info.point);
    return dealt;
  }

  /** Raise the curtain between `from` and `toward`, 3 m out from the caster. */
  raise(from: THREE.Vector3, toward: THREE.Vector3, scene: THREE.Object3D | null, world: CollisionWorld | null): void {
    if (this.active || this.cooldown > 0) return;
    this.active = true;
    this.life = 9;
    this.health = this.maxHealth;
    this.group.visible = true;
    _p0.subVectors(toward, from);
    _p0.y = 0;
    if (_p0.lengthSq() < 1e-4) _p0.set(0, 0, -1);
    _p0.normalize();
    this.group.position.copy(from).addScaledVector(_p0, 3.2);
    this.group.position.y += this.height * 0.5 - 0.1;
    // Bodies face along local -Z, so the curtain's face must too.
    this.group.quaternion.setFromAxisAngle(UP, Math.atan2(-_p0.x, -_p0.z));
    this.group.scale.set(1, 0.04, 1);
    if (scene && this.group.parent !== scene) scene.add(this.group);
    this.host = proxyHost(world);
    if (this.host) {
      for (const p of this.proxies) {
        p.enabled = true;
        this.host.addProxy(p);
      }
    }
    this.vfx.elementalBurst(this.group.position, 'solar', 1.6);
  }

  collapse(point: THREE.Vector3): void {
    if (!this.active) return;
    this.active = false;
    this.cooldown = 14;
    this.group.visible = false;
    if (this.host) this.host.removeProxiesFor(this.entityId);
    for (const p of this.proxies) p.enabled = false;
    this.host = null;
    this.vfx.explosion(point, 2.4, 'solar');
  }

  /** Per-behaviour-tick maintenance: grow, burn, damage anything standing in it. */
  step(ctx: BehaviourContext): void {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - ctx.dt);
    if (!this.active) return;
    this.life -= ctx.dt;
    if (this.life <= 0) {
      this.group.getWorldPosition(_p1);
      this.collapse(_p1);
      return;
    }
    // Grow on a spring so it erupts rather than pops into existence.
    this.group.scale.y = damp(this.group.scale.y, 1, 9, ctx.dt);
    this.flash = damp(this.flash, 0, 6, ctx.dt);
    const t = ctx.elapsed;
    this.sheet.scale.x = 1 + Math.sin(t * 4.3) * 0.03;
    this.embers.scale.y = 1 + Math.sin(t * 7.1) * 0.12;
    this.sheetMat.opacity = 0.34 + this.flash * 0.4 + Math.sin(t * 9) * 0.04;
    this.emberMat.opacity = 0.6 + Math.sin(t * 13) * 0.1;

    // Burn anyone who walks into it.
    if (!ctx.targetValid || !ctx.target || ctx.target.isDead) return;
    ctx.target.getWorldPosition(_p1);
    this.group.getWorldPosition(_p2);
    _p3.copy(_p1).sub(_p2);
    _p3.applyQuaternion(_qA.copy(this.group.quaternion).invert());
    if (Math.abs(_p3.x) > this.width * 0.55 || Math.abs(_p3.z) > 0.9 || Math.abs(_p3.y) > this.height * 0.6) return;
    _reptDamage.amount = 22 * ctx.dt;
    _reptDamage.element = 'solar';
    _reptDamage.point.copy(_p1);
    _reptDamage.direction.set(0, 0, -1).applyQuaternion(this.group.quaternion);
    _reptDamage.normal.copy(_reptDamage.direction).negate();
    _reptDamage.sourceId = this.entityId;
    ctx.target.applyDamage(_reptDamage);
  }

  dispose(): void {
    if (this.host) this.host.removeProxiesFor(this.entityId);
    this.host = null;
    this.active = false;
    this.group.removeFromParent();
    this.sheet.geometry.dispose();
    this.embers.geometry.dispose();
    this.posts.geometry.dispose();
    this.sheetMat.dispose();
    this.emberMat.dispose();
  }
}

const barriers = new WeakMap<EnemyAgent, FireBarrier>();

function barrierFor(agent: EnemyAgent, vfx: VfxSystem): FireBarrier {
  let b = barriers.get(agent);
  if (!b) {
    b = new FireBarrier(vfx, 7.5, 3.4);
    barriers.set(agent, b);
    liveBarriers.push(b);
  }
  return b;
}

const liveBarriers: FireBarrier[] = [];

/**
 * The Tyrant's arena. Phase three floods the fighting floor with lava and
 * pushes six obsidian columns up out of it; standing on the floor cooks the
 * player, so the fight becomes a platforming problem with a boss on it.
 *
 * The columns are registered as *static* collision once they finish rising —
 * `BvhCollisionWorld` has no static-removal API, which is correct for a world
 * whose statics are level geometry, so they are deliberately one-way: they rise
 * once per encounter and stay for the rest of the level.
 */
class LavaArena {
  readonly group = new THREE.Group();
  active = false;
  private risen = false;
  private rise = 0;
  private columns: THREE.Mesh[] = [];
  private lava: THREE.Mesh | null = null;
  private lavaMat: THREE.MeshBasicMaterial | null = null;
  private colGeo: THREE.BufferGeometry | null = null;
  private centre = new THREE.Vector3();
  private radius = 17;
  private tick = 0;
  private vfx: VfxSystem | null = null;

  begin(centre: THREE.Vector3, scene: THREE.Object3D | null, vfx: VfxSystem): void {
    if (this.active) return;
    this.active = true;
    this.vfx = vfx;
    this.centre.copy(centre);
    this.rise = 0;
    this.risen = false;

    if (!this.lava) {
      const g = new THREE.RingGeometry(3.4, this.radius, 48, 3);
      g.rotateX(-Math.PI / 2);
      this.lavaMat = vfx.materials.additive(0xff4a12, 0.5);
      this.lavaMat.side = THREE.DoubleSide;
      this.lavaMat.depthWrite = false;
      this.lava = new THREE.Mesh(g, this.lavaMat);
      this.lava.renderOrder = 4;
      this.lava.frustumCulled = false;
      this.group.add(this.lava);
    }
    if (this.columns.length === 0) {
      // Hexagonal capped columns: basalt reads as basalt because it is faceted
      // and vertical, not because of a texture.
      this.colGeo = new THREE.CylinderGeometry(1.5, 1.75, 5.2, 6, 1);
      const mat = vfx.materials.get('obsidian');
      const count = Math.max(4, Math.round(6 * clamp(settings.profile.terrainDetail, 0.6, 1.3)));
      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU + 0.4;
        const m = new THREE.Mesh(this.colGeo, mat);
        const r = this.radius * (i % 2 === 0 ? 0.5 : 0.78);
        m.position.set(Math.sin(a) * r, -2.6, Math.cos(a) * r);
        m.rotation.y = a * 1.7;
        m.castShadow = true;
        m.receiveShadow = true;
        this.columns.push(m);
        this.group.add(m);
      }
    }
    this.group.position.copy(centre);
    this.group.position.y += 0.06;
    if (scene && this.group.parent !== scene) scene.add(this.group);
    this.group.visible = true;
    vfx.explosion(centre, 6, 'solar');
  }

  step(ctx: BehaviourContext): void {
    if (!this.active || !this.vfx) return;
    this.rise = Math.min(1, this.rise + ctx.dt * 0.5);
    const lift = smoothstep(this.rise);
    for (let i = 0; i < this.columns.length; i++) {
      const c = this.columns[i];
      c.position.y = lerp(-2.6, 0.85 + (i % 3) * 0.45, lift);
    }
    if (this.lavaMat) this.lavaMat.opacity = 0.34 + Math.sin(ctx.elapsed * 2.1) * 0.08;

    if (!this.risen && this.rise >= 1) {
      this.risen = true;
      const host = ctx.collision as unknown as
        | { addMesh?: (m: THREE.Mesh, s: SurfaceKind) => void }
        | null;
      if (host && typeof host.addMesh === 'function') {
        for (const c of this.columns) {
          c.updateWorldMatrix(true, false);
          host.addMesh(c, 'rock');
        }
      }
    }

    // Cook anything standing on the floor rather than on a column.
    this.tick -= ctx.dt;
    if (this.tick > 0) return;
    this.tick = 0.35;
    if (!ctx.targetValid || !ctx.target || ctx.target.isDead) return;
    ctx.target.getWorldPosition(_p1);
    const dx = _p1.x - this.centre.x;
    const dz = _p1.z - this.centre.z;
    const d = Math.hypot(dx, dz);
    if (d < 3.4 || d > this.radius) return;
    if (_p1.y > this.centre.y + 1.4) return;
    _reptDamage.amount = 30 * 0.35 * lift;
    _reptDamage.element = 'solar';
    _reptDamage.point.copy(_p1);
    _reptDamage.normal.set(0, 1, 0);
    _reptDamage.direction.set(0, -1, 0);
    _reptDamage.sourceId = 0;
    ctx.target.applyDamage(_reptDamage);
    this.vfx.elementalBurst(_p1, 'solar', 0.5);
  }

  dispose(): void {
    this.active = false;
    this.group.removeFromParent();
    // Every column shares `colGeo`, which is disposed once below.
    this.columns.length = 0;
    this.colGeo?.dispose();
    this.colGeo = null;
    this.lava?.geometry.dispose();
    this.lavaMat?.dispose();
    this.lava = null;
    this.lavaMat = null;
  }
}

/** One arena per level; the Tyrant is a solo encounter by construction. */
const ARENA = new LavaArena();

/** Release the faction's shared props and pools. Levels call this on teardown. */
export function disposeReptilianEffects(): void {
  REPT_FIRE.dispose();
  ARENA.dispose();
  for (const b of liveBarriers) b.dispose();
  liveBarriers.length = 0;
  for (let i = 0; i < CORPSE_T.length; i++) CORPSE_T[i] = -1e9;
}

// ---------------------------------------------------------------------------
// Body kit
// ---------------------------------------------------------------------------

/**
 * Everything that varies between the six saurians. Written as absolute metres
 * rather than as a scale factor times a base, because a Warbrute is not a big
 * Legionary — its hips are wider *relative* to its legs, its neck is shorter,
 * and its skull sits lower. `saurPlan()` produces a proportionally scaled
 * starting point which each unit then overrides where it should differ.
 */
interface SaurPlan {
  id: string;
  /** Authored standing height, metres. Feeds shields and camera framing. */
  height: number;
  /** Hip joint height above the ground at rest. */
  hipY: number;
  hipWidth: number;
  /** femur, tibia, metatarsus, plantar (ankle→toe), toe tip extent. */
  legs: [number, number, number, number, number];
  legBend: [number, number, number, number];
  /** Femur radius; everything else in the leg derives from it. */
  legR: number;
  /** hips→lumbar, lumbar→chest, chest→neck, neck→head, head→snout tip. */
  spine: [number, number, number, number, number];
  spineBend: [number, number, number, number, number];
  /** Chest half-width. Drives the torso loft and the pauldron placement. */
  torsoR: number;
  shoulderW: number;
  /** upper arm, forearm, hand. */
  arms: [number, number, number];
  armR: number;
  /** Five tail spans, base → tip. */
  tail: [number, number, number, number, number];
  tailR: number;
  /** Skull length; the snout is `skull * 0.62`. */
  skull: number;
  /** Obsidian plating is expensive in draw calls; minors go without. */
  useObsidian: boolean;
  crest: 'ridge' | 'swept' | 'crown' | 'antler' | 'horn';
  /** Number of dorsal scute spines along the back. */
  scutes: number;
  tuning: Partial<AnimatorTuning>;
}

/** Base proportions, at the Legionary's 2.35 m. `k` scales the whole frame. */
function saurPlan(id: string, k: number, o: Partial<SaurPlan> = {}): SaurPlan {
  const base: SaurPlan = {
    id,
    height: 2.35 * k,
    hipY: 1.35 * k,
    hipWidth: 0.21 * k,
    legs: [0.52 * k, 0.5 * k, 0.34 * k, 0.2 * k, 0.13 * k],
    legBend: [0.62, -1.05, 0.92, 1.2],
    legR: 0.145 * k,
    spine: [0.26 * k, 0.32 * k, 0.2 * k, 0.22 * k, 0.34 * k],
    spineBend: [0.34, 0.06, -0.18, 0.3, 0.83],
    torsoR: 0.28 * k,
    shoulderW: 0.3 * k,
    arms: [0.36 * k, 0.33 * k, 0.15 * k],
    armR: 0.095 * k,
    tail: [0.3 * k, 0.28 * k, 0.25 * k, 0.21 * k, 0.16 * k],
    tailR: 0.13 * k,
    skull: 0.34 * k,
    useObsidian: true,
    crest: 'ridge',
    scutes: 7,
    tuning: {},
  };
  return { ...base, ...o };
}

/** Rest-pose anchors the per-unit detail hooks attach their kit to. */
interface SaurAnchors {
  plan: SaurPlan;
  hips: THREE.Vector3;
  lumbar: THREE.Vector3;
  chest: THREE.Vector3;
  neck: THREE.Vector3;
  head: THREE.Vector3;
  snout: THREE.Vector3;
  /** Forward unit vector in body space (bodies face local -Z). */
  fwd: THREE.Vector3;
  shoulder: [THREE.Vector3, THREE.Vector3];
  wrist: [THREE.Vector3, THREE.Vector3];
  hand: [THREE.Vector3, THREE.Vector3];
  knee: [THREE.Vector3, THREE.Vector3];
  tailBase: THREE.Vector3;
  proxies: ProxySpec[];
}

/**
 * Five materials, four values plus the glow. A body made from one material is a
 * brown smear at 20 m no matter how good its normal map is: the near-black
 * obsidian, dark oxblood hide, mid charcoal scute and bright bronze are what
 * carve the armour out of the silhouette, and the heat fissures are the only
 * thing allowed to be saturated.
 *
 * The library authors albedo physically, and vertex/diffuse tints multiply in
 * linear space, so tints above 1 are how a recipe gets *lifted* to the value
 * this faction needs without throwing away its baked detail. `repeat` below 1
 * enlarges the pattern — at 1:1 the scale pattern was 2 cm across and the whole
 * body read as sandpaper rather than as hide.
 */
function reptilianMaterials(b: BodyBuilder, plan: SaurPlan): void {
  const hide = b.material('hide', 'flesh', { roughness: 1.25, metalness: 0, repeat: 0.55 });
  // Flesh's recipe is a warm mid brown; red is held near unity and green/blue
  // crushed hard, which is what turns it oxblood instead of sunburnt.
  hide.color.setRGB(1.0, 0.34, 0.26);
  hide.normalScale.setScalar(0.85);
  hide.envMapIntensity = 0.35;

  const scute = b.material('scute', 'reptilianStone', { roughness: 1.1, metalness: 0.05, repeat: 0.45 });
  scute.color.setRGB(0.72, 0.62, 0.55);
  scute.normalScale.setScalar(1.0);
  scute.envMapIntensity = 0.5;

  const bronze = b.material('bronze', 'rustedSteel', { roughness: 0.82, metalness: 0.95, repeat: 0.5 });
  bronze.color.setRGB(1.55, 1.02, 0.48);
  bronze.normalScale.setScalar(0.55);
  bronze.envMapIntensity = 0.9;

  if (plan.useObsidian) {
    const obs = b.material('obsid', 'obsidian', { roughness: 0.62, metalness: 0.85, repeat: 0.4 });
    obs.color.setRGB(0.55, 0.5, 0.6);
    obs.normalScale.setScalar(0.9);
    obs.envMapIntensity = 1.25;
  }

  b.emissive('heat', REPTILIAN.heat, 3.2);
}

/** Which material key an obsidian-plated unit uses, with a fallback for minors. */
function plateKey(plan: SaurPlan): string {
  return plan.useObsidian ? 'obsid' : 'scute';
}

/**
 * A heat fissure: a thin faceted sliver of emissive laid just proud of the
 * hide. Cracks are what stop a dark body from becoming a hole in the frame, and
 * they are the read the player uses to judge how enraged something is.
 */
function fissure(
  b: BodyBuilder,
  from: THREE.Vector3,
  to: THREE.Vector3,
  width: number,
  axis: THREE.Vector3,
): void {
  b.add('heat', b.segment({
    from,
    to,
    r0: width * 0.35,
    r1: width,
    bulge: 1.5,
    flatten: 0.22,
    sides: 4,
    steps: 5,
    faceted: true,
    bend: width * 1.4,
    bendAxis: axis,
    color: REPTILIAN.heat,
    colorTip: REPTILIAN.heatHot,
  }));
}

/**
 * A saurian skull: long box braincase, a deep tapering snout, a hinged lower
 * jaw on its own bone, brow ridges, slit-pupil eyes and a full row of teeth.
 * The jaw is a `generic` chain so the base animation pass leaves it alone and
 * `reptAnimate` can open it for the roar that telegraphs every heavy attack.
 */
function addSkull(ctx: BodyBuildContext, plan: SaurPlan, head: THREE.Vector3, snout: THREE.Vector3): void {
  const b = ctx.builder;
  // Transverse unit. The skull's *length* is `plan.skull`; everything across
  // and above it is expressed in `k`, so a wider unit is wider everywhere.
  const k = plan.skull * 1.2;
  const fwd = new THREE.Vector3().subVectors(snout, head).normalize();
  const up = new THREE.Vector3(0, 1, 0).addScaledVector(fwd, -fwd.y).normalize();
  const side = new THREE.Vector3().crossVectors(up, fwd).normalize();
  const L = head.distanceTo(snout);
  const pk = plateKey(plan);

  const P = (f: number, u: number, s: number): THREE.Vector3 =>
    head.clone().addScaledVector(fwd, f).addScaledVector(up, u).addScaledVector(side, s);

  // Braincase → muzzle, in two lofts so the profile breaks at the eye socket
  // instead of running as one smooth cone (which reads as a beak).
  b.add('hide', b.segment({
    from: P(-0.18 * L, 0.02 * L, 0),
    to: P(0.34 * L, 0.03 * L, 0),
    r0: 0.30 * k, r1: 0.26 * k,
    flatten: 0.86, bulge: 1.1, sides: 10,
    color: REPTILIAN.hide,
  }));
  b.add('hide', b.segment({
    from: P(0.3 * L, 0.03 * L, 0),
    to: P(1.02 * L, -0.06 * L, 0),
    r0: 0.25 * k, r1: 0.115 * k,
    flatten: 0.78, sides: 9,
    color: REPTILIAN.hide, colorTip: REPTILIAN.belly,
  }));
  // Dorsal skull plate: the hard read that separates a saurian from a lizard.
  b.add('scute', b.carapace({
    centre: P(0.24 * L, 0.19 * k, 0),
    radius: 0.24 * k, height: 0.13 * k, length: 1.75,
    ridges: 4, ridgeDepth: 0.12, segments: 10,
    direction: up.clone().addScaledVector(fwd, 0.22).normalize(),
    color: REPTILIAN.scute,
  }));

  // Lower jaw. Bone is added by the caller; the geometry is authored around it.
  b.add('hide', b.segment({
    from: P(0.08 * L, -0.3 * k, 0),
    to: P(0.95 * L, -0.35 * k, 0),
    r0: 0.2 * k, r1: 0.1 * k,
    flatten: 0.86, sides: 8,
    color: REPTILIAN.belly,
  }));
  // Jaw muscle bulge behind the hinge — the mass that makes the bite credible.
  b.add('hide', b.segment({
    from: P(-0.06 * L, -0.14 * k, 0),
    to: P(0.3 * L, -0.24 * k, 0),
    r0: 0.16 * k, r1: 0.19 * k, bulge: 1.15,
    flatten: 0.7, sides: 8,
    color: REPTILIAN.hide,
  }));

  // Teeth: a row per jaw, alternating length so the bite reads as a bite.
  const teeth = Math.max(3, Math.round(5 * clamp(ctx.detail, 0.6, 1.2)));
  for (let i = 0; i < teeth; i++) {
    const t = 0.34 + (i / (teeth - 1)) * 0.6;
    const big = i % 2 === 0 ? 1.35 : 0.85;
    for (const s of [-1, 1] as const) {
      b.add('scute', b.spine({
        base: P(t * L, -0.13 * k, s * (0.2 - t * 0.1) * k),
        direction: up.clone().negate().addScaledVector(fwd, 0.12),
        length: 0.11 * k * big, radius: 0.028 * k * big,
        curve: 0.012 * k, sharpness: 1.7,
        color: 0xd8cfc0, colorTip: 0xfff6e8,
      }));
      b.add('scute', b.spine({
        base: P((t + 0.03) * L, -0.29 * k, s * (0.17 - t * 0.08) * k),
        direction: up.clone().addScaledVector(fwd, 0.1),
        length: 0.085 * k * big, radius: 0.024 * k * big,
        curve: 0.01 * k, sharpness: 1.7,
        color: 0xd8cfc0, colorTip: 0xfff6e8,
      }));
    }
  }

  // Eyes: forward-facing (predator), deep under a brow, with a vertical slit.
  for (const s of [-1, 1] as const) {
    const eye = P(0.4 * L, 0.09 * k, s * 0.2 * k);
    const nrm = fwd.clone().multiplyScalar(0.55).addScaledVector(side, s * 0.78).addScaledVector(up, 0.2).normalize();
    b.add('heat', b.lens({
      centre: eye, normal: nrm, radius: 0.062 * k, bulge: 0.62, segments: 10,
      color: 0xffb733, coreColor: 0xfff0c8,
    }));
    b.add(pk, b.segment({
      from: eye.clone().addScaledVector(nrm, 0.03 * k).addScaledVector(up, 0.055 * k),
      to: eye.clone().addScaledVector(nrm, 0.03 * k).addScaledVector(up, -0.055 * k),
      r0: 0.012 * k, r1: 0.012 * k, flatten: 0.35, sides: 4, faceted: true,
      color: 0x0a0708,
    }));
    // Brow ridge over the socket — the scowl that makes it read as hostile.
    b.add('scute', b.spine({
      base: P(0.2 * L, 0.16 * k, s * 0.21 * k),
      direction: fwd.clone().multiplyScalar(0.86).addScaledVector(side, s * 0.34).addScaledVector(up, 0.32),
      length: 0.3 * k, radius: 0.055 * k, curve: 0.05 * k, sharpness: 1.15,
      color: REPTILIAN.scute,
    }));
    // Heat-venting nostril slit.
    b.add('heat', b.lens({
      centre: P(0.9 * L, 0.02 * k, s * 0.09 * k),
      normal: fwd.clone().multiplyScalar(0.6).addScaledVector(side, s * 0.7).addScaledVector(up, 0.3).normalize(),
      radius: 0.026 * k, bulge: 0.3, segments: 6,
      color: REPTILIAN.heat, coreColor: REPTILIAN.heatHot,
    }));
  }

  // Crest. This is the single biggest silhouette differentiator on the roster.
  const crestUp = up.clone();
  switch (plan.crest) {
    case 'ridge':
      for (let i = 0; i < 3; i++) {
        b.add('scute', b.spine({
          base: P((-0.05 + i * 0.14) * L, 0.26 * k, 0),
          direction: crestUp.clone().addScaledVector(fwd, -0.5 - i * 0.1),
          length: (0.2 - i * 0.03) * k, radius: 0.05 * k, curve: 0.03 * k,
          color: REPTILIAN.scute,
        }));
      }
      break;
    case 'swept':
      for (const s of [-1, 1] as const) {
        b.add(pk, b.horn({
          base: P(-0.02 * L, 0.2 * k, s * 0.16 * k),
          direction: crestUp.clone().multiplyScalar(0.5).addScaledVector(fwd, -0.8).addScaledVector(side, s * 0.34),
          length: 0.58 * k, radius: 0.07 * k, curve: 0.13 * k, ridges: 7, twist: 0.3,
          color: REPTILIAN.obsidian, colorTip: 0x6b6572,
        }));
      }
      // Central fin between them.
      b.add('scute', b.plate({
        centre: P(-0.08 * L, 0.32 * k, 0),
        normal: side, up: crestUp,
        width: 0.42 * k, height: 0.3 * k, thickness: 0.026 * k,
        curve: 0.4, taper: 0.5, segments: 6,
        color: REPTILIAN.scute, edgeColor: REPTILIAN.bronze,
      }));
      break;
    case 'crown': {
      const horns = 5;
      for (let i = 0; i < horns; i++) {
        const a = (i / (horns - 1) - 0.5) * 1.9;
        b.add(pk, b.horn({
          base: P(-0.02 * L, 0.24 * k, Math.sin(a) * 0.2 * k),
          direction: crestUp.clone().multiplyScalar(0.9)
            .addScaledVector(side, Math.sin(a) * 0.7)
            .addScaledVector(fwd, -0.42 + Math.abs(Math.sin(a)) * 0.25),
          length: (0.5 - Math.abs(a) * 0.1) * k, radius: 0.065 * k,
          curve: 0.1 * k, ridges: 6, twist: 0.2,
          color: REPTILIAN.obsidian, colorTip: REPTILIAN.bronze,
        }));
      }
      break;
    }
    case 'antler':
      for (const s of [-1, 1] as const) {
        const root = P(-0.04 * L, 0.22 * k, s * 0.14 * k);
        const dir = crestUp.clone().multiplyScalar(1).addScaledVector(side, s * 0.45).addScaledVector(fwd, -0.3);
        b.add('scute', b.horn({
          base: root, direction: dir, length: 0.72 * k, radius: 0.058 * k,
          curve: 0.16 * k, ridges: 8, twist: 0.5,
          color: REPTILIAN.scute, colorTip: 0xd9c9a8,
        }));
        for (let t = 0; t < 2; t++) {
          const branch = root.clone().addScaledVector(dir.clone().normalize(), (0.28 + t * 0.24) * k);
          b.add('scute', b.spine({
            base: branch,
            direction: crestUp.clone().addScaledVector(side, s * (0.9 + t * 0.3)).addScaledVector(fwd, -0.4 + t * 0.5),
            length: (0.3 - t * 0.06) * k, radius: 0.03 * k, curve: 0.05 * k,
            color: REPTILIAN.scute, colorTip: 0xd9c9a8,
          }));
        }
      }
      break;
    case 'horn':
      for (const s of [-1, 1] as const) {
        b.add(pk, b.horn({
          base: P(0.18 * L, 0.14 * k, s * 0.24 * k),
          direction: fwd.clone().multiplyScalar(0.62).addScaledVector(side, s * 0.66).addScaledVector(crestUp, 0.42),
          length: 0.66 * k, radius: 0.09 * k, curve: 0.2 * k, ridges: 9, twist: 0.8,
          color: REPTILIAN.obsidian, colorTip: REPTILIAN.bronze,
        }));
      }
      b.add('scute', b.spine({
        base: P(0.86 * L, 0.06 * k, 0),
        direction: crestUp.clone().addScaledVector(fwd, 0.55),
        length: 0.2 * k, radius: 0.05 * k, curve: 0.02 * k,
        color: REPTILIAN.scute,
      }));
      break;
  }
}

/**
 * The shared saurian body: skeleton, muscle, plating, tail, skull and hands.
 * Per-unit kit (weapons, tanks, crowns, mortars) is added afterwards by the
 * caller through the returned anchors, so every unit walks identically and only
 * its silhouette differs.
 */
function buildSaurian(ctx: BodyBuildContext, plan: SaurPlan): SaurAnchors {
  const rig = ctx.rig;
  const b = ctx.builder;
  reptilianMaterials(b, plan);
  const pk = plateKey(plan);
  const k = plan.height / 2.35;

  // -- skeleton -------------------------------------------------------------
  rig.chain(
    'spine',
    ['hips', 'lumbar', 'chest', 'neck', 'head'],
    plan.spine,
    {
      origin: v(0, plan.hipY, 0),
      direction: UP,
      pole: FORWARD,
      kind: 'spine',
      restBend: plan.spineBend,
      capture: [
        plan.torsoR * 1.5, plan.torsoR * 1.6, plan.torsoR * 1.7,
        plan.torsoR * 0.95, plan.skull * 1.05,
      ],
    },
  );

  // The tail is genuinely long — it is the counterweight that makes a forward
  // stance believable, and the animator lags it behind the hips automatically.
  rig.chain('tail', ['t0', 't1', 't2', 't3', 't4'], plan.tail, {
    parent: 'spine.hips',
    origin: v(0, plan.hipY * 0.02, plan.torsoR * 0.55),
    direction: v(0, 0.22, 1).normalize(),
    pole: UP,
    kind: 'tail',
    restBend: [0, -0.14, -0.16, -0.2, -0.18],
    capture: plan.tail.map((s) => s * 1.5),
  });

  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    rig.chain(
      `leg.${s}`,
      ['hip', 'knee', 'hock', 'ankle', 'toe'],
      plan.legs,
      {
        parent: 'spine.hips',
        origin: v(side * plan.hipWidth, -plan.legR * 0.2, plan.torsoR * 0.12),
        direction: DOWN,
        pole: FORWARD,
        kind: 'leg',
        side,
        restBend: plan.legBend,
        capture: [
          plan.legR * 1.9, plan.legR * 1.7, plan.legR * 1.5,
          plan.legR * 1.3, plan.legR * 1.2,
        ],
      },
    );
    rig.chain(`arm.${s}`, ['shoulder', 'elbow', 'wrist'], plan.arms, {
      parent: 'spine.chest',
      origin: v(side * plan.shoulderW, plan.torsoR * 0.24, 0),
      direction: v(side * 0.24, -1, -0.06).normalize(),
      pole: FORWARD,
      kind: 'arm',
      side,
      restBend: [0.16, 0.42, 0.24],
      capture: [plan.armR * 2.1, plan.armR * 1.9, plan.armR * 1.7],
    });
  }

  // Jaw and crest ride on `generic` chains: the base animation pass skips those
  // kinds entirely, which leaves them free for the species `animate()` hook.
  const skullFwd = new THREE.Vector3(0, 0, -1);
  rig.chain('jaw', ['hinge', 'tip'], [plan.skull * 0.9, plan.skull * 0.3], {
    parent: 'spine.head',
    // The hinge sits low and slightly back, where a jaw articulation actually
    // is. That vertical separation — not a weight hack — is what keeps the
    // upper teeth on the skull when the mouth opens.
    origin: v(0, -plan.skull * 0.34, plan.skull * 0.1),
    direction: skullFwd,
    pole: UP,
    kind: 'generic',
    capture: [plan.skull * 0.5, 0.001],
    skinBias: 1.5,
  });

  // -- rest anchors ---------------------------------------------------------
  const hips = at(rig, 'spine.hips');
  const lumbar = at(rig, 'spine.lumbar');
  const chest = at(rig, 'spine.chest');
  const neck = at(rig, 'spine.neck');
  const head = at(rig, 'spine.head');
  const snout = tipOf(rig, 'spine');
  const fwd = new THREE.Vector3(0, 0, -1);

  const anchors: SaurAnchors = {
    plan,
    hips, lumbar, chest, neck, head, snout, fwd,
    shoulder: [at(rig, 'arm.L.shoulder'), at(rig, 'arm.R.shoulder')],
    wrist: [at(rig, 'arm.L.wrist'), at(rig, 'arm.R.wrist')],
    hand: [tipOf(rig, 'arm.L'), tipOf(rig, 'arm.R')],
    knee: [at(rig, 'leg.L.knee'), at(rig, 'leg.R.knee')],
    tailBase: at(rig, 'tail.t0'),
    proxies: [],
  };

  // -- torso ----------------------------------------------------------------
  // Pelvis is wider than it is deep; chest is deeper than it is wide. That one
  // reversal is what makes a biped read as a saurian rather than as a person.
  b.add('hide', b.taperedLimb({
    from: hips.clone().addScaledVector(fwd, -plan.torsoR * 0.35),
    to: lumbar,
    r0: plan.torsoR * 0.86, r1: plan.torsoR * 0.8,
    jointR: plan.torsoR * 0.9, muscle: 1.12, flatten: 1.22, sides: 12,
    color: REPTILIAN.hide,
  }));
  b.add('hide', b.taperedLimb({
    from: lumbar, to: chest,
    r0: plan.torsoR * 0.8, r1: plan.torsoR,
    jointR: plan.torsoR * 0.95, muscle: 1.16, flatten: 0.82, sides: 12,
    color: REPTILIAN.hide,
  }));
  // Belly plates: paler, and the only place the value lifts on the underside.
  b.add('hide', b.segment({
    from: hips.clone().addScaledVector(fwd, plan.torsoR * 0.5),
    to: chest.clone().addScaledVector(fwd, plan.torsoR * 0.62),
    r0: plan.torsoR * 0.42, r1: plan.torsoR * 0.5,
    flatten: 1.5, ridges: 7, ridgeDepth: 0.16, sides: 9,
    color: REPTILIAN.belly,
  }));
  b.add('hide', b.taperedLimb({
    from: chest, to: neck,
    r0: plan.torsoR * 0.82, r1: plan.torsoR * 0.52,
    jointR: plan.torsoR * 0.7, muscle: 1.08, flatten: 0.94, sides: 10,
    color: REPTILIAN.hide,
  }));
  b.add('hide', b.taperedLimb({
    from: neck, to: head,
    r0: plan.torsoR * 0.52, r1: plan.torsoR * 0.42,
    jointR: plan.torsoR * 0.5, muscle: 1.1, flatten: 0.9, sides: 10,
    color: REPTILIAN.hide,
  }));

  // Dorsal scutes down the spine and out along the tail. Breaks the back line,
  // which is the read that survives being flattened to black.
  const ridgePts: THREE.Vector3[] = [hips, lumbar, chest, neck];
  for (let i = 0; i < plan.scutes; i++) {
    const t = i / (plan.scutes - 1);
    const seg = t * (ridgePts.length - 1);
    const i0 = Math.min(ridgePts.length - 2, Math.floor(seg));
    const p = new THREE.Vector3().lerpVectors(ridgePts[i0], ridgePts[i0 + 1], seg - i0);
    const h = (0.2 - Math.abs(t - 0.45) * 0.16) * plan.height * 0.55;
    b.add('scute', b.spine({
      base: p.clone().addScaledVector(fwd, -plan.torsoR * 0.62),
      direction: v(0, 0.72, 0.7).normalize(),
      length: h, radius: h * 0.3, curve: h * 0.16, sharpness: 1.5,
      color: REPTILIAN.scute, colorTip: 0x6a5f52,
    }));
  }

  // -- tail -----------------------------------------------------------------
  const tailBones = ['tail.t0', 'tail.t1', 'tail.t2', 'tail.t3', 'tail.t4'];
  for (let i = 0; i < tailBones.length; i++) {
    const from = at(rig, tailBones[i]);
    const to = i + 1 < tailBones.length ? at(rig, tailBones[i + 1]) : tipOf(rig, 'tail');
    const r0 = plan.tailR * (1 - i * 0.17);
    const r1 = plan.tailR * (1 - (i + 1) * 0.17);
    b.add('hide', b.taperedLimb({
      from, to, r0, r1: Math.max(r1, plan.tailR * 0.08),
      jointR: r0 * 1.05, muscle: 1.04, flatten: 0.86, sides: 9,
      color: REPTILIAN.hide, colorTip: i > 2 ? REPTILIAN.scute : REPTILIAN.hide,
    }));
    if (i < 4) {
      b.add('scute', b.spine({
        base: from.clone().addScaledVector(v(0, 1, 0), r0 * 0.7),
        direction: v(0, 0.86, 0.5).normalize(),
        length: r0 * 1.5, radius: r0 * 0.3, curve: r0 * 0.2,
        color: REPTILIAN.scute,
      }));
    }
  }
  // A bronze-banded club at the tip: the tail ends in a statement, not a taper.
  b.add('bronze', b.segment({
    from: at(rig, 'tail.t4'),
    to: tipOf(rig, 'tail'),
    r0: plan.tailR * 0.34, r1: plan.tailR * 0.16,
    ridges: 5, ridgeDepth: 0.24, sides: 7, faceted: true,
    color: REPTILIAN.bronze,
  }));

  // -- legs -----------------------------------------------------------------
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    const hip = at(rig, `leg.${s}.hip`);
    const knee = at(rig, `leg.${s}.knee`);
    const hock = at(rig, `leg.${s}.hock`);
    const ankle = at(rig, `leg.${s}.ankle`);
    const toe = at(rig, `leg.${s}.toe`);
    const toeTip = tipOf(rig, `leg.${s}`);

    // Thigh carries the mass; the shank is a cable; the metatarsus is thin.
    b.add('hide', b.taperedLimb({
      from: hip, to: knee,
      r0: plan.legR, r1: plan.legR * 0.62,
      jointR: plan.legR * 1.12, muscle: 1.42, flatten: 0.88, sides: 10,
      color: REPTILIAN.hide,
    }));
    b.add('hide', b.taperedLimb({
      from: knee, to: hock,
      r0: plan.legR * 0.6, r1: plan.legR * 0.34,
      jointR: plan.legR * 0.7, muscle: 1.24, flatten: 0.84, sides: 9,
      color: REPTILIAN.hide,
    }));
    b.add('hide', b.taperedLimb({
      from: hock, to: ankle,
      r0: plan.legR * 0.34, r1: plan.legR * 0.28,
      jointR: plan.legR * 0.4, muscle: 1.06, flatten: 0.8, sides: 8,
      color: REPTILIAN.hide, colorTip: REPTILIAN.scute,
    }));
    // Plantar pad + three forward toes and one dew claw behind — the shape a
    // theropod foot actually leaves in ash.
    b.add('scute', b.segment({
      from: ankle, to: toe,
      r0: plan.legR * 0.3, r1: plan.legR * 0.26,
      flatten: 1.25, sides: 8,
      color: REPTILIAN.scute,
    }));
    for (let d = -1; d <= 1; d++) {
      b.add('scute', b.digit({
        base: toe.clone().addScaledVector(v(1, 0, 0), d * plan.legR * 0.32),
        direction: v(d * 0.3, -0.18, -1).normalize(),
        length: plan.legs[4] * 1.5, radius: plan.legR * 0.2,
        joints: 2, curl: 0.16, claw: true,
        color: REPTILIAN.scute,
      }));
    }
    b.add('scute', b.digit({
      base: ankle.clone().addScaledVector(v(0, 0, 1), plan.legR * 0.2),
      direction: v(0, -0.55, 1).normalize(),
      length: plan.legs[4] * 0.9, radius: plan.legR * 0.16,
      joints: 2, curl: 0.4, claw: true,
      color: REPTILIAN.scute,
    }));
    void toeTip;

    // Greaves and a knee cop. Bronze rims on obsidian: scavenged, not issued.
    b.add(pk, b.plate({
      centre: knee.clone().addScaledVector(fwd, -plan.legR * 0.7).addScaledVector(v(0, 1, 0), plan.legR * 0.15),
      normal: fwd, up: v(0, 1, 0),
      width: plan.legR * 2.3, height: plan.legR * 2.5, thickness: plan.legR * 0.17,
      curve: 1.5, taper: 0.66, segments: 7,
      color: plan.useObsidian ? REPTILIAN.obsidian : REPTILIAN.scute,
      edgeColor: REPTILIAN.bronze,
    }));
    b.add(pk, b.plate({
      centre: hip.clone().addScaledVector(v(side, 0, 0), plan.legR * 0.62)
        .addScaledVector(v(0, 1, 0), -plan.legR * 0.5),
      normal: v(side * 0.94, 0.1, -0.32).normalize(), up: v(0, 1, 0),
      width: plan.legR * 2.1, height: plan.legR * 3.4, thickness: plan.legR * 0.15,
      curve: 1.0, taper: 0.74, segments: 7,
      color: plan.useObsidian ? REPTILIAN.obsidian : REPTILIAN.scute,
      edgeColor: REPTILIAN.bronze,
    }));
    // Heat fissure down the outside of the thigh.
    fissure(
      b,
      hip.clone().addScaledVector(v(side, 0, 0), plan.legR * 0.9),
      knee.clone().addScaledVector(v(side, 0, 0), plan.legR * 0.5),
      plan.legR * 0.14,
      v(side, 0, -0.3).normalize(),
    );
  }

  // -- arms and hands -------------------------------------------------------
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? 'L' : 'R';
    const shoulder = at(rig, `arm.${s}.shoulder`);
    const elbow = at(rig, `arm.${s}.elbow`);
    const wrist = at(rig, `arm.${s}.wrist`);
    const hand = tipOf(rig, `arm.${s}`);

    b.add('hide', b.taperedLimb({
      from: shoulder, to: elbow,
      r0: plan.armR, r1: plan.armR * 0.72,
      jointR: plan.armR * 1.12, muscle: 1.36, sides: 9,
      color: REPTILIAN.hide,
    }));
    b.add('hide', b.taperedLimb({
      from: elbow, to: wrist,
      r0: plan.armR * 0.72, r1: plan.armR * 0.52,
      jointR: plan.armR * 0.86, muscle: 1.2, sides: 9,
      color: REPTILIAN.hide,
    }));
    b.add('hide', b.segment({
      from: wrist, to: hand,
      r0: plan.armR * 0.55, r1: plan.armR * 0.42,
      flatten: 0.68, sides: 8,
      color: REPTILIAN.hide,
    }));
    // Four clawed digits. Three forward, one opposed — enough to read as a hand
    // that grips a weapon rather than a mitten.
    for (let d = 0; d < 3; d++) {
      b.add('scute', b.digit({
        base: hand.clone()
          .addScaledVector(v(side, 0, 0), (d - 1) * plan.armR * 0.3)
          .addScaledVector(v(0, 1, 0), plan.armR * 0.05),
        direction: v(side * (d - 1) * 0.22, -0.72, -0.66).normalize(),
        length: plan.armR * 1.35, radius: plan.armR * 0.19,
        joints: 3, curl: 0.62, claw: true,
        color: REPTILIAN.scute,
      }));
    }
    b.add('scute', b.digit({
      base: hand.clone().addScaledVector(v(side, 0, 0), -plan.armR * 0.42),
      direction: v(-side * 0.5, -0.55, -0.66).normalize(),
      length: plan.armR * 1.0, radius: plan.armR * 0.17,
      joints: 2, curl: 0.7, claw: true,
      color: REPTILIAN.scute,
    }));

    // Pauldron. The widest thing on the body and therefore the loudest part of
    // the silhouette; each unit scales it in its own detail hook if it differs.
    b.add(pk, b.plate({
      centre: shoulder.clone()
        .addScaledVector(v(side, 0, 0), plan.armR * 0.75)
        .addScaledVector(v(0, 1, 0), plan.armR * 0.5),
      normal: v(side * 0.9, 0.44, 0).normalize(), up: fwd.clone().negate(),
      width: plan.shoulderW * 2.5, height: plan.shoulderW * 2.0, thickness: plan.armR * 0.22,
      curve: 1.55, taper: 0.62, segments: 8,
      color: plan.useObsidian ? REPTILIAN.obsidian : REPTILIAN.scute,
      edgeColor: REPTILIAN.bronze,
    }));
    b.add('bronze', b.segment({
      from: shoulder.clone().addScaledVector(v(side, 0, 0), plan.armR * 0.2).addScaledVector(v(0, 1, 0), plan.armR * 1.05),
      to: shoulder.clone().addScaledVector(v(side, 0, 0), plan.armR * 1.5).addScaledVector(v(0, 1, 0), plan.armR * 0.35),
      r0: plan.armR * 0.2, r1: plan.armR * 0.13,
      sides: 6, faceted: true, ridges: 4, ridgeDepth: 0.2,
      color: REPTILIAN.bronze,
    }));
    // Vambrace.
    b.add('bronze', b.segment({
      from: elbow.clone().addScaledVector(v(0, -1, 0), plan.armR * 0.05),
      to: wrist,
      r0: plan.armR * 0.86, r1: plan.armR * 0.66,
      ridges: 6, ridgeDepth: 0.14, sides: 8, faceted: true,
      color: REPTILIAN.bronze,
    }));
  }

  // -- torso plating --------------------------------------------------------
  const cuirass = chest.clone().addScaledVector(fwd, plan.torsoR * 0.82).addScaledVector(v(0, -1, 0), plan.torsoR * 0.12);
  b.add(pk, b.plate({
    centre: cuirass,
    normal: fwd, up: v(0, 1, 0),
    width: plan.torsoR * 3.0, height: plan.torsoR * 3.4, thickness: plan.torsoR * 0.11,
    curve: 1.35, taper: 0.8, segments: 9,
    color: plan.useObsidian ? REPTILIAN.obsidian : REPTILIAN.scute,
    edgeColor: REPTILIAN.bronze,
  }));
  // Bronze strapping across the cuirass, and a heat vent under the ribs.
  for (let i = 0; i < 2; i++) {
    b.add('bronze', b.segment({
      from: cuirass.clone()
        .addScaledVector(v(1, 0, 0), -plan.torsoR * 1.4)
        .addScaledVector(v(0, 1, 0), (i - 0.5) * plan.torsoR * 1.1),
      to: cuirass.clone()
        .addScaledVector(v(1, 0, 0), plan.torsoR * 1.4)
        .addScaledVector(v(0, 1, 0), (i - 0.5) * plan.torsoR * 1.1 - plan.torsoR * 0.15),
      r0: plan.torsoR * 0.09, r1: plan.torsoR * 0.09,
      flatten: 0.45, sides: 5, faceted: true, bend: plan.torsoR * 0.28, bendAxis: fwd,
      color: REPTILIAN.bronze,
    }));
  }
  b.add('heat', b.vent({
    centre: lumbar.clone().addScaledVector(fwd, plan.torsoR * 0.72),
    normal: fwd, up: v(0, 1, 0),
    width: plan.torsoR * 1.1, height: plan.torsoR * 0.8, depth: plan.torsoR * 0.28,
    slats: 3, color: REPTILIAN.heat,
  }));
  // Back plate and a spinal heat channel — this is what the player shoots at
  // when the unit turns away, so it has to be as designed as the front.
  b.add(pk, b.plate({
    centre: chest.clone().addScaledVector(fwd, -plan.torsoR * 0.78),
    normal: fwd.clone().negate(), up: v(0, 1, 0),
    width: plan.torsoR * 2.6, height: plan.torsoR * 3.0, thickness: plan.torsoR * 0.1,
    curve: 1.2, taper: 0.86, segments: 8,
    color: plan.useObsidian ? REPTILIAN.obsidian : REPTILIAN.scute,
    edgeColor: REPTILIAN.bronze,
  }));
  for (const s of [-1, 1] as const) {
    fissure(
      b,
      lumbar.clone().addScaledVector(v(s, 0, 0), plan.torsoR * 0.78),
      chest.clone().addScaledVector(v(s, 0, 0), plan.torsoR * 0.9).addScaledVector(fwd, plan.torsoR * 0.2),
      plan.torsoR * 0.09,
      v(s, 0, 0.4).normalize(),
    );
    fissure(
      b,
      neck.clone().addScaledVector(v(s, 0, 0), plan.torsoR * 0.42),
      chest.clone().addScaledVector(v(s, 0, 0), plan.torsoR * 0.66).addScaledVector(fwd, -plan.torsoR * 0.3),
      plan.torsoR * 0.07,
      v(s, 0, -0.4).normalize(),
    );
  }
  // Gorget: bronze collar between the pauldrons, and the throat crit target.
  b.add('bronze', b.segment({
    from: neck.clone().addScaledVector(v(0, -1, 0), plan.torsoR * 0.12),
    to: neck.clone().addScaledVector(v(0, 1, 0), plan.torsoR * 0.34),
    r0: plan.torsoR * 0.72, r1: plan.torsoR * 0.56,
    flatten: 0.9, ridges: 8, ridgeDepth: 0.1, sides: 10, faceted: true,
    color: REPTILIAN.bronze,
  }));

  addSkull(ctx, plan, head, snout);

  // -- hit proxies ----------------------------------------------------------
  anchors.proxies.push(
    { region: 'head', bone: 'spine.head', offset: v(0, 0, plan.skull * 0.7), radius: plan.skull * 0.62, multiplier: 2.3 },
    { region: 'body', bone: 'spine.chest', radius: plan.torsoR * 1.05, halfHeight: plan.torsoR * 0.5, multiplier: 1 },
    { region: 'body', bone: 'spine.lumbar', radius: plan.torsoR * 0.95, halfHeight: plan.torsoR * 0.4, multiplier: 1 },
    { region: 'body', bone: 'spine.hips', radius: plan.torsoR * 0.85, multiplier: 1 },
    { region: 'limb', bone: 'arm.L.elbow', radius: plan.armR * 1.6, multiplier: 0.6 },
    { region: 'limb', bone: 'arm.R.elbow', radius: plan.armR * 1.6, multiplier: 0.6 },
    { region: 'limb', bone: 'leg.L.knee', radius: plan.legR * 1.4, multiplier: 0.6 },
    { region: 'limb', bone: 'leg.R.knee', radius: plan.legR * 1.4, multiplier: 0.6 },
    { region: 'limb', bone: 'tail.t1', radius: plan.tailR * 1.4, multiplier: 0.45 },
  );
  void k;
  return anchors;
}

/** Default animator tuning for a heavy digitigrade biped. */
function saurTuning(plan: SaurPlan): Partial<AnimatorTuning> {
  return {
    runSpeed: 6.4,
    strideScale: 0.66,
    kneeSign: 1,
    bob: 0.05 * (plan.height / 2.35),
    sway: 0.026 * (plan.height / 2.35),
    liftScale: 0.3,
    leanAccel: 0.024,
    leanTurn: 0.13,
    breathRate: 0.5,
    breathAmount: 0.045,
    lookShare: [0.42, 0.3, 0.2],
    lookYawLimit: 1.5,
    lookPitchLimit: 0.7,
    ...plan.tuning,
  };
}

/**
 * Add a rigid hard-point chain: two `generic` bones running along a held
 * weapon's axis, parented to the bone that carries it.
 *
 * Long kit — a 1.4 m rifle, a 2.6 m mortar tube — cannot be skinned by
 * proximity to a wrist: half of it falls outside every capture radius and the
 * orphan fallback then binds the muzzle to whichever bone happens to be
 * nearest, which is how a rifle ends up welded to a jaw. A dedicated chain with
 * capture radii sized to the *weapon* claims exactly the weapon volume, and
 * because the animator ignores `generic` chains those bones never move relative
 * to their parent — the kit is rigidly attached, which is what a weapon is.
 */
function addHardpoint(
  rig: Rig,
  id: string,
  parent: string,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  length: number,
  radius: number,
): void {
  rig.chain(id, ['root', 'tip'], [length * 0.62, length * 0.38], {
    parent,
    origin,
    direction: direction.clone().normalize(),
    pole: UP,
    kind: 'generic',
    capture: [radius, radius],
    skinBias: 3,
  });
}

// ---------------------------------------------------------------------------
// Unit plans
// ---------------------------------------------------------------------------

const SKIRMISHER_PLAN = saurPlan('rept_skirmisher', 0.83, {
  height: 1.95,
  hipY: 1.06,
  // Deep crouch: more bend everywhere, so the hips ride low and the spine runs
  // nearly horizontal. Read at 40 m: a sprinter, not a soldier.
  legBend: [0.86, -1.34, 1.06, 1.24],
  spineBend: [0.72, 0.2, -0.26, 0.34, 0.72],
  torsoR: 0.2,
  shoulderW: 0.22,
  useObsidian: false,
  crest: 'ridge',
  scutes: 8,
  tail: [0.3, 0.29, 0.27, 0.24, 0.2],
  tailR: 0.1,
  skull: 0.28,
  tuning: { runSpeed: 8.2, strideScale: 0.72, bob: 0.055, sway: 0.03, liftScale: 0.36, leanAccel: 0.032 },
});

const LEGIONARY_PLAN = saurPlan('rept_legionary', 1, {
  crest: 'swept',
  scutes: 7,
  tuning: { runSpeed: 6.2 },
});

const PYROCLAST_PLAN = saurPlan('rept_pyroclast', 0.99, {
  height: 2.3,
  hipY: 1.3,
  // Hunched under the tank: the lumbar tips further forward and the neck drops.
  spineBend: [0.5, 0.18, -0.3, 0.26, 0.9],
  torsoR: 0.33,
  shoulderW: 0.33,
  legR: 0.16,
  armR: 0.105,
  crest: 'ridge',
  scutes: 5,
  skull: 0.33,
  tuning: { runSpeed: 5.6, bob: 0.058, sway: 0.03 },
});

const WARBRUTE_PLAN = saurPlan('rept_warbrute', 1.383, {
  height: 3.25,
  hipY: 1.82,
  hipWidth: 0.34,
  // Head sunk between the shoulders. The chest counter-rotation is small so the
  // whole mass leans over the toes — a bull about to charge.
  spineBend: [0.4, 0.16, -0.1, 0.42, 0.86],
  torsoR: 0.46,
  shoulderW: 0.5,
  arms: [0.54, 0.5, 0.22],
  armR: 0.16,
  legR: 0.24,
  crest: 'horn',
  scutes: 9,
  skull: 0.47,
  tuning: { runSpeed: 6.8, strideScale: 0.7, bob: 0.075, sway: 0.042, leanTurn: 0.1 },
});

const ASHPRIEST_PLAN = saurPlan('rept_ashpriest', 1.19, {
  height: 2.8,
  hipY: 1.62,
  hipWidth: 0.22,
  // Upright and gaunt: the spine barely leans, so it towers over a Legionary
  // despite weighing less. Long neck, high head carriage.
  spineBend: [0.14, 0.02, -0.06, 0.2, 1.02],
  spine: [0.3, 0.38, 0.3, 0.28, 0.36],
  torsoR: 0.27,
  shoulderW: 0.31,
  arms: [0.46, 0.44, 0.18],
  armR: 0.088,
  legR: 0.15,
  tail: [0.34, 0.32, 0.29, 0.25, 0.19],
  tailR: 0.12,
  crest: 'antler',
  scutes: 6,
  skull: 0.36,
  tuning: { runSpeed: 5, strideScale: 0.6, bob: 0.04, sway: 0.02, breathAmount: 0.06 },
});

const TYRANT_PLAN = saurPlan('rept_tyrant', 3.4, {
  height: 8,
  hipY: 4.35,
  hipWidth: 0.78,
  spineBend: [0.44, 0.1, -0.14, 0.34, 0.9],
  spine: [0.82, 1.02, 0.6, 0.72, 1.06],
  torsoR: 1.02,
  shoulderW: 1.12,
  arms: [1.36, 1.24, 0.5],
  armR: 0.4,
  legR: 0.6,
  legs: [1.78, 1.72, 1.16, 0.7, 0.44],
  tail: [1.15, 1.05, 0.95, 0.8, 0.62],
  tailR: 0.5,
  crest: 'crown',
  scutes: 11,
  skull: 1.06,
  tuning: {
    runSpeed: 5.6, strideScale: 0.78, bob: 0.16, sway: 0.09,
    liftScale: 0.26, leanTurn: 0.07, breathRate: 0.34, breathAmount: 0.05,
  },
});

// ---------------------------------------------------------------------------
// Weapon kit
// ---------------------------------------------------------------------------

/**
 * A Reptilian firearm: bronze receiver, obsidian shroud, a heat sink that glows
 * and a flared muzzle. Built along an explicit axis so the same routine serves a
 * carbine, a rifle and a cannon at three different scales.
 */
function addGun(
  b: BodyBuilder,
  plan: SaurPlan,
  base: THREE.Vector3,
  dir: THREE.Vector3,
  length: number,
  calibre: number,
  opts: { drum?: boolean; shroudRibs?: number; sight?: boolean } = {},
): void {
  const f = dir.clone().normalize();
  const up = new THREE.Vector3(0, 1, 0).addScaledVector(f, -f.y).normalize();
  const side = new THREE.Vector3().crossVectors(up, f).normalize();
  const pk = plateKey(plan);
  const P = (t: number, u: number, s: number): THREE.Vector3 =>
    base.clone().addScaledVector(f, t * length).addScaledVector(up, u).addScaledVector(side, s);

  // Receiver: a faceted bronze box, not a tube. Hard-surface reads flat-shaded.
  b.add('bronze', b.segment({
    from: P(-0.2, 0, 0), to: P(0.34, 0.01, 0),
    r0: calibre * 2.1, r1: calibre * 1.9,
    flatten: 0.72, sides: 5, faceted: true,
    color: REPTILIAN.bronze,
  }));
  // Barrel and flared muzzle.
  b.add(pk, b.segment({
    from: P(0.3, 0.012, 0), to: P(1, 0.012, 0),
    r0: calibre * 0.9, r1: calibre * 0.72,
    sides: 8,
    color: plan.useObsidian ? REPTILIAN.obsidian : REPTILIAN.scute,
  }));
  b.add('bronze', b.segment({
    from: P(0.94, 0.012, 0), to: P(1.06, 0.012, 0),
    r0: calibre * 1.15, r1: calibre * 1.4,
    ridges: 6, ridgeDepth: 0.18, sides: 7, faceted: true,
    color: REPTILIAN.bronze,
  }));
  b.add('heat', b.lens({
    centre: P(1.05, 0.012, 0), normal: f,
    radius: calibre * 0.85, bulge: 0.35, segments: 8,
    color: REPTILIAN.heat, coreColor: REPTILIAN.heatHot,
  }));
  // Heat sink: fins over the chamber, glowing between them.
  const ribs = opts.shroudRibs ?? 4;
  for (let i = 0; i < ribs; i++) {
    const t = 0.36 + (i / ribs) * 0.36;
    b.add(pk, b.plate({
      centre: P(t, calibre * 0.6, 0), normal: up, up: f,
      width: calibre * 2.4, height: calibre * 0.9, thickness: calibre * 0.22,
      curve: 0.5, taper: 0.9, segments: 4,
      color: plan.useObsidian ? REPTILIAN.obsidian : REPTILIAN.scute,
      edgeColor: REPTILIAN.bronze,
    }));
  }
  b.add('heat', b.segment({
    from: P(0.36, calibre * 0.25, 0), to: P(0.74, calibre * 0.25, 0),
    r0: calibre * 0.22, r1: calibre * 0.22,
    flatten: 0.4, sides: 4, faceted: true,
    color: REPTILIAN.heat, colorTip: REPTILIAN.heatHot,
  }));
  // Grip and a hooked underslung brace.
  b.add(pk, b.segment({
    from: P(0.02, -calibre * 0.4, 0), to: P(-0.06, -calibre * 2.4, 0),
    r0: calibre * 0.62, r1: calibre * 0.48,
    flatten: 0.62, sides: 5, faceted: true,
    color: plan.useObsidian ? REPTILIAN.obsidian : REPTILIAN.scute,
  }));
  if (opts.drum) {
    b.add('bronze', b.segment({
      from: P(0.16, -calibre * 1.5, -calibre * 1.5),
      to: P(0.16, -calibre * 1.5, calibre * 1.5),
      r0: calibre * 1.6, r1: calibre * 1.6,
      ridges: 8, ridgeDepth: 0.12, sides: 10,
      color: REPTILIAN.bronze,
    }));
    b.add('heat', b.lens({
      centre: P(0.16, -calibre * 1.5, calibre * 1.6),
      normal: side, radius: calibre * 0.8, bulge: 0.3, segments: 8,
      color: REPTILIAN.heat, coreColor: REPTILIAN.heatHot,
    }));
  }
  if (opts.sight ?? true) {
    b.add('bronze', b.segment({
      from: P(0.5, calibre * 1.5, 0), to: P(0.72, calibre * 1.5, 0),
      r0: calibre * 0.34, r1: calibre * 0.26,
      flatten: 0.6, sides: 5, faceted: true,
      color: REPTILIAN.bronze,
    }));
    b.add('heat', b.lens({
      centre: P(0.5, calibre * 1.5, 0), normal: f.clone().negate(),
      radius: calibre * 0.28, bulge: 0.4, segments: 6,
      color: 0xff8a3a, coreColor: 0xffe0b0,
    }));
  }
}

/**
 * The frame a held weapon must be authored in.
 *
 * Geometry is authored in the rig's **bind** pose, but the pose the player
 * actually fights is the animator's weapon-ready stance, and the two differ:
 * two-bone arm IK aims the forearm at the ready target and leaves the wrist at
 * its rest offset, which works out as a roughly 180° roll and a 40° pitch
 * change relative to bind. Working that through, world-forward in the ready
 * pose is the wrist bone's local **+Y**, and world-up is its local **−Z**. So a
 * weapon authored along those two bind-space axes points forward and sits
 * right-side-up in combat, which is the only pose that matters.
 */
function gripFrame(rig: Rig, side: 'L' | 'R'): { origin: THREE.Vector3; fwd: THREE.Vector3; up: THREE.Vector3 } {
  const bone = rig.bone(`arm.${side}.wrist`);
  const origin = tipOf(rig, `arm.${side}`);
  const q = bone ? bone.worldQuat : new THREE.Quaternion();
  const fwd = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
  const up = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
  return { origin, fwd, up };
}

// ---------------------------------------------------------------------------
// Unit builders
// ---------------------------------------------------------------------------

/** Skirmisher — the light scout. Crouched, tail out, stubby fire-spitter. */
function buildSkirmisher(ctx: BodyBuildContext): BuiltBody {
  const plan = SKIRMISHER_PLAN;
  const a = buildSaurian(ctx, plan);
  const b = ctx.builder;
  const rig = ctx.rig;
  const g = gripFrame(rig, 'R');
  const gunLen = 0.62;
  addHardpoint(rig, 'gun', 'arm.R.wrist', g.origin.clone().sub(at(rig, 'arm.R.wrist')), g.fwd, gunLen, 0.2);
  addGun(b, plan, g.origin.clone().addScaledVector(g.fwd, -0.1), g.fwd, gunLen, 0.036, {
    drum: true, shroudRibs: 2, sight: false,
  });

  // Scouts wear almost nothing: a bandolier and a light gorget, so the read is
  // "fast" rather than "armoured". The bare neck is also its crit spot.
  for (let i = 0; i < 2; i++) {
    b.add('bronze', b.segment({
      from: a.chest.clone().add(v(-0.24, 0.1 - i * 0.02, -0.16)),
      to: a.hips.clone().add(v(0.2, 0.02, 0.14)),
      r0: 0.026, r1: 0.022, flatten: 0.35, sides: 4, faceted: true,
      bend: 0.05, bendAxis: v(0, 0, -1),
      color: REPTILIAN.bronze,
    }));
  }
  for (let i = 0; i < 3; i++) {
    b.add('heat', b.lens({
      centre: a.chest.clone().add(v(-0.2 + i * 0.09, 0.04 - i * 0.05, -0.19)),
      normal: v(-0.3, 0.2, -1).normalize(),
      radius: 0.024, bulge: 0.6, segments: 6,
      color: REPTILIAN.heat, coreColor: REPTILIAN.heatHot,
    }));
  }

  a.proxies.push({
    region: 'critSpot', bone: 'spine.neck', offset: v(0, 0, plan.torsoR * 0.5),
    radius: plan.torsoR * 0.5, multiplier: 3.2,
  });

  return {
    rig,
    parts: b.finish(),
    height: plan.height,
    headBone: 'spine.head',
    muzzleBone: 'gun.tip',
    accentColor: REPTILIAN.accent,
    shieldRadius: plan.height * 0.44,
    tuning: saurTuning(plan),
    hitProxies: a.proxies,
  };
}

/** Legionary — the backbone. Slab pauldrons, long plasma rifle, charge pouches. */
function buildLegionary(ctx: BodyBuildContext): BuiltBody {
  const plan = LEGIONARY_PLAN;
  const a = buildSaurian(ctx, plan);
  const b = ctx.builder;
  const rig = ctx.rig;
  const g = gripFrame(rig, 'R');
  const gunLen = 1.15;
  addHardpoint(rig, 'gun', 'arm.R.wrist', g.origin.clone().sub(at(rig, 'arm.R.wrist')), g.fwd, gunLen, 0.24);
  addGun(b, plan, g.origin.clone().addScaledVector(g.fwd, -0.26), g.fwd, gunLen, 0.05, { shroudRibs: 4 });

  // Incendiary charges on the belt: four bronze flasks with a glowing seam. The
  // player learns to read them, because that is what is about to be thrown.
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * 0.13;
    const p = a.hips.clone().add(v(x, 0.12, -0.24 + Math.abs(x) * 0.32));
    b.add('bronze', b.segment({
      from: p, to: p.clone().add(v(0, -0.15, 0)),
      r0: 0.05, r1: 0.042, ridges: 6, ridgeDepth: 0.12, sides: 8,
      color: REPTILIAN.bronze,
    }));
    b.add('heat', b.segment({
      from: p.clone().add(v(0, -0.05, 0)), to: p.clone().add(v(0, -0.09, 0)),
      r0: 0.048, r1: 0.048, sides: 8,
      color: REPTILIAN.heat, colorTip: REPTILIAN.heatHot,
    }));
  }
  // Back-mounted plasma cell: the crit spot, and the reason it turns to fight.
  const cell = a.chest.clone().add(v(0, -0.05, 0.3));
  b.add('bronze', b.segment({
    from: cell.clone().add(v(-0.16, 0.1, 0)), to: cell.clone().add(v(0.16, 0.1, 0)),
    r0: 0.11, r1: 0.11, ridges: 7, ridgeDepth: 0.14, sides: 9,
    color: REPTILIAN.bronze,
  }));
  b.add('heat', b.lens({
    centre: cell.clone().add(v(0, 0.1, 0.09)), normal: v(0, 0.1, 1).normalize(),
    radius: 0.085, bulge: 0.5, segments: 10,
    color: REPTILIAN.heat, coreColor: REPTILIAN.heatHot,
  }));
  // A short cape of scale mail hanging off the left pauldron — asymmetry is
  // what stops a rank of Legionaries reading as clones.
  b.add('scute', b.plate({
    centre: a.shoulder[0].clone().add(v(-0.16, -0.3, 0.06)),
    normal: v(-0.94, 0.1, 0.32).normalize(), up: v(0, 1, 0),
    width: 0.42, height: 0.62, thickness: 0.02,
    curve: 0.9, taper: 1.15, segments: 7,
    color: REPTILIAN.scute, edgeColor: REPTILIAN.bronze,
  }));

  a.proxies.push(
    { region: 'critSpot', bone: 'spine.chest', offset: v(0, -0.05, -0.3), radius: 0.17, multiplier: 2.8 },
    { region: 'critSpot', bone: 'spine.neck', offset: v(0, 0, plan.torsoR * 0.45), radius: plan.torsoR * 0.42, multiplier: 2.4 },
  );

  return {
    rig,
    parts: b.finish(),
    height: plan.height,
    headBone: 'spine.head',
    muzzleBone: 'gun.tip',
    accentColor: REPTILIAN.accent,
    shieldRadius: plan.height * 0.46,
    tuning: saurTuning(plan),
    hitProxies: a.proxies,
  };
}

/** Pyroclast — flamethrower and a back tank that is a detonating weak point. */
function buildPyroclast(ctx: BodyBuildContext): BuiltBody {
  const plan = PYROCLAST_PLAN;
  const a = buildSaurian(ctx, plan);
  const b = ctx.builder;
  const rig = ctx.rig;
  const g = gripFrame(rig, 'R');
  const nozzleLen = 0.86;
  addHardpoint(rig, 'gun', 'arm.R.wrist', g.origin.clone().sub(at(rig, 'arm.R.wrist')), g.fwd, nozzleLen, 0.3);

  // The nozzle: a short wide bell with a ring of pilot flames, deliberately
  // unlike the Legionary's rifle so the threat is legible before it fires.
  const nb = g.origin.clone().addScaledVector(g.fwd, -0.16);
  const nUp = g.up.clone();
  const nSide = new THREE.Vector3().crossVectors(nUp, g.fwd).normalize();
  b.add('bronze', b.segment({
    from: nb, to: nb.clone().addScaledVector(g.fwd, nozzleLen * 0.6),
    r0: 0.075, r1: 0.062, ridges: 6, ridgeDepth: 0.16, sides: 8,
    color: REPTILIAN.bronze,
  }));
  b.add('obsid', b.segment({
    from: nb.clone().addScaledVector(g.fwd, nozzleLen * 0.55),
    to: nb.clone().addScaledVector(g.fwd, nozzleLen),
    r0: 0.07, r1: 0.15, sides: 10, faceted: true,
    color: REPTILIAN.obsidian, colorTip: 0x4a4048,
  }));
  b.add('heat', b.lens({
    centre: nb.clone().addScaledVector(g.fwd, nozzleLen * 0.99), normal: g.fwd,
    radius: 0.125, bulge: 0.28, segments: 12,
    color: REPTILIAN.heat, coreColor: 0xfff0c0,
  }));
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * TAU + 0.4;
    b.add('heat', b.spine({
      base: nb.clone().addScaledVector(g.fwd, nozzleLen * 0.86)
        .addScaledVector(nUp, Math.cos(ang) * 0.115)
        .addScaledVector(nSide, Math.sin(ang) * 0.115),
      direction: g.fwd,
      length: 0.1, radius: 0.018, curve: 0.008,
      color: REPTILIAN.heatHot, colorTip: 0xffffff,
    }));
  }
  b.add('bronze', b.segment({
    from: nb.clone().addScaledVector(nUp, -0.05),
    to: nb.clone().addScaledVector(nUp, -0.2).addScaledVector(g.fwd, 0.1),
    r0: 0.045, r1: 0.038, flatten: 0.6, sides: 5, faceted: true,
    color: REPTILIAN.bronze,
  }));

  // Back tank: two fat drums on a bronze cradle, banded, with a pressure lens.
  // It is the silhouette (a hunched figure with a hump) and the weak point.
  const tank = a.chest.clone().add(v(0, -0.16, 0.4));
  for (const s of [-1, 1] as const) {
    b.add('bronze', b.segment({
      from: tank.clone().add(v(s * 0.17, -0.24, 0)),
      to: tank.clone().add(v(s * 0.17, 0.34, 0.02)),
      r0: 0.16, r1: 0.145, bulge: 1.12, ridges: 3, ridgeDepth: 0.07, sides: 10,
      color: REPTILIAN.bronze,
    }));
    b.add('obsid', b.segment({
      from: tank.clone().add(v(s * 0.17, 0.3, 0.02)),
      to: tank.clone().add(v(s * 0.17, 0.4, 0.02)),
      r0: 0.15, r1: 0.11, sides: 8, faceted: true,
      color: REPTILIAN.obsidian,
    }));
    b.add('heat', b.segment({
      from: tank.clone().add(v(s * 0.17, -0.02, 0.14)),
      to: tank.clone().add(v(s * 0.17, 0.16, 0.15)),
      r0: 0.03, r1: 0.03, flatten: 0.4, sides: 4, faceted: true,
      color: REPTILIAN.heat, colorTip: REPTILIAN.heatHot,
    }));
  }
  b.add('heat', b.lens({
    centre: tank.clone().add(v(0, 0.08, 0.17)), normal: v(0, 0.15, 1).normalize(),
    radius: 0.1, bulge: 0.45, segments: 10,
    color: 0xff7a1e, coreColor: 0xfff2c8,
  }));
  // Feed hose from the tank to the nozzle arm, sagging under its own weight.
  b.add('scute', b.segment({
    from: tank.clone().add(v(0.2, 0.16, 0.06)),
    to: a.shoulder[1].clone().add(v(0.1, -0.1, 0.02)),
    r0: 0.038, r1: 0.032, sides: 6,
    bend: 0.14, bendAxis: v(0.4, -1, 0.3).normalize(),
    color: 0x241f1c,
  }));
  b.add('scute', b.segment({
    from: a.shoulder[1].clone().add(v(0.1, -0.1, 0.02)),
    to: g.origin.clone().addScaledVector(g.fwd, -0.12).addScaledVector(nUp, -0.06),
    r0: 0.032, r1: 0.026, sides: 6,
    bend: 0.12, bendAxis: v(0.5, -1, 0).normalize(),
    color: 0x241f1c,
  }));

  a.proxies.push({
    region: 'critSpot', bone: 'spine.chest', offset: v(0, -0.16, -0.4),
    radius: 0.34, halfHeight: 0.24, multiplier: 3.4,
  });

  return {
    rig,
    parts: b.finish(),
    height: plan.height,
    headBone: 'spine.head',
    muzzleBone: 'gun.tip',
    accentColor: REPTILIAN.accent,
    shieldRadius: plan.height * 0.5,
    tuning: saurTuning(plan),
    hitProxies: a.proxies,
  };
}
