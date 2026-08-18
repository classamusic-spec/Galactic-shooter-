/**
 * Rig — procedural skeletons for creatures that have no animation files.
 *
 * ## The one convention you must know
 *
 * **Every bone's local +Y axis points at its child.** That single rule is what
 * lets one IK solver drive a two-legged Nordic warrior, a four-armed mantis and
 * a six-legged hive drone without any per-species special cases. A bone of
 * length `L` places its child at local `(0, L, 0)`; the rest orientation of a
 * chain is derived from a world-space `direction` (where the chain points) plus
 * a `pole` (which way "front" is for that chain), so twist is deterministic and
 * never flips.
 *
 * ## Authoring a species skeleton
 *
 * ```ts
 * const rig = new Rig();
 * const spine = rig.chain('spine', ['hips', 'lumbar', 'chest', 'neck', 'head'],
 *   [0.26, 0.30, 0.20, 0.16],
 *   { origin: new THREE.Vector3(0, 1.02, 0), direction: UP, kind: 'spine' });
 *
 * rig.chain('leg.L', ['hip', 'knee', 'ankle', 'toe'], [0.46, 0.44, 0.14], {
 *   parent: 'spine.hips', origin: new THREE.Vector3(0.17, 0, 0.02),
 *   direction: DOWN, kind: 'leg', side: -1, restBend: [0.10, -0.22, 0.12],
 * });
 * ```
 *
 * Bones are addressed as `"<chainId>.<partName>"`. Chains may hang off any bone
 * of any earlier chain, so a mantis can grow four arms from one thorax and a
 * hexapod six legs from one abdomen with no extra machinery.
 *
 * ## Definition vs instance
 *
 * A `Rig` is a *definition*: rest pose, chain topology, and the skin weights
 * baked into the shared geometry. `rig.build()` produces a `RigInstance` — a
 * fresh `THREE.Bone` hierarchy plus a `THREE.Skeleton` — for each individual
 * enemy. Geometry and skin weights are therefore shared across every instance
 * of a species; only the ~30 bones per body are per-instance. That is the whole
 * reason 40 agents fit in the frame budget.
 */
import * as THREE from 'three';
import { clamp } from '@/util/math';

export type ChainKind =
  | 'spine'
  | 'neck'
  | 'leg'
  | 'arm'
  | 'tail'
  | 'wing'
  | 'tentacle'
  | 'digit'
  | 'generic';

export interface ChainOptions {
  /** Bone name to attach to (`"<chainId>.<part>"`). Defaults to the rig root. */
  parent?: string;
  /** Offset from the parent bone's origin, in body space. */
  origin?: THREE.Vector3;
  /** Body-space direction the chain points at rest. Defaults to +Y. */
  direction?: THREE.Vector3;
  /** Body-space "front" reference that fixes the chain's twist. Defaults to -Z. */
  pole?: THREE.Vector3;
  kind?: ChainKind;
  /** -1 = left, +1 = right, 0 = centre. Drives default gait phasing. */
  side?: -1 | 0 | 1;
  /**
   * Per-joint rest bend in radians around each bone's local X. A leg with a
   * little pre-bend never hits the degenerate straight-line IK case, and reads
   * as a creature at rest rather than a mannequin.
   */
  restBend?: number[];
  /** Explicit gait phase offset in [0,1). Defaults derive from side + order. */
  gaitPhase?: number;
  /**
   * Skin capture radius per bone; vertices further than this get no weight from
   * the bone. Defaults to `length * 1.9 + 0.14`.
   */
  capture?: number[];
  /** Multiplies this chain's skin influence — lower it for bones inside a shell. */
  skinBias?: number;
}

export interface BoneDef {
  name: string;
  index: number;
  parent: number;
  /** Local rest translation from the parent bone. */
  restPos: THREE.Vector3;
  restQuat: THREE.Quaternion;
  /** Body-space rest transform, precomputed for skinning. */
  worldPos: THREE.Vector3;
  worldQuat: THREE.Quaternion;
  /** Distance to this bone's child along +Y; 0 for a leaf. */
  length: number;
  captureRadius: number;
  skinBias: number;
  chain: number;
  /** Index of the bone within its chain. */
  link: number;
}

