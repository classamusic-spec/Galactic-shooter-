/**
 * CoverMap — precomputed places worth standing.
 *
 * A firefight reads as *designed* rather than *emergent* when enemies always
 * have somewhere sensible to be. Rather than reasoning about geometry at query
 * time (expensive, and it produces the "enemy stands next to a rock but on the
 * wrong side of it" bug), we bake it:
 *
 *   for every walkable cell that touches blocked space, fire eight compass
 *   probes at crouch height and again at standing height, and record which
 *   directions are protected as a bitmask.
 *
 * A query then reduces to "which of my 400 points is protected from *that*
 * bearing, near me, and inside my weapon's range" — a linear scan over packed
 * arrays with one confirming raycast on the winner. That is fast enough to run
 * whenever an agent needs a decision, which is what lets the whole squad
 * reposition when the player pushes.
 */
import * as THREE from 'three';
import type { CollisionWorld } from '@/types';
import { clamp01 } from '@/util/math';
import { NAV_NEAR_WALL, NAV_WALKABLE, type NavGrid } from './NavGrid';

/** 8 compass directions, angle = k * 45°, x = sin, z = cos. */
const CDX = new Float32Array(8);
const CDZ = new Float32Array(8);
for (let k = 0; k < 8; k++) {
  const a = (k * Math.PI) / 4;
  CDX[k] = Math.sin(a);
  CDZ[k] = Math.cos(a);
}

/** Compass bucket for a world-space XZ direction. */
export function compassIndex(dx: number, dz: number): number {
  const a = Math.atan2(dx, dz);
  return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
}

export interface CoverPoint {
  index: number;
  /** Cell index in the nav grid. */
  cell: number;
  /** Stand position on the ground. */
  readonly position: THREE.Vector3;
  /** Unit XZ vector pointing to the open side of the cover. */
  readonly outward: THREE.Vector3;
  /** Bit k set when a crouching agent is protected from compass direction k. */
  lowMask: number;
  /** Bit k set when a standing agent is protected from compass direction k. */
  highMask: number;
  /** 0..1 — fraction of the compass that is blocked. */
  quality: number;
  /** Entity currently claiming this point; -1 when free. */
  claimedBy: number;
  /** Seconds before this point may be re-claimed after a release. */
  cooldown: number;
}

export interface CoverQuery {
  /** Who is asking; used so an agent can re-pick the point it already holds. */
  entityId: number;
  /** Where the agent is now — nearer cover wins. */
  from: THREE.Vector3;
  /** The thing being hidden from (usually the player's eye). */
  threat: THREE.Vector3;
  /** Reject cover closer to the threat than this. */
  minRange: number;
  /** Reject cover further from the threat than this — cover out of weapon range
   *  is just hiding, and hiding is not a fight. */
  maxRange: number;
  /** Reject cover further than this from the agent. */
  maxTravel: number;
  /** Prefer full-height cover (true) or is crouch cover fine (false)? */
  preferHigh: boolean;
}

const _v = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();

type CoverPhase = 'idle' | 'scan' | 'probe' | 'ready';

export class CoverMap {
  readonly points: CoverPoint[] = [];
  private grid: NavGrid;
  private world: CollisionWorld;
  private phase: CoverPhase = 'idle';
  private cursor = 0;
  private stride = 1;
  private candidateCount = 0;
  private maxPoints: number;
  /** Probe reach beyond the agent radius, metres. */
  private probeLength = 1.55;
  private claims = new Map<number, number>();
  /** Rays cast during the build, for reporting. */
  raysCast = 0;
  /** Query diagnostics, surfaced in the AI debug snapshot. */
  readonly stats = { queries: 0, hits: 0, rejectRange: 0, rejectTravel: 0, rejectBearing: 0, rejectClaimed: 0 };

  constructor(grid: NavGrid, world: CollisionWorld, maxPoints = 384) {
    this.grid = grid;
    this.world = world;
    this.maxPoints = Math.max(32, maxPoints);
    this.phase = 'scan';
  }

