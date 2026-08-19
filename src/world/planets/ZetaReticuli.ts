/**
 * Zeta Reticuli IV — the Ashen Flats.
 *
 * Forty millibars of nitrogen over grey regolith. There is effectively no sky
 * fill here, which is the entire art problem: an unlit face on this world is
 * *black*, not dark grey. So the level is composed for cross-light — the spawn
 * heading is scored perpendicular to the sun — and every set piece is a form
 * that turns through the light rather than a flat plate that either catches it
 * or does not.
 *
 * Three languages share the frame and are never mixed:
 *   - the *plain*: pale terraced regolith, the one bright value;
 *   - the *Custodians*: seamless white alloy, half-buried, nothing joins to
 *     anything, no fasteners, no panel lines except a single violet seam;
 *   - the *wreck*: Federation plate, rust, torn structure — the only warm hue
 *     and the only asymmetric silhouette on the horizon.
 *
 * Registers itself with the planet registry on import.
 */
import * as THREE from 'three';
import type { FrameContext, PlanetDescriptor } from '@/types';
import type { EncounterScript } from '@/gameplay/ai/EncounterDirector';
import { ATMOSPHERES, cloneAtmosphere, type AtmosphereProfile } from '@/gfx/sky/AtmosphereProfile';
import { terrainRecipe } from '@/gfx/terrain/TerrainBuilder';
import type { TerrainDescriptor } from '@/gfx/terrain/HeightField';
import { clamp, TAU } from '@/util/math';
import { settings } from '@/core/Settings';
import {
  PlanetLevel,
  bandRing,
  cloneRecipe,
  revolved,
  tapered,
  tube,
  type PropBatch,
  type SpawnVolumeSpec,
} from './PlanetLevel';
import { registerPlanet, type PlanetDeps } from './index';
// Sibling registrations — see the note in `Aurvangr.ts`. Importing any one of
// this owner's planet modules registers all three.
import './Aurvangr';
import './Khepri';

/** Grey Collective emissive identity. Matches FACTION_IDENTITY.grey. */
const CUSTODIAN_VIOLET = 0xb478ff;
/** Federation running lights. */
const FED_CYAN = 0x64e2ff;

const _up = new THREE.Vector3(0, 1, 0);
const _tmp = new THREE.Vector3();

/** A seam light waiting to be built. Higher `priority` survives a lower tier. */
interface SeamLightSpot {
  position: THREE.Vector3;
  color: number;
  intensity: number;
  range: number;
  priority: number;
}

class ZetaReticuliLevel extends PlanetLevel {
  private alloy!: PropBatch;
  private seam!: PropBatch;
  private mono!: PropBatch;
  private hull!: PropBatch;
  private plate!: PropBatch;
  private burnt!: PropBatch;
  private glass!: PropBatch;
  private light!: PropBatch;
  private regolith!: PropBatch;
  /** Near-field grit: chips, ejecta, torn foil. Never collides. */
  private grit!: PropBatch;

  /**
   * Real lights behind the violet seams and the Federation running lights.
   *
   * The seams were emissive geometry and nothing else: a hard-edged flat strip
   * with no falloff onto the alloy either side of it and no pool on the regolith
   * under it, which on a world with essentially no sky fill made them read as
   * tape stuck to the forms. `DracoIX` and `HivePrime` already back their
   * emissives with point lights; this is the same pattern, budgeted the same way.
   */
  private readonly seamLights: THREE.PointLight[] = [];
  private readonly seamBase: number[] = [];
  private readonly seamSpots: SeamLightSpot[] = [];

  /** Where the wreck still smoulders. */
  private readonly vents: THREE.Vector3[] = [];

  /** Impact point of the survey vessel Halberd — chapter two's arrival point. */
  private readonly wreckPos = new THREE.Vector3();

  private ventTimer = 0;
  private ventCursor = 0;

  constructor(deps: PlanetDeps, descriptor: PlanetDescriptor) {
    super(deps, descriptor, {
      navRadius: 126,
      // No sky fill: only a raking key gives these forms any modelling at all.
      spawnFacing: 'across',
      spawnSearchRadius: 110,
      dust: { density: 0.22, color: 0xb6aec2, size: 0.035 },
    });
  }

  protected override atmosphere(): AtmosphereProfile {
    const a = cloneAtmosphere(ATMOSPHERES['zeta-reticuli']);
    // The wreck is 60 m long and the monolith field spreads 180 m; the stock
    // 95 m frustum clipped the far half of the field's shadows.
    a.shadowExtent = 145;
    return a;
  }

  protected override recipe(): TerrainDescriptor {
    const d = cloneRecipe(terrainRecipe('zeta-reticuli'));
    // Open review defect: the macro silhouette rounds off into dunes. The
    // terraces are this world's whole shape language, so sharpen both.
    d.ridgePower = 2.35;
    d.erosion = 0.78;
    d.terraceStrength = 0.78;
    // "No vegetation." The stock recipe scatters grass and scrub; a stripped
    // world has neither, and removing them also buys back the scatter budget
    // the monolith field spends.
    for (const e of d.flora.entries) e.density = 0;
    // A stripped plain needs to actually be a plain: the stock 58 m basin is a
    // pothole in a mesa field, and the monolith array spans 180 m.
    d.flattenRadius = 260;
    d.flattenHeight = 3;
    return d;
  }

  // -- construction ----------------------------------------------------------