export interface ChainDef {
  id: string;
  kind: ChainKind;
  side: -1 | 0 | 1;
  /** Global bone indices, root → tip. */
  bones: number[];
  /** Segment lengths; `lengths[i]` spans `bones[i]` → `bones[i+1]`. */
  lengths: number[];
  /** Sum of `lengths` — the chain's maximum reach. */
  reach: number;
  gaitPhase: number;
  /** Body-space rest direction. */
  direction: THREE.Vector3;
  pole: THREE.Vector3;
  /** Body-space rest position of the chain root. */
  origin: THREE.Vector3;
  /** Body-space rest position of the chain tip. */
  restTip: THREE.Vector3;
}

const _y = new THREE.Vector3(0, 1, 0);
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _toP = new THREE.Vector3();

export const UP = Object.freeze(new THREE.Vector3(0, 1, 0));
export const DOWN = Object.freeze(new THREE.Vector3(0, -1, 0));
export const FORWARD = Object.freeze(new THREE.Vector3(0, 0, -1));
export const BACK = Object.freeze(new THREE.Vector3(0, 0, 1));

/**
 * Orientation whose local +Y is `dir` and whose local +Z leans toward `pole`.
 * Degenerate inputs fall back to a stable perpendicular rather than NaN, which
 * matters because a single NaN quaternion silently deletes an entire body.
 */
export function aimQuaternion(
  dir: THREE.Vector3,
  pole: THREE.Vector3,
  out: THREE.Quaternion,
): THREE.Quaternion {
  const yLen = dir.length();
  if (yLen < 1e-6) return out.identity();
  const yy = _v.copy(dir).multiplyScalar(1 / yLen);
  _z.copy(pole).addScaledVector(yy, -pole.dot(yy));
  if (_z.lengthSq() < 1e-8) {
    // Pole is parallel to the bone: pick any stable perpendicular.
    _z.set(yy.z, yy.x, yy.y).addScaledVector(yy, -(yy.z * yy.x + yy.x * yy.y + yy.y * yy.z));
    if (_z.lengthSq() < 1e-8) _z.set(1, 0, 0);
  }
  _z.normalize();
  _x.crossVectors(yy, _z).normalize();
  _m.makeBasis(_x, yy, _z);
  return out.setFromRotationMatrix(_m);
}

/** Squared distance from `p` to the segment `a`→`b`. Allocation-free. */
function distSqToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  _seg.subVectors(b, a);
  _toP.subVectors(p, a);
  const len2 = _seg.lengthSq();
  const t = len2 < 1e-9 ? 0 : clamp(_toP.dot(_seg) / len2, 0, 1);
  const dx = _toP.x - _seg.x * t;
  const dy = _toP.y - _seg.y * t;
  const dz = _toP.z - _seg.z * t;
  return dx * dx + dy * dy + dz * dz;
}

export class Rig {
  readonly bones: BoneDef[] = [];
  readonly chains: ChainDef[] = [];
  private byName = new Map<string, number>();
  private legCount = 0;

  constructor() {
    // Bone 0 is always the body root: identity, at the origin, parents anything
    // that does not name an explicit parent.
    this.bones.push({
      name: 'root',
      index: 0,
      parent: -1,
      restPos: new THREE.Vector3(),
      restQuat: new THREE.Quaternion(),
      worldPos: new THREE.Vector3(),
      worldQuat: new THREE.Quaternion(),
      length: 0,
      captureRadius: 0,
      skinBias: 0,
      chain: -1,
      link: 0,
    });
    this.byName.set('root', 0);
  }

