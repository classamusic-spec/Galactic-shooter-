/**
 * NavGrid — the navigation substrate for every AI in the game.
 *
 * Design notes, because the choices here are load-bearing:
 *
 *  - **A uniform 0.75 m grid, not a navmesh.** Levels are procedurally generated
 *    heightfields with scattered props; there is no authored geometry to build a
 *    proper navmesh from and no budget to run a voxel-to-mesh pipeline in a
 *    browser. A grid sampled from `collision.sampleGround` gets us 95% of the
 *    quality for 5% of the complexity, and string-pulling removes the staircase
 *    artefacts that make grid paths look robotic.
 *
 *  - **The build is incremental.** Sampling ~80 000 cells means ~80 000 ground
 *    samples plus a clearance raycast each; doing that in one go would stall the
 *    first second of a level. `step()` consumes a millisecond budget per frame
 *    and the grid reports `ready` when it is done. `performance.now()` appears
 *    here *only* as a loader work budget — never as gameplay timing.
 *
 *  - **A* is for one-off precise queries; the flow field is for the crowd.**
 *    Thirty enemies all running A* to the same player is thirty times the work
 *    for one answer. A single Dijkstra pass outward from the player, refreshed a
 *    few times a second, gives every agent a gradient to follow for free.
 *
 *  - **No allocation after construction.** Every search structure is a typed
 *    array with a generation stamp so it never needs clearing.
 */
import * as THREE from 'three';
import type { CollisionWorld } from '@/types';
import { clamp, scratch } from '@/util/math';

// -- cell flags --------------------------------------------------------------

/** Ground was successfully sampled for this cell. */
export const NAV_SAMPLED = 1 << 0;
/** Cell is standable: slope, clearance and step tests all passed. */
export const NAV_WALKABLE = 1 << 1;
/** At least one 4-neighbour is blocked — the seed set for cover points. */
export const NAV_NEAR_WALL = 1 << 2;
/** A big downward step to a neighbour: agents should not casually walk off. */
export const NAV_LEDGE = 1 << 3;
/** Open on all sides — good for flanking routes, bad for hiding. */
export const NAV_OPEN = 1 << 4;

/** 8-neighbour offsets. Odd indices are diagonals. */
const NX = new Int8Array([1, 1, 0, -1, -1, -1, 0, 1]);
const NZ = new Int8Array([0, 1, 1, 1, 0, -1, -1, -1]);
const NDIST = new Float32Array([1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2]);

export interface NavGridOptions {
  /** Cell edge length in metres. */
  cellSize: number;
  /** Radius of the agent the grid is built for. */
  agentRadius: number;
  /** Standing height that must be clear above a walkable cell. */
  agentHeight: number;
  /** Steepest standable ground, radians. */
  maxSlope: number;
  /** Largest height difference an agent may traverse between neighbours. */
  maxStep: number;
  /** Hard cap on cells per axis, so a huge level cannot blow the memory budget. */
  maxCellsPerAxis: number;
}

export const NAV_DEFAULTS: NavGridOptions = {
  cellSize: 0.75,
  agentRadius: 0.42,
  agentHeight: 1.9,
  maxSlope: 0.78,
  maxStep: 0.55,
  maxCellsPerAxis: 288,
};

export type NavBuildPhase = 'idle' | 'sampling' | 'linking' | 'regions' | 'ready';

/** Longest path the pathfinder will return. Longer routes get truncated and
 *  re-planned on arrival, which is what you want anyway for a moving target. */
export const MAX_PATH_POINTS = 96;

/**
 * A pooled path. Agents own one for their lifetime; `findPath` writes into it.
 */
export class NavPath {
  readonly points: THREE.Vector3[] = [];
  /** Number of valid entries in `points`. */
  count = 0;
  /** Index of the waypoint the agent is currently steering toward. */
  cursor = 0;
  /** True when the last plan succeeded and reached the requested goal cell. */
  complete = false;
  /** Goal the path was planned to; used to decide whether to re-plan. */
  readonly goal = new THREE.Vector3();
  /** Cost of the path in metres. */
  length = 0;

  constructor() {
    for (let i = 0; i < MAX_PATH_POINTS; i++) this.points.push(new THREE.Vector3());
  }

  clear(): void {
    this.count = 0;
    this.cursor = 0;
    this.complete = false;
    this.length = 0;
  }

  get done(): boolean {
    return this.cursor >= this.count;
  }

  /** Current waypoint, or null when the path is exhausted. */
  current(): THREE.Vector3 | null {
    return this.cursor < this.count ? this.points[this.cursor] : null;
  }

  /** Waypoint after the current one — used for corner-cutting lookahead. */
  next(): THREE.Vector3 | null {
    return this.cursor + 1 < this.count ? this.points[this.cursor + 1] : null;
  }

  advance(): void {
    if (this.cursor < this.count) this.cursor++;
  }
}

// ---------------------------------------------------------------------------
// Flow field
// ---------------------------------------------------------------------------

