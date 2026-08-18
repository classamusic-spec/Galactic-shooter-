/**
 * EncounterDirector — who fights you, how many, when, and from where.
 *
 * This is the pacing system. Three rules drive everything:
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

export interface WaveSpec {
  units: WaveUnit[];
  /** Seconds to wait after the trigger condition before the wave begins. */
  delay: number;
  /** Fraction of the previous wave that must be dead before this one arms. */
  triggerFraction: number;
  /** Objective line pushed to the HUD when the wave starts. */
  objective?: string;
  /** Spawn volumes to restrict this wave to, by id. */
  volumes?: string[];
}

export interface EncounterScript {
  id: string;
  waves: WaveSpec[];
  /** Optional final unit, spawned after the last wave clears. */
  boss?: WaveUnit;
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
} as const;

interface PendingSpawn {
  archetype: string;
  volume: string | null;
  /** Marks the spawn as reinforcement so it can join an existing squad. */
  reinforcement: boolean;
  readonly near: THREE.Vector3;
  nearValid: boolean;
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
  private waveKilled = 0;
  private waveTotal = 0;
  private bossSpawned = false;
  private lastReportedKills = -1;

  // Rolling performance signals.
  private damageTaken = 0;
  private killsRecent = 0;
  private sinceContact = 0;
  private unsubs: Array<() => void> = [];

  /** Set by the director each step so spawn placement can use it. */
  private lineOfSight: ((a: THREE.Vector3, b: THREE.Vector3) => boolean) | null = null;

  /** Live count of enemies this director has placed and that are still alive. */
  private tracked = new Set<number>();

  constructor(host: AiEnemyHost) {
    this.host = host;
    this.unsubs.push(
      events.on('enemy:killed', (p) => {
        this.killsRecent += 1;
        this.tracked.delete(p.entityId);
        if (this.phase === 'spawning' || this.phase === 'fighting' || this.phase === 'boss') {
          this.waveKilled++;
        }
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
    this.tracked.clear();
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

  // -- scripts ---------------------------------------------------------------

  /** Begin a scripted encounter. Replaces any encounter already running. */
  start(script: EncounterScript): void {
    this.script = script;
    this.phase = 'waiting';
    this.waveIndex = -1;
    this.waveTimer = 0;
    this.waveKilled = 0;
    this.waveTotal = 0;
    this.waveSpawned = 0;
    this.bossSpawned = false;
    this.queue.length = 0;
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
      });
    }
    events.emit('ui:toast', { text: 'REINFORCEMENTS INBOUND', duration: 2.6 });
    return true;
  }

  /** Queue an ad-hoc group without a script. Used by level triggers. */
  queueUnits(units: readonly WaveUnit[], volumeIds?: readonly string[]): void {
    for (const u of units) {
      for (let i = 0; i < u.count; i++) {
        this.queue.push({
          archetype: u.archetype,
          volume: volumeIds && volumeIds.length ? volumeIds[i % volumeIds.length] : null,
          reinforcement: false,
          near: new THREE.Vector3(),
          nearValid: false,
        });
      }
    }
    if (this.phase === 'idle') this.phase = 'spawning';
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

  private updateScript(dt: number, target: TargetSignature): void {
    const script = this.script;
    if (!script) return;

    switch (this.phase) {
      case 'waiting': {
        this.waveTimer -= dt;
        if (this.waveTimer > 0) return;
        this.waveIndex++;
        if (this.waveIndex >= script.waves.length) {
          if (script.boss && !this.bossSpawned) {
            this.bossSpawned = true;
            this.waveKilled = 0;
            this.waveTotal = script.boss.count;
            this.queueUnits([script.boss]);
            this.phase = 'boss';
            events.emit('objective:updated', {
              text: 'Eliminate the champion',
              progress: 0,
              total: script.boss.count,
            });
          } else {
            this.complete();
          }
          return;
        }
        const wave = script.waves[this.waveIndex];
        this.waveKilled = 0;
        this.lastReportedKills = -1;
        this.waveSpawned = 0;
        this.waveTotal = wave.units.reduce((a, u) => a + u.count, 0);
        this.queueUnits(wave.units, wave.volumes);
        this.phase = 'spawning';
        events.emit('objective:updated', {
          text: wave.objective ?? `Clear wave ${this.waveIndex + 1} of ${script.waves.length}`,
          progress: 0,
          total: this.waveTotal,
        });
        break;
      }
      case 'spawning':
        if (this.queue.length === 0) this.phase = 'fighting';
        break;
      case 'fighting':
      case 'boss': {
        const remaining = Math.max(0, this.waveTotal - this.waveKilled);
        const wave = this.phase === 'boss' ? null : script.waves[this.waveIndex];
        const need = wave
          ? Math.ceil(this.waveTotal * clamp01(wave.triggerFraction || 1))
          : this.waveTotal;
        // Only on a change: this runs every simulation step, and emitting a
        // fresh payload object 120 times a second is exactly the kind of quiet
        // allocation that turns into a GC hitch mid-firefight.
        if (this.waveKilled !== this.lastReportedKills) {
          this.lastReportedKills = this.waveKilled;
          events.emit('objective:updated', {
            text:
              this.phase === 'boss'
                ? 'Eliminate the champion'
                : wave?.objective ?? `Clear wave ${this.waveIndex + 1} of ${script.waves.length}`,
            progress: Math.min(this.waveKilled, this.waveTotal),
            total: this.waveTotal,
          });
        }
        if (this.waveKilled >= need && remaining <= this.waveTotal - need) {
          if (this.phase === 'boss') {
            this.complete();
          } else {
            events.emit('objective:completed', {
              text: wave?.objective ?? `Wave ${this.waveIndex + 1} cleared`,
            });
            this.waveTimer = wave ? wave.delay : 4;
            this.phase = 'waiting';
          }
        }
        break;
      }
      default:
        break;
    }
    void target;
  }

  private complete(): void {
    const script = this.script;
    this.phase = 'complete';
    if (!script) return;
    events.emit('objective:completed', { text: 'Encounter complete' });
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
      this.tracked.add(agent.entityId);
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
    this.tracked.clear();
    this.script = null;
    this.phase = 'idle';
  }
}