  protected decorate(): void {
    this.alloy = this.batch(
      'alloy',
      this.surface('greyAlloy', {
        repeat: 1,
        color: 0xe6e6ee,
        roughness: 0.16,
        metalness: 0.32,
        envMapIntensity: 1.5,
      }),
      { tile: 6, collide: true, surface: 'metal' },
    );
    this.seam = this.batch('seam', this.glow(CUSTODIAN_VIOLET, 1.0), {
      tile: 0,
      collide: false,
      castShadow: false,
      receiveShadow: false,
    });
    this.mono = this.batch(
      'monolith',
      // Not `obsidian`: that recipe is metalness 1 at envMapIntensity 1.7, and
      // under a near-black violet sky its specular becomes a field of white
      // sparkles that reads as cut crystal. Dark rock at high roughness is what
      // a monolith is — the material has to be chosen for the *sky it stands
      // under*, not from the name in the catalogue.
      this.surface('rock', {
        repeat: 1,
        color: 0x282634,
        roughness: 0.95,
        metalness: 0,
        normalScale: 1.2,
        envMapIntensity: 0.4,
      }),
      { tile: 3.4, collide: true, surface: 'rock' },
    );
    this.hull = this.batch(
      'hull',
      this.surface('fedHull', { repeat: 1, color: 0x6f757c, roughness: 0.55, metalness: 0.7 }),
      { tile: 3.2, collide: true, surface: 'metal' },
    );
    this.plate = this.batch(
      'plate',
      this.surface('fedPanel', { repeat: 1, color: 0x5d646c, roughness: 0.66, metalness: 0.45 }),
      { tile: 2.4, collide: true, surface: 'metal' },
    );
    this.burnt = this.batch(
      'burnt',
      this.surface('rustedSteel', { repeat: 1, color: 0x6b4a38, roughness: 0.92, metalness: 0.35 }),
      { tile: 2, collide: true, surface: 'metal' },
    );
    this.glass = this.batch('glass', this.surface('fedGlass', { repeat: 1 }), {
      tile: 2,
      collide: false,
      castShadow: false,
    });
    this.light = this.batch('light', this.glow(FED_CYAN, 3.2), {
      tile: 0,
      collide: false,
      castShadow: false,
      receiveShadow: false,
    });
    this.regolith = this.batch(
      'regolith',
      this.surface('sand', { repeat: 1, color: 0x9c958a, roughness: 1, normalScale: 0.9 }),
      { tile: 5, collide: false, surface: 'sand' },
    );

    // The near field was a smooth grey plane out to twenty metres in every
    // review frame. Its own batch because nothing that collides may be two
    // centimetres across.
    this.grit = this.batch(
      'grit',
      // Darker than the regolith it lies on. On a world with no sky fill the
      // only thing separating a stone from the ground is its own value and its
      // own shadow, so it gets both.
      this.surface('sand', { repeat: 1, color: 0x6b655d, roughness: 1 }),
      // `castShadow` is on, and it is the reason any of this reads. Captures of
      // the first attempt showed a bare ground plane with the scatter provably
      // present in it: a 20 cm stone lit from the same direction as the ground
      // it lies on has no edge until it drops a contact shadow. One merged mesh,
      // so the whole near field costs one extra shadow draw.
      { tile: 0.9, collide: false, surface: 'sand', castShadow: true },
    );

    // Order matters only for legibility; the merge is per material anyway.
    this.buildImpactFurrow(22, 96, 6);
    this.buildWreck(94, 6);
    this.buildHullGallery();
    this.buildCustodianArray();
    this.buildCustodianTerrace();
    this.buildMonolithField();
    this.buildCover();
    this.buildForeground();
    this.buildNearField();
    this.installSeamLights();
  }

  /**
   * Build the queued seam lights, up to the tier's budget.
   *
   * Every extra light lengthens the forward light loop in every lit shader in
   * the scene, so the count comes from `settings.profile` rather than being
   * fixed, and the spots are ranked so a low tier drops the ones that carry the
   * least of the frame instead of an arbitrary set.
   */
  private installSeamLights(): void {
    const budget = Math.round(clamp(settings.profile.terrainDetail * 6, 2, 8));
    this.seamSpots.sort((a, b) => b.priority - a.priority);
    for (let i = 0; i < Math.min(budget, this.seamSpots.length); i++) {
      const spot = this.seamSpots[i];
      const light = new THREE.PointLight(spot.color, spot.intensity, spot.range, 2);
      light.position.copy(spot.position);
      light.castShadow = false;
      this.props.add(light);
      this.seamLights.push(light);
      this.seamBase.push(spot.intensity);
    }
    this.seamSpots.length = 0;
  }

  /** Queue a seam light; `priority` decides which survive a low tier. */
  private queueSeamLight(
    position: THREE.Vector3,
    color: number,
    intensity: number,
    range: number,
    priority: number,
  ): void {
    this.seamSpots.push({ position: position.clone(), color, intensity, range, priority });
  }

  // -- the landmark ----------------------------------------------------------