/**
 * A Dijkstra distance field flowing toward a single goal cell.
 *
 * Double-buffered: agents always read a finished field while the next one is
 * built incrementally in the background, so a rebuild never produces a frame of
 * garbage directions (which is exactly what makes crowds jitter).
 */
export class FlowField {
  private grid: NavGrid;
  private a: Float32Array;
  private b: Float32Array;
  /** The finished field agents read. */
  private front: Float32Array;
  /** The field currently being built. */
  private back: Float32Array;

  private heap: Int32Array;
  private heapPos: Int32Array;
  private heapCount = 0;

  private building = false;
  private clearCursor = 0;
  private clearing = false;
  /** Cells whose cost exceeds this are not expanded — keeps the field local. */
  maxCost = 96;

  goalCell = -1;
  private pendingGoal = -1;
  /** Goal of the field currently readable. */
  readonly goalPosition = new THREE.Vector3();
  private pendingGoalPosition = new THREE.Vector3();
  /** Incremented every time a new field becomes readable. */
  generation = 0;
  hasField = false;

  constructor(grid: NavGrid) {
    this.grid = grid;
    const n = grid.count;
    this.a = new Float32Array(n);
    this.b = new Float32Array(n);
    this.a.fill(Infinity);
    this.b.fill(Infinity);
    this.front = this.a;
    this.back = this.b;
    this.heap = new Int32Array(n + 1);
    this.heapPos = new Int32Array(n);
    this.heapPos.fill(-1);
  }

  /** Queue a rebuild toward `position`. Cheap; the work happens in `step`. */
  requestGoal(position: THREE.Vector3): void {
    const cell = this.grid.nearestWalkableCell(position.x, position.z, 6);
    if (cell < 0) return;
    this.pendingGoal = cell;
    this.pendingGoalPosition.copy(position);
  }

  /** True when a rebuild is neither running nor queued. */
  get idle(): boolean {
    return !this.building && this.pendingGoal < 0;
  }

  /**
   * Advance the incremental build. `budget` is the number of heap pops allowed
   * this step — a deterministic unit of work, not a wall-clock slice.
   */
  step(budget: number): void {
    if (!this.building) {
      if (this.pendingGoal < 0) return;
      this.building = true;
      this.clearing = true;
      this.clearCursor = 0;
      this.goalCell = this.pendingGoal;
      this.pendingGoal = -1;
      this.heapCount = 0;
    }

    // Clearing 80k floats is ~0.1 ms; still, spread it so a rebuild never spikes.
    if (this.clearing) {
      const end = Math.min(this.back.length, this.clearCursor + budget * 12);
      this.back.fill(Infinity, this.clearCursor, end);
      this.clearCursor = end;
      if (end < this.back.length) return;
      this.clearing = false;
      this.back[this.goalCell] = 0;
      this.push(this.goalCell);
      return;
    }

    const grid = this.grid;
    const cost = this.back;
    const flags = grid.flags;
    const height = grid.height;
    const w = grid.w;
    const h = grid.h;
    const cs = grid.cellSize;
    const maxStep = grid.options.maxStep;
    let pops = 0;

    while (this.heapCount > 0 && pops < budget) {
      const i = this.pop();
      pops++;
      const ci = cost[i];
      if (ci >= this.maxCost) continue;
      const cx = i % w;
      const cz = (i / w) | 0;
      const hi = height[i];

      for (let k = 0; k < 8; k++) {
        const nx = cx + NX[k];
        const nz = cz + NZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nz * w + nx;
        if ((flags[ni] & NAV_WALKABLE) === 0) continue;
        const dh = height[ni] - hi;
        if (dh > maxStep || dh < -maxStep * 2.6) continue;
        if ((k & 1) === 1) {
          // No corner cutting: both orthogonal neighbours must be open.
          const oa = cz * w + nx;
          const ob = nz * w + cx;
          if ((flags[oa] & NAV_WALKABLE) === 0 || (flags[ob] & NAV_WALKABLE) === 0) continue;
        }
        const nc = ci + NDIST[k] * cs * (1 + Math.abs(dh) * 0.9);
        if (nc < cost[ni]) {
          cost[ni] = nc;
          this.push(ni);
        }
      }
    }

    if (this.heapCount === 0) {
      // Swap: the freshly built field becomes readable.
      const t = this.front;
      this.front = this.back;
      this.back = t;
      this.goalPosition.copy(this.pendingGoalPosition);
      this.building = false;
      this.hasField = true;
      this.generation++;
    }
  }

  /** Distance to the goal from a world position, or Infinity if unreachable. */
  costAt(x: number, z: number): number {
    const i = this.grid.cellAt(x, z);
    return i < 0 ? Infinity : this.front[i];
  }