  /**
   * Add a chain. `lengths` may hold `parts.length - 1` entries (joint spans) or
   * `parts.length` (a trailing tip extent used for skin capture on the last
   * bone — a toe, a claw tip, a horn point).
   */
  chain(id: string, parts: string[], lengths: number[], opts: ChainOptions = {}): ChainDef {
    if (parts.length < 2) throw new Error(`Rig chain "${id}" needs at least two parts`);
    const spans = lengths.slice(0, parts.length - 1);
    if (spans.length !== parts.length - 1) {
      throw new Error(`Rig chain "${id}": need ${parts.length - 1} lengths, got ${lengths.length}`);
    }
    const tipLength = lengths.length >= parts.length ? lengths[parts.length - 1] : spans[spans.length - 1] * 0.4;

    const parentIndex = opts.parent ? this.require(opts.parent) : 0;
    const parent = this.bones[parentIndex];
    const direction = (opts.direction ?? UP).clone().normalize();
    const pole = (opts.pole ?? FORWARD).clone().normalize();
    const kind = opts.kind ?? 'generic';
    const side = opts.side ?? 0;
    const skinBias = opts.skinBias ?? 1;

    const chainIndex = this.chains.length;
    const def: ChainDef = {
      id,
      kind,
      side,
      bones: [],
      lengths: spans,
      reach: spans.reduce((a, b) => a + b, 0),
      gaitPhase: 0,
      direction,
      pole,
      origin: new THREE.Vector3(),
      restTip: new THREE.Vector3(),
    };

    // Rest orientation of the whole chain, then per-joint pre-bend accumulates
    // down the chain exactly as the runtime pose will.
    aimQuaternion(direction, pole, _q);
    const chainWorldQuat = _q.clone();

    const originWorld = new THREE.Vector3()
      .copy(parent.worldPos)
      .add(opts.origin ?? _v.set(0, 0, 0));
    def.origin.copy(originWorld);

    let cursorPos = originWorld.clone();
    let cursorQuat = chainWorldQuat.clone();

    for (let i = 0; i < parts.length; i++) {
      const name = `${id}.${parts[i]}`;
      if (this.byName.has(name)) throw new Error(`Rig: duplicate bone "${name}"`);
      const index = this.bones.length;
      const prevIndex = i === 0 ? parentIndex : def.bones[i - 1];
      const prev = this.bones[prevIndex];
      const length = i < spans.length ? spans[i] : tipLength;

      const bend = opts.restBend?.[i] ?? 0;
      if (i > 0 && bend !== 0) {
        cursorQuat.multiply(_q.setFromAxisAngle(_x.set(1, 0, 0), bend));
      } else if (i === 0 && bend !== 0) {
        cursorQuat.multiply(_q.setFromAxisAngle(_x.set(1, 0, 0), bend));
      }

      // Local transform relative to the previous bone in the hierarchy.
      const restQuat = prev.worldQuat.clone().invert().multiply(cursorQuat);
      const restPos = new THREE.Vector3()
        .subVectors(cursorPos, prev.worldPos)
        .applyQuaternion(_q.copy(prev.worldQuat).invert());

      const captureRadius = opts.capture?.[i] ?? length * 1.9 + 0.14;

      this.bones.push({
        name,
        index,
        parent: prevIndex,
        restPos,
        restQuat,
        worldPos: cursorPos.clone(),
        worldQuat: cursorQuat.clone(),
        length,
        captureRadius,
        skinBias,
        chain: chainIndex,
        link: i,
      });
      this.byName.set(name, index);
      def.bones.push(index);

      // Advance the cursor to where this bone's child sits.
      cursorPos = cursorPos.clone().add(_v.set(0, length, 0).applyQuaternion(cursorQuat));
      cursorQuat = cursorQuat.clone();
    }

    def.restTip.copy(cursorPos);
    def.gaitPhase = opts.gaitPhase ?? this.defaultGaitPhase(kind, side);
    if (kind === 'leg') this.legCount++;
    this.chains.push(def);
    return def;
  }

  /**
   * Default phase offsets: bipeds alternate, quadrupeds trot on the diagonal,
   * hexapods fall into an alternating tripod. Species may override per chain.
   */
  private defaultGaitPhase(kind: ChainKind, side: -1 | 0 | 1): number {
    if (kind !== 'leg') return 0;
    const n = this.legCount;
    const pair = Math.floor(n / 2);
    // Alternate by side, and flip every other pair so quadrupeds trot and
    // hexapods form the classic {L1,R2,L3} / {R1,L2,R3} tripods.
    const base = side < 0 ? 0 : 0.5;
    return (base + (pair % 2 === 1 ? 0.5 : 0)) % 1;
  }

  boneIndex(name: string): number {
    return this.byName.get(name) ?? -1;
  }

  bone(name: string): BoneDef | undefined {
    const i = this.byName.get(name);
    return i == null ? undefined : this.bones[i];
  }

  private require(name: string): number {
    const i = this.byName.get(name);
    if (i == null) throw new Error(`Rig: unknown parent bone "${name}"`);
    return i;
  }

  chainById(id: string): ChainDef | undefined {
    return this.chains.find((c) => c.id === id);
  }

  chainsOfKind(kind: ChainKind): ChainDef[] {
    return this.chains.filter((c) => c.kind === kind);
  }

  /** Body-space rest position of a bone — handy for placing hit proxies. */
  restPosition(name: string, out: THREE.Vector3): THREE.Vector3 {
    const b = this.bone(name);
    return b ? out.copy(b.worldPos) : out.set(0, 0, 0);
  }

