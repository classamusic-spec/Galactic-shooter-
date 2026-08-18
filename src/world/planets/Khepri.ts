/**
 * Khepri — the Acid Canopy.
 *
 * A hot wet greenhouse: enormous aerosol load, an overcast lid at 1250 m, and
 * an atmosphere whose Rayleigh term peaks in the green. Everything more than
 * eighty metres away dissolves, which makes this the one world in the game where
 * *depth is free* — and the one where value structure is hardest to hold, because
 * a diffuse key over dark foliage collapses the whole frame into a single band.
 *
 * The last review recorded exactly that failure. Three things are done about it
 * here, all of them art-direction rather than post:
 *
 *  - the atmosphere clone lifts multiple scattering and the hemisphere fill, so
 *    the sky actually bounces into the understorey instead of leaving it black;
 *  - the terrain layer tints are lifted out of near-black and the organic layer
 *    is retiled, which kills the repeating vein swirl at mid distance;
 *  - the composition puts *light* in the frame — canopy gaps with real shafts
 *    coming through them, and acid pools glowing from below.
 *
 * The shot the level is designed around: two buttressed trunks filling the frame
 * edges, a floodplain of acid pools receding through the haze between them,
 * shafts of green-gold light cutting down through the canopy, and the Brood
 * Spire — a forty-metre resin tower lit from inside — on the horizon.
 *
 * Registers itself with the planet registry on import.
 */
import * as THREE from 'three';
import type { FrameContext, PlanetDescriptor } from '@/types';
import type { EncounterScript } from '@/gameplay/ai/EncounterDirector';
import { ATMOSPHERES, cloneAtmosphere, type AtmosphereProfile } from '@/gfx/sky/AtmosphereProfile';
import { terrainRecipe } from '@/gfx/terrain/TerrainBuilder';
import type { TerrainDescriptor } from '@/gfx/terrain/HeightField';
import { clamp, clamp01, TAU } from '@/util/math';
import {
  PlanetLevel,
  bandRing,
  cloneRecipe,
  revolved,
  shaftCone,
  tapered,
  tube,
  type PropBatch,
  type SpawnVolumeSpec,
} from './PlanetLevel';
import { registerPlanet, type PlanetDeps } from './index';
// Sibling registrations — see the note in `Aurvangr.ts`.
import './Aurvangr';
import './ZetaReticuli';

/** Mantis Swarm emissive identity. Matches FACTION_IDENTITY.mantis. */
const ACID_GREEN = 0x9dff4a;

const _up = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _pt = new THREE.Vector3();

interface TreeSpec {
  /** Position in the authored view frame. */
  f: number;
  r: number;
  height: number;
  radius: number;
  /** 0 = no brood, 1 = heavily colonised. */
  brood: number;
  vines: number;
}

class KhepriLevel extends PlanetLevel {
  private bark!: PropBatch;
  private canopy!: PropBatch;
  private frond!: PropBatch;
  private vine!: PropBatch;
  private resin!: PropBatch;
  private resinGlow!: PropBatch;
  private acid!: PropBatch;
  private silt!: PropBatch;
  private shafts!: PropBatch;

  /** Acid pool centres and radii, for the bubbling ambience. */
  private readonly pools: Array<{ p: THREE.Vector3; r: number }> = [];
  private poolTimer = 0;
  private poolCursor = 0;

  constructor(deps: PlanetDeps, descriptor: PlanetDescriptor) {
    super(deps, descriptor, {
      navRadius: 118,
      // Facing the sun puts the canopy gaps between the camera and the key,
      // which is the only way a light shaft is ever visible.
      spawnFacing: 'toward',
      spawnSearchRadius: 100,
      dust: { density: 0.85, color: 0xd8f0a0, size: 0.07 },
    });
  }

  protected override atmosphere(): AtmosphereProfile {
    const a = cloneAtmosphere(ATMOSPHERES.khepri);
    // Recorded defect: "Khepri crushes to near-black." A jungle floor in
    // daylight is dim, not black — the missing light is the sky bounce, so the
    // multiple-scattering term and the hemisphere fill both come up, and the
    // ground albedo with them so the bounce has something to bounce off.
    a.multipleScattering = 1.95;
    a.sunIntensity = 3.5;
    a.ambientIntensity = 1.55;
    a.groundAlbedo = new THREE.Color(0x6b8043);
    a.cloudUnderlightStrength = 1.05;
    // The canopy is 45 m tall and its shadows are what model the floodplain.
    a.shadowExtent = 130;
    return a;
  }