  /**
   * Smooth descent direction (XZ, unit length) toward the goal.
   * Uses the weighted gradient over all 8 neighbours rather than "walk to the
   * cheapest neighbour", which is what stops agents snapping between two
   * equal-cost cells and vibrating on the spot.
   */
  sample(x: number, z: number, out: THREE.Vector3): boolean {
    const grid = this.grid;
    const i = grid.cellAt(x, z);
    if (i < 0) return false;
    const cost = this.front;
    const c0 = cost[i];
    if (!Number.isFinite(c0)) return false;
    const w = grid.w;
    const h = grid.h;
    const cx = i % w;
    const cz = (i / w) | 0;
    let dx = 0;
    let dz = 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + NX[k];
      const nz = cz + NZ[k];
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const ni = nz * w + nx;
      const cn = cost[ni];
      if (!Number.isFinite(cn)) continue;
      const drop = (c0 - cn) / NDIST[k];
      if (drop <= 0) continue;
      dx += NX[k] * drop;
      dz += NZ[k] * drop;
    }
    const len = Math.hypot(dx, dz);
    if (len < 1e-5) {
      out.set(0, 0, 0);
      return false;
    }
    out.set(dx / len, 0, dz / len);
    return true;
  }

  private push(i: number): void {
    let pos = this.heapPos[i];
    if (pos < 0) {
      pos = ++this.heapCount;
      this.heap[pos] = i;
      this.heapPos[i] = pos;
    }
    this.siftUp(pos);
  }

  private pop(): number {
    const top = this.heap[1];
    this.heapPos[top] = -1;
    const last = this.heap[this.heapCount];
    this.heapCount--;
    if (this.heapCount > 0) {
      this.heap[1] = last;
      this.heapPos[last] = 1;
      this.siftDown(1);
    }
    return top;
  }

  private siftUp(pos: number): void {
    const heap = this.heap;
    const cost = this.back;
    const node = heap[pos];
    const key = cost[node];
    while (pos > 1) {
      const parent = pos >> 1;
      const pn = heap[parent];
      if (cost[pn] <= key) break;
      heap[pos] = pn;
      this.heapPos[pn] = pos;
      pos = parent;
    }
    heap[pos] = node;
    this.heapPos[node] = pos;
  }

  private siftDown(pos: number): void {
    const heap = this.heap;
    const cost = this.back;
    const n = this.heapCount;
    const node = heap[pos];
    const key = cost[node];
    for (;;) {
      let child = pos << 1;
      if (child > n) break;
      if (child + 1 <= n && cost[heap[child + 1]] < cost[heap[child]]) child++;
      const cn = heap[child];
      if (cost[cn] >= key) break;
      heap[pos] = cn;
      this.heapPos[cn] = pos;
      pos = child;
    }
    heap[pos] = node;
    this.heapPos[node] = pos;
  }

  reset(): void {
    this.heapCount = 0;
    this.heapPos.fill(-1);
    this.building = false;
    this.clearing = false;
    this.hasField = false;
    this.pendingGoal = -1;
    this.a.fill(Infinity);
    this.b.fill(Infinity);
  }
}

// ---------------------------------------------------------------------------
// NavGrid
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);

export class NavGrid {
  readonly options: NavGridOptions;
  readonly cellSize: number;
  readonly minX: number;
  readonly minZ: number;
  readonly w: number;
  readonly h: number;
  readonly count: number;

  /** Ground height per cell. */
  readonly height: Float32Array;
  /** Cosine of the ground slope per cell (1 = flat). */
  readonly slopeCos: Float32Array;
  readonly flags: Uint8Array;
  /** Connected-component id; -1 for unwalkable cells. */
  readonly region: Int16Array;
  /** Extra traversal cost, 0..255, scaled into metres by `DANGER_SCALE`. */
  readonly extraCost: Uint8Array;

  /** Region id of the largest connected component — "the playable space". */
  mainRegion = -1;
  /** Cell counts per region, index = region id. */
  readonly regionSize: number[] = [];

  readonly flow: FlowField;

  private world: CollisionWorld;
  private phase: NavBuildPhase = 'idle';
  private cursor = 0;
  private buildQueue: Int32Array;
  private buildHead = 0;
  private buildTail = 0;

  // A* working set, generation-stamped so it is never cleared.
  private gScore: Float32Array;
  private fScore: Float32Array;
  private cameFrom: Int32Array;
  private stamp: Uint32Array;
  private nodeState: Uint8Array;
  private aHeap: Int32Array;
  private aHeapPos: Int32Array;
  private aHeapCount = 0;
  private generation = 1;

  /** Scratch for string-pulling; sized to the raw grid path. */
  private rawPath: Int32Array;

  /**
   * Optional extra traversal cost in metres at a world position — the AI
   * director points this at its decaying danger sources (grenades, fire).
   */
  dangerFn: ((x: number, z: number) => number) | null = null;

  /** Milliseconds of build work consumed so far — useful for load reporting. */
  buildMs = 0;

  /**
   * Heuristic inflation. 1.0 is optimal A*; 1.2 typically expands three to five
   * times fewer nodes for paths at most 20% longer, which no player can see and
   * every frame budget can feel. Games have shipped on this trade for decades.
   */
  heuristicWeight = 1.2;

