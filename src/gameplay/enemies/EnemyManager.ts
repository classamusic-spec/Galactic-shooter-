/**
 * EnemyManager — spawning, pooling, LOD, damage routing and death, for every
 * enemy in the game.
 *
 * ## The shape of a frame
 *
 * `update()` (fixed 120 Hz) is gameplay only: behaviour ticks at an
 * LOD-dependent cadence, movement integration, separation, hit-proxy refresh,
 * shield regeneration, death timelines and ragdoll stepping.
 *
 * `render()` (once per frame) is presentation: pick an animation LOD from the
 * camera distance, run the procedural animator at a rate the LOD chooses, drive
 * the shield shell and the dissolve, and let the species' `animate()` hook add
 * its flourishes. Animation is deliberately *not* in `update()` — running IK at
 * 120 Hz for `enemyBudget` agents would burn the whole frame for detail nobody
 * can see, and every animator output is spring-smoothed so a variable rate is
 * invisible.
 *
 * ## Cost model
 *
 * - One `SkinnedMesh` per material per agent — the reference biped is 4
 *   (hull, panel, trim, glow) plus one shield shell when shielded.
 * - Geometry and skin weights are shared per species; only bones and materials
 *   are per-agent, and materials are clones that share a compiled program.
 * - Agents are pooled per species and never allocated after warm-up.
 */
import * as THREE from 'three';
import type { EngineSystem, Engine } from '@/core/Engine';
import type {
  CollisionWorld,
  DamageInfo,
  EnemyArchetype,
  FactionId,
  FrameContext,
  Damageable,
  Level,
  LootDrop,
} from '@/types';
import type { AimTarget, AimTargetSource } from '@/gameplay/AimAssist';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import { clamp, clamp01, damp, Rng, scratch } from '@/util/math';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import type { VfxSystem } from '@/gfx/vfx/VfxSystem';
import type { HitProxy } from '@/gameplay/Physics';
import { BodyBuilder, cloneEnemyMaterial, enemyUniforms, type BuiltPart } from './BodyBuilder';
import { Rig, type RigInstance } from './Rig';
import { settleRig, type AnimationContext, type AnimationLod } from './ProceduralAnimator';
import {
  EnemyAgent,
  getSpecies,
  registerSpecies,
  speciesIds,
  type BehaviourContext,
  type BuiltBody,
  type EnemyHost,
  type ProxySpec,
  type SpeciesDefinition,
} from './EnemyAgent';
import { ARCHETYPES, FACTION_ACCENT, FACTION_DISSOLVE, registerReferenceSpecies, speciesSeed } from './Archetypes';

export { ARCHETYPES, FACTION_ACCENT, archetypesOf } from './Archetypes';
export {
  EnemyAgent,
  standardCombatBehaviour,
  sequence,
  selector,
  parallel,
  action,
  condition,
  invert,
  cooldown,
  wait,
} from './EnemyAgent';
export type {
  AgentAi,
  BehaviourContext,
  BehaviourNode,
  BehaviourStatus,
  BodyBuildContext,
  BuiltBody,
  ProxySpec,
  SpeciesDefinition,
} from './EnemyAgent';
export { BodyBuilder } from './BodyBuilder';
export { Rig, UP, DOWN, FORWARD, BACK } from './Rig';
export type { AnimationContext, AnimationLod, AnimatorTuning } from './ProceduralAnimator';

/** The `BvhCollisionWorld` surface we use when the level provides one. */
interface ProxyHost {
  addProxy(p: HitProxy): HitProxy;
  removeProxiesFor(entityId: number): void;
}

type PlayerLike = Damageable & {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  eyePosition: THREE.Vector3;
};

/** Per-species shared assets, built once on first spawn. */
interface SpeciesTemplate {
  def: SpeciesDefinition;
  body: BuiltBody;
  rig: Rig;
  parts: BuiltPart[];
  pool: EnemyAgent[];
  live: number;
}

const CORPSE_LINGER = 4.5;
const DISSOLVE_TIME = 1.35;

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _dmg: DamageInfo = {
  amount: 0,
  element: 'kinetic',
  region: 'body',
  precision: false,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  direction: new THREE.Vector3(0, 0, -1),
  sourceId: 0,
};

// ---------------------------------------------------------------------------
// Shield shell
// ---------------------------------------------------------------------------

