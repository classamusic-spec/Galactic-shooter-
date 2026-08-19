/**
 * EncounterDirector — who fights you, how many, when, from where, and what
 * actually ends a wave.
 *
 * This is the pacing system. Four rules drive everything:
 *
 *  - **The budget is a hard ceiling.** `settings.profile.enemyBudget` is the
 *    absolute cap on simultaneous live enemies, and the *target* population is a
 *    fraction of it that moves with pressure. Nothing here ever hardcodes a
 *    count.
 *  - **Pressure follows the player.** Doing well — high health, killing quickly,
 *    taking little damage — raises the target population and shortens the gap
 *    between waves. Struggling opens breathing room. The player should feel
 *    tested, never farmed, and never bored.
 *  - **Nothing pops into view.** Spawn points are rejected if the player can see
 *    them: outside the view cone *or* occluded, and always beyond a minimum
 *    distance. If nothing valid exists this step, the spawn simply waits.
 *  - **A verb the code does not check is a lie.** A wave ends on the condition
 *    it declares — arrive somewhere, hold somewhere, destroy something, or kill
 *    what it spawned — and the HUD counter shows that condition's progress.
 *
 * ## Wave timing, stated once
 *
 * Every `WaveSpec` describes *when it begins*, never when it ends:
 *
 *  - `triggerFraction` — the share of the **previous** wave that must be dead
 *    before this one arms. Ignored on the first wave, and ignored when the
 *    previous wave ends on a trigger of its own. Absent means 1: a full clear.
 *  - `delay` — seconds between that condition and this wave's first spawn.
 *
 * So wave *i* is over the moment wave *i+1*'s arming condition is met (or, for
 * the last wave, when it is fully dead and the boss can arrive) — unless wave
 * *i* declares its own `trigger`, in which case that decides and the kill count
 * is not consulted.
 *
 * ## Kill attribution
 *
 * Waves overlap on purpose: at 65% the next one arms while survivors are still
 * on their feet. Every unit the director places is therefore tagged with the
 * wave that queued it, and a kill is credited to *that* wave's counter no
 * matter which wave is on screen when it dies. Without the tag, mopping up
 * leftovers pays into the next wave's meter and later waves complete
 * themselves.
 *
 * `threatLevel` (0..1) is the single number this exports to the rest of the
 * game — music intensity, the attack-token cap and post-process punch all read
 * it, so combat escalation is coherent across systems instead of each one
 * guessing.
 */
import * as THREE from 'three';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import { clamp, clamp01, damp, Rng } from '@/util/math';
import { hostAliveCount, type AiAgent, type AiEnemyHost } from './AiDirector';
import type { NavGrid } from './NavGrid';
import type { TargetSignature } from './Perception';
import type { Squad } from './SquadBrain';

/** A place enemies may arrive from. Levels register these; otherwise they are
 *  synthesised from the nav grid around the player. */
export interface SpawnVolume {
  id: string;
  readonly position: THREE.Vector3;
  /** Enemies appear within this radius of `position`. */
  radius: number;
  /** Never spawn while the player is nearer than this. */
  minPlayerDistance: number;
  /** Restrict to these archetype ids; empty means "whatever the wave asks for". */
  archetypes: string[];
  enabled: boolean;
  /** Seconds before this volume may be used again. */
  cooldown: number;
}

export interface WaveUnit {
  archetype: string;
  count: number;
}

/**
 * A place in the world a wave trigger cares about. `THREE.Vector3` satisfies
 * this, and so does the plain `{ x, y, z }` shape `MissionObjective.position`
 * uses, so mission content can be handed straight through without a copy.
 */
export interface WavePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * How a wave ends.
 *
 * Absent means `clear` with the fraction the *next* wave's `triggerFraction`
 * asks for — the behaviour every shipped script relies on, which is why no
 * existing script needs a trigger to keep working.
 *
 * Positional tests are measured on the **XZ plane**. Levels sit on terrain and
 * a player standing on a ledge two metres above the authored point has still
 * arrived; a 3D test would fail them for being tall.
 */