  constructor(world: CollisionWorld, bounds: THREE.Box3, opts?: Partial<NavGridOptions>) {
    this.world = world;
    this.options = { ...NAV_DEFAULTS, ...opts };
    this.cellSize = this.options.cellSize;

    const sizeX = Math.max(this.cellSize * 4, bounds.max.x - bounds.min.x);
    const sizeZ = Math.max(this.cellSize * 4, bounds.max.z - bounds.min.z);
    const cap = this.options.maxCellsPerAxis;

    // Coarsen before clipping.
    //
    // The cap exists to bound memory, but it used to bound *reach*: 288 cells
    // at 0.75 m is 216 m across, so a level asking for a 252 m grid silently
    // got 216 and everything outside it was simply not navigable. Spawn volumes
    // placed past that radius placed nothing at all, with no error, and a whole
    // encounter arrived from the one channel that happened to fall inside.
    // Growing the cell instead honours the requested extent at exactly the same
    // memory, which is what the cap was actually protecting.
    //
    // Only so far, though. Cell size is what decides whether a doorway or a
    // gap between cover is walkable, and past about double the default the grid
    // stops resolving the spaces the levels are built from. Beyond that, clip
    // and re-centre as before.
    const need = Math.max(sizeX, sizeZ) / this.cellSize;
    if (need > cap) {
      this.cellSize = Math.min(this.cellSize * 2, (this.cellSize * need) / cap);
    }
    this.w = Math.min(cap, Math.max(4, Math.ceil(sizeX / this.cellSize)));
    this.h = Math.min(cap, Math.max(4, Math.ceil(sizeZ / this.cellSize)));
    // Re-centre if the cap still clipped the requested extent.
    const cx = (bounds.min.x + bounds.max.x) * 0.5;
    const cz = (bounds.min.z + bounds.max.z) * 0.5;
    this.minX = cx - (this.w * this.cellSize) * 0.5;
    this.minZ = cz - (this.h * this.cellSize) * 0.5;
    this.count = this.w * this.h;

    const n = this.count;
    this.height = new Float32Array(n);
    this.slopeCos = new Float32Array(n);
    this.flags = new Uint8Array(n);
    this.region = new Int16Array(n).fill(-1);
    this.extraCost = new Uint8Array(n);

    this.gScore = new Float32Array(n);
    this.fScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.nodeState = new Uint8Array(n);
    this.aHeap = new Int32Array(n + 1);
    this.aHeapPos = new Int32Array(n);
    this.buildQueue = new Int32Array(n);
    this.rawPath = new Int32Array(4096);

    this.flow = new FlowField(this);
    this.phase = 'sampling';
  }

  get ready(): boolean {
    return this.phase === 'ready';
  }

  get progress(): number {
    switch (this.phase) {
      case 'idle':
        return 0;
      case 'sampling':
        return (this.cursor / this.count) * 0.8;
      case 'linking':
        return 0.8 + (this.cursor / this.count) * 0.15;
      case 'regions':
        return 0.95;
      default:
        return 1;
    }
  }

  // -- indexing -------------------------------------------------------------

  /** Cell index at a world XZ, or -1 when outside the grid. */
  cellAt(x: number, z: number): number {
    const gx = Math.floor((x - this.minX) / this.cellSize);
    const gz = Math.floor((z - this.minZ) / this.cellSize);
    if (gx < 0 || gz < 0 || gx >= this.w || gz >= this.h) return -1;
    return gz * this.w + gx;
  }

  /** Cell index, clamped into the grid instead of failing. */
  clampedCellAt(x: number, z: number): number {
    const gx = clamp(Math.floor((x - this.minX) / this.cellSize), 0, this.w - 1);
    const gz = clamp(Math.floor((z - this.minZ) / this.cellSize), 0, this.h - 1);
    return gz * this.w + gx;
  }

  cellCentre(i: number, out: THREE.Vector3): THREE.Vector3 {
    const gx = i % this.w;
    const gz = (i / this.w) | 0;
    return out.set(
      this.minX + (gx + 0.5) * this.cellSize,
      this.height[i],
      this.minZ + (gz + 0.5) * this.cellSize,
    );
  }

  isWalkableCell(i: number): boolean {
    return i >= 0 && (this.flags[i] & NAV_WALKABLE) !== 0;
  }

  isWalkable(x: number, z: number): boolean {
    return this.isWalkableCell(this.cellAt(x, z));
  }

  /** Ground height at a world XZ from the grid (not a fresh physics query). */
  heightAt(x: number, z: number): number {
    const i = this.cellAt(x, z);
    return i < 0 ? 0 : this.height[i];
  }