  /**
   * The survey vessel `Halberd`, broken across the spine.
   *
   * Built in a *local frame* — +Z is the direction the ship was travelling when
   * it hit, +Y is up, origin is the point of impact — and transformed into the
   * world exactly once. Two earlier attempts composed the wreck straight into
   * world space with per-piece Euler tilts, and the result was unreadable: with
   * `YXZ` order and a ninety-degree X tilt it is genuinely hard to predict which
   * end of a revolved profile ends up buried, and the "landmark" kept coming out
   * as an anonymous mound. In a local frame the shape is just arithmetic.
   *
   * The silhouette it is aiming for: a forward section climbing out of its own
   * crater with the nose driven under, a twenty-five metre tail section reared
   * up behind the break with its fin still on, and torn structure between them.
   * Nothing else on this world is asymmetric, so at any distance that reads.
   */
  private buildWreck(forward: number, right: number): void {
    const rng = this.rng;
    // The hull lies along the furrow, which runs down the composition axis.
    const axis = this.spawnYaw + 0.22;
    const base = this.atSpawn(forward, right);
    const groundY = this.padHeight(base, 18, 13);
    // The mission's arrival point. Chapter 2's first objective is *reach the
    // Halberd*, and a reach trigger needs the wreck's real world position rather
    // than the authored offsets that produced it.
    this.wreckPos.set(base.x, groundY, base.z);

    const world = new THREE.Matrix4().compose(
      new THREE.Vector3(base.x, groundY, base.z),
      new THREE.Quaternion().setFromAxisAngle(_up, axis),
      new THREE.Vector3(1, 1, 1),
    );
    const local = new THREE.Matrix4();
    const composed = new THREE.Matrix4();
    const lp = new THREE.Vector3();
    const lq = new THREE.Quaternion();
    const ls = new THREE.Vector3(1, 1, 1);

    /** Place a geometry at a local pose. */
    const put = (
      batch: PropBatch,
      geo: THREE.BufferGeometry,
      x: number,
      y: number,
      z: number,
      rx = 0,
      ry = 0,
      rz = 0,
      scale: THREE.Vector3 | number = 1,
    ): void => {
      lp.set(x, y, z);
      lq.setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
      if (typeof scale === 'number') ls.setScalar(scale);
      else ls.copy(scale);
      local.compose(lp, lq, ls);
      composed.multiplyMatrices(world, local);
      batch.add(geo, composed);
    };
    /** Local-space point list straight into the world transform. */
    const sweep = (
      batch: PropBatch,
      pts: Array<[number, number, number]>,
      r0: number,
      r1: number,
      sides = 10,
    ): void => {
      const v = pts.map((q) => new THREE.Vector3(q[0], q[1], q[2]));
      batch.add(this.temp(tube(v, r0, r1, sides)), world);
    };

    // -- forward section: nose driven under, hull climbing out of the crater --
    sweep(this.hull, [[0, -5, -4], [0, -1.6, 1], [0.4, 1.2, 6]], 1.1, 3.9, 12);
    sweep(this.hull, [[0.4, 1.2, 6], [0.7, 4.2, 12], [0.6, 7.4, 18]], 3.9, 5.1, 12);
    sweep(this.hull, [[0.6, 7.4, 18], [0.2, 9.6, 23]], 5.1, 4.3, 12);

    // Dorsal spine and belly keel: the two lines that make a hull read as built.
    sweep(this.plate, [[0, 3.4, 4], [0.6, 6.6, 12], [0.5, 10.9, 21]], 0.7, 0.5, 5);
    put(this.plate, this.temp(tapered(0.7, 9, 5.5, 0.4, 0, 0.05, rng)), 0.4, 5.2, 14, 0.42, 0, 0);

    // -- the break: torn ribs and burnt frames --------------------------------
    const tear = new THREE.Vector3(0.2, 10.6, 24.5);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU;
      const x0 = tear.x + Math.cos(a) * 3.9;
      const y0 = tear.y + Math.sin(a) * 3.9;
      sweep(
        this.burnt,
        [
          [x0, y0, tear.z - 1],
          [x0 * 1.15, y0 * 1.05 + rng.range(-0.8, 0.8), tear.z + rng.range(1.2, 3.6)],
        ],
        0.3,
        0.12,
        5,
      );
    }

    // -- aft section: reared up, fin still on ---------------------------------
    sweep(this.hull, [[2.4, -3, 30], [1.4, 5, 31.5], [0.2, 13, 33]], 5.0, 4.1, 12);
    sweep(this.hull, [[0.2, 13, 33], [-1.6, 20, 34], [-3.2, 26, 34.8]], 4.1, 1.9, 12);
    // The fin: a thin, tall, deep plate. This is the single element that makes
    // the wreck legible as a *vessel* on a horizon two hundred metres away.
    put(
      this.plate,
      this.temp(tapered(0.9, 15, 8.5, 0.55, -2.2, 0.1, rng)),
      -1.2,
      11,
      33.4,
      -0.22,
      0,
      0.12,
    );

    // -- engines: one still mounted, one thrown clear -------------------------
    const nacelle = this.temp(
      revolved(
        [
          [1.8, 0],
          [2.2, 1.4],
          [2.1, 8],
          [1.6, 10.2],
          [2.0, 11],
        ],
        12,
        0.02,
        rng,
      ),
    );
    put(this.burnt, nacelle, 4.6, 4.6, 29, -1.35, 0, 0.1);
    put(this.burnt, nacelle, -14, 0.6, 12, Math.PI / 2 - 0.28, 1.9, 0.4);

    // -- wings: one folded back against the hull, one standing in the ground --
    const spar = this.temp(tapered(2.4, 20, 1.2, 0.55, 3.6, 0.12, rng));
    put(this.plate, spar, 5.2, 3.4, 14, 1.25, 0.5, 0.3);
    put(this.plate, spar, -16, -2.2, 2, 0.32, -0.8, -0.2, 1.15);

    // -- cockpit: the one piece of glass in the level, and still lit ----------
    const canopy = this.temp(new THREE.SphereGeometry(2.6, 16, 10, 0, TAU, 0, 1.2));
    put(this.glass, canopy, 0, 1.9, 5.2, -1.15, 0, 0, new THREE.Vector3(1, 0.8, 1.7));