  get ready(): boolean {
    return this.phase === 'ready';
  }

  get progress(): number {
    if (this.phase === 'ready') return 1;
    if (this.phase === 'scan') return this.cursor / Math.max(1, this.grid.count) * 0.2;
    return 0.2 + (this.cursor / Math.max(1, this.grid.count)) * 0.8;
  }

  /**
   * Incremental build. Requires the nav grid to be `ready`; call once per step.
   * Wall-clock here is a loading budget, never gameplay timing.
   */
  step(budgetMs = 1): void {
    if (this.phase === 'ready' || this.phase === 'idle') return;
    if (!this.grid.ready) return;
    const deadline = performance.now() + budgetMs;
    while (performance.now() < deadline) {
      if (this.phase === 'scan') {
        if (!this.scanChunk(8192)) {
          // Sub-sample so a large level does not produce ten thousand points.
          this.stride = Math.max(1, Math.ceil(this.candidateCount / this.maxPoints));
          this.cursor = 0;
          this.phase = 'probe';
        }
      } else if (this.phase === 'probe') {
        if (!this.probeChunk(24)) {
          this.phase = 'ready';
          break;
        }
      } else break;
    }
  }

  buildBlocking(): void {
    let guard = 0;
    while (!this.ready && guard++ < 100000) this.step(8);
  }

  private scanChunk(cells: number): boolean {
    const end = Math.min(this.grid.count, this.cursor + cells);
    const flags = this.grid.flags;
    for (let i = this.cursor; i < end; i++) {
      if ((flags[i] & NAV_WALKABLE) === 0) continue;
      if ((flags[i] & NAV_NEAR_WALL) === 0) continue;
      this.candidateCount++;
    }
    this.cursor = end;
    return this.cursor < this.grid.count;
  }

  private probeChunk(maxPoints: number): boolean {
    const flags = this.grid.flags;
    let made = 0;
    let seen = 0;
    while (this.cursor < this.grid.count && made < maxPoints) {
      const i = this.cursor++;
      if ((flags[i] & NAV_WALKABLE) === 0) continue;
      if ((flags[i] & NAV_NEAR_WALL) === 0) continue;
      if (this.stride > 1 && seen++ % this.stride !== 0) continue;
      if (this.points.length >= this.maxPoints) {
        this.cursor = this.grid.count;
        break;
      }
      if (this.probeCell(i)) made++;
    }
    return this.cursor < this.grid.count;
  }

  /** Fire the compass probes for one candidate cell. Returns true if kept. */
  private probeCell(cell: number): boolean {
    const grid = this.grid;
    grid.cellCentre(cell, _v);
    const lowY = _v.y + 0.75;
    const highY = _v.y + 1.55;
    let lowMask = 0;
    let highMask = 0;
    let openX = 0;
    let openZ = 0;
    let blocked = 0;

    for (let k = 0; k < 8; k++) {
      _dir.set(CDX[k], 0, CDZ[k]);
      _eye.set(_v.x, lowY, _v.z);
      this.raysCast++;
      const low = this.world.raycast(_eye, _dir, this.probeLength);
      if (low) {
        lowMask |= 1 << k;
        blocked++;
        _eye.set(_v.x, highY, _v.z);
        this.raysCast++;
        if (this.world.raycast(_eye, _dir, this.probeLength)) highMask |= 1 << k;
      } else {
        openX += CDX[k];
        openZ += CDZ[k];
      }
    }

    // Useless if nothing blocks, and useless if everything does (a crevice you
    // cannot shoot out of is a trap, not cover).
    if (blocked === 0 || blocked >= 7) return false;

    const ol = Math.hypot(openX, openZ);
    const point: CoverPoint = {
      index: this.points.length,
      cell,
      position: _v.clone(),
      outward: new THREE.Vector3(ol > 1e-4 ? openX / ol : 0, 0, ol > 1e-4 ? openZ / ol : 1),
      lowMask,
      highMask,
      quality: clamp01(blocked / 6),
      claimedBy: -1,
      cooldown: 0,
    };
    this.points.push(point);
    return true;
  }