  /**
   * Spiral outward from a world position to the nearest walkable cell.
   * `maxRing` is in cells; 6 rings ≈ 4.5 m at the default cell size.
   */
  nearestWalkableCell(x: number, z: number, maxRing = 8): number {
    const gx = Math.floor((x - this.minX) / this.cellSize);
    const gz = Math.floor((z - this.minZ) / this.cellSize);
    if (gx >= 0 && gz >= 0 && gx < this.w && gz < this.h) {
      const i = gz * this.w + gx;
      if ((this.flags[i] & NAV_WALKABLE) !== 0) return i;
    }
    for (let r = 1; r <= maxRing; r++) {
      let best = -1;
      let bestD = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) continue;
          const i = nz * this.w + nx;
          if ((this.flags[i] & NAV_WALKABLE) === 0) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Snap a position onto the nav surface. Returns false if nothing is near. */
  snap(position: THREE.Vector3, out: THREE.Vector3, maxRing = 8): boolean {
    const i = this.nearestWalkableCell(position.x, position.z, maxRing);
    if (i < 0) return false;
    this.cellCentre(i, out);
    return true;
  }

  /** True when two world positions sit in the same connected component. */
  sameRegion(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const ia = this.nearestWalkableCell(a.x, a.z, 4);
    const ib = this.nearestWalkableCell(b.x, b.z, 4);
    if (ia < 0 || ib < 0) return false;
    return this.region[ia] === this.region[ib];
  }

  // -- incremental build ----------------------------------------------------

  /**
   * Do up to `budgetMs` of build work. Call once per simulation step until
   * `ready`. The wall clock is used purely as a work budget for a loading task.
   */
  step(budgetMs = 1.5): void {
    if (this.phase === 'ready' || this.phase === 'idle') return;
    const t0 = performance.now();
    const deadline = t0 + budgetMs;

    while (performance.now() < deadline) {
      if (this.phase === 'sampling') {
        if (!this.sampleChunk(512)) this.enterLinking();
      } else if (this.phase === 'linking') {
        if (!this.linkChunk(4096)) this.enterRegions();
      } else if (this.phase === 'regions') {
        if (!this.regionChunk(6000)) {
          this.phase = 'ready';
          break;
        }
      } else {
        break;
      }
    }
    this.buildMs += performance.now() - t0;
  }

  /** Force the remaining build to completion. Only for tests and tooling. */
  buildBlocking(): void {
    let guard = 0;
    while (!this.ready && guard++ < 100000) this.step(8);
  }

  private sampleChunk(cells: number): boolean {
    const end = Math.min(this.count, this.cursor + cells);
    const cs = this.cellSize;
    const maxSlopeCos = Math.cos(this.options.maxSlope);
    const clearance = this.options.agentHeight;
    for (let i = this.cursor; i < end; i++) {
      const gx = i % this.w;
      const gz = (i / this.w) | 0;
      const x = this.minX + (gx + 0.5) * cs;
      const z = this.minZ + (gz + 0.5) * cs;
      const g = this.world.sampleGround(x, z);
      if (!g) {
        this.height[i] = -1e6;
        this.slopeCos[i] = 0;
        continue;
      }
      this.height[i] = g.y;
      const ny = g.normal.y;
      this.slopeCos[i] = ny;
      this.flags[i] = NAV_SAMPLED;
      if (ny < maxSlopeCos) continue;

      // Clearance, in two tests, because the world raycast is front-face only
      // and a point *inside* a closed mesh therefore sees no surfaces at all —
      // every face's normal points away from it. Getting this wrong is the
      // difference between "crates are obstacles" and "enemies walk through
      // crates", so it is worth the second ray.
      //
      // 1. Look up. A hit is an overhang: walkable only if the headroom below it
      //    clears the agent's standing height (a bridge, not a low pipe).
      _v.set(x, g.y + 0.12, z);
      _up.set(0, 1, 0);
      const above = this.world.raycast(_v, _up, 60);
      if (above) {
        if (above.distance < clearance) continue;
        this.flags[i] |= NAV_WALKABLE;
        continue;
      }
      // 2. Nothing overhead — which means open sky, or buried inside geometry.
      //    A ray from well above the cell distinguishes the two: it sees the top
      //    face of whatever solid we are standing inside.
      _v2.set(x, g.y + 60, z);
      _down.set(0, -1, 0);
      const roof = this.world.raycast(_v2, _down, 60);
      if (roof && roof.point.y > g.y + 0.3) continue;
      this.flags[i] |= NAV_WALKABLE;
    }
    this.cursor = end;
    return this.cursor < this.count;
  }

  private enterLinking(): void {
    this.phase = 'linking';
    this.cursor = 0;
  }

  /**
   * Second pass: reject cells whose neighbourhood makes them unusable and tag
   * the topology flags the cover map and the steering layer read.
   *
   * A cell with no traversable neighbour at all is a one-cell island — usually
   * a rock top or a sliver between two walls. Those are worse than useless:
   * agents path onto them and get stuck, so they are removed.
   */
  private linkChunk(cells: number): boolean {
    const end = Math.min(this.count, this.cursor + cells);
    const maxStep = this.options.maxStep;
    const w = this.w;
    const h = this.h;
    const flags = this.flags;
    const height = this.height;
    for (let i = this.cursor; i < end; i++) {
      if ((flags[i] & NAV_WALKABLE) === 0) continue;
      const gx = i % w;
      const gz = (i / w) | 0;
      const hi = height[i];
      let links = 0;
      let blockedOrtho = 0;
      let ledge = false;
      for (let k = 0; k < 8; k++) {
        const nx = gx + NX[k];
        const nz = gz + NZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) {
          if ((k & 1) === 0) blockedOrtho++;
          continue;
        }
        const ni = nz * w + nx;
        const walk = (flags[ni] & NAV_WALKABLE) !== 0;
        if (!walk) {
          if ((k & 1) === 0) blockedOrtho++;
          continue;
        }
        const dh = height[ni] - hi;
        if (Math.abs(dh) <= maxStep) links++;
        else if (dh < -maxStep) ledge = true;
        else if ((k & 1) === 0) blockedOrtho++;
      }
      if (links === 0) {
        flags[i] &= ~NAV_WALKABLE;
        continue;
      }
      if (blockedOrtho > 0) flags[i] |= NAV_NEAR_WALL;
      else flags[i] |= NAV_OPEN;
      if (ledge) flags[i] |= NAV_LEDGE;
    }
    this.cursor = end;
    return this.cursor < this.count;
  }