  protected override recipe(): TerrainDescriptor {
    const d = cloneRecipe(terrainRecipe('khepri'));
    // Same defect, other half: the layer albedos are too dark to carry the
    // lifted light, so the ground still sits in one band with the canopy.
    d.layers[0].tint = 0x6d7261;
    d.layers[1].tint = 0x84a94e;
    d.layers[2].tint = 0xb6d75c;
    d.layers[3].tint = 0x8a9370;
    // "The organic layer's vein network reads as a visible repeating swirl at
    // mid distance" — the feature is too big relative to the tile, so shrink it.
    d.layers[1].tileMetres = 2.4;
    // Open defect: rounded macro silhouette. Khepri's ridges should be walls.
    d.ridgePower = 2.7;
    d.erosion = 1.1;
    d.distantFadeStart = 110;
    // The floodplain has to be flood *plain*: pools need level ground and the
    // canopy corridor needs 150 m of it.
    d.flattenRadius = 230;
    d.flattenHeight = 5;
    return d;
  }

  // -- construction ----------------------------------------------------------

  protected decorate(): void {
    this.bark = this.batch(
      'bark',
      this.surface('organic', { repeat: 1, color: 0x6f6350, roughness: 0.95, normalScale: 1.25 }),
      // 2.6 m cells read as cracked mud on a trunk this size; bark is a fine
      // grain seen from two metres away and a smooth mass seen from forty.
      { tile: 1.8, collide: true, surface: 'organic' },
    );
    this.canopy = this.batch(
      'canopy',
      this.surface('organic', { repeat: 1, color: 0x7fae44, roughness: 0.86 }),
      { tile: 2.2, collide: false, surface: 'foliage' },
    );
    this.frond = this.batch(
      'frond',
      this.surface('foliage', { repeat: 1, color: 0x93c455, alphaTest: 0.4 }),
      { tile: 3, collide: false, surface: 'foliage', castShadow: true, receiveShadow: true },
    );
    this.vine = this.batch(
      'vine',
      this.surface('organic', { repeat: 1, color: 0x4d6335, roughness: 1 }),
      { tile: 1.6, collide: false, surface: 'foliage' },
    );
    this.resin = this.batch(
      'resin',
      this.surface('mantisResin', { repeat: 1, color: 0xc3d76a, roughness: 0.45, metalness: 0.05 }),
      { tile: 3, collide: true, surface: 'chitin' },
    );
    this.resinGlow = this.batch('resinGlow', this.glow(ACID_GREEN, 2.6), {
      tile: 0,
      collide: false,
      castShadow: false,
      receiveShadow: false,
    });
    // 1.5 clipped straight through the bloom pass and turned every pool into a
    // flat white disc. An acid pool glows; it is not a light box.
    this.acid = this.batch('acid', this.glow(0x4a9e14, 0.3, { roughness: 0.18 }), {
      tile: 0,
      collide: false,
      castShadow: false,
      receiveShadow: false,
      renderOrder: 2,
    });
    this.silt = this.batch(
      'silt',
      this.surface('sand', { repeat: 1, color: 0x8a8f5e, roughness: 1 }),
      { tile: 4, collide: false, surface: 'sand' },
    );
    // Additive light shafts. Vertex colour carries the falloff, so the whole
    // set is one draw call and needs no bespoke shader.
    this.shafts = this.batch(
      'shafts',
      this.own(
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.15,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: true,
        }),
      ),
      { tile: 0, collide: false, castShadow: false, receiveShadow: false, renderOrder: 20 },
    );

    this.buildFloodplain();
    this.buildForest();
    this.buildBroodSpire(94, -6);
    this.buildGodRays();
  }

  // -- the forest ------------------------------------------------------------

  private buildForest(): void {
    const rng = this.rng;
    // Hand-placed hero trees first: the two framing trunks, the pair that make
    // the mid-ground gateway, and the trio the Brood Spire is built between.
    const heroes: TreeSpec[] = [
      // The framing pair sits at roughly forty-five degrees off the view axis,
      // which is the edge of a ninety-five degree frame: close enough to fill
      // the corner, far enough not to wall off the shot the way an eight-metre
      // offset did.
      { f: 16, r: -15.5, height: 44, radius: 3.2, brood: 0.25, vines: 5 },
      { f: 19, r: 16.5, height: 47, radius: 3.5, brood: 0.15, vines: 6 },
      { f: 46, r: -26, height: 38, radius: 2.9, brood: 0.5, vines: 4 },
      { f: 52, r: 24, height: 41, radius: 3.1, brood: 0.35, vines: 4 },
      { f: 88, r: -22, height: 44, radius: 3.6, brood: 0.9, vines: 5 },
      { f: 100, r: 8, height: 47, radius: 3.9, brood: 0.95, vines: 5 },
      { f: 92, r: 18, height: 39, radius: 3.0, brood: 0.8, vines: 4 },
    ];
    for (const t of heroes) this.buildTree(t);

    // Then a scattered stand, thinning toward the middle of the floodplain so
    // the pools stay visible and the composition keeps its corridor.
    const count = Math.round(30 * this.detail);
    for (let i = 0; i < count; i++) {
      const f = rng.range(-40, 160);
      const r = rng.range(-80, 80);
      // A wider clear corridor: the pools, the shafts and the spire are the
      // whole mid-ground, and a stray trunk in front of them costs all three.
      const corridor = Math.abs(r) < 20 && f > 14 && f < 108;
      if (corridor) continue;
      // Nothing in the player's own lap: a 3 m trunk eighteen metres wide in
      // the frame is not a framing element, it is a wall.
      if (f > -16 && f < 18 && Math.abs(r) < 24) continue;
      const p = this.atSpawn(f, r);
      if (this.slopeAt(p.x, p.z) > 0.62) continue;
      this.buildTree({
        f,
        r,
        height: rng.range(22, 40),
        radius: rng.range(1.6, 3.1),
        brood: rng.next() < 0.3 ? rng.range(0.2, 0.7) : 0,
        vines: Math.round(rng.range(2, 7) * this.detail),
      });
    }
  }

  /**
   * One buttressed giant. The buttresses are the whole silhouette: a jungle
   * emergent is unmistakable from its base outward, and they also give the
   * frame-edge trees a shape that fills the corner instead of a bare pole.
   */
  private buildTree(spec: TreeSpec): void {
    const rng = this.rng;
    const base = this.atSpawn(spec.f, spec.r, -0.5);
    const R = spec.radius;
    const H = spec.height;
    const yaw = this.spawnYaw + rng.range(0, TAU);

    // -- trunk ---------------------------------------------------------------
    const trunk = this.temp(
      revolved(
        [
          [R * 1.5, 0],
          [R * 1.12, H * 0.1],
          [R * 0.92, H * 0.3],
          [R * 0.8, H * 0.55],
          [R * 0.72, H * 0.75],
          [R * 0.62, H * 0.92],
          [R * 0.3, H],
        ],
        10,
        0.075,
        rng,
      ),
    );
    this.bark.addAt(trunk, base, yaw, 1, rng.range(-0.02, 0.02), rng.range(-0.02, 0.02));

    // -- buttress roots ------------------------------------------------------
    const nb = 5 + (rng.next() < 0.5 ? 1 : 0);
    for (let i = 0; i < nb; i++) {
      const a = yaw + (i / nb) * TAU + rng.range(-0.18, 0.18);
      const reach = R * rng.range(2.2, 3.6);
      const rise = H * rng.range(0.14, 0.24);
      const fin = this.temp(
        tapered(rng.range(0.7, 1.2), rise, reach, 0.94, 0, 0.1, rng),
      );
      const p = new THREE.Vector3(
        base.x + Math.sin(a) * reach * 0.5,
        base.y,
        base.z + Math.cos(a) * reach * 0.5,
      );
      p.y = this.groundAt(p.x, p.z) - 0.6;
      this.bark.addAt(fin, p, a, 1, 0, 0);
      // A fillet where the fin meets the ground, so the join is not a knife.
      const foot = this.temp(
        revolved(
          [
            [reach * 0.42, 0],
            [reach * 0.3, 0.7],
            [reach * 0.14, 1.4],
          ],
          8,
          0.2,
          rng,
        ),
      );
      this.bark.addAt(foot, p.clone().setY(p.y - 0.2), a, new THREE.Vector3(0.7, 1.4, 1.5));
    }

    // -- branch arms and canopy ---------------------------------------------
    const arms = 3 + rng.int(0, 2);
    const crown = base.y + H;
    // A mass on the crown itself. Without it the trunk ends in a flat disc and
    // every tree in the mid-ground reads as a cut-off cylinder.
    const cap = this.temp(new THREE.IcosahedronGeometry(R * rng.range(2.4, 3.4), 1));
    this.canopy.addAt(
      cap,
      new THREE.Vector3(base.x, crown - R * 0.4, base.z),
      rng.range(0, TAU),
      new THREE.Vector3(1.2, 0.5, 1.2),
    );
    for (let i = 0; i < arms; i++) {
      const a = yaw + (i / arms) * TAU + rng.range(-0.3, 0.3);
      const len = R * rng.range(3.5, 6);
      const start = new THREE.Vector3(base.x, crown - H * rng.range(0.06, 0.2), base.z);
      const end = new THREE.Vector3(
        base.x + Math.sin(a) * len,
        crown + rng.range(0.5, 3.5),
        base.z + Math.cos(a) * len,
      );
      const midA = start.clone().lerp(end, 0.45);
      midA.y += rng.range(0.5, 2.5);
      this.bark.add(this.temp(tube([start, midA, end], R * 0.35, R * 0.13, 6)));

      // Canopy mass on the arm tip: flattened, so from below it is a ceiling.
      const blob = this.temp(new THREE.IcosahedronGeometry(len * rng.range(0.5, 0.75), 1));
      this.canopy.addAt(
        blob,
        end,
        rng.range(0, TAU),
        new THREE.Vector3(1.25, 0.42, 1.25),
      );
      // Fringe cards hanging under the edge of the mass.
      const cards = Math.round(3 * this.detail) + 1;
      for (let k = 0; k < cards; k++) {
        const ca = rng.range(0, TAU);
        const cd = len * rng.range(0.35, 0.75);
        const cp = new THREE.Vector3(
          end.x + Math.sin(ca) * cd,
          end.y - rng.range(0.5, 2.5),
          end.z + Math.cos(ca) * cd,
        );
        const card = this.temp(new THREE.PlaneGeometry(rng.range(3, 7), rng.range(2.5, 5)));
        this.frond.addAt(card, cp, ca, 1, rng.range(0.9, 1.5), 0);
      }
    }

    // -- hanging vines -------------------------------------------------------
    for (let i = 0; i < spec.vines; i++) {
      // Hung from the branch zone, not from thin air, and given a real hanging
      // curve: a dead-straight 0.1 m tube reads as cable, not as vine.
      const a = rng.range(0, TAU);
      const d = R * rng.range(2.2, 5.5);
      const topY = crown - H * rng.range(0.04, 0.22);
      const top = new THREE.Vector3(base.x + Math.sin(a) * d, topY, base.z + Math.cos(a) * d);
      const drop = rng.range(H * 0.4, H * 0.8);
      const swayA = a + rng.range(-0.9, 0.9);
      const sway = rng.range(1.4, 4.5);
      const pts: THREE.Vector3[] = [];
      const segs = 5;
      for (let k = 0; k <= segs; k++) {
        const t = k / segs;
        // sin(pi*t/2) leans out fast at the top then hangs plumb, which is what
        // a vine caught on a branch actually does.
        const out = Math.sin((t * Math.PI) / 2) * sway;
        pts.push(
          new THREE.Vector3(
            top.x + Math.sin(swayA) * out,
            topY - drop * t,
            top.z + Math.cos(swayA) * out,
          ),
        );
      }
      this.vine.add(this.temp(tube(pts, rng.range(0.16, 0.3), rng.range(0.1, 0.18), 5)));
    }

    // -- brood colonisation --------------------------------------------------
    if (spec.brood > 0.05) {
      const pods = Math.round(spec.brood * 6 * this.detail) + 1;
      for (let i = 0; i < pods; i++) {
        const a = yaw + rng.range(0, TAU);
        const y = base.y + H * rng.range(0.45, 0.9);
        const pr = R * rng.range(0.8, 1.4);
        const p = new THREE.Vector3(base.x + Math.sin(a) * pr, y, base.z + Math.cos(a) * pr);
        this.buildPod(p, a, rng.range(1.4, 3.2));
      }
      // A resin sheath running up the trunk, so the pods belong to the tree.
      const sheath = this.temp(
        revolved(
          [
            [R * 1.25, 0],
            [R * 1.0, H * 0.2],
            [R * 0.9, H * 0.45],
            [R * 0.7, H * 0.6],
          ],
          9,
          0.22,
          rng,
        ),
      );
      this.resin.addAt(sheath, base.clone().setY(base.y + H * 0.28), yaw);
    }
  }

  /** A single brood pod: a resin teardrop with a lit mouth. */
  private buildPod(p: THREE.Vector3, yaw: number, scale: number): void {
    const rng = this.rng;
    const pod = this.temp(
      revolved(
        [
          [0.15 * scale, 0],
          [0.75 * scale, 0.5 * scale],
          [1.0 * scale, 1.4 * scale],
          [0.85 * scale, 2.3 * scale],
          [0.45 * scale, 2.9 * scale],
          [0.1 * scale, 3.2 * scale],
        ],
        10,
        0.14,
        rng,
      ),
    );
    this.resin.addAt(pod, p, yaw, 1, rng.range(-0.4, 0.4), rng.range(-0.4, 0.4));
    const mouth = this.temp(new THREE.SphereGeometry(0.42 * scale, 10, 7));
    this.resinGlow.addAt(mouth, p.clone().setY(p.y + 1.5 * scale), yaw);
  }

  // -- the landmark ----------------------------------------------------------

  /**
   * The Brood Spire: forty metres of layered resin thrown up between the far
   * trees, lit from inside. Through this world's haze the silhouette goes soft
   * at about eighty metres, so the *glow* is what carries at distance — which is
   * exactly what makes it read as a beacon rather than as another trunk.
   */
  private buildBroodSpire(forward: number, right: number): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    const base = this.atSpawn(forward, right);
    const groundY = this.padHeight(base, 14, 11);
    base.y = groundY;

    const body = this.temp(
      revolved(
        [
          [9.5, 0],
          [8.2, 4],
          [6.4, 11],
          [6.9, 16],
          [5.2, 23],
          [3.6, 30],
          [3.9, 34],
          [2.1, 39],
          [0.6, 42],
        ],
        14,
        0.11,
        rng,
      ),
    );
    this.resin.addAt(body, base, yaw);

    // Flying buttresses of resin out to the surrounding trunks: the structure
    // has to look grown *onto* the forest, not dropped into it.
    for (let i = 0; i < 5; i++) {
      const a = yaw + (i / 5) * TAU + rng.range(-0.2, 0.2);
      const reach = rng.range(11, 19);
      const top = new THREE.Vector3(
        base.x + Math.sin(a) * 4,
        groundY + rng.range(16, 27),
        base.z + Math.cos(a) * 4,
      );
      const foot = new THREE.Vector3(
        base.x + Math.sin(a) * reach,
        0,
        base.z + Math.cos(a) * reach,
      );
      foot.y = this.groundAt(foot.x, foot.z) - 0.4;
      const mid = top.clone().lerp(foot, 0.5);
      mid.y += rng.range(2, 6);
      this.resin.add(this.temp(tube([top, mid, foot], rng.range(0.6, 1.1), rng.range(1.1, 1.8), 6)));
    }

    // Mouths and vents up the spire — a vertical run of emissives that reads
    // through the haze, brightest at the crown.
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const a = yaw + i * 2.4;
      const r = 7.6 - t * 5.4;
      const p = new THREE.Vector3(
        base.x + Math.sin(a) * r,
        groundY + 3 + t * 34,
        base.z + Math.cos(a) * r,
      );
      const mouth = this.temp(new THREE.SphereGeometry(0.85 + t * 0.7, 10, 7));
      this.resinGlow.addAt(mouth, p, a, new THREE.Vector3(1, 1.5, 1));
    }
    const crown = this.temp(new THREE.IcosahedronGeometry(2.4, 1));
    this.resinGlow.addAt(crown, base.clone().setY(groundY + 41), yaw, new THREE.Vector3(1, 1.7, 1));

    // Pods clustered on the flanks.
    for (let i = 0; i < Math.round(8 * this.detail) + 3; i++) {
      const a = yaw + rng.range(0, TAU);
      const t = rng.next();
      const r = 8.4 - t * 5;
      const p = new THREE.Vector3(
        base.x + Math.sin(a) * r,
        groundY + 2 + t * 32,
        base.z + Math.cos(a) * r,
      );
      this.buildPod(p, a, rng.range(1.1, 2.4));
    }
  }

  // -- the floodplain --------------------------------------------------------

  /**
   * Acid pools, their silt rims, and the resin-crusted banks. The pools are
   * emissive: they are the only light source below the canopy, and they do the
   * job the sky refuses to do on this world — separating the ground plane from
   * the trunks standing on it.
   */
  private buildFloodplain(): void {
    const rng = this.rng;
    const count = Math.round(18 * this.detail) + 6;
    const placed: Array<{ p: THREE.Vector3; r: number }> = [];

    for (let i = 0; i < count; i++) {
      // Bias the first few into the corridor so the leading line is made of
      // light rather than of geometry.
      const onAxis = i < 6;
      const f = onAxis ? 14 + i * 14 + rng.range(-3, 3) : rng.range(-30, 150);
      const r = onAxis ? rng.range(-11, 11) : rng.range(-70, 70);
      const p = this.atSpawn(f, r, 0);
      if (this.slopeAt(p.x, p.z) > 0.3) continue;
      const radius = rng.range(3.5, 8.5) * (onAxis ? 1.25 : 1);

      let clash = false;
      for (const q of placed) {
        if (q.p.distanceTo(p) < q.r + radius + 3) clash = true;
      }
      if (clash) continue;
      placed.push({ p, r: radius });

      // The surface: a flat emissive disc, lifted just clear of the ground so
      // it cannot z-fight with the terrain's dune ripple.
      // 22 segments showed as straight chords on a sixteen-metre pool.
      const surface = this.temp(new THREE.CircleGeometry(radius, 44));
      surface.rotateX(-Math.PI / 2);
      this.acid.addAt(surface, p.clone().setY(p.y + 0.16), rng.range(0, TAU));

      // A resin rim and a silt bank, so the pool has an edge instead of being
      // a decal on the dirt.
      this.resin.addAt(
        this.temp(bandRing(radius, radius + rng.range(0.6, 1.3), 44)),
        p.clone().setY(p.y + 0.22),
        rng.range(0, TAU),
      );
      const bank = this.temp(
        revolved(
          [
            [radius + 2.6, 0],
            [radius + 1.5, 0.55],
            [radius + 0.5, 0.85],
            [radius + 0.1, 0.95],
          ],
          18,
          0.1,
          rng,
        ),
      );
      this.silt.addAt(bank, p.clone().setY(p.y - 0.5), rng.range(0, TAU));

      // Reeds and crusted resin spurs around the bank.
      for (let k = 0; k < Math.round(5 * this.detail); k++) {
        const a = rng.range(0, TAU);
        const d = radius + rng.range(0.4, 2.6);
        const q = new THREE.Vector3(p.x + Math.sin(a) * d, 0, p.z + Math.cos(a) * d);
        q.y = this.groundAt(q.x, q.z) - 0.2;
        const spur = this.temp(
          tapered(rng.range(0.25, 0.6), rng.range(1.2, 3.4), rng.range(0.2, 0.5), 0.7, 0, 0.1, rng),
        );
        this.resin.addAt(spur, q, a, 1, rng.range(-0.3, 0.3), rng.range(-0.3, 0.3));
      }

      this.pools.push({ p: p.clone().setY(p.y + 0.2), r: radius });
    }
  }

  // -- god rays --------------------------------------------------------------

  /**
   * Shafts through the canopy gaps. Aligned to the sun, so they agree with the
   * shadows the same sun casts; faded to nothing at the floor with vertex colour
   * so no shaft ever shows a hard rim where it meets geometry.
   */
  private buildGodRays(): void {
    const rng = this.rng;
    const colour = new THREE.Color(0xe9f7c4).convertSRGBToLinear();
    const sun = this.sunDirection.clone().normalize();
    _q.setFromUnitVectors(_up, sun);

    const count = Math.round(7 * this.detail) + 3;
    for (let i = 0; i < count; i++) {
      // Cluster the shafts down the composition corridor: a shaft the player
      // cannot see through is a wasted draw. Narrow, because a wide cone with
      // an additive material stops reading as light and starts reading as
      // hanging fabric.
      const f = 18 + i * 11 + rng.range(-4, 4);
      const r = rng.range(-17, 17);
      const foot = this.atSpawn(f, r, 0);
      const length = rng.range(30, 44);
      const top = rng.range(1.1, 2.4);
      const bottom = top * rng.range(1.9, 2.8);
      const g = this.temp(shaftCone(top, bottom, length, colour, 9));
      // The cone is built along +Y; rotate it onto the sun axis and lift it so
      // its bright end is up in the canopy.
      _s.setScalar(1);
      const centre = new THREE.Vector3(
        foot.x + sun.x * length * 0.5,
        foot.y + sun.y * length * 0.5,
        foot.z + sun.z * length * 0.5,
      );
      _m.compose(centre, _q, _s);
      this.shafts.add(g, _m);
    }
  }

  // -- combat ----------------------------------------------------------------

  protected spawnVolumeSpecs(): SpawnVolumeSpec[] {
    return [
      { id: 'khepri.spire', forward: 92, right: -6, radius: 20, minPlayerDistance: 32 },
      { id: 'khepri.canopy.left', forward: 52, right: -30, radius: 16, minPlayerDistance: 24 },
      { id: 'khepri.canopy.right', forward: 56, right: 30, radius: 16, minPlayerDistance: 24 },
      { id: 'khepri.pools', forward: 76, right: 4, radius: 18, minPlayerDistance: 26 },
      { id: 'khepri.flank', forward: 14, right: -38, radius: 15, minPlayerDistance: 24 },
      { id: 'khepri.rear', forward: -28, right: 16, radius: 16, minPlayerDistance: 26 },
    ];
  }

  protected encounterScript(): EncounterScript {
    return {
      id: 'khepri.canopy',
      completesLevel: true,
      score: 3800,
      waves: [
        {
          delay: 5,
          triggerFraction: 0,
          objective: 'Cross the floodplain',
          volumes: ['khepri.canopy.left', 'khepri.canopy.right', 'khepri.flank'],
          units: [
            { archetype: 'mantis_nymph', count: 7 },
            { archetype: 'mantis_striker', count: 2 },
          ],
        },
        {
          delay: 4,
          triggerFraction: 0.6,
          objective: 'Burn out the brood pods',
          volumes: ['khepri.pools', 'khepri.canopy.left', 'khepri.rear'],
          units: [
            { archetype: 'mantis_striker', count: 4 },
            { archetype: 'mantis_spitter', count: 3 },
            { archetype: 'mantis_nymph', count: 5 },
          ],
        },
        {
          delay: 5,
          triggerFraction: 0.7,
          objective: 'Take the Brood Spire',
          volumes: ['khepri.spire', 'khepri.pools', 'khepri.canopy.right'],
          units: [
            { archetype: 'mantis_bladelord', count: 2 },
            { archetype: 'mantis_spitter', count: 3 },
            { archetype: 'mantis_striker', count: 4 },
          ],
        },
      ],
      boss: { archetype: 'mantis_matriarch', count: 1 },
    };
  }

  // -- ambience --------------------------------------------------------------

  protected override tick(ctx: FrameContext): void {
    if (this.pools.length === 0) return;
    this.poolTimer -= ctx.dt;
    if (this.poolTimer > 0) return;
    this.poolTimer = 0.3;
    for (let tries = 0; tries < 5; tries++) {
      this.poolCursor = (this.poolCursor + 1) % this.pools.length;
      const pool = this.pools[this.poolCursor];
      const d = pool.p.distanceToSquared(this.camPos);
      if (d > 70 * 70) continue;
      const a = (ctx.elapsed * 2.3 + this.poolCursor * 1.7) % TAU;
      const rr = pool.r * clamp01(0.25 + ((ctx.elapsed * 0.37 + this.poolCursor) % 1) * 0.7);
      _pt.set(pool.p.x + Math.sin(a) * rr, pool.p.y, pool.p.z + Math.cos(a) * rr);
      this.vfx.impact(
        _pt,
        _up,
        'water',
        clamp(0.9 - Math.sqrt(d) * 0.006, 0.3, 0.9),
      );
      return;
    }
  }
}

registerPlanet('khepri', (deps, descriptor) => new KhepriLevel(deps, descriptor));

export { KhepriLevel };