export type WaveTrigger =
  /** Kill `fraction` (0..1) of the units *this* wave spawned. */
  | { kind: 'clear'; fraction?: number }
  /** Player comes within `radius` metres of `position`. */
  | { kind: 'reach'; position: WavePoint; radius: number }
  /**
   * Player banks `seconds` inside `radius` of `position`. The clock is
   * **cumulative**: it runs while they are inside, pauses when they step out or
   * die, and never resets. Leaving a contested zone costs time, not progress —
   * a resetting timer punishes exactly the repositioning the fight demands.
   */
  | { kind: 'hold'; position: WavePoint; radius: number; seconds: number }
  /** A registered `DestructibleTarget` reaches zero health. */
  | { kind: 'destroy'; targetId: string };

/**
 * A world object a `destroy` wave watches — the rune stone, a brood pod, the
 * Choir core.
 *
 * Nothing in the game builds one of these yet. This is the seam: whoever owns
 * the object owns its health and hands the director a live view of it with
 * `registerTarget`. The director only ever reads, and only ever asks two
 * questions — is it dead, and how far along is it. Deliberately nothing more:
 * a `Damageable` (see `@/types`) with an `id` on it already satisfies this, so
 * a destructible prop can register itself without an adapter.
 */
export interface DestructibleTarget {
  /** Name a wave's `destroy` trigger refers to it by. */
  readonly id: string;
  /** Current health. The trigger fires the moment this is <= 0. */
  readonly health: number;
  /** Full health, for the HUD's progress bar. Must be > 0. */
  readonly maxHealth: number;
}

export interface WaveSpec {
  units: WaveUnit[];
  /** Seconds to wait after the trigger condition before the wave begins. */
  delay?: number;
  /**
   * Fraction of the previous wave that must be dead before this one arms.
   * Ignored on the first wave, and ignored when the previous wave ends on a
   * `trigger` of its own. Absent means 1 — the previous wave must be cleared.
   */
  triggerFraction?: number;
  /** Objective line pushed to the HUD when the wave starts. */
  objective?: string;
  /** Spawn volumes to restrict this wave to, by id. */
  volumes?: string[];
  /**
   * What ends this wave. Absent means the kill count described by the next
   * wave's `triggerFraction` — the original behaviour.
   */
  trigger?: WaveTrigger;
}

export interface EncounterScript {
  id: string;
  waves: WaveSpec[];
  /** Optional final unit, spawned after the last wave clears. */
  boss?: WaveUnit;
  /** Seconds between the last wave clearing and the boss arriving. */
  bossDelay?: number;
  /** HUD line for the boss phase. Absent keeps the old generic line. */
  bossObjective?: string;
  /** What this encounter is called. Shown when it completes. */
  title?: string;
  /** Emit `level:cleared` on completion. */
  completesLevel: boolean;
  /** Score awarded on completion. */
  score: number;
}

type EncounterPhase = 'idle' | 'waiting' | 'spawning' | 'fighting' | 'boss' | 'complete';

export const ENCOUNTER = {
  /** Never spawn closer to the player than this. */
  minSpawnDistance: 22,
  maxSpawnDistance: 78,
  /** Half-angle of the player's "I would see that" cone, radians. */
  viewCone: 1.0,
  /** Seconds between spawn attempts while a wave is arriving. */
  spawnInterval: 0.55,
  /** How fast `threatLevel` chases its target, 1/s. */
  threatRate: 0.8,
  /** Seconds of no contact before the encounter considers the fight lulled. */
  lullTime: 6,
  /** Reinforcement squad size. */
  reinforceCount: 3,
  /** Seconds before the boss arrives, when the script does not say. */
  bossDelay: 4,
  /** Fallback boss line for scripts that do not name their boss. */
  bossObjective: 'Eliminate the champion',
  /** Buckets an `advance` objective's approach is reported in. */
  reachSteps: 10,
} as const;

interface PendingSpawn {
  archetype: string;
  volume: string | null;
  /** Marks the spawn as reinforcement so it can join an existing squad. */
  reinforcement: boolean;
  readonly near: THREE.Vector3;
  nearValid: boolean;
  /** Wave that queued this unit, `-1` for anything not part of a wave. Kills
   *  are credited to this index and no other. */
  wave: number;
}