  private enterRegions(): void {
    this.phase = 'regions';
    this.cursor = 0;
    this.regionSize.length = 0;
    this.region.fill(-1);
    this.buildHead = 0;
    this.buildTail = 0;
  }

  /**
   * Connected-component labelling by BFS. Regions are what let the encounter
   * director reject spawn points the player could never reach, and what the
   * verification harness uses to assert "every reachable cell is reachable".
   */
  private regionChunk(cells: number): boolean {
    const w = this.w;
    const h = this.h;
    const flags = this.flags;
    const height = this.height;
    const region = this.region;
    const maxStep = this.options.maxStep;
    let work = 0;

    while (work < cells) {
      if (this.buildHead === this.buildTail) {
        // Find a new seed.
        let seed = -1;
        while (this.cursor < this.count) {
          const i = this.cursor++;
          if ((flags[i] & NAV_WALKABLE) !== 0 && region[i] < 0) {
            seed = i;
            break;
          }
        }
        if (seed < 0) break;
        const id = this.regionSize.length;
        if (id > 32000) break;
        this.regionSize.push(0);
        region[seed] = id;
        this.buildHead = 0;
        this.buildTail = 0;
        this.buildQueue[this.buildTail++] = seed;
      }

      const i = this.buildQueue[this.buildHead++];
      const id = region[i];
      this.regionSize[id]++;
      work++;
      const gx = i % w;
      const gz = (i / w) | 0;
      const hi = height[i];
      for (let k = 0; k < 8; k++) {
        const nx = gx + NX[k];
        const nz = gz + NZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nz * w + nx;
        if ((flags[ni] & NAV_WALKABLE) === 0 || region[ni] >= 0) continue;
        if (Math.abs(height[ni] - hi) > maxStep) continue;
        if ((k & 1) === 1) {
          const oa = gz * w + nx;
          const ob = nz * w + gx;
          if ((flags[oa] & NAV_WALKABLE) === 0 || (flags[ob] & NAV_WALKABLE) === 0) continue;
        }
        region[ni] = id;
        if (this.buildTail < this.buildQueue.length) this.buildQueue[this.buildTail++] = ni;
      }
      // Compact the ring buffer when it drains, so long floods do not overflow.
      if (this.buildHead > 0 && this.buildTail >= this.buildQueue.length) {
        this.buildQueue.copyWithin(0, this.buildHead, this.buildTail);
        this.buildTail -= this.buildHead;
        this.buildHead = 0;
      }
    }

    if (this.buildHead === this.buildTail && this.cursor >= this.count) {
      let best = -1;
      let bestN = 0;
      for (let r = 0; r < this.regionSize.length; r++) {
        if (this.regionSize[r] > bestN) {
          bestN = this.regionSize[r];
          best = r;
        }
      }
      this.mainRegion = best;
      return false;
    }
    return true;
  }

  // -- A* -------------------------------------------------------------------

  /** Octile distance in metres between two cells. */
  private heuristic(a: number, b: number): number {
    const ax = a % this.w;
    const az = (a / this.w) | 0;
    const bx = b % this.w;
    const bz = (b / this.w) | 0;
    const dx = Math.abs(ax - bx);
    const dz = Math.abs(az - bz);
    const lo = dx < dz ? dx : dz;
    const hi = dx < dz ? dz : dx;
    return (hi + (Math.SQRT2 - 1) * lo) * this.cellSize * this.heuristicWeight;
  }