  // -- runtime ---------------------------------------------------------------

  update(dt: number): void {
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (p.cooldown > 0) p.cooldown -= dt;
    }
  }

  /** Is a compass bearing covered from this point? */
  protectedFrom(p: CoverPoint, dx: number, dz: number, high: boolean): boolean {
    const k = compassIndex(dx, dz);
    const mask = high ? p.highMask : p.lowMask;
    // Accept the exact bearing or either neighbour — cover is not a laser.
    const kl = (k + 7) & 7;
    const kr = (k + 1) & 7;
    return (mask & (1 << k)) !== 0 || ((mask & (1 << kl)) !== 0 && (mask & (1 << kr)) !== 0);
  }

  /**
   * Best cover point for a query, or null. Scores travel distance, standoff
   * error against the agent's weapon envelope, cover quality and whether the
   * point is already taken; then confirms the winner with one real occlusion
   * ray, because a bitmask baked at build time can be wrong for an elevated
   * threat.
   */
  find(q: CoverQuery): CoverPoint | null {
    if (!this.ready) return null;
    this.stats.queries++;
    const idealRange = (q.minRange + q.maxRange) * 0.5;
    let best: CoverPoint | null = null;
    let bestScore = -Infinity;
    let secondBest: CoverPoint | null = null;
    let secondScore = -Infinity;

    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (p.claimedBy >= 0 && p.claimedBy !== q.entityId) {
        this.stats.rejectClaimed++;
        continue;
      }
      if (p.cooldown > 0 && p.claimedBy !== q.entityId) {
        this.stats.rejectClaimed++;
        continue;
      }

      const tdx = p.position.x - q.threat.x;
      const tdz = p.position.z - q.threat.z;
      const tDist = Math.hypot(tdx, tdz);
      if (tDist < q.minRange || tDist > q.maxRange) {
        this.stats.rejectRange++;
        continue;
      }

      const adx = p.position.x - q.from.x;
      const adz = p.position.z - q.from.z;
      const travel = Math.hypot(adx, adz);
      if (travel > q.maxTravel) {
        this.stats.rejectTravel++;
        continue;
      }

      // Bearing the threat attacks from = threat → point.
      const high = this.protectedFrom(p, -tdx, -tdz, true);
      const low = high || this.protectedFrom(p, -tdx, -tdz, false);
      if (!low) {
        this.stats.rejectBearing++;
        continue;
      }

      let score = 0;
      score += p.quality * 2.2;
      score += high ? 1.4 : q.preferHigh ? 0 : 0.8;
      score -= (travel / Math.max(1, q.maxTravel)) * 3.4;
      score -= (Math.abs(tDist - idealRange) / Math.max(1, idealRange)) * 2.0;
      if (p.claimedBy === q.entityId) score += 1.1; // stickiness beats churn
      // Slight preference for cover that is not directly between us and the
      // threat, so the squad spreads across the arena rather than lining up.
      const lateral = Math.abs(adx * tdz - adz * tdx) / Math.max(1, travel * tDist);
      score += lateral * 0.6;

      if (score > bestScore) {
        secondBest = best;
        secondScore = bestScore;
        best = p;
        bestScore = score;
      } else if (score > secondScore) {
        secondBest = p;
        secondScore = score;
      }
    }

    if (!best) return null;
    this.stats.hits++;
    if (this.confirm(best, q.threat)) return best;
    if (secondBest && this.confirm(secondBest, q.threat)) return secondBest;
    return best;
  }

  /** One ray: is a crouched agent at this point actually hidden from `threat`? */
  private confirm(p: CoverPoint, threat: THREE.Vector3): boolean {
    _eye.set(p.position.x, p.position.y + 0.8, p.position.z);
    return !this.world.lineOfSight(_eye, threat);
  }

  /**
   * A position that attacks the threat from a different bearing than `from`.
   * `side` is -1 for the threat's left, +1 for its right. Returns false when the
   * nav grid has nothing suitable — the caller should then just advance.
   */
  findFlank(
    threat: THREE.Vector3,
    from: THREE.Vector3,
    side: number,
    radius: number,
    out: THREE.Vector3,
  ): boolean {
    const grid = this.grid;
    // Bearing from the threat back to the agent — the flank swings away from it.
    const bx = from.x - threat.x;
    const bz = from.z - threat.z;
    const bl = Math.hypot(bx, bz) || 1;
    const nx = bx / bl;
    const nz = bz / bl;
    // Rotate by ±70° around the threat.
    const ang = side >= 0 ? 1.22 : -1.22;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const wantX = threat.x + (nx * ca - nz * sa) * radius;
    const wantZ = threat.z + (nx * sa + nz * ca) * radius;
    _v.set(wantX, threat.y, wantZ);

    // Cheap path first: the ideal flank point is usually already walkable, and
    // a spiral snap costs a couple of dozen cell tests. Only when it is inside
    // geometry do we pay for the scored ring search.
    if (grid.snap(_v, out, 5)) {
      const dx = out.x - wantX;
      const dz = out.z - wantZ;
      if (dx * dx + dz * dz < 9) return true;
    }

    const cell = grid.findNear(_v, 0, Math.min(9, radius * 0.55), (_i, x, z, y) => {
      const d = Math.hypot(x - wantX, z - wantZ);
      const tDist = Math.hypot(x - threat.x, z - threat.z);
      // Want it near the ideal flank spot and at roughly the requested standoff.
      return -d - Math.abs(tDist - radius) * 0.8 + (y > threat.y ? 0.5 : 0);
    });
    if (cell < 0) return false;
    grid.cellCentre(cell, out);
    return true;
  }

  /**
   * A position with a clear shot at the threat, at the requested standoff,
   * that is not where the agent already is. Used by "never stand still shooting
   * in the open" — when an agent has no cover it still keeps moving to a new
   * firing position instead of rooting.
   */
  findFiringPosition(
    threat: THREE.Vector3,
    from: THREE.Vector3,
    radius: number,
    spread: number,
    out: THREE.Vector3,
  ): boolean {
    const grid = this.grid;
    const cell = grid.findNear(from, 2.5, spread, (_i, x, z, y) => {
      const tDist = Math.hypot(x - threat.x, z - threat.z);
      const rangeErr = Math.abs(tDist - radius);
      _eye.set(x, y + 1.1, z);
      // Cheap first: reject anything wildly off-range before paying for a ray.
      if (rangeErr > radius * 0.6) return -Infinity;
      return -rangeErr;
    });
    if (cell < 0) return false;
    grid.cellCentre(cell, out);
    _eye.set(out.x, out.y + 1.1, out.z);
    return this.world.lineOfSight(_eye, threat);
  }

  // -- claims ----------------------------------------------------------------

  claim(p: CoverPoint, entityId: number): void {
    const prev = this.claims.get(entityId);
    if (prev !== undefined && prev !== p.index) this.releaseIndex(prev, entityId);
    p.claimedBy = entityId;
    this.claims.set(entityId, p.index);
  }

  release(entityId: number): void {
    const idx = this.claims.get(entityId);
    if (idx === undefined) return;
    this.releaseIndex(idx, entityId);
    this.claims.delete(entityId);
  }

  private releaseIndex(index: number, entityId: number): void {
    const p = this.points[index];
    if (p && p.claimedBy === entityId) {
      p.claimedBy = -1;
      p.cooldown = 1.4;
    }
  }

  claimedPoint(entityId: number): CoverPoint | null {
    const idx = this.claims.get(entityId);
    return idx === undefined ? null : this.points[idx] ?? null;
  }

  dispose(): void {
    this.points.length = 0;
    this.claims.clear();
    this.phase = 'idle';
  }
}