  /**
   * Compute skin indices/weights for a geometry authored in the rig's rest
   * (bind) space. Weight falls off as an inverse cube of the distance to the
   * bone's *segment*, not its origin — the difference between an arm that bends
   * and an arm that shears. Capped at 4 influences, normalised, and clamped to
   * each bone's capture radius so a shoulder plate never gets dragged by a shin.
   */
  skin(geometry: THREE.BufferGeometry, opts: { falloff?: number; smooth?: number } = {}): void {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const count = pos.count;
    const idx = new Uint16Array(count * 4);
    const wgt = new Float32Array(count * 4);
    const falloff = opts.falloff ?? 3;
    const smooth = opts.smooth ?? 0.035;

    const bones = this.bones;
    // Candidate list reused per vertex: no allocation in the loop.
    const bestI = [0, 0, 0, 0];
    const bestW = [0, 0, 0, 0];
    const p = new THREE.Vector3();
    const tail = new THREE.Vector3();

    for (let v = 0; v < count; v++) {
      p.set(pos.getX(v), pos.getY(v), pos.getZ(v));
      bestI[0] = bestI[1] = bestI[2] = bestI[3] = 0;
      bestW[0] = bestW[1] = bestW[2] = bestW[3] = 0;

      for (let b = 1; b < bones.length; b++) {
        const bone = bones[b];
        if (bone.captureRadius <= 0 || bone.skinBias <= 0) continue;
        tail
          .set(0, bone.length, 0)
          .applyQuaternion(bone.worldQuat)
          .add(bone.worldPos);
        const d2 = distSqToSegment(p, bone.worldPos, tail);
        if (d2 > bone.captureRadius * bone.captureRadius) continue;
        const d = Math.sqrt(d2);
        const w = (bone.skinBias / Math.pow(d + smooth, falloff)) *
          (1 - d / bone.captureRadius);
        if (w <= 0) continue;
        // Insertion sort into the top-4.
        for (let s = 0; s < 4; s++) {
          if (w > bestW[s]) {
            for (let k = 3; k > s; k--) {
              bestW[k] = bestW[k - 1];
              bestI[k] = bestI[k - 1];
            }
            bestW[s] = w;
            bestI[s] = b;
            break;
          }
        }
      }

      let sum = bestW[0] + bestW[1] + bestW[2] + bestW[3];
      if (sum <= 0) {
        // Orphan vertex: bind it to the nearest bone outright rather than
        // leaving it stapled to the origin, which is the classic exploded mesh.
        let near = 1;
        let nearD = Infinity;
        for (let b = 1; b < bones.length; b++) {
          const bone = bones[b];
          tail.set(0, bone.length, 0).applyQuaternion(bone.worldQuat).add(bone.worldPos);
          const d2 = distSqToSegment(p, bone.worldPos, tail);
          if (d2 < nearD) {
            nearD = d2;
            near = b;
          }
        }
        bestI[0] = near;
        bestW[0] = 1;
        sum = 1;
      }
      const inv = 1 / sum;
      for (let s = 0; s < 4; s++) {
        idx[v * 4 + s] = bestI[s];
        wgt[v * 4 + s] = bestW[s] * inv;
      }
    }

    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(wgt, 4));
  }

  /** Instantiate a fresh bone hierarchy + skeleton for one individual. */
  build(): RigInstance {
    return new RigInstance(this);
  }
}

/** Runtime view of one chain, in world space, refreshed by `syncWorld()`. */
export interface ChainRuntime {
  def: ChainDef;
  bones: THREE.Bone[];
  /** Global bone indices into `RigInstance.bones`. */
  indices: number[];
  lengths: number[];
  reach: number;
  /** World joint positions, `bones.length + 1` entries (last = tip). */
  world: THREE.Vector3[];
  /** World orientation per bone. */
  quats: THREE.Quaternion[];
}

export class RigInstance {
  readonly def: Rig;
  readonly root: THREE.Bone;
  readonly bones: THREE.Bone[] = [];
  readonly skeleton: THREE.Skeleton;
  readonly chains: ChainRuntime[] = [];
  private chainMap = new Map<string, ChainRuntime>();
  private boneMap = new Map<string, THREE.Bone>();
  /** World position/orientation per bone, maintained by `syncWorld()`. */
  readonly worldPos: THREE.Vector3[] = [];
  readonly worldQuat: THREE.Quaternion[] = [];
  private parents: Int32Array;