const _v = new THREE.Vector3();
const _cand = new THREE.Vector3();
const _eye = new THREE.Vector3();

export class EncounterDirector {
  readonly volumes: SpawnVolume[] = [];
  /** 0..1 combat intensity. Music, pacing and the token pool all read this. */
  threatLevel = 0;

  private host: AiEnemyHost;
  private nav: NavGrid | null = null;
  private rng = new Rng(0x1f2e3d4c);
  private queue: PendingSpawn[] = [];
  private spawnTimer = 0;

  private script: EncounterScript | null = null;
  private phase: EncounterPhase = 'idle';
  private waveIndex = -1;
  private waveTimer = 0;
  private waveSpawned = 0;
  private waveTotal = 0;
  /** Kills this wave needs before the next thing arms. */
  private waveNeed = 0;
  /**
   * Kills credited to each wave, indexed by wave; the boss sits at index
   * `waves.length`. Survivors that die two waves later still land here.
   */
  private killedByWave: number[] = [];
  /** Wave index every live director-placed unit belongs to. */
  private waveOf = new Map<number, number>();
  private bossSpawned = false;

  // Trigger state for the wave in progress. Reset on every wave change.
  /** HUD line for the wave in progress, built once when it arms. */
  private waveText = '';
  private holdTime = 0;
  private destroyTarget: DestructibleTarget | null = null;
  /** Metres between the player and a `reach` point when the wave armed. */
  private reachSpan = 1;

  /** Objects a `destroy` trigger may name. Levels register them. */
  private targets = new Map<string, DestructibleTarget>();

  // Last objective payload sent, so a 120 Hz loop only speaks on a change.
  private lastObjText: string | null = null;
  private lastObjProgress = -1;
  private lastObjTotal = -1;

  // Rolling performance signals.
  private damageTaken = 0;
  private killsRecent = 0;
  private sinceContact = 0;
  private unsubs: Array<() => void> = [];

  /** Set by the director each step so spawn placement can use it. */
  private lineOfSight: ((a: THREE.Vector3, b: THREE.Vector3) => boolean) | null = null;

  constructor(host: AiEnemyHost) {
    this.host = host;
    this.unsubs.push(
      events.on('enemy:killed', (p) => {
        this.killsRecent += 1;
        const wave = this.waveOf.get(p.entityId);
        if (wave === undefined) return;
        this.waveOf.delete(p.entityId);
        // Credit the wave that spawned it, whatever is on screen now. Anything
        // the director did not place for a wave (reinforcements, level
        // triggers) is tagged -1 and counts towards nothing.
        if (wave >= 0 && wave < this.killedByWave.length) this.killedByWave[wave]++;
      }),
      events.on('player:damaged', (p) => {
        this.damageTaken += p.amount;
        this.sinceContact = 0;
      }),
    );
  }

  bind(nav: NavGrid | null, los: ((a: THREE.Vector3, b: THREE.Vector3) => boolean) | null): void {
    this.nav = nav;
    this.lineOfSight = los;
    this.volumes.length = 0;
    this.queue.length = 0;
    this.waveOf.clear();
    this.targets.clear();
    this.phase = 'idle';
    this.script = null;
    this.threatLevel = 0;
  }

  // -- spawn volumes ---------------------------------------------------------

  addVolume(v: SpawnVolume): SpawnVolume {
    this.volumes.push(v);
    return v;
  }

