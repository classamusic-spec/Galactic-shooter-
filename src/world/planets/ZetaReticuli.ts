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

  /** Where the wreck still smoulders. */
  private readonly vents: THREE.Vector3[] = [];
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

    // Order matters only for legibility; the merge is per material anyway.
    this.buildImpactFurrow(22, 96, 6);
    this.buildWreck(94, 6);
    this.buildCustodianArray();
    this.buildMonolithField();
    this.buildForeground();
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
          break;
        }
        case 1: {
          // A torus arch standing on edge — the only thing on the plain you can
          // see the sky through, so it frames whatever is behind it.
          const g = this.temp(new THREE.TorusGeometry(9 * s, 1.5 * s, 12, 30));
          this.alloy.addAt(g, p.clone().setY(p.y + 5.4 * s), rot, 1, Math.PI / 2, 0.06);
          const seamG = this.temp(new THREE.TorusGeometry(9 * s, 0.13, 6, 40));
          this.seam.addAt(seamG, p.clone().setY(p.y + 5.4 * s), rot, 1, Math.PI / 2, 0.06);
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
          this.seam.addAt(
            seamG,
            this.offsetAlong(p.clone().setY(p.y + 8 * s), rot, -3.1 * s, 0),
            rot,
            1,
            0,
            rng.range(0.1, 0.22),
          );
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
      { id: 'zeta.wreck', forward: 96, right: 14, radius: 20, minPlayerDistance: 34 },
      { id: 'zeta.arc.left', forward: 62, right: -34, radius: 16, minPlayerDistance: 28 },
      { id: 'zeta.arc.right', forward: 64, right: 34, radius: 16, minPlayerDistance: 28 },
      { id: 'zeta.field', forward: 92, right: -4, radius: 20, minPlayerDistance: 32 },
      { id: 'zeta.flank', forward: 20, right: 44, radius: 15, minPlayerDistance: 26 },
      { id: 'zeta.rear', forward: -34, right: -12, radius: 18, minPlayerDistance: 28 },
    ];
  }

  protected encounterScript(): EncounterScript {
    return {
      id: 'zeta.survey',
      completesLevel: true,
      score: 3100,
      waves: [
        {
          delay: 5,
          triggerFraction: 0,
          objective: 'Reach the survey vessel Halberd',
          volumes: ['zeta.arc.left', 'zeta.arc.right'],
          units: [
            { archetype: 'grey.drone', count: 6 },
            { archetype: 'grey.observer', count: 2 },
          ],
        },
        {
          delay: 4,
          triggerFraction: 0.6,
          objective: 'Clear the Custodian array',
          volumes: ['zeta.field', 'zeta.flank', 'zeta.rear'],
          units: [
            { archetype: 'grey.operative', count: 4 },
            { archetype: 'grey.observer', count: 3 },
            { archetype: 'grey.drone', count: 4 },
          ],
        },
        {
          delay: 5,
          triggerFraction: 0.7,
          objective: 'Sever the psionic link at the crash site',
          volumes: ['zeta.wreck', 'zeta.field', 'zeta.arc.right'],
          units: [
            { archetype: 'grey.psion', count: 2 },
            { archetype: 'grey.operative', count: 4 },
            { archetype: 'grey.observer', count: 2 },
          ],
        },
      ],
      boss: { archetype: 'grey.overseer', count: 1 },
    };
  }

  // -- ambience --------------------------------------------------------------

  protected override tick(ctx: FrameContext): void {
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
}

registerPlanet('zeta-reticuli', (deps, descriptor) => new ZetaReticuliLevel(deps, descriptor));

export { ZetaReticuliLevel };