  /**
   * A* between two world positions. Writes a string-pulled path into `out`.
   *
   * Returns false when either endpoint has no nearby walkable cell or the goal
   * is in a different connected component — in which case `out` is left with a
   * partial best-effort path toward the closest reachable cell, which is what
   * makes an enemy walk *at* an unreachable player instead of standing still.
   */
  findPath(start: THREE.Vector3, goal: THREE.Vector3, out: NavPath, maxNodes = 6000): boolean {
    out.clear();
    out.goal.copy(goal);
    if (!this.ready) return false;

    const startCell = this.nearestWalkableCell(start.x, start.z, 6);
    const goalCell = this.nearestWalkableCell(goal.x, goal.z, 8);
    if (startCell < 0 || goalCell < 0) return false;

    if (startCell === goalCell) {
      this.cellCentre(goalCell, _v);
      out.points[0].copy(_v);
      out.count = 1;
      out.complete = true;
      return true;
    }

    const gen = ++this.generation;
    const stamp = this.stamp;
    const gScore = this.gScore;
    const fScore = this.fScore;
    const cameFrom = this.cameFrom;
    const state = this.nodeState;
    const flags = this.flags;
    const height = this.height;
    const extra = this.extraCost;
    const w = this.w;
    const h = this.h;
    const cs = this.cellSize;
    const maxStep = this.options.maxStep;
    const danger = this.dangerFn;

    this.aHeapCount = 0;
    stamp[startCell] = gen;
    gScore[startCell] = 0;
    fScore[startCell] = this.heuristic(startCell, goalCell);
    cameFrom[startCell] = -1;
    state[startCell] = 1;
    this.aPush(startCell);

    let expanded = 0;
    let bestCell = startCell;
    let bestH = fScore[startCell];
    let found = false;

    while (this.aHeapCount > 0 && expanded < maxNodes) {
      const cur = this.aPop();
      if (cur === goalCell) {
        found = true;
        break;
      }
      state[cur] = 2;
      expanded++;

      const gx = cur % w;
      const gz = (cur / w) | 0;
      const hc = height[cur];
      const gc = gScore[cur];

      for (let k = 0; k < 8; k++) {
        const nx = gx + NX[k];
        const nz = gz + NZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nz * w + nx;
        if ((flags[ni] & NAV_WALKABLE) === 0) continue;
        if (stamp[ni] === gen && state[ni] === 2) continue;
        const dh = height[ni] - hc;
        if (Math.abs(dh) > maxStep) continue;
        if ((k & 1) === 1) {
          const oa = gz * w + nx;
          const ob = nz * w + gx;
          if ((flags[oa] & NAV_WALKABLE) === 0 || (flags[ob] & NAV_WALKABLE) === 0) continue;
        }

        let stepCost = NDIST[k] * cs;
        // Climbing is expensive; hugging a wall is mildly discouraged so agents
        // prefer open lines but will still use corridors.
        stepCost *= 1 + Math.abs(dh) * 1.1 + ((flags[ni] & NAV_NEAR_WALL) !== 0 ? 0.12 : 0);
        stepCost += extra[ni] * (2 / 255);
        if (danger) {
          const wx = this.minX + (nx + 0.5) * cs;
          const wz = this.minZ + (nz + 0.5) * cs;
          stepCost += danger(wx, wz);
        }

        const tentative = gc + stepCost;
        const known = stamp[ni] === gen;
        if (known && tentative >= gScore[ni]) continue;
        stamp[ni] = gen;
        gScore[ni] = tentative;
        const hh = this.heuristic(ni, goalCell);
        fScore[ni] = tentative + hh;
        cameFrom[ni] = cur;
        state[ni] = 1;
        this.aPush(ni);
        if (hh < bestH) {
          bestH = hh;
          bestCell = ni;
        }
      }
    }

    const endCell = found ? goalCell : bestCell;
    this.reconstruct(startCell, endCell, out);
    out.complete = found;
    return found;
  }

  /** Walk the parent chain backwards, then smooth. */
  private reconstruct(startCell: number, endCell: number, out: NavPath): void {
    const raw = this.rawPath;
    let n = 0;
    let cur = endCell;
    const cameFrom = this.cameFrom;
    const gen = this.generation;
    while (cur >= 0 && n < raw.length) {
      raw[n++] = cur;
      if (cur === startCell) break;
      if (this.stamp[cur] !== gen) break;
      cur = cameFrom[cur];
    }
    // raw is end→start; reverse in place.
    for (let i = 0, j = n - 1; i < j; i++, j--) {
      const t = raw[i];
      raw[i] = raw[j];
      raw[j] = t;
    }
    this.stringPull(raw, n, out);
  }

  /**
   * String pulling: greedily skip waypoints while the straight line between the
   * anchor and the candidate is both grid-walkable and clear in the real world.
   *
   * Without this, a grid path is a staircase and enemies visibly zig-zag. With
   * it, they cut corners the way a person does.
   */
  private stringPull(raw: Int32Array, n: number, out: NavPath): void {
    out.clear();
    if (n === 0) return;
    const push = (cell: number): void => {
      if (out.count >= MAX_PATH_POINTS) return;
      this.cellCentre(cell, out.points[out.count]);
      out.count++;
    };

    push(raw[0]);
    let anchor = 0;
    let i = 1;
    while (i < n) {
      // Extend as far as line of sight allows, then commit the last valid point.
      let last = i;
      let j = i;
      while (j < n && this.cellLineClear(raw[anchor], raw[j])) {
        last = j;
        j++;
      }
      if (last === anchor) last = i;
      push(raw[last]);
      anchor = last;
      i = last + 1;
      if (out.count >= MAX_PATH_POINTS) break;
    }
    if (out.count > 1 && raw[n - 1] !== -1) {
      const tail = out.points[out.count - 1];
      this.cellCentre(raw[n - 1], _v);
      if (tail.distanceToSquared(_v) > 1e-4 && out.count < MAX_PATH_POINTS) {
        out.points[out.count].copy(_v);
        out.count++;
      }
    }

    let len = 0;
    for (let k = 1; k < out.count; k++) len += out.points[k].distanceTo(out.points[k - 1]);
    out.length = len;
  }