  constructor(def: Rig) {
    this.def = def;
    const n = def.bones.length;
    this.parents = new Int32Array(n);

    for (let i = 0; i < n; i++) {
      const bd = def.bones[i];
      const bone = new THREE.Bone();
      bone.name = bd.name;
      bone.position.copy(bd.restPos);
      bone.quaternion.copy(bd.restQuat);
      bone.matrixAutoUpdate = true;
      this.bones.push(bone);
      this.boneMap.set(bd.name, bone);
      this.worldPos.push(new THREE.Vector3().copy(bd.worldPos));
      this.worldQuat.push(new THREE.Quaternion().copy(bd.worldQuat));
      this.parents[i] = bd.parent;
      if (bd.parent >= 0) this.bones[bd.parent].add(bone);
    }
    this.root = this.bones[0];

    for (const c of def.chains) {
      const rt: ChainRuntime = {
        def: c,
        bones: c.bones.map((i) => this.bones[i]),
        indices: c.bones.slice(),
        lengths: c.lengths.slice(),
        reach: c.reach,
        world: [],
        quats: [],
      };
      for (let i = 0; i <= c.bones.length; i++) rt.world.push(new THREE.Vector3());
      for (let i = 0; i < c.bones.length; i++) rt.quats.push(new THREE.Quaternion());
      this.chains.push(rt);
      this.chainMap.set(c.id, rt);
    }

    // Bind matrices come straight from the definition's rest pose, so a body's
    // skin weights are valid for every instance without re-baking.
    const inverses: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const bd = def.bones[i];
      m.compose(bd.worldPos, bd.worldQuat, _v.set(1, 1, 1));
      inverses.push(m.clone().invert());
    }
    this.skeleton = new THREE.Skeleton(this.bones, inverses);
    this.syncWorld();
  }

  bone(name: string): THREE.Bone | undefined {
    return this.boneMap.get(name);
  }

  chain(id: string): ChainRuntime | undefined {
    return this.chainMap.get(id);
  }

  chainsOfKind(kind: ChainKind): ChainRuntime[] {
    return this.chains.filter((c) => c.def.kind === kind);
  }

  /** Reset every bone to the definition's rest pose. */
  resetPose(): void {
    for (let i = 0; i < this.bones.length; i++) {
      const bd = this.def.bones[i];
      this.bones[i].position.copy(bd.restPos);
      this.bones[i].quaternion.copy(bd.restQuat);
    }
    this.syncWorld();
  }

  /**
   * Recompute world transforms for every bone from the local ones, in bone
   * order (guaranteed topological by construction). This is the animator's
   * working space; it costs one quaternion multiply and one rotate per bone and
   * avoids three.js' full `updateMatrixWorld` recursion inside the IK loops.
   *
   * `basePos`/`baseQuat` are the body root's world transform. Pass nothing to
   * work in body-local space.
   */
  syncWorld(basePos?: THREE.Vector3, baseQuat?: THREE.Quaternion): void {
    const wp = this.worldPos;
    const wq = this.worldQuat;
    if (basePos) wp[0].copy(basePos);
    else wp[0].set(0, 0, 0);
    if (baseQuat) wq[0].copy(baseQuat);
    else wq[0].identity();
    // The root bone itself may be posed (pelvis offset lives on bone 0's child,
    // but a species is free to move the root); fold its local transform in.
    wq[0].multiply(this.bones[0].quaternion);
    wp[0].add(_v.copy(this.bones[0].position).applyQuaternion(baseQuat ?? _q.identity()));

    for (let i = 1; i < this.bones.length; i++) {
      const p = this.parents[i];
      const b = this.bones[i];
      wq[i].copy(wq[p]).multiply(b.quaternion);
      wp[i].copy(_v.copy(b.position).applyQuaternion(wq[p])).add(wp[p]);
    }

    for (const c of this.chains) {
      const n = c.indices.length;
      for (let i = 0; i < n; i++) {
        const gi = c.indices[i];
        c.world[i].copy(wp[gi]);
        c.quats[i].copy(wq[gi]);
      }
      const last = c.indices[n - 1];
      c.world[n]
        .copy(_v.set(0, this.def.bones[last].length, 0).applyQuaternion(wq[last]))
        .add(wp[last]);
    }
  }

  /** World position of a bone after the last `syncWorld()`. */
  boneWorld(name: string, out: THREE.Vector3): THREE.Vector3 {
    const i = this.def.boneIndex(name);
    return i >= 0 ? out.copy(this.worldPos[i]) : out.set(0, 0, 0);
  }

  /** True when every bone transform is finite. Used by the animation asserts. */
  validate(): boolean {
    for (const b of this.bones) {
      const q = b.quaternion;
      const p = b.position;
      if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z) || !Number.isFinite(q.w)) return false;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
    }
    return true;
  }

  dispose(): void {
    this.skeleton.dispose();
  }
}