  /**
   * Synthesise a ring of spawn volumes around a point from the nav grid. Levels
   * that do not author spawn placement still get sensible arrivals.
   */
  autoVolumes(centre: THREE.Vector3, count = 8, radius = 46): void {
    const nav = this.nav;
    if (!nav) return;
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + this.rng.next() * 0.4;
      const r = radius * (0.7 + this.rng.next() * 0.5);
      _v.set(centre.x + Math.sin(ang) * r, centre.y, centre.z + Math.cos(ang) * r);
      if (!nav.snap(_v, _cand, 10)) continue;
      // Only accept a point the player could actually walk to, or enemies will
      // spawn on an island and stand there looking foolish.
      if (nav.mainRegion >= 0) {
        const cell = nav.nearestWalkableCell(_cand.x, _cand.z, 4);
        if (cell < 0 || nav.region[cell] !== nav.mainRegion) continue;
      }
      this.volumes.push({
        id: `auto${i}`,
        position: _cand.clone(),
        radius: 6,
        minPlayerDistance: ENCOUNTER.minSpawnDistance,
        archetypes: [],
        enabled: true,
        cooldown: 0,
      });
    }
  }

  // -- destructible objectives ----------------------------------------------

  /**
   * Register an object a `destroy` trigger may name. The director keeps the
   * reference and reads `health` each step; it never writes to it. Call this
   * before the encounter reaches the wave that names it — a wave whose target
   * is missing falls back to its kill count rather than stalling the campaign.
   */
  registerTarget(target: DestructibleTarget): void {
    this.targets.set(target.id, target);
  }

  /** Drop a target — it was destroyed and cleaned up, or the level unloaded. */
  unregisterTarget(id: string): void {
    this.targets.delete(id);
  }

  // -- scripts ---------------------------------------------------------------

  /** Begin a scripted encounter. Replaces any encounter already running. */
  start(script: EncounterScript): void {
    this.script = script;
    this.phase = 'waiting';
    this.waveIndex = -1;
    // The first wave's own `delay` is the pause before it lands, not a pause
    // after it. Wave 0 declaring `delay: 6` used to do nothing at all.
    this.waveTimer = script.waves.length > 0 ? script.waves[0].delay ?? 0 : 0;
    this.waveTotal = 0;
    this.waveNeed = 0;
    this.waveSpawned = 0;
    this.bossSpawned = false;
    this.queue.length = 0;
    this.waveOf.clear();
    // One slot per wave plus one for the boss.
    this.killedByWave.length = 0;
    for (let i = 0; i <= script.waves.length; i++) this.killedByWave.push(0);
    this.resetWaveState();
    // Put the first instruction up during the pre-wave pause. The HUD used to
    // fill instantly because wave 0 spawned instantly; now that its `delay`
    // means something, the card would otherwise sit blank until the shooting
    // starts. No counter yet — there is nothing to count until it arms.
    const first = script.waves[0];
    if (first && first.objective) this.emitObjective(first.objective, 0, 0);
  }

  stop(): void {
    this.script = null;
    this.phase = 'idle';
    this.queue.length = 0;
  }

  get running(): boolean {
    return this.script !== null && this.phase !== 'complete' && this.phase !== 'idle';
  }

  get currentWave(): number {
    return this.waveIndex + 1;
  }

  get totalWaves(): number {
    return this.script ? this.script.waves.length : 0;
  }

  /** What the running encounter is called, when its script says. */
  get title(): string | null {
    return this.script?.title ?? null;
  }

  // -- reinforcements --------------------------------------------------------

  /** Called by the squad brain when an elite calls for help. */
  requestReinforcements(squad: Squad): boolean {
    const budget = settings.profile.enemyBudget;
    const alive = hostAliveCount(this.host);
    if (alive + this.queue.length >= budget) return false;
    const archetypes = this.host.archetypesFor
      ? this.host.archetypesFor(squad.faction, 'standard')
      : [];
    if (archetypes.length === 0) return false;
    const n = Math.min(ENCOUNTER.reinforceCount, budget - alive - this.queue.length);
    for (let i = 0; i < n; i++) {
      this.queue.push({
        archetype: archetypes[this.rng.int(0, archetypes.length - 1)],
        volume: null,
        reinforcement: true,
        near: squad.centroid.clone(),
        nearValid: true,
        wave: -1,
      });
    }
    events.emit('ui:toast', { text: 'REINFORCEMENTS INBOUND', duration: 2.6 });
    return true;
  }

  /**
   * Queue an ad-hoc group without a script. Used by level triggers. These count
   * towards no wave — only units a wave placed can complete that wave.
   */
  queueUnits(units: readonly WaveUnit[], volumeIds?: readonly string[]): void {
    for (const u of units) this.enqueue(u, volumeIds, -1);
    if (this.phase === 'idle') this.phase = 'spawning';
  }

  private enqueue(unit: WaveUnit, volumeIds: readonly string[] | undefined, wave: number): void {
    for (let i = 0; i < unit.count; i++) {
      this.queue.push({
        archetype: unit.archetype,
        volume: volumeIds && volumeIds.length ? volumeIds[i % volumeIds.length] : null,
        reinforcement: false,
        near: new THREE.Vector3(),
        nearValid: false,
        wave,
      });
    }
  }

  // -- simulation ------------------------------------------------------------

  update(dt: number, agents: readonly AiAgent[], target: TargetSignature, engaged: number): void {
    this.sinceContact += dt;
    this.damageTaken = Math.max(0, this.damageTaken - dt * 7);
    this.killsRecent = Math.max(0, this.killsRecent - dt * 0.18);

    for (let i = 0; i < this.volumes.length; i++) {
      if (this.volumes[i].cooldown > 0) this.volumes[i].cooldown -= dt;
    }

    this.updateThreat(dt, agents, target, engaged);
    this.updateScript(dt, target);
    this.drainQueue(dt, target);
  }

  /**
   * Threat is a blend of "how many things are actively fighting me", "how badly
   * am I hurt" and "how recently was I shot". It rises fast and falls slowly, so
   * a lull after a hard fight still feels tense for a few seconds.
   */
  private updateThreat(
    dt: number,
    agents: readonly AiAgent[],
    target: TargetSignature,
    engaged: number,
  ): void {
    const budget = Math.max(1, settings.profile.enemyBudget);
    let near = 0;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.isDead) continue;
      if (a.position.distanceToSquared(target.centre) < 45 * 45) near++;
    }
    const density = clamp01(near / (budget * 0.55));
    const pressure = clamp01(engaged / 5);
    const hurt = clamp01(1 - (this.hostHealth01 ?? 1));
    const recent = clamp01(1 - this.sinceContact / ENCOUNTER.lullTime);
    const wanted = clamp01(density * 0.36 + pressure * 0.34 + hurt * 0.16 + recent * 0.24);
    // Asymmetric: attack quickly, release slowly.
    const rate = wanted > this.threatLevel ? ENCOUNTER.threatRate * 2.2 : ENCOUNTER.threatRate * 0.5;
    this.threatLevel = damp(this.threatLevel, wanted, rate, dt);
    if (!Number.isFinite(this.threatLevel)) this.threatLevel = 0;
  }

  /** Player health fraction, injected each step by the AI director. */
  hostHealth01: number | null = null;

  /**
   * Difficulty pressure, 0..1. High when the player is healthy and killing
   * quickly; low when they are hurt and being chewed on.
   */
  get pressure(): number {
    const health = this.hostHealth01 ?? 1;
    const performing = clamp01(this.killsRecent / 6);
    const suffering = clamp01(this.damageTaken / 140);
    return clamp01(health * 0.55 + performing * 0.35 - suffering * 0.4 + 0.15);
  }

  /** Live population the director is currently aiming for. */
  get targetPopulation(): number {
    const budget = settings.profile.enemyBudget;
    return Math.round(clamp(budget * (0.35 + this.pressure * 0.65), 2, budget));
  }

  /** Kills credited to the wave (or boss) currently in progress. */
  private get waveKilled(): number {
    const n = this.killedByWave[this.waveIndex];
    return n === undefined ? 0 : n;
  }

  private updateScript(dt: number, target: TargetSignature): void {
    const script = this.script;
    if (!script) return;

    switch (this.phase) {
      case 'waiting': {
        this.waveTimer -= dt;
        if (this.waveTimer > 0) return;
        this.beginNext(script, target);
        break;
      }
      case 'spawning':
      case 'fighting':
      case 'boss': {
        if (this.phase === 'spawning' && this.queue.length === 0) this.phase = 'fighting';
        // Order matters: bank timer progress, show it, then test it — otherwise
        // a hold reads one step stale and never displays its final second.
        const done = this.tickTrigger(dt, script, target);
        this.reportObjective(script, target);
        if (done) this.advance(script);
        break;
      }
      default:
        break;
    }
  }

  /** Arm the next wave, or the boss, or finish. */
  private beginNext(script: EncounterScript, target: TargetSignature): void {
    this.waveIndex++;
    this.resetWaveState();

    if (this.waveIndex >= script.waves.length) {
      const boss = script.boss;
      if (boss && !this.bossSpawned) {
        this.bossSpawned = true;
        this.waveTotal = boss.count;
        this.waveNeed = boss.count;
        this.enqueue(boss, undefined, this.waveIndex);
        this.phase = 'boss';
        this.waveText = script.bossObjective ?? ENCOUNTER.bossObjective;
        this.emitObjective(this.waveText, 0, boss.count);
      } else {
        this.complete();
      }
      return;
    }

    const wave = script.waves[this.waveIndex];
    // Built here rather than in the reporter: that runs 120 times a second, and
    // a template literal per step is a per-frame allocation in a hot path.
    this.waveText = wave.objective ?? `Clear wave ${this.waveIndex + 1} of ${script.waves.length}`;
    this.waveTotal = 0;
    for (let i = 0; i < wave.units.length; i++) this.waveTotal += wave.units[i].count;
    this.waveNeed = Math.ceil(this.waveTotal * clamp01(this.clearFraction(script, wave)));
    this.armTrigger(wave.trigger, target);
    for (let i = 0; i < wave.units.length; i++) this.enqueue(wave.units[i], wave.volumes, this.waveIndex);
    this.waveSpawned = 0;
    this.phase = 'spawning';
    this.reportObjective(script, target);
  }

  /**
   * How much of this wave has to die before the next thing arrives. The
   * successor states its own entry price; the last wave answers to the boss,
   * which asks for all of it.
   */
  private clearFraction(script: EncounterScript, wave: WaveSpec): number {
    const trigger = wave.trigger;
    if (trigger && trigger.kind === 'clear' && trigger.fraction !== undefined) {
      return trigger.fraction;
    }
    const next = script.waves[this.waveIndex + 1];
    return next ? next.triggerFraction ?? 1 : 1;
  }

  private resetWaveState(): void {
    this.waveText = '';
    this.holdTime = 0;
    this.destroyTarget = null;
    this.reachSpan = 1;
    // Force the next objective emit through even if the line is identical.
    this.lastObjText = null;
    this.lastObjProgress = -1;
    this.lastObjTotal = -1;
  }

  private armTrigger(trigger: WaveTrigger | undefined, target: TargetSignature): void {
    if (!trigger) return;
    if (trigger.kind === 'reach') {
      // Remember how far away the player started so the HUD bar can fill on the
      // way in rather than sitting empty until it snaps to done.
      this.reachSpan = Math.max(1, this.distanceXZ(trigger.position, target) - trigger.radius);
    } else if (trigger.kind === 'destroy') {
      this.destroyTarget = this.targets.get(trigger.targetId) ?? null;
    }
  }

  private distanceXZ(p: WavePoint, target: TargetSignature): number {
    const dx = target.centre.x - p.x;
    const dz = target.centre.z - p.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /** Advance timed trigger state and report whether this wave is finished. */
  private tickTrigger(dt: number, script: EncounterScript, target: TargetSignature): boolean {
    if (this.phase === 'boss') return this.waveKilled >= this.waveNeed;
    const wave = script.waves[this.waveIndex];
    if (!wave) return true;
    const trigger = wave.trigger;
    if (!trigger) return this.waveKilled >= this.waveNeed;

    switch (trigger.kind) {
      case 'clear':
        return this.waveKilled >= this.waveNeed;
      case 'reach':
        return !target.dead && this.distanceXZ(trigger.position, target) <= trigger.radius;
      case 'hold': {
        if (!target.dead && this.distanceXZ(trigger.position, target) <= trigger.radius) {
          this.holdTime += dt;
        }
        return this.holdTime >= trigger.seconds;
      }
      case 'destroy': {
        // Resolve late as well as early: a level may build the object after the
        // encounter starts, and a wave that can never finish is worse than one
        // that finishes on kills.
        if (!this.destroyTarget) this.destroyTarget = this.targets.get(trigger.targetId) ?? null;
        const t = this.destroyTarget;
        if (!t) return this.waveKilled >= this.waveNeed;
        return t.health <= 0;
      }
    }
  }

  /**
   * Push the HUD line and its counter. The counter means something different
   * per trigger — kills, metres closed, seconds held, damage done — but always
   * reads as `progress / total`, which is all the bar renders.
   */
  private reportObjective(script: EncounterScript, target: TargetSignature): void {
    if (this.phase === 'boss') {
      this.emitObjective(this.waveText, Math.min(this.waveKilled, this.waveTotal), this.waveTotal);
      return;
    }
    const wave = script.waves[this.waveIndex];
    if (!wave) return;
    const text = this.waveText;
    const trigger = wave.trigger;

    if (trigger) {
      switch (trigger.kind) {
        case 'reach': {
          const left = Math.max(0, this.distanceXZ(trigger.position, target) - trigger.radius);
          const closed = clamp01(1 - left / this.reachSpan);
          this.emitObjective(text, Math.round(closed * ENCOUNTER.reachSteps), ENCOUNTER.reachSteps);
          return;
        }
        case 'hold': {
          const total = Math.max(1, Math.round(trigger.seconds));
          this.emitObjective(text, Math.min(Math.floor(this.holdTime), total), total);
          return;
        }
        case 'destroy': {
          const t = this.destroyTarget;
          if (t) {
            const done = clamp01(1 - Math.max(0, t.health) / Math.max(1, t.maxHealth));
            this.emitObjective(text, Math.round(done * 100), 100);
            return;
          }
          break; // no target yet — fall through to the kill count
        }
        default:
          break; // 'clear' is the kill count
      }
    }
    this.emitObjective(text, Math.min(this.waveKilled, this.waveNeed), this.waveNeed);
  }

  /**
   * Emit only on a change. This runs every simulation step, and building a
   * fresh payload 120 times a second is exactly the kind of quiet allocation
   * that turns into a GC hitch mid-firefight.
   */
  private emitObjective(text: string, progress: number, total: number): void {
    if (text === this.lastObjText && progress === this.lastObjProgress && total === this.lastObjTotal) {
      return;
    }
    this.lastObjText = text;
    this.lastObjProgress = progress;
    this.lastObjTotal = total;
    events.emit('objective:updated', { text, progress, total });
  }

  /** This wave is done: close it out and start the clock on the next one. */
  private advance(script: EncounterScript): void {
    if (this.phase === 'boss') {
      this.complete();
      return;
    }
    const wave = script.waves[this.waveIndex];
    events.emit('objective:completed', {
      text: wave?.objective ?? `Wave ${this.waveIndex + 1} cleared`,
    });
    const next = script.waves[this.waveIndex + 1];
    // The pause belongs to the wave that follows it, which is what `delay` has
    // always claimed in its doc comment and never once did.
    this.waveTimer = next ? next.delay ?? 0 : script.bossDelay ?? ENCOUNTER.bossDelay;
    this.phase = 'waiting';
  }

  private complete(): void {
    const script = this.script;
    this.phase = 'complete';
    if (!script) return;
    events.emit('objective:completed', { text: script.title ?? 'Encounter complete' });
    if (script.completesLevel) {
      events.emit('level:cleared', { id: script.id, score: script.score });
    }
  }

  /**
   * Pull one queued unit per `spawnInterval` and try to place it. Spacing the
   * arrivals out is deliberate: six enemies materialising on one frame reads as
   * a cheat, three arriving over two seconds reads as a flanking manoeuvre.
   */
  private drainQueue(dt: number, target: TargetSignature): void {
    if (this.queue.length === 0) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;

    const budget = settings.profile.enemyBudget;
    if (hostAliveCount(this.host) >= Math.min(budget, this.targetPopulation)) return;

    const pending = this.queue[0];
    if (!this.placeSpawn(pending, target, _cand)) {
      // No valid hidden position right now — retry shortly rather than cheating.
      this.spawnTimer = 0.35;
      return;
    }
    const yaw = Math.atan2(target.centre.x - _cand.x, target.centre.z - _cand.z);
    const agent = this.host.spawn(pending.archetype, _cand, yaw);
    this.spawnTimer = ENCOUNTER.spawnInterval;
    if (agent) {
      this.waveOf.set(agent.entityId, pending.wave);
      this.queue.shift();
      this.waveSpawned++;
    } else {
      // The manager refused (budget/pool exhausted); back off and try later.
      this.spawnTimer = 1;
    }
  }

  /** Choose a hidden, reachable point for one pending spawn. */
  private placeSpawn(p: PendingSpawn, target: TargetSignature, out: THREE.Vector3): boolean {
    const nav = this.nav;
    // Reinforcements arrive near the squad that called them, everything else
    // from a registered volume.
    if (p.nearValid) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const ang = this.rng.next() * Math.PI * 2;
        const r = 6 + this.rng.next() * 12;
        _v.set(p.near.x + Math.sin(ang) * r, p.near.y, p.near.z + Math.cos(ang) * r);
        if (this.acceptSpawn(_v, target, out)) return true;
      }
      return false;
    }

    const candidates = this.volumes;
    if (candidates.length === 0) {
      if (!nav) return false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const ang = this.rng.next() * Math.PI * 2;
        const r = ENCOUNTER.minSpawnDistance + this.rng.next() * 34;
        _v.set(target.centre.x + Math.sin(ang) * r, target.centre.y, target.centre.z + Math.cos(ang) * r);
        if (this.acceptSpawn(_v, target, out)) return true;
      }
      return false;
    }

    // Prefer volumes that are far from the player and off cooldown, and try a
    // few so a blocked one does not stall the wave.
    const start = this.rng.int(0, candidates.length - 1);
    for (let k = 0; k < candidates.length; k++) {
      const v = candidates[(start + k) % candidates.length];
      if (!v.enabled || v.cooldown > 0) continue;
      if (p.volume && v.id !== p.volume) continue;
      if (p.volume === null && v.archetypes.length > 0 && v.archetypes.indexOf(p.archetype) < 0) {
        continue;
      }
      if (v.position.distanceTo(target.centre) < v.minPlayerDistance) continue;
      for (let attempt = 0; attempt < 5; attempt++) {
        const ang = this.rng.next() * Math.PI * 2;
        const r = this.rng.next() * v.radius;
        _v.set(v.position.x + Math.sin(ang) * r, v.position.y, v.position.z + Math.cos(ang) * r);
        if (this.acceptSpawn(_v, target, out)) {
          v.cooldown = 1.2;
          return true;
        }
      }
    }
    return false;
  }

  /** Distance, reachability and visibility tests for one candidate point. */
  private acceptSpawn(candidate: THREE.Vector3, target: TargetSignature, out: THREE.Vector3): boolean {
    const nav = this.nav;
    if (!nav || !nav.snap(candidate, out, 8)) return false;
    const cell = nav.nearestWalkableCell(out.x, out.z, 3);
    if (cell < 0) return false;
    if (nav.mainRegion >= 0 && nav.region[cell] !== nav.mainRegion) return false;

    const dx = out.x - target.centre.x;
    const dz = out.z - target.centre.z;
    const dist = Math.hypot(dx, dz);
    if (dist < ENCOUNTER.minSpawnDistance || dist > ENCOUNTER.maxSpawnDistance) return false;

    // Out of view: either behind the player's cone, or occluded from their eye.
    const los = this.lineOfSight;
    _eye.set(out.x, out.y + 1.5, out.z);
    if (los && los(target.eye, _eye)) {
      // Visible geometry-wise — only acceptable if it is well outside the cone.
      const fx = target.forward.x;
      const fz = target.forward.z;
      const fl = Math.hypot(fx, fz) || 1;
      const cosA = (dx * fx + dz * fz) / (dist * fl);
      if (cosA > Math.cos(ENCOUNTER.viewCone)) return false;
    }
    return true;
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.volumes.length = 0;
    this.queue.length = 0;
    this.waveOf.clear();
    this.targets.clear();
    this.script = null;
    this.phase = 'idle';
  }
}