const SHIELD_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec3 vLocal;
void main() {
  vLocal = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewW = normalize(cameraPosition - world.xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const SHIELD_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uHit;
uniform float uTime;
uniform float uHealth;
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec3 vLocal;

// Hex-ish cell pattern: a shield should read as a constructed field, not fog.
float cells(vec3 p) {
  vec3 q = p * 7.0;
  vec3 f = abs(fract(q) - 0.5);
  float d = max(max(f.x, f.y), f.z);
  return smoothstep(0.34, 0.5, d);
}

void main() {
  float fres = pow(1.0 - clamp(dot(normalize(vNormalW), normalize(vViewW)), 0.0, 1.0), 2.6);
  float grid = cells(vLocal + vec3(0.0, uTime * 0.05, 0.0)) * 0.22;
  // A band sweeps up the shell so it never looks like a static decal.
  float sweep = smoothstep(0.0, 0.04, abs(fract(vLocal.y * 0.9 - uTime * 0.35) - 0.5) - 0.44);
  float a = (fres * 0.9 + grid * fres + sweep * 0.45) * uOpacity * (0.3 + uHealth * 0.7);
  a += uHit * (0.8 + fres);
  vec3 col = uColor * (1.0 + uHit * 3.0 + sweep * 1.5);
  gl_FragColor = vec4(col * a, a);
  if (a < 0.004) discard;
}`;

const SHIELD_ELEMENT_COLOR: Record<string, number> = {
  arc: 0x7fd8ff,
  solar: 0xff8a2a,
  void: 0xb478ff,
  stasis: 0x6fa8ff,
  kinetic: 0xd7e2ee,
};

// ---------------------------------------------------------------------------

export class EnemyManager implements EngineSystem, EnemyHost, AimTargetSource {
  readonly name = 'enemies';
  readonly engine: Engine;
  readonly materials: MaterialLibrary;
  readonly vfx: VfxSystem;

  // Named `roster`, not `agents`: AiEnemyHost declares an optional PUBLIC `agents`,
  // and a private member of the same name makes EnemyManager unassignable to it.
  private readonly roster: EnemyAgent[] = [];

  /**
   * Every live agent, including those playing their death sequence. The array
   * is reused across frames — never retain a reference to an element past the
   * step you read it in, because pooled agents are recycled.
   */
  get active(): readonly EnemyAgent[] {
    return this.roster;
  }

  /** Called when an enemy dies and should drop something. LootSystem subscribes. */
  onLootDrop: ((drop: LootDrop) => void) | null = null;

  /**
   * Set to true by an AI director that integrates enemy movement itself (see
   * `@/gameplay/ai/AiDirector`). Agents then stop steering from
   * `ai.desiredVelocity` and only maintain ground contact, facing and timers,
   * so the two layers never fight over `position`.
   */
  set externalMotion(on: boolean) {
    this.externalMotionFlag = on;
    for (const a of this.roster) a.externalMotion = on;
  }

  get externalMotion(): boolean {
    return this.externalMotionFlag;
  }

  private externalMotionFlag = false;

  private group = new THREE.Group();
  private scene: THREE.Scene | null = null;
  private collisionWorld: CollisionWorld | null = null;
  private proxyHost: ProxyHost | null = null;
  private templates = new Map<string, SpeciesTemplate>();
  /** Hit proxies per entity, with their bone indices resolved once at spawn. */
  private proxies = new Map<number, { list: HitProxy[]; bones: Int32Array }>();
  private shieldGeometry: THREE.BufferGeometry;
  private shieldTemplate: THREE.ShaderMaterial;
  private rng = new Rng(0x51ee7);
  private time = 0;
  private renderTime = 0;
  private frameIndex = 0;
  private disposed = false;

  /** Diagnostics for the capture harness. */
  readonly stats = {
    live: 0,
    dying: 0,
    animMs: 0,
    animated: 0,
    drawCalls: 0,
    triangles: 0,
    maxFootSlide: 0,
    nanBones: 0,
  };

  constructor(engine: Engine, materials: MaterialLibrary, vfx: VfxSystem) {
    this.engine = engine;
    this.materials = materials;
    this.vfx = vfx;
    this.group.name = 'enemies';
    registerReferenceSpecies();

    // One icosphere serves every shield; per-agent scale does the rest.
    this.shieldGeometry = new THREE.IcosahedronGeometry(1, 3);
    this.shieldTemplate = new THREE.ShaderMaterial({
      vertexShader: SHIELD_VERT,
      fragmentShader: SHIELD_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(0x7fd8ff) },
        uOpacity: { value: 0.34 },
        uHit: { value: 0 },
        uTime: { value: 0 },
        uHealth: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      toneMapped: false,
    });
  }

  /** Register a species. Faction modules call this at module load. */
  static register(def: SpeciesDefinition): void {
    registerSpecies(def);
  }

  /** Ids of every registered species. */
  static get registered(): string[] {
    return speciesIds();
  }

  // -- level lifecycle -------------------------------------------------------

  bindLevel(level: Level): void {
    this.clear();
    this.scene = level.scene;
    this.collisionWorld = level.collision;
    const host = level.collision as unknown as Partial<ProxyHost>;
    this.proxyHost =
      typeof host.addProxy === 'function' && typeof host.removeProxiesFor === 'function'
        ? (host as ProxyHost)
        : null;
    level.scene.add(this.group);
  }

  get collision(): CollisionWorld | null {
    return this.collisionWorld;
  }

  /** Despawn everything and return it to the pools. */
  clear(): void {
    for (let i = this.roster.length - 1; i >= 0; i--) this.retire(this.roster[i], true);
    this.roster.length = 0;
    this.group.removeFromParent();
    this.scene = null;
  }

  // -- spawning --------------------------------------------------------------

  /**
   * Spawn an enemy. Returns null when the archetype has no registered species,
   * or when the quality profile's `enemyBudget` is already saturated with live
   * (non-dying) agents — corpses never block a spawn.
   */
  spawn(archetypeId: string, position: THREE.Vector3, yaw: number): EnemyAgent | null {
    const def = getSpecies(archetypeId);
    if (!def) {
      console.warn(`[enemies] no species registered for "${archetypeId}"`);
      return null;
    }
    let liveCount = 0;
    for (const a of this.roster) if (a.state === 'alive') liveCount++;
    if (liveCount >= settings.profile.enemyBudget) return null;

    const tpl = this.template(archetypeId, def);
    const agent = this.acquire(tpl);
    if (!agent) return null;

    let groundY = position.y;
    if (this.collisionWorld && !def.archetype.flying) {
      const g = this.collisionWorld.sampleGround(position.x, position.z, position.y + 40);
      if (g) groundY = g.y;
    }
    agent.externalMotion = this.externalMotionFlag;
    agent.activate(position, yaw, groundY);
    this.registerProxies(agent, tpl);
    this.group.add(agent.object);
    if (agent.shieldMesh) agent.shieldMesh.visible = agent.shield > 0;
    this.roster.push(agent);
    return agent;
  }

  /** Build (or fetch) the shared geometry + rig for a species. */
  private template(id: string, def: SpeciesDefinition): SpeciesTemplate {
    const hit = this.templates.get(id);
    if (hit) return hit;

    const profile = settings.profile;
    const detail = clamp(profile.terrainDetail * 0.85 + 0.3, 0.55, 1.25);
    const rng = new Rng(speciesSeed(id));
    const builder = new BodyBuilder(this.materials, rng, detail);
    const rig = new Rig();
    const body = def.build({
      materials: this.materials,
      builder,
      rig,
      archetype: def.archetype,
      rng,
      detail,
    });

    // Held props are re-authored into the pose the animator actually settles
    // into, *before* the skin bind, so a shield drawn upright stays upright.
    alignHeldProps(body);

    // Skin weights are computed once against the rest pose and shared by every
    // instance — the single biggest reason 40 agents fit in the budget.
    for (const part of body.parts) body.rig.skin(part.geometry, { hardBones: part.hardBones });

    // With weights in hand, measure how far each foot's sole sits below the
    // joint the IK actually drives, so the animator can plant it on the floor
    // instead of a guessed fraction of the last bone's length.
    body.footLift = measureFootLift(body);

    const tpl: SpeciesTemplate = {
      def,
      body,
      rig: body.rig,
      parts: body.parts,
      pool: [],
      live: 0,
    };
    this.templates.set(id, tpl);
    return tpl;
  }

  private acquire(tpl: SpeciesTemplate): EnemyAgent | null {
    for (const a of tpl.pool) {
      if (a.state === 'pooled' && this.roster.indexOf(a) < 0) return a;
    }
    const agent = this.instantiate(tpl);
    tpl.pool.push(agent);
    return agent;
  }

  private instantiate(tpl: SpeciesTemplate): EnemyAgent {
    const rigInstance: RigInstance = tpl.rig.build();
    const agent = new EnemyAgent(
      tpl.def,
      tpl.body,
      rigInstance,
      this,
      speciesSeed(tpl.def.archetype.id) ^ (tpl.pool.length * 2654435761),
    );

    const dissolveMode = FACTION_DISSOLVE[tpl.def.archetype.faction] ?? 4;
    const accent = new THREE.Color(tpl.body.accentColor ?? FACTION_ACCENT[tpl.def.archetype.faction]);
    for (const part of tpl.parts) {
      const mat = cloneEnemyMaterial(part.material);
      const u = enemyUniforms(mat);
      if (u) {
        u.uDissolveMode.value = dissolveMode;
        u.uEdgeColor.value.copy(accent);
        u.uCentre.value.set(0, tpl.body.height * 0.5, 0);
      }
      const mesh = new THREE.SkinnedMesh(part.geometry, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Bones are parented under the agent group, so the bind matrices are in
      // the group's space and `bindMode` must stay attached (the default).
      mesh.bind(rigInstance.skeleton, new THREE.Matrix4());
      mesh.frustumCulled = false;
      agent.object.add(mesh);
      agent.meshes.push(mesh);
    }

    if (tpl.def.archetype.shield > 0) {
      const mat = this.shieldTemplate.clone();
      const element = tpl.def.archetype.shieldElement ?? 'kinetic';
      (mat.uniforms.uColor.value as THREE.Color).setHex(SHIELD_ELEMENT_COLOR[element] ?? 0xd7e2ee);
      const shell = new THREE.Mesh(this.shieldGeometry, mat);
      // Ellipsoid, not a sphere: a shield that hugs the body reads as a
      // personal field. A true sphere reads as a bubble the unit stands in.
      const r = tpl.body.shieldRadius ?? tpl.body.height * 0.52;
      shell.scale.set(r * 0.5, r, r * 0.5);
      shell.position.y = tpl.body.height * 0.48;
      shell.renderOrder = 6;
      shell.frustumCulled = false;
      shell.visible = false;
      agent.object.add(shell);
      agent.shieldMesh = shell;
    }

    agent.brain = tpl.def.behaviour(this.behaviourContext(1 / 60));
    return agent;
  }

  private registerProxies(agent: EnemyAgent, tpl: SpeciesTemplate): void {
    if (!this.proxyHost) return;
    const specs: ProxySpec[] = tpl.body.hitProxies ?? [
      { region: 'head', bone: agent.headBone, radius: 0.2, multiplier: 2 },
      { region: 'body', bone: 'spine.chest', radius: 0.35, multiplier: 1 },
    ];
    let entry = this.proxies.get(agent.entityId);
    if (!entry) {
      entry = {
        list: specs.map((s) => ({
          damageable: agent,
          region: s.region,
          offset: (s.offset ?? _v0.set(0, 0, 0)).clone(),
          radius: s.radius,
          halfHeight: s.halfHeight ?? 0,
          multiplier: s.multiplier,
          enabled: true,
          world: new THREE.Vector3(),
        })),
        // Resolve the bone name once. `refreshProxies` runs for every agent on
        // every simulation step; a string map lookup in there is thousands of
        // wasted hashes a second.
        bones: Int32Array.from(specs.map((s) => agent.rig.def.boneIndex(s.bone))),
      };
      this.proxies.set(agent.entityId, entry);
    }
    for (const p of entry.list) {
      p.enabled = true;
      this.proxyHost.addProxy(p);
    }
    this.refreshProxies(agent);
  }

  /**
   * Track the animated skeleton. Proxies read the pose the animator produced on
   * the last rendered frame, so a headshot lands on the head where the player
   * saw it, not where a bind-pose capsule would be.
   */
  private refreshProxies(agent: EnemyAgent): void {
    const entry = this.proxies.get(agent.entityId);
    if (!entry) return;
    const { list, bones } = entry;
    for (let i = 0; i < list.length; i++) {
      const idx = bones[i];
      if (idx < 0) continue;
      const p = list[i];
      p.world.copy(agent.rig.worldPos[idx]);
      if (p.offset.lengthSq() > 1e-8) {
        p.world.add(_v0.copy(p.offset).applyQuaternion(agent.rig.worldQuat[idx]));
      }
    }
  }

  // -- host callbacks --------------------------------------------------------

  onAgentDamaged(agent: EnemyAgent, info: DamageInfo, dealt: number): void {
    events.emit('enemy:damaged', {
      ...info,
      remaining: agent.health,
      entityId: agent.entityId,
    });
    if (dealt > 0) {
      this.vfx.bloodOrIchor(info.point, info.normal, agent.faction, clamp(dealt / 40, 0.3, 1.6));
    }
    if (agent.shieldMesh && agent.shield > 0) {
      const u = (agent.shieldMesh.material as THREE.ShaderMaterial).uniforms;
      u.uHit.value = 1;
    }
  }

  onAgentShieldBroken(agent: EnemyAgent, info: DamageInfo): void {
    const element = agent.archetype.shieldElement ?? info.element;
    agent.getWorldPosition(_v0);
    events.emit('enemy:shieldBroken', {
      entityId: agent.entityId,
      position: _v0.clone(),
      element,
    });
    this.vfx.shieldBreak(_v0, element, agent.height * 0.6);
    if (agent.shieldMesh) agent.shieldMesh.visible = false;
  }

  onAgentKilled(agent: EnemyAgent, info: DamageInfo | null): void {
    if (agent.isDead) return;
    agent.beginDeath(info);
    agent.getWorldPosition(_v0);
    events.emit('enemy:killed', {
      entityId: agent.entityId,
      position: _v0.clone(),
      score: agent.archetype.score,
      precision: info?.precision ?? false,
      name: agent.archetype.displayName,
      element: info?.element ?? 'kinetic',
    });
    this.dropLoot(agent);
    this.enforceCorpseCap();
  }

  private dropLoot(agent: EnemyAgent): void {
    if (!this.onLootDrop) return;
    const r = this.rng.next();
    const rank = agent.archetype.rank;
    let kind: LootDrop['kind'] = 'ammo';
    if (rank === 'boss' || rank === 'champion') kind = r < 0.6 ? 'engram' : 'heavyAmmo';
    else if (rank === 'elite') kind = r < 0.3 ? 'heavyAmmo' : r < 0.55 ? 'orb' : 'ammo';
    else if (r < 0.12) kind = 'health';
    else if (r > 0.82) kind = 'orb';
    else if (r > 0.55) kind = 'ammo';
    else return;
    this.onLootDrop({
      kind,
      rarity: rank === 'boss' ? 'legendary' : rank === 'champion' ? 'rare' : 'common',
      position: agent.position.clone().setY(agent.position.y + 0.4),
    });
  }

  /** Keep only as many ragdolls as the profile can afford; oldest dissolves first. */
  private enforceCorpseCap(): void {
    const cap = clamp(Math.round(settings.profile.enemyBudget / 4), 3, 10);
    let corpses = 0;
    let oldest: EnemyAgent | null = null;
    for (const a of this.roster) {
      if (a.state !== 'dying') continue;
      corpses++;
      if (!oldest || a.deathTime > oldest.deathTime) oldest = a;
    }
    if (corpses > cap && oldest) oldest.deathTime = Math.max(oldest.deathTime, CORPSE_LINGER);
  }

  // -- simulation ------------------------------------------------------------

  update(ctx: FrameContext): void {
    if (this.disposed) return;
    this.time = ctx.elapsed;
    const dt = ctx.dt;
    const player = this.player();
    const bctx = this.behaviourContext(dt);
    if (player && !player.isDead) {
      bctx.target = player;
      bctx.targetPosition.copy(player.eyePosition);
      bctx.targetVelocity.copy(player.velocity);
      bctx.targetValid = true;
    }

    let live = 0;
    let dying = 0;

    for (let i = this.roster.length - 1; i >= 0; i--) {
      const agent = this.roster[i];

      if (agent.state === 'alive') {
        live++;
        this.updatePerception(agent, bctx);
        // Behaviour ticks at 12–30 Hz depending on LOD: an AI decision does not
        // need 120 Hz, and this is the difference between 40 agents costing
        // 0.4 ms and costing 4 ms.
        agent.brainAccum += dt;
        const brainStep = agent.lod === 'full' ? 1 / 30 : agent.lod === 'reduced' ? 1 / 20 : 1 / 10;
        if (agent.brainAccum >= brainStep) {
          bctx.dt = agent.brainAccum;
          agent.think(bctx);
          agent.brainAccum = 0;
          bctx.dt = dt;
        }
        // The AI director's one-step `fire` pulse, and its wind-up telegraph.
        if (agent.ai.fire) {
          agent.ai.fire = false;
          agent.ai.vars.set('attackPending', 1);
          if (!agent.anim.busy) agent.anim.attack(0.02, 0.06, 0.2);
        }
        agent.staggered = agent.anim.staggering;
        this.resolveAttack(agent, bctx);
        agent.step(dt, this.collisionWorld);
        this.regenShield(agent, dt);
      } else if (agent.state === 'dying') {
        dying++;
        this.updateDeath(agent, dt);
      }

      if (agent.state === 'dead') {
        this.retire(agent, false);
        this.roster.splice(i, 1);
        continue;
      }
      this.refreshProxies(agent);
    }

    this.separate(dt);
    this.stats.live = live;
    this.stats.dying = dying;
  }

  private updatePerception(agent: EnemyAgent, ctx: BehaviourContext): void {
    const ai = agent.ai;
    ai.target = ctx.target;
    if (!ctx.targetValid) {
      ai.hasLineOfSight = false;
      ai.distanceToTarget = Infinity;
      return;
    }
    ai.targetPosition.copy(ctx.targetPosition);
    agent.getAimPoint(_v0);
    ai.distanceToTarget = _v0.distanceTo(ctx.targetPosition);
    // LOS is the expensive query; stagger it across agents so 40 of them never
    // cast 40 rays on the same simulation step.
    if (this.frameIndex % 6 === agent.entityId % 6) {
      ai.hasLineOfSight = this.collisionWorld
        ? this.collisionWorld.lineOfSight(_v0, ctx.targetPosition)
        : true;
      if (ai.hasLineOfSight) ai.lastKnownPosition.copy(ctx.targetPosition);
    }
  }

  /**
   * Resolve a telegraphed attack when its strike window opens. This is a
   * deliberately simple hitscan-with-spread; a faction that wants projectiles
   * overrides it by handling `attackPending` in its own behaviour tree.
   */
  private resolveAttack(agent: EnemyAgent, ctx: BehaviourContext): void {
    if (!agent.ai.vars.get('attackPending')) return;
    if (!agent.anim.attackStriking) return;
    agent.ai.vars.set('attackPending', 0);
    if (!ctx.targetValid || !ctx.target) return;

    const a = agent.archetype;
    agent.rig.boneWorld(agent.muzzleBone, _v0);
    _v1.subVectors(ctx.targetPosition, _v0);
    const dist = _v1.length();
    if (dist > a.preferredRange * 3 + 4) return;
    _v1.multiplyScalar(1 / Math.max(1e-4, dist));

    const melee = a.preferredRange < 4;
    if (melee) {
      if (dist > a.preferredRange * 1.6) return;
    } else {
      // Aim error grows with range; `accuracy` is the cone at max range.
      const spread = a.accuracy * clamp01(dist / Math.max(1, a.preferredRange * 2));
      _v1.x += this.rng.gaussian() * spread;
      _v1.y += this.rng.gaussian() * spread;
      _v1.z += this.rng.gaussian() * spread;
      _v1.normalize();
      const colour = FACTION_ACCENT[agent.faction] ?? 0xffd08a;
      _v2.copy(_v0).addScaledVector(_v1, dist);
      this.vfx.tracer(_v0, _v2, 0.03, colour);
      this.vfx.muzzle(_v0, _v1, 0.75, colour);
      // A miss must still be legible, so only a real hit deals damage.
      if (this.collisionWorld && !this.collisionWorld.lineOfSight(_v0, ctx.targetPosition)) return;
      const cone = Math.acos(clamp(_v1.dot(_v2.subVectors(ctx.targetPosition, _v0).normalize()), -1, 1));
      if (cone > 0.06) return;
    }

    _dmg.amount = a.attackDamage;
    _dmg.element = a.shieldElement ?? 'kinetic';
    _dmg.region = 'body';
    _dmg.precision = false;
    _dmg.point.copy(ctx.targetPosition);
    _dmg.normal.copy(_v1).negate();
    _dmg.direction.copy(_v1);
    _dmg.sourceId = agent.entityId;
    _dmg.impulse = melee ? 6 : 2;
    ctx.target.applyDamage(_dmg);
  }

  private regenShield(agent: EnemyAgent, dt: number): void {
    if (agent.maxShield <= 0) return;
    const ai = agent.ai;
    // Only regenerate out of combat, and only after a real lull.
    if (ai.alert > 0.5 && ai.hasLineOfSight) return;
    if (agent.shield >= agent.maxShield) return;
    agent.shield = Math.min(agent.maxShield, agent.shield + agent.maxShield * 0.18 * dt);
    if (agent.shieldMesh && agent.shield > agent.maxShield * 0.05) agent.shieldMesh.visible = true;
  }

  /** Keep bodies out of each other. O(n²) over `enemyBudget` is a few hundred pairs. */
  private separate(dt: number): void {
    const n = this.roster.length;
    for (let i = 0; i < n; i++) {
      const a = this.roster[i];
      if (a.state !== 'alive') continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.roster[j];
        if (b.state !== 'alive') continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const minD = a.archetype.capsuleRadius + b.archetype.capsuleRadius;
        const d2 = dx * dx + dz * dz;
        if (d2 > minD * minD || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = ((minD - d) / d) * 0.5 * Math.min(1, dt * 22);
        a.position.x -= dx * push;
        a.position.z -= dz * push;
        b.position.x += dx * push;
        b.position.z += dz * push;
      }
    }
  }

  /** Stagger → ragdoll → dissolve → pool. */
  private updateDeath(agent: EnemyAgent, dt: number): void {
    agent.deathTime += dt;

    if (agent.staggerTime > 0) {
      agent.staggerTime -= dt;
      if (agent.staggerTime <= 0) {
        const info = agent.killInfo;
        _v0.copy(info?.point ?? agent.position);
        _v1.copy(info?.direction ?? _v2.set(0, 0, 1));
        const impulse = clamp((info?.impulse ?? 4) * 0.9, 1.5, 20);
        agent.ragdoll.begin(agent.velocity, _v0, _v1, impulse, this.collisionWorld);
        // The gib burst is the moment of death; do it as the body goes limp.
        this.spawnGibs(agent, info);
      }
    } else {
      agent.ragdoll.step(dt);
    }

    if (agent.deathTime > CORPSE_LINGER) {
      agent.dissolve = clamp01((agent.deathTime - CORPSE_LINGER) / DISSOLVE_TIME);
      if (agent.dissolve >= 1) agent.state = 'dead';
    }
  }

  private spawnGibs(agent: EnemyAgent, info: DamageInfo | null): void {
    const count = agent.archetype.rank === 'minor' ? 3 : agent.archetype.rank === 'boss' ? 10 : 5;
    agent.getWorldPosition(_v0);
    for (let i = 0; i < count; i++) {
      this.rng.onSphere(_v1);
      _v1.multiplyScalar(this.rng.range(2.2, 5.5));
      _v1.y = Math.abs(_v1.y) + 2.4;
      if (info) _v1.addScaledVector(info.direction, (info.impulse ?? 3) * 0.4);
      _v2.copy(_v0).addScaledVector(scratch.v3a.copy(_v1).normalize(), 0.2);
      this.vfx.spawnGib(_v2, _v1, agent.faction);
    }
  }

  private retire(agent: EnemyAgent, immediate: boolean): void {
    if (this.proxyHost) this.proxyHost.removeProxiesFor(agent.entityId);
    const entry = this.proxies.get(agent.entityId);
    if (entry) for (const p of entry.list) p.enabled = false;
    agent.deactivate();
    agent.object.removeFromParent();
    for (const m of agent.meshes) {
      const u = enemyUniforms(m.material as THREE.Material);
      if (u) {
        u.uDissolve.value = 0;
        u.uHitFlash.value = 0;
      }
    }
    if (immediate) {
      const i = this.roster.indexOf(agent);
      if (i >= 0) this.roster.splice(i, 1);
    }
  }

  // -- presentation ----------------------------------------------------------

  render(ctx: FrameContext, alpha: number): void {
    if (this.disposed || this.roster.length === 0) return;
    this.frameIndex++;
    const frameDt = Math.min(ctx.frameDt, 0.1);
    this.renderTime += frameDt;
    const camera = this.engine.host.camera;
    camera.getWorldPosition(_v0);

    const player = this.player();
    const t0 = performance.now();
    let animated = 0;
    let slide = 0;
    let nan = 0;

    const actx: AnimationContext = {
      dt: frameDt,
      elapsed: this.renderTime,
      lod: 'full',
      collision: this.collisionWorld,
      focus: _v1,
      focusValid: false,
    };
    if (player && !player.isDead) {
      _v1.copy(player.eyePosition);
      actx.focusValid = true;
    }

    for (const agent of this.roster) {
      const pos = agent.renderPositionAt(alpha);
      const dist = Math.sqrt(
        (pos.x - _v0.x) ** 2 + (pos.y - _v0.y) ** 2 + (pos.z - _v0.z) ** 2,
      );

      // LOD by distance. Rates are frame counts, not seconds, so a slow frame
      // never starves distant agents of animation entirely.
      let lod: AnimationLod;
      let every: number;
      if (dist < 18) {
        lod = 'full';
        every = 1;
      } else if (dist < 42) {
        lod = 'reduced';
        every = 2;
      } else if (dist < 95) {
        lod = 'coarse';
        every = 3;
      } else {
        lod = 'distant';
        every = 6;
      }
      agent.lod = lod;
      agent.animAccum += frameDt;

      if (agent.state === 'dying' && agent.staggerTime <= 0) {
        // The ragdoll owns the pose; only the group transform needs writing.
        agent.object.position.copy(agent.ragdoll.rootPosition);
        agent.object.quaternion.copy(agent.ragdoll.rootQuaternion);
      } else if ((this.frameIndex + agent.entityId) % every === 0) {
        actx.dt = agent.animAccum;
        actx.lod = lod;
        agent.animAccum = 0;
        agent.anim.update({
          dt: actx.dt,
          elapsed: this.renderTime,
          lod,
          position: pos,
          velocity: agent.velocity,
          yaw: agent.yaw,
          yawRate: agent.yawRate,
          grounded: agent.grounded,
          groundY: agent.groundHeight,
          groundNormal: agent.groundSurfaceNormal,
          collision: this.collisionWorld,
          focus: actx.focus,
          focusValid: actx.focusValid,
          thrust: agent.ai.thrust,
        });
        agent.species.animate?.(agent, actx);
        agent.object.position.copy(agent.anim.rootPosition);
        agent.object.quaternion.copy(agent.anim.rootQuaternion);
        animated++;
        if (agent.anim.maxFootSlide > slide) slide = agent.anim.maxFootSlide;
        if (!agent.rig.validate()) nan++;
      } else {
        agent.object.position.copy(pos);
        _q0.setFromAxisAngle(_v2.set(0, 1, 0), agent.yaw);
        agent.object.quaternion.copy(_q0);
      }

      this.updateMaterials(agent, frameDt);
    }

    this.stats.animMs = damp(this.stats.animMs, performance.now() - t0, 6, frameDt);
    this.stats.animated = animated;
    this.stats.maxFootSlide = slide;
    this.stats.nanBones = nan;
  }

  private updateMaterials(agent: EnemyAgent, dt: number): void {
    // Decayed here rather than in the fixed step so a corpse fades out of its
    // hit flash too — a body that dies mid-flash must not stay blown out.
    agent.hitFlash = damp(agent.hitFlash, 0, 9, dt);
    const flash = agent.hitFlash;
    for (const m of agent.meshes) {
      const u = enemyUniforms(m.material as THREE.Material);
      if (!u) continue;
      u.uHitFlash.value = flash * 0.55;
      u.uDissolve.value = agent.dissolve;
      u.uTime.value = this.renderTime;
    }
    const shell = agent.shieldMesh;
    if (shell && shell.visible) {
      const u = (shell.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = this.renderTime;
      u.uHealth.value = agent.maxShield > 0 ? agent.shield / agent.maxShield : 0;
      u.uHit.value = damp(u.uHit.value as number, 0, 7, dt);
      if (agent.shield <= 0) shell.visible = false;
    }
  }

  // -- helpers ---------------------------------------------------------------

  private cachedCtx: BehaviourContext | null = null;

  private behaviourContext(dt: number): BehaviourContext {
    if (!this.cachedCtx) {
      this.cachedCtx = {
        dt,
        elapsed: this.time,
        collision: this.collisionWorld,
        vfx: this.vfx,
        target: null,
        targetPosition: new THREE.Vector3(),
        targetVelocity: new THREE.Vector3(),
        targetValid: false,
        rng: this.rng,
      };
    }
    const c = this.cachedCtx;
    c.dt = dt;
    c.elapsed = this.time;
    c.collision = this.collisionWorld;
    c.target = null;
    c.targetValid = false;
    return c;
  }

  private player(): PlayerLike | null {
    return (this.engine.get('player') as unknown as PlayerLike | undefined) ?? null;
  }

  /** All live agents of a faction — handy for the AI director and objectives. */
  agentsOf(faction: FactionId): EnemyAgent[] {
    return this.roster.filter((a) => a.faction === faction && a.state === 'alive');
  }

  /** Nearest live agent to a point within `maxDistance`, or null. */
  nearest(point: THREE.Vector3, maxDistance = Infinity): EnemyAgent | null {
    let best: EnemyAgent | null = null;
    let bestD = maxDistance * maxDistance;
    for (const a of this.roster) {
      if (a.state !== 'alive') continue;
      const d = a.position.distanceToSquared(point);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  /**
   * Aim-assist candidates: one bubble per live agent, centred on the body rather
   * than the ground contact `position` sits at.
   *
   * The bubble is deliberately a little wider than the collision capsule. Assist
   * that only engages once the crosshair is already on the hitbox is assist that
   * arrives too late to help, and the radius only shapes where the camera slows
   * down — it has no bearing on where bullets go.
   */
  collectAimTargets(out: AimTarget[], origin: THREE.Vector3, maxDistance: number): void {
    const maxSq = maxDistance * maxDistance;
    for (const a of this.roster) {
      if (a.state !== 'alive') continue;
      if (a.position.distanceToSquared(origin) > maxSq) continue;
      const arc = a.archetype;
      const target = this.aimTargetPool[out.length] ?? this.newAimTarget();
      target.point.set(a.position.x, a.position.y + arc.capsuleHalfHeight, a.position.z);
      target.radius = Math.max(arc.capsuleRadius, arc.capsuleHalfHeight * 0.75) * 1.35;
      out.push(target);
    }
  }

  private readonly aimTargetPool: AimTarget[] = [];

  /** Grow the pool rather than allocating in the aim path every step. */
  private newAimTarget(): AimTarget {
    const t: AimTarget = { point: new THREE.Vector3(), radius: 1 };
    this.aimTargetPool.push(t);
    return t;
  }

  /** Kill an agent without a damage source (scripted deaths, level cleanup). */
  kill(agent: EnemyAgent): void {
    if (agent.isDead) return;
    agent.health = 0;
    this.onAgentKilled(agent, null);
  }

  /** Live (non-dying) agent count. Read by the AI director's host interface. */
  get aliveCount(): number {
    let n = 0;
    for (const a of this.roster) if (a.state === 'alive') n++;
    return n;
  }

  /** Archetype ids for a faction and rank — the encounter director's roster. */
  archetypesFor(faction: FactionId, rank: string): string[] {
    const out: string[] = [];
    for (const id of Object.keys(ARCHETYPES)) {
      const a = ARCHETYPES[id];
      if (a.faction === faction && a.rank === rank && getSpecies(id)) out.push(id);
    }
    return out;
  }

  /**
   * Deal an attack the AI director released. Mirrors the internal telegraphed
   * path so both drivers produce the same tracer, muzzle flash and damage.
   */
  onAttack(agent: EnemyAgent, aimPoint: THREE.Vector3): void {
    agent.ai.aimPoint.copy(aimPoint);
    agent.ai.vars.set('attackPending', 1);
    if (!agent.anim.busy) agent.anim.attack(0.02, 0.06, 0.2);
  }

  /** Archetype lookup, so callers do not need a second import. */
  archetype(id: string): EnemyArchetype | undefined {
    return ARCHETYPES[id];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    for (const tpl of this.templates.values()) {
      for (const agent of tpl.pool) agent.dispose();
      for (const part of tpl.parts) {
        part.geometry.dispose();
        part.material.dispose();
      }
    }
    this.templates.clear();
    this.proxies.clear();
    this.shieldGeometry.dispose();
    this.shieldTemplate.dispose();
  }
}

// ---------------------------------------------------------------------------
// Held-prop alignment
// ---------------------------------------------------------------------------

const _alignM = new THREE.Matrix4();
const _alignN = new THREE.Matrix3();
const _alignV = new THREE.Vector3();

/**
 * Bake the bind-pose → combat-pose difference out of every rigidly bound prop.
 *
 * A rig's bind pose has the arms hanging straight down; the animator's ready
 * stance drops the elbow back and swings the forearm forward, and measured on
 * the Nordic Huscarl that is an 89-degree rotation of the hand bone. Anything
 * rigidly bound to that bone inherits all 89 degrees, which is why a tower
 * shield authored square to the front rendered edge-on to the player and a pair
 * of axes rolled into their owner's thigh. No amount of authoring-by-eye fixes
 * it, because the number depends on limb proportions the author does not
 * control.
 *
 * So measure it. Instantiate the rig once, run the animator to its settled idle
 * with a target in front, read the world transform each bound bone ended up
 * with, and pre-multiply the prop's vertices by the inverse. The prop is then
 * authored in the pose a player actually sees, and the skinning puts it back
 * exactly there. Cost is one throwaway rig and a dozen animator steps per
 * species, paid once at template build.
 */
function alignHeldProps(body: BuiltBody): void {
  const wanted = body.parts.some(
    (p) => p.hardBones?.length && p.hardAlign?.some((a) => a),
  );
  if (!wanted) return;

  const inst = settleRig(body.rig, body.tuning, body.height);

  // One correction matrix per bound bone: inverse of (posed world × bind
  // inverse), which is exactly the transform skinning is about to apply.
  const corrections = new Map<string, THREE.Matrix4>();
  const resolve = (name: string): THREE.Matrix4 | null => {
    const hit = corrections.get(name);
    if (hit) return hit;
    const gi = body.rig.boneIndex(name);
    if (gi < 0) return null;
    const rest = body.rig.bones[gi];
    _alignM.compose(rest.worldPos, rest.worldQuat, _alignV.set(1, 1, 1)).invert();
    const m = new THREE.Matrix4().multiplyMatrices(inst.bones[gi].matrixWorld, _alignM).invert();
    corrections.set(name, m);
    return m;
  };

  for (const part of body.parts) {
    const names = part.hardBones;
    const align = part.hardAlign;
    if (!names?.length || !align?.some((a) => a)) continue;
    const tag = part.geometry.getAttribute('hardBone') as THREE.BufferAttribute | undefined;
    const pos = part.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nor = part.geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (!tag) continue;
    for (let v = 0; v < pos.count; v++) {
      const t = tag.getX(v) | 0;
      if (t <= 0 || !align[t - 1]) continue;
      const m = resolve(names[t - 1]);
      if (!m) continue;
      _alignV.set(pos.getX(v), pos.getY(v), pos.getZ(v)).applyMatrix4(m);
      pos.setXYZ(v, _alignV.x, _alignV.y, _alignV.z);
      if (nor) {
        _alignN.getNormalMatrix(m);
        _alignV.set(nor.getX(v), nor.getY(v), nor.getZ(v)).applyMatrix3(_alignN).normalize();
        nor.setXYZ(v, _alignV.x, _alignV.y, _alignV.z);
      }
    }
    pos.needsUpdate = true;
    if (nor) nor.needsUpdate = true;
    part.geometry.computeBoundingSphere();
  }

  inst.dispose();
}

/**
 * How far below each leg chain's IK joint the sole of its foot actually is, in
 * the bind pose, measured from the skinned geometry.
 *
 * The animator used to infer this from bone lengths — 85% of the last segment —
 * which knows nothing about how thick the foot mesh is. Measured against the
 * capture harness every ground unit in the game was floating: 9.8 cm for a
 * Nordic Raider, 13.3 for a Grey Psion, 13.4 for a Hive Soldier. At two metres
 * tall that is the difference between a creature standing on a planet and a
 * sticker hovering over one.
 *
 * A vertex counts toward a foot when its dominant bone is the IK joint or
 * anything past it in the same chain — i.e. the foot and its toes, never the
 * shin. Claws that dip below the sole are excluded by taking the 4th percentile
 * rather than the minimum, so a single dew-claw does not lift the whole body.
 */
function measureFootLift(body: BuiltBody): number[] {
  const rig = body.rig;
  const legs = rig.chains.filter((c) => c.kind === 'leg');
  if (!legs.length) return [];
  const out: number[] = [];
  const samples: number[][] = legs.map(() => []);
  // Bone index -> which leg it belongs to, counting only the foot end.
  const owner = new Map<number, number>();
  for (let l = 0; l < legs.length; l++) {
    const c = legs[l];
    const ikJoint = c.lengths.length >= 3 ? c.lengths.length - 1 : c.lengths.length;
    for (let i = ikJoint; i < c.bones.length; i++) owner.set(c.bones[i], l);
  }

  for (const part of body.parts) {
    const pos = part.geometry.getAttribute('position') as THREE.BufferAttribute;
    const si = part.geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const sw = part.geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    if (!si || !sw) continue;
    for (let v = 0; v < pos.count; v++) {
      let best = -1;
      let bestW = 0.35;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(v, k);
        if (w > bestW) {
          bestW = w;
          best = si.getComponent(v, k);
        }
      }
      if (best < 0) continue;
      const leg = owner.get(best);
      if (leg == null) continue;
      samples[leg].push(pos.getY(v));
    }
  }

  for (let l = 0; l < legs.length; l++) {
    const c = legs[l];
    const ikJoint = c.lengths.length >= 3 ? c.lengths.length - 1 : c.lengths.length;
    const jointY = rig.bones[c.bones[Math.min(ikJoint, c.bones.length - 1)]].worldPos.y;
    const list = samples[l];
    if (list.length < 8) {
      out.push(Number.NaN);
      continue;
    }
    list.sort((a, b) => a - b);
    const sole = list[Math.floor(list.length * 0.04)];
    out.push(jointY - sole);
  }
  return out;
}