  /**
   * Is the straight segment between two cells traversable?
   * Two tests, both needed: a supercover walk over the grid (catches holes and
   * steps the physics ray would fly straight over) and a real line-of-sight ray
   * at chest height (catches props that are too thin to block a cell).
   */
  cellLineClear(a: number, b: number): boolean {
    const w = this.w;
    const ax = a % w;
    const az = (a / w) | 0;
    const bx = b % w;
    const bz = (b / w) | 0;
    const dx = bx - ax;
    const dz = bz - az;
    const steps = Math.max(Math.abs(dx), Math.abs(dz));
    if (steps === 0) return true;
    if (steps > 96) return false;
    const flags = this.flags;
    const height = this.height;
    const maxStep = this.options.maxStep;
    let prev = a;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const cx = Math.round(ax + dx * t);
      const cz = Math.round(az + dz * t);
      const ci = cz * w + cx;
      if ((flags[ci] & NAV_WALKABLE) === 0) return false;
      if (Math.abs(height[ci] - height[prev]) > maxStep) return false;
      prev = ci;
    }
    this.cellCentre(a, _v);
    this.cellCentre(b, _v2);
    _v.y += 0.95;
    _v2.y += 0.95;
    return this.world.lineOfSight(_v, _v2);
  }

  /** Straight-line walkability between two arbitrary world positions. */
  lineWalkable(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const a = this.cellAt(from.x, from.z);
    const b = this.cellAt(to.x, to.z);
    if (a < 0 || b < 0) return false;
    return this.cellLineClear(a, b);
  }

  private aPush(i: number): void {
    let pos = this.aHeapPos[i];
    if (pos <= 0 || pos > this.aHeapCount || this.aHeap[pos] !== i) {
      pos = ++this.aHeapCount;
      this.aHeap[pos] = i;
      this.aHeapPos[i] = pos;
    }
    const heap = this.aHeap;
    const f = this.fScore;
    const node = heap[pos];
    const key = f[node];
    while (pos > 1) {
      const parent = pos >> 1;
      const pn = heap[parent];
      if (f[pn] <= key) break;
      heap[pos] = pn;
      this.aHeapPos[pn] = pos;
      pos = parent;
    }
    heap[pos] = node;
    this.aHeapPos[node] = pos;
  }

  private aPop(): number {
    const heap = this.aHeap;
    const f = this.fScore;
    const top = heap[1];
    this.aHeapPos[top] = 0;
    const last = heap[this.aHeapCount];
    this.aHeapCount--;
    if (this.aHeapCount <= 0) return top;
    let pos = 1;
    heap[1] = last;
    this.aHeapPos[last] = 1;
    const key = f[last];
    const n = this.aHeapCount;
    for (;;) {
      let child = pos << 1;
      if (child > n) break;
      if (child + 1 <= n && f[heap[child + 1]] < f[heap[child]]) child++;
      const cn = heap[child];
      if (f[cn] >= key) break;
      heap[pos] = cn;
      this.aHeapPos[cn] = pos;
      pos = child;
    }
    heap[pos] = last;
    this.aHeapPos[last] = pos;
    return top;
  }

  // -- sampling helpers -----------------------------------------------------

  /**
   * Pick a walkable cell near `origin` satisfying a predicate, searching rings
   * outward. Allocation-free; the predicate receives the cell index.
   */
  findNear(
    origin: THREE.Vector3,
    minRadius: number,
    maxRadius: number,
    accept: (cell: number, x: number, z: number, y: number) => number,
  ): number {
    const cs = this.cellSize;
    const gx = Math.floor((origin.x - this.minX) / cs);
    const gz = Math.floor((origin.z - this.minZ) / cs);
    const r0 = Math.max(0, Math.floor(minRadius / cs));
    const r1 = Math.max(r0 + 1, Math.ceil(maxRadius / cs));
    let best = -1;
    let bestScore = -Infinity;
    for (let dz = -r1; dz <= r1; dz++) {
      const nz = gz + dz;
      if (nz < 0 || nz >= this.h) continue;
      for (let dx = -r1; dx <= r1; dx++) {
        const nx = gx + dx;
        if (nx < 0 || nx >= this.w) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 < r0 * r0 || d2 > r1 * r1) continue;
        const i = nz * this.w + nx;
        if ((this.flags[i] & NAV_WALKABLE) === 0) continue;
        const x = this.minX + (nx + 0.5) * cs;
        const z = this.minZ + (nz + 0.5) * cs;
        const score = accept(i, x, z, this.height[i]);
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
    return best;
  }

  /** Number of walkable cells; used by tests and by spawn-density heuristics. */
  countWalkable(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if ((this.flags[i] & NAV_WALKABLE) !== 0) n++;
    return n;
  }

  dispose(): void {
    this.flow.reset();
    this.dangerFn = null;
    this.phase = 'idle';
  }
}