    const lamp = this.temp(new THREE.BoxGeometry(0.4, 0.18, 1.1));
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      put(this.light, lamp, 0.5, 3.2 + t * 7.6, 5 + t * 16, 0.4, 0, 0);
    }
    put(this.light, this.temp(new THREE.TorusGeometry(3.9, 0.14, 6, 26)), tear.x, tear.y, tear.z);
    // The torn spine is the wreck's focal point and the only cyan on the plain.
    // Queued in world space, which is where the light has to live.
    this.queueSeamLight(
      new THREE.Vector3(tear.x, tear.y, tear.z).applyMatrix4(world),
      FED_CYAN,
      18,
      24,
      80,
    );

    // -- debris field ---------------------------------------------------------
    const shard = this.temp(tapered(3.4, 0.25, 2.6, 0.2, 0, 0.55, rng));
    for (let i = 0; i < 26; i++) {
      const z = rng.range(-34, 40);
      const x = rng.range(-20, 20);
      const wx = base.x + Math.sin(axis) * z + Math.cos(axis) * x;
      const wz = base.z + Math.cos(axis) * z - Math.sin(axis) * x;
      const batch = rng.next() < 0.55 ? this.plate : this.burnt;
      batch.addAt(
        shard,
        new THREE.Vector3(wx, this.groundAt(wx, wz) + 0.06, wz),
        rng.range(0, TAU),
        rng.range(0.7, 1.9),
        rng.range(-0.5, 0.5),
        rng.range(-0.5, 0.5),
      );
    }

    // Smoulder points, in world space, for the ambient plume.
    const toWorld = (x: number, y: number, z: number): THREE.Vector3 =>
      new THREE.Vector3(x, y, z).applyMatrix4(world);
    this.vents.push(toWorld(tear.x, tear.y, tear.z), toWorld(4.6, 6, 29), toWorld(0, 2.4, 5));
  }

  /**
   * The furrow the vessel cut on the way in: paired ridges of thrown-up
   * regolith converging on the wreck. It is the level's leading line, and it
   * exists because a landmark with nothing pointing at it is just scenery.
   */
  private buildImpactFurrow(from: number, to: number, right: number): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    const axis = yaw + 0.22;
    const steps = Math.round(58 * this.detail) + 20;
    const ridge = this.temp(
      revolved(
        [
          [2.6, 0],
          [2.4, 0.6],
          [1.6, 1.25],
          [0.5, 1.7],
        ],
        9,
        0.2,
        rng,
      ),
    );
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const along = from + (to - from) * t;
      // The furrow narrows and deepens toward the impact.
      const width = 7.5 - t * 3.4;
      for (const side of [-1, 1]) {
        const lateral = right * t + side * width + rng.range(-1.2, 1.2);
        const p = this.atSpawn(along + rng.range(-1.5, 1.5), lateral, -0.4);
        const s = (0.6 + t * 0.7) * rng.range(0.7, 1.2);
        this.regolith.addAt(
          ridge,
          p,
          axis + rng.range(-0.25, 0.25),
          new THREE.Vector3(s * 2.6, s * 0.8, s),
        );
      }
      // Ejecta thrown clear of the ridges, thickening toward the impact.
      if (rng.next() < 0.35 + t * 0.4) {
        const p = this.atSpawn(
          along + rng.range(-4, 4),
          right * t + rng.range(-24, 24),
          -0.25,
        );
        const s = rng.range(0.35, 0.9);
        this.regolith.addAt(ridge, p, rng.range(0, TAU), new THREE.Vector3(s * 1.8, s * 0.6, s));
      }
    }
  }

  // -- Custodian architecture ------------------------------------------------

  /**
   * Half-buried alloy forms in a shallow arc across the mid-ground. Nothing
   * here has a join, a bolt or a panel line: the read is "grown, then sunk", and
   * the single violet seam per form is the only edge the eye can find.
   */
  private buildCustodianArray(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    type Form = { f: number; r: number; kind: number; s: number };
    const forms: Form[] = [
      { f: 44, r: -30, kind: 0, s: 1.35 },
      { f: 58, r: -21, kind: 1, s: 1.0 },
      { f: 50, r: 22, kind: 2, s: 1.15 },
      { f: 74, r: 32, kind: 0, s: 0.85 },
      { f: 86, r: -34, kind: 3, s: 1.3 },
      { f: 88, r: -30, kind: 1, s: 1.55 },
      { f: 70, r: 34, kind: 3, s: 0.7 },
      { f: 108, r: 44, kind: 2, s: 1.0 },
      { f: 34, r: 40, kind: 3, s: 0.9 },
    ];

    for (const form of forms) {
      const p = this.atSpawn(form.f, form.r);
      const s = form.s;
      const rot = yaw + rng.range(-0.6, 0.6);
      switch (form.kind) {
        case 0: {
          // A sphere sunk to two-thirds. Reads as enormous because the ground
          // line cuts it, which no free-standing shape ever manages.
          const g = this.temp(new THREE.SphereGeometry(7 * s, 26, 18));
          this.alloy.addAt(g, p.clone().setY(p.y - 4.1 * s), rot);
          this.seam.addAt(
            this.temp(bandRing(7.02 * s, 7.02 * s + 0.16, 40)),
            p.clone().setY(p.y + 1.4 * s),
            rot,
          );
          this.queueSeamLight(
            p.clone().setY(p.y + 1.4 * s),
            CUSTODIAN_VIOLET,
            14 * s,
            17 * s,
            70 - form.f * 0.2,
          );
          break;
        }
        case 1: {
          // A torus arch standing on edge — the only thing on the plain you can
          // see the sky through, so it frames whatever is behind it.
          const g = this.temp(new THREE.TorusGeometry(9 * s, 1.5 * s, 12, 30));
          this.alloy.addAt(g, p.clone().setY(p.y + 5.4 * s), rot, 1, Math.PI / 2, 0.06);
          const seamG = this.temp(new THREE.TorusGeometry(9 * s, 0.13, 6, 40));
          this.seam.addAt(seamG, p.clone().setY(p.y + 5.4 * s), rot, 1, Math.PI / 2, 0.06);
          // Inside the ring, so the arch lights the ground you see *through* it.
          this.queueSeamLight(
            p.clone().setY(p.y + 5.4 * s),
            CUSTODIAN_VIOLET,
            16 * s,
            20 * s,
            72 - form.f * 0.2,
          );
          break;
        }
        case 2: {
          // A leaning blade: rounded, tapering, no visible support.
          const g = this.temp(
            revolved(
              [
                [3.2 * s, 0],
                [3.6 * s, 3 * s],
                [3.0 * s, 12 * s],
                [1.7 * s, 20 * s],
                [0.5 * s, 24 * s],
              ],
              18,
              0.01,
              rng,
            ),
          );
          this.alloy.addAt(g, p.clone().setY(p.y - 1.6), rot, 1, 0, rng.range(0.1, 0.22));
          const seamG = this.temp(new THREE.BoxGeometry(0.14, 17 * s, 0.5));
          const bladeSeam = this.offsetAlong(p.clone().setY(p.y + 8 * s), rot, -3.1 * s, 0);
          this.seam.addAt(seamG, bladeSeam, rot, 1, 0, rng.range(0.1, 0.22));
          // The blade is the tallest Custodian form and the one the composition
          // points at; its seam gets the strongest light of the set.
          this.queueSeamLight(bladeSeam, CUSTODIAN_VIOLET, 20 * s, 22 * s, 88 - form.f * 0.2);
          break;
        }
        default: {
          // A capsule laid on its side and half sunk — a whale-back.
          const g = this.temp(new THREE.CapsuleGeometry(3.6 * s, 15 * s, 8, 20));
          this.alloy.addAt(g, p.clone().setY(p.y - 1.5 * s), rot, 1, 0, Math.PI / 2);
          this.seam.addAt(
            this.temp(new THREE.BoxGeometry(15 * s, 0.14, 0.4)),
            p.clone().setY(p.y + 1.9 * s),
            rot,
            1,
            0,
            0,
          );
          this.queueSeamLight(
            p.clone().setY(p.y + 2.1 * s),
            CUSTODIAN_VIOLET,
            12 * s,
            15 * s,
            66 - form.f * 0.2,
          );
          break;
        }
      }
      // Every Custodian form has displaced the regolith it sits in.
      const skirt = this.temp(
        revolved(
          [
            [9.5 * s, 0],
            [8.6 * s, 0.5],
            [7.2 * s, 0.95],
            [6.2 * s, 1.1],
          ],
          16,
          0.09,
          rng,
        ),
      );
      this.regolith.addAt(skirt, p.clone().setY(p.y - 0.6), rot);
    }
  }

  /**
   * Geometric monoliths at wrong angles. Each one is close to vertical and none
   * of them is vertical; the field reads as deliberate rather than as scatter
   * because they share a size language and a spacing, and disagree only about
   * which way is up.
   */
  private buildMonolithField(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    const count = Math.round(24 * this.detail);
    for (let i = 0; i < count; i++) {
      // A jittered lattice: order at a glance, no visible grid.
      const gx = (i % 6) - 2.5;
      const gz = Math.floor(i / 6) - 1.5;
      const f = 42 + gz * 32 + rng.range(-9, 9);
      const r = gx * 28 + rng.range(-9, 9);
      // Keep the sightline to the wreck clear — the field frames the landmark,
      // it does not stand in front of it.
      if (Math.abs(r) < 14) continue;
      const p = this.atSpawn(f, r, -1.2);
      if (this.slopeAt(p.x, p.z) > 0.6) continue;
      const h = rng.range(9, 22);
      const w = rng.range(1.6, 3.4);
      const g = this.temp(tapered(w, h, w * rng.range(0.35, 0.7), 0.06, 0, 0.04, rng));
      this.mono.addAt(
        g,
        p,
        yaw + rng.range(0, TAU),
        1,
        rng.range(-0.36, 0.36),
        rng.range(-0.36, 0.36),
      );
      // A hairline violet seam down one face on about a third of them: enough
      // to say "these are theirs" without turning the field into a light show.
      if (rng.next() < 0.34) {
        this.seam.addAt(
          this.temp(new THREE.BoxGeometry(0.1, h * 0.72, 0.1)),
          p.clone().setY(p.y + h * 0.42),
          yaw + rng.range(0, TAU),
          1,
          rng.range(-0.3, 0.3),
          rng.range(-0.3, 0.3),
        );
      }
    }
  }

  /**
   * Foreground framing: two monoliths just inside the frame edges and a low
   * alloy shelf under the left one. Both sit between the camera and the light,
   * so they are the darkest values in the shot.
   */
  private buildForeground(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;

    const leftPos = this.atSpawn(12, -12.5, -1.6);
    const leftGeo = this.temp(tapered(3.1, 15, 1.5, 0.05, 0, 0.05, rng));
    this.mono.addAt(leftGeo, leftPos, yaw + 0.35, 1, 0.13, -0.22);
    this.seam.addAt(
      this.temp(new THREE.BoxGeometry(0.12, 11, 0.12)),
      leftPos.clone().setY(leftPos.y + 7.5),
      yaw + 0.35,
      1,
      0.13,
      -0.22,
    );
    // Twelve metres from the camera: the only seam that can put coloured light
    // into the foreground, which is where the frame's darkest values live.
    this.queueSeamLight(leftPos.clone().setY(leftPos.y + 7.5), CUSTODIAN_VIOLET, 9, 12, 100);

    const rightPos = this.atSpawn(16, 15, -2.2);
    const rightGeo = this.temp(tapered(2.4, 12, 2.6, 0.08, 0, 0.06, rng));
    this.mono.addAt(rightGeo, rightPos, yaw - 0.8, 1, -0.19, 0.16);

    // A shallow Custodian shelf breaking the surface at the bottom of frame:
    // gives the foreground a bright edge to read the dark monoliths against.
    const shelf = this.temp(new THREE.CapsuleGeometry(2.4, 11, 6, 16));
    const sp = this.atSpawn(19, -19, -2.4);
    this.alloy.addAt(shelf, sp, yaw + 1.1, 1, 0, Math.PI / 2);
    this.seam.addAt(
      this.temp(new THREE.BoxGeometry(11, 0.12, 0.32)),
      sp.clone().setY(sp.y + 2.2),
      yaw + 1.1,
    );
    this.queueSeamLight(sp.clone().setY(sp.y + 2.4), CUSTODIAN_VIOLET, 8, 11, 95);
  }

  // -- depth: interior -------------------------------------------------------

  /**
   * A section of the Halberd's spine, torn off on the way in and lying open on
   * the flats: twenty-two metres of walkable hull with a roof on it.
   *
   * This is the only enclosed space on the world and it exists for three
   * reasons. It gives the level a second lighting condition — inside, the
   * violet sky is gone entirely and the vessel's own cyan strips are the only
   * source, which is the strongest colour contrast in the frame. It gives the
   * `hold` objective somewhere to actually be held: a corridor with two mouths
   * and one breach is a position, and an open plain is not. And it puts a hard
   * dark shape in the mid-ground for the pale regolith to read against.
   *
   * Four metres of headroom, well over the nav grid's 1.9 m clearance test, so
   * the Custodians follow the player in rather than milling about outside.
   */
  private buildHullGallery(): void {
    const rng = this.rng;
    const axis = this.spawnYaw + 0.22;
    // Sixteen metres from the impact point, which puts it inside the recorder
    // hold's eighteen-metre radius: the gallery has to be somewhere the hold can
    // actually be held from, or it is scenery next to the objective rather than
    // part of it.
    const centre = this.atSpawn(84, -8);
    const pad = this.padHeight(centre, 13, 11);

    const fx = -Math.sin(axis);
    const fz = -Math.cos(axis);
    const rx = -fz;
    const rz = fx;
    /** A point `along` metres down the hull axis, `across` to its right. */
    const at = (along: number, across: number, y: number): THREE.Vector3 =>
      new THREE.Vector3(
        centre.x + fx * along + rx * across,
        pad + y,
        centre.z + fz * along + rz * across,
      );

    const halfLen = 11;
    const halfWidth = 2.9;
    const wallH = 4.3;

    // Side walls, in plates so the seam line reads and the sun finds an edge.
    for (const side of [-1, 1]) {
      for (let i = 0; i < 13; i++) {
        const along = -halfLen + (i / 12) * halfLen * 2;
        // A breach in the starboard wall: a way in that is not an end, which is
        // what stops the gallery being a dead-end corridor.
        if (side > 0 && along > -1.6 && along < 3.4) continue;
        const h = wallH + rng.range(-0.25, 0.25);
        const g = this.temp(tapered(1.9, h + 1.4, 0.85, 0.05, 0, 0.07, rng));
        (rng.next() < 0.7 ? this.hull : this.plate).addAt(
          g,
          at(along, side * halfWidth, -1.4),
          axis,
          1,
          0,
          side * 0.02,
        );
      }
    }

    // Roof, with two panels missing so the low sun cuts bars across the floor.
    for (let i = 0; i < 7; i++) {
      if (i === 2 || i === 5) continue;
      const along = -halfLen + 1.6 + i * 3.1;
      const g = this.temp(tapered(3.0, 0.55, halfWidth * 2 + 1.2, 0.04, 0, 0.1, rng));
      this.plate.addAt(g, at(along, 0, wallH), axis, 1, 0, rng.range(-0.02, 0.02));
    }

    // Frames: the ribs that make the inside read as the inside of something.
    for (let i = 0; i < 8; i++) {
      const along = -halfLen + 0.8 + i * 3.0;
      const a = at(along, -halfWidth + 0.35, 0.2);
      const b = at(along, -halfWidth + 0.9, wallH - 0.1);
      const c = at(along, halfWidth - 0.9, wallH - 0.1);
      const d = at(along, halfWidth - 0.35, 0.2);
      this.burnt.add(this.temp(tube([a, b, c, d], 0.2, 0.2, 5)));
    }

    // Deliberately no deck plate.
    //
    // A raised floor would look better and would make the interior unreachable:
    // the nav grid samples *terrain* height and then rejects any cell whose
    // downward probe finds a surface above it, so a slab thirty centimetres
    // proud of the regolith turns the whole gallery into a hole in the walkable
    // set and the Custodians stop at the door. The floor is the ground, and the
    // structure is sunk to meet it.

    // Ceiling strips: this is what the interior is lit by, and the reason the
    // dark shape in the mid-ground has a glowing slot in it at distance.
    const strip = this.temp(new THREE.BoxGeometry(2.4, 0.12, 0.34));
    for (let i = 0; i < 8; i++) {
      this.light.addAt(strip, at(-halfLen + 1.4 + i * 3.0, 0, wallH - 0.36), axis);
    }
    this.queueSeamLight(at(-3, 0, wallH - 0.8), FED_CYAN, 13, 16, 84);
    this.queueSeamLight(at(6, 0, wallH - 0.8), FED_CYAN, 11, 15, 62);

    // Spill: torn cable, a fallen locker and scattered plate around the mouths,
    // so the gallery has a threshold rather than an edge.
    for (let i = 0; i < Math.round(16 * this.detail) + 6; i++) {
      const along = rng.range(-halfLen - 6, halfLen + 6);
      const across = rng.range(-halfWidth - 5, halfWidth + 5);
      const p = at(along, across, 0);
      p.y = this.groundAt(p.x, p.z) + 0.08;
      const g = this.temp(tapered(rng.range(0.6, 2.2), rng.range(0.15, 0.5), rng.range(0.5, 1.6), 0.2, 0, 0.3, rng));
      (rng.next() < 0.5 ? this.burnt : this.plate).addAt(
        g,
        p,
        rng.range(0, TAU),
        1,
        rng.range(-0.4, 0.4),
        rng.range(-0.4, 0.4),
      );
    }
    this.vents.push(at(-halfLen - 1, 0, 1.2), at(halfLen + 1, 0, 1.2));
  }

  // -- depth: verticality ----------------------------------------------------

  /**
   * A Custodian plinth beside the array: two alloy tiers a player can climb, and
   * a firing position over the whole mid-ground.
   *
   * The forms in `buildCustodianArray` are all *sunk* — spheres, whale-backs, a
   * blade — which is right for the read but leaves the plain perfectly flat to
   * fight on. This is the same material language taken upward. It is
   * deliberately not a staircase: the Custodians do not build for legs, so the
   * way up is a run of displaced ground and a shelf, and the top tier needs the
   * double jump.
   */
  private buildCustodianTerrace(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    const centre = this.atSpawn(60, -23);
    const pad = this.padHeight(centre, 9, 9);

    const tiers: Array<[number, number]> = [
      [8.6, 1.75],
      [5.4, 3.5],
    ];
    for (const [radius, top] of tiers) {
      const g = this.temp(
        revolved(
          [
            [radius, 0],
            [radius * 0.98, top - 0.5],
            [radius * 0.9, top],
            [radius * 0.86, top + 0.05],
          ],
          22,
          0.006,
          rng,
        ),
      );
      // Sunk 0.6 m so the form grows out of the regolith rather than resting on
      // it, which puts the lower deck at 1.15 m and the upper at 2.9 m — one
      // stair and one double jump.
      this.alloy.addAt(g, new THREE.Vector3(centre.x, pad - 0.6, centre.z), yaw);
      this.seam.addAt(
        this.temp(bandRing(radius * 0.9, radius * 0.9 + 0.14, 34)),
        new THREE.Vector3(centre.x, pad + top - 0.54, centre.z),
        yaw,
      );
    }
    this.queueSeamLight(
      new THREE.Vector3(centre.x, pad + 3.4, centre.z),
      CUSTODIAN_VIOLET,
      13,
      18,
      76,
    );

    // The way up: a ramp of thrown regolith to the first tier, then a shelf the
    // double jump clears to the second.
    const edge = new THREE.Vector3(
      centre.x - this.viewForward.x * 8.2,
      pad + 1.1,
      centre.z - this.viewForward.z * 8.2,
    );
    const foot = new THREE.Vector3(
      edge.x - this.viewForward.x * 6,
      0,
      edge.z - this.viewForward.z * 6,
    );
    foot.y = this.groundAt(foot.x, foot.z);
    const top = this.stairs(this.regolith, foot, this.yawTowards(foot, edge), pad + 1.1 - foot.y, 4.2, 0.8, 0.42);
    this.landing(this.regolith, top, edge, 4.2);

    // Standing stones on the upper tier: cover for whoever holds the height.
    for (let i = 0; i < 4; i++) {
      const a = yaw + (i / 4) * TAU + 0.5;
      const p = new THREE.Vector3(
        centre.x + Math.sin(a) * 3.6,
        pad + 2.85,
        centre.z + Math.cos(a) * 3.6,
      );
      const g = this.temp(tapered(1.5, 1.35 + rng.range(-0.15, 0.4), 1.0, 0.16, 0, 0.03, rng));
      this.alloy.addAt(g, p, yaw + rng.range(0, TAU), 1, 0, rng.range(-0.03, 0.03));
    }
  }

  // -- depth: cover ----------------------------------------------------------

  /**
   * Hull plate driven into the regolith on the run-in to the wreck, and alloy
   * shelves out among the array.
   *
   * There was no cover anywhere on this world. `CoverMap` bakes from the
   * collision world and only the AI reads it, so a Custodian line on an open
   * plain against a player with nothing to stand behind is a shooting gallery in
   * whichever direction the numbers happen to favour. Every plate here is
   * collidable and therefore counts for both sides.
   */
  private buildCover(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    /** forward, right, full-height. */
    const sites: Array<[number, number, boolean]> = [
      [26, -8, false], [31, 9.5, false], [38, -12, true], [43, 5, false],
      [49, -6, false], [54, 12.5, true], [58, -14.5, false], [63, 4, false],
      [68, 15, false], [72, -9, true], [77, 8.5, false], [82, -17, false],
      [86, 13, true], [90, -4, false], [95, 17, false], [99, -12.5, true],
      [104, 6, false], [108, -6.5, false], [112, 14, false],
    ];
    for (const [f, r, full] of sites) {
      const p = this.atSpawn(f + rng.range(-1.5, 1.5), r + rng.range(-1.5, 1.5), -0.7);
      const h = full ? 2.6 + rng.range(-0.2, 0.6) : 1.2 + rng.range(-0.1, 0.3);
      const g = this.temp(
        tapered(full ? 3.4 : 3.9, h + 0.7, full ? 0.9 : 1.1, 0.06, 0, 0.12, rng),
      );
      // Federation plate near the crash, Custodian alloy out in the field: the
      // two languages stay separated, which is the whole art direction here.
      const near = f > 62;
      (near ? (rng.next() < 0.6 ? this.plate : this.burnt) : this.alloy).addAt(
        g,
        p,
        yaw + rng.range(-0.7, 0.7),
        1,
        rng.range(-0.14, 0.14),
        rng.range(-0.12, 0.12),
      );
      // Regolith banked against the foot: nothing on this plain sits *on* the
      // ground, everything is half-buried in it.
      const bank = this.temp(
        revolved(
          [
            [2.9, 0],
            [2.4, 0.35],
            [1.3, 0.7],
            [0.3, 0.9],
          ],
          9,
          0.22,
          rng,
        ),
      );
      this.regolith.addAt(
        bank,
        p.clone().setY(p.y + 0.45),
        yaw + rng.range(0, TAU),
        new THREE.Vector3(rng.range(1.2, 1.9), 1, rng.range(0.7, 1.1)),
      );
    }
  }

  // -- depth: the near field -------------------------------------------------

  /**
   * The first twenty-five metres: ejecta, chips of plate, and the fine gravel a
   * vacuum-weathered regolith actually is.
   *
   * Reviewed frames had nothing at all in the bottom third but a smooth grey
   * gradient, which is why the world read as a render of a plane rather than as
   * a place. One draw call, no collision, no shadows.
   */
  private buildNearField(): void {
    const rng = this.rng;
    const chip = [
      this.temp(tapered(0.5, 0.22, 0.4, 0.35, 0, 0.14, rng)),
      this.temp(tapered(0.32, 0.28, 0.3, 0.5, 0, 0.1, rng)),
      this.temp(tapered(0.75, 0.14, 0.42, 0.25, 0, 0.18, rng)),
    ];
    const count = Math.round(210 * this.detail);
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const a = i * 2.399963;
      const d = 1.8 + Math.pow(t, 0.6) * 18;
      const p = this.atSpawn(Math.cos(a) * d, Math.sin(a) * d, -0.03);
      if (this.slopeAt(p.x, p.z) > 0.6) continue;
      this.grit.addAt(
        chip[i % chip.length],
        p,
        rng.range(0, TAU),
        rng.range(1.1, 2.8),
        rng.range(-0.35, 0.35),
        rng.range(-0.35, 0.35),
      );
    }

    // Torn Federation foil blown back down the furrow — the first hint of the
    // wreck, read from ten metres rather than from a hundred.
    for (let i = 0; i < Math.round(26 * this.detail) + 8; i++) {
      const p = this.atSpawn(rng.range(3, 24), rng.range(-14, 14), 0.05);
      const g = this.temp(tapered(rng.range(0.9, 2.4), 0.12, rng.range(0.7, 1.8), 0.3, 0, 0.35, rng));
      (rng.next() < 0.5 ? this.burnt : this.plate).addAt(
        g,
        p,
        rng.range(0, TAU),
        1,
        rng.range(-0.5, 0.5),
        rng.range(-0.5, 0.5),
      );
    }

    // A cluster of larger ejecta blocks at eight metres, off to one side, so the
    // near field has one real shape in it and not only texture.
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + 0.4;
      const d = 4.5 + rng.next() * 6.5;
      const p = this.atSpawn(Math.cos(a) * d, Math.sin(a) * d, -0.35);
      if (this.slopeAt(p.x, p.z) > 0.6) continue;
      const g = this.temp(tapered(rng.range(1.1, 2.2), rng.range(0.6, 1.3), rng.range(0.9, 1.8), 0.2, 0, 0.3, rng));
      this.mono.addAt(g, p, rng.range(0, TAU), 1, rng.range(-0.2, 0.2), rng.range(-0.2, 0.2));
    }
  }

  // -- helpers ---------------------------------------------------------------

  /** A point `along` metres down `axis` and `across` metres to its right. */
  private offsetAlong(from: THREE.Vector3, axis: number, along: number, across: number): THREE.Vector3 {
    const fx = -Math.sin(axis);
    const fz = -Math.cos(axis);
    const rx = -fz;
    const rz = fx;
    return new THREE.Vector3(
      from.x + fx * along + rx * across,
      from.y,
      from.z + fz * along + rz * across,
    );
  }

  // -- combat ----------------------------------------------------------------

  protected spawnVolumeSpecs(): SpawnVolumeSpec[] {
    return [
      // Two numbers here are load-bearing, and both exist because of how
      // `EncounterDirector.drainQueue` works: it only ever retries `queue[0]`,
      // so one unit that cannot be placed stalls every unit behind it —
      // including the boss, several waves later.
      //
      //  - `minPlayerDistance` gates whether a volume is *considered*. It is not
      //    the pop-in guard; `ENCOUNTER.minSpawnDistance` already refuses any
      //    candidate point inside 22 m of the player. Keep it small.
      //  - `radius` has to exceed 22 m on any volume the player can end up
      //    standing on — an objective, a landmark, an arrival point. A 20 m
      //    volume with the player at its centre contains no point 22 m away from
      //    them, so it is blocked *permanently*, and everything queued behind it
      //    never spawns. Measured: Khepri's boss sat behind thirteen units
      //    pinned to a 20 m volume the player was standing in, forever.
      { id: 'zeta.wreck', forward: 96, right: 14, radius: 30, minPlayerDistance: 6 },
      { id: 'zeta.gallery', forward: 80, right: -26, radius: 16, minPlayerDistance: 12 },
      { id: 'zeta.arc.left', forward: 62, right: -34, radius: 17, minPlayerDistance: 14 },
      { id: 'zeta.arc.right', forward: 64, right: 34, radius: 17, minPlayerDistance: 14 },
      { id: 'zeta.field', forward: 92, right: -4, radius: 26, minPlayerDistance: 6 },
      { id: 'zeta.flank', forward: 20, right: 44, radius: 16, minPlayerDistance: 14 },
      { id: 'zeta.rear', forward: -34, right: -12, radius: 18, minPlayerDistance: 16 },
    ];
  }

  /**
   * Chapter 2 — **Silent Archive**.
   *
   * The old script said "reach the survey vessel Halberd" and then excluded the
   * Halberd's own spawn volume, so the one place the line pointed at was the one
   * place nothing came from, and the wave completed on a kill count wherever the
   * player happened to be standing. Now the arrival is a real trigger on the
   * wreck's world position, and `zeta.wreck` is in the volume list.
   *
   * The second objective is the campaign's first `hold`: forty-five seconds
   * inside eighteen metres of the crash while the recorder dumps, with the
   * Custodians arriving from three sides including the wreck itself. The clock
   * is cumulative, so backing out of the gallery to break line of sight costs
   * time rather than progress — which is exactly the decision the geometry was
   * built to offer.
   */
  protected encounterScript(): EncounterScript {
    return {
      id: 'zeta.survey',
      title: 'Silent Archive',
      completesLevel: true,
      score: 3100,
      waves: [
        {
          delay: 5,
          triggerFraction: 0,
          objective: 'Reach the Halberd',
          volumes: ['zeta.arc.left', 'zeta.arc.right', 'zeta.wreck'],
          trigger: { kind: 'reach', position: this.wreckPos, radius: 14 },
          units: [
            { archetype: 'grey.drone', count: 6 },
            { archetype: 'grey.observer', count: 2 },
          ],
        },
        {
          delay: 2,
          triggerFraction: 0.5,
          objective: 'Hold the wreck while the recorder dumps',
          volumes: ['zeta.wreck', 'zeta.gallery', 'zeta.field', 'zeta.arc.right'],
          trigger: { kind: 'hold', position: this.wreckPos, radius: 18, seconds: 45 },
          units: [
            { archetype: 'grey.operative', count: 5 },
            { archetype: 'grey.observer', count: 3 },
            { archetype: 'grey.drone', count: 6 },
            { archetype: 'grey.psion', count: 1 },
          ],
        },
        {
          delay: 4,
          triggerFraction: 0.7,
          objective: 'Clear the Custodian array',
          // `zeta.flank` is 83 m from the crash site, past the 78 m the director
          // will place a spawn at, and a pinned unit that can never be placed
          // stalls every unit behind it. Everything listed here is inside range
          // of where this wave is actually fought.
          volumes: ['zeta.arc.left', 'zeta.arc.right', 'zeta.gallery', 'zeta.field'],
          units: [
            { archetype: 'grey.psion', count: 2 },
            { archetype: 'grey.operative', count: 4 },
            { archetype: 'grey.overseer', count: 1 },
            { archetype: 'grey.observer', count: 2 },
          ],
        },
      ],
      boss: { archetype: 'grey.overmind', count: 1 },
      bossObjective: 'Kill the Overmind',
      bossDelay: 5,
    };
  }

  // -- ambience --------------------------------------------------------------

  protected override tick(ctx: FrameContext): void {
    // Custodian light does not flicker like fire; it *breathes*, on a long
    // period, which is the difference between "machine" and "campfire".
    const t = ctx.elapsed;
    for (let i = 0; i < this.seamLights.length; i++) {
      this.seamLights[i].intensity =
        this.seamBase[i] * (1 + Math.sin(t * 0.41 + i * 2.3) * 0.12);
    }

    if (this.vents.length === 0) return;
    this.ventTimer -= ctx.dt;
    if (this.ventTimer > 0) return;
    this.ventTimer = 0.55;
    this.ventCursor = (this.ventCursor + 1) % this.vents.length;
    const p = this.vents[this.ventCursor];
    const d = p.distanceToSquared(this.camPos);
    // Thin atmosphere: the plume is dust lifted off hot plate, not smoke, so it
    // is short-lived and only worth drawing when the wreck is actually in view.
    if (d > 160 * 160) return;
    _tmp.copy(_up);
    this.vfx.impact(p, _tmp, 'sand', clamp(1.9 - Math.sqrt(d) * 0.006, 0.6, 1.8));
  }

  override dispose(): void {
    for (const l of this.seamLights) l.dispose();
    this.seamLights.length = 0;
    this.seamBase.length = 0;
    super.dispose();
  }
}

registerPlanet('zeta-reticuli', (deps, descriptor) => new ZetaReticuliLevel(deps, descriptor));

export { ZetaReticuliLevel };
