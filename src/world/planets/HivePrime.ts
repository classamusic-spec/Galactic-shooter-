/**
 * Hive Prime — the Spore Reach.
 *
 * The whole crust is one nest, and the art direction follows from a single
 * decision: **the player is inside something living, and it is not finished with
 * them yet.** Perpetual amber dusk, a cloud deck at 900 m acting as a lid, and
 * geometry that keeps closing in and opening out again.
 *
 * The composition the level is designed around, read from the spawn:
 *
 *  - A resin buttress on the left edge and a broken chitin column on the right,
 *    both close and both nearly black. That is the dark foreground frame the
 *    value structure needs, and it is also what makes the mid-ground read as
 *    *far* rather than merely smaller.
 *  - A processional canyon of nest wall running away from the camera, its
 *    ribbing converging on the arch at 34 m — leading lines to the objective,
 *    with web strands strung overhead so there is always something between the
 *    player and the sky.
 *  - The canyon opens into a brood arena at 80 m: a bowl ringed with resin
 *    pillars and three tunnel mouths in the far rim, which is where everything
 *    comes from.
 *  - The great spire at 180 m, 95 m tall, as the unmistakable horizon landmark,
 *    with two lesser spires behind it for depth and a scatter of distant ones at
 *    300-450 m so the horizon is nest all the way out.
 *
 * Emissive language is amber-orange throughout (`FACTION_IDENTITY.insectoid`):
 * egg clutches, fungal gills, and the resin veins running up the spires. Every
 * one of those is a *rim glow on a lit object*, never a replacement for lighting
 * — the flat-amber-cutout failure this world's flora already had to be rescued
 * from once.
 *
 * Registers itself with the planet registry on import.
 */
import * as THREE from 'three';
import type { FrameContext, PlanetDescriptor } from '@/types';
import type { EncounterScript } from '@/gameplay/ai/EncounterDirector';
import { ATMOSPHERES, cloneAtmosphere, type AtmosphereProfile } from '@/gfx/sky/AtmosphereProfile';
import { terrainRecipe } from '@/gfx/terrain/TerrainBuilder';
import type { TerrainDescriptor } from '@/gfx/terrain/HeightField';
import { clamp01, TAU } from '@/util/math';
import {
  PlanetLevel,
  cloneRecipe,
  glowCross,
  prism,
  revolved,
  shaftCone,
  tapered,
  tube,
  type PropBatch,
  type SpawnVolumeSpec,
} from './PlanetLevel';
import { registerPlanet, type PlanetDeps } from './index';
// Sibling world shipped by the same owner; imported for its registration side
// effect so pulling in either one makes both available to the star map.
import './DracoIX';

/** Insectoid emissive identity. Matches FACTION_IDENTITY.insectoid. */
const HIVE_AMBER = 0xff9a2e;
const HIVE_PALE = 0xffc46b;

const _up = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/**
 * Compose a matrix whose +Y axis points along `dir`. Every shape in the kit is
 * authored Y-up, so this is what lets a tooth, a rib or a horn be aimed rather
 * than merely rotated.
 */
function aim(
  out: THREE.Matrix4,
  position: THREE.Vector3,
  dir: THREE.Vector3,
  roll: number,
  scale: THREE.Vector3 | number,
): THREE.Matrix4 {
  _dir.copy(dir);
  if (_dir.lengthSq() < 1e-8) _dir.set(0, 1, 0);
  _dir.normalize();
  _q.setFromUnitVectors(_up, _dir);
  if (roll !== 0) _q.multiply(new THREE.Quaternion().setFromAxisAngle(_up, roll));
  if (typeof scale === 'number') _s.set(scale, scale, scale);
  else _s.copy(scale);
  return out.compose(position, _q, _s);
}

class HivePrimeLevel extends PlanetLevel {
  private chitin!: PropBatch;
  private resin!: PropBatch;
  private husk!: PropBatch;
  private shell!: PropBatch;
  private flesh!: PropBatch;
  private voidBatch!: PropBatch;
  private glowBatch!: PropBatch;
  private shafts!: PropBatch;
  /** Near-field detritus: shell fragments, husk chips, chewed grit. */
  private grit!: PropBatch;

  /** Animated materials this level owns outright, so pulsing them is safe. */
  private veinMat!: THREE.MeshStandardMaterial;
  private clutchMat!: THREE.MeshStandardMaterial;
  private shaftMat!: THREE.MeshBasicMaterial;

  /** Amber fill lights sitting in the egg clutches. */
  private readonly clutchLights: THREE.PointLight[] = [];
  private readonly extraGeometry: THREE.BufferGeometry[] = [];
  private spores: THREE.Points | null = null;
  private sporeMat: THREE.ShaderMaterial | null = null;
  /** Where the ambient chittering and spore bursts come from. */
  private readonly ventPoints: THREE.Vector3[] = [];
  private ventTimer = 0;
  private ventCursor = 0;

  /** Mouth of the avenue — chapter four's defensive stand. */
  private readonly avenueMouth = new THREE.Vector3();
  /** Centre of the brood arena. */
  private readonly arenaCentre = new THREE.Vector3();

  constructor(deps: PlanetDeps, descriptor: PlanetDescriptor) {
    super(deps, descriptor, {
      navRadius: 132,
      // Three-quarter light. An 8-degree sun straight down the view axis blows
      // the amber haze out to a flat wash and every spire loses its form; taken
      // across the frame the same sun models the ribbing and throws the long
      // shadows sideways where they read as depth.
      spawnFacing: 'across',
      spawnSearchRadius: 330,
      dust: { density: 0.95, color: 0xffb469, size: 0.055 },
    });
  }

  protected override atmosphere(): AtmosphereProfile {
    const a = cloneAtmosphere(ATMOSPHERES['hive-prime']);
    // The ceiling is the point of this world. Bring the deck down and thicken it
    // so it caps the frame instead of hovering somewhere out of shot, and let
    // the underlight from the nest bounce back off it.
    a.cloudAltitude = 760;
    a.cloudCoverage = 0.78;
    a.cloudUnderlightStrength = 1.25;
    // The spires are tall and the sun is low: the default frustum clips their
    // shadows off halfway down the avenue.
    a.shadowExtent = 165;
    return a;
  }

  protected override recipe(): TerrainDescriptor {
    const d = cloneRecipe(terrainRecipe('hive-prime'));
    // Open review defect: the macro silhouette rounds off into dunes. Deepen the
    // valleys so the canyons this world is named for actually have walls.
    d.ridgePower = 2.7;
    d.erosion = 0.95;
    // Fungal density is authored for open ground; the set pieces add their own
    // canopy, and doubling up buries the composition.
    d.flora.entries[0].density *= 0.8;
    // The whole frame sat in one mid-amber band, with the chitin layer's cell
    // pattern reading as a visible repeat inside 20 m. Darken the two ground
    // layers so the set pieces and the sky have something to be lighter *than*,
    // and stretch the tiles so the cells are landscape-scale rather than
    // wallpaper.
    // The organic and chitin ground layers are both authored as wet, glossy,
    // strongly patterned creature surfaces. Across a whole basin they read as
    // oiled eel skin with a visible repeat inside 20 m — an outright fail. The
    // crust of a nest is still *ground*: geological surfaces, tinted amber.
    d.layers[0].surface = 'rock';
    d.layers[0].tint = 0x3a2712;
    d.layers[0].tileMetres = 7;
    d.layers[0].roughness = 1;
    d.layers[0].metalness = 0;
    d.layers[0].normalStrength = 0.9;
    d.layers[1].surface = 'sand';
    d.layers[1].tint = 0x8a6330;
    d.layers[1].tileMetres = 9;
    d.layers[1].roughness = 1;
    d.layers[1].metalness = 0;
    d.layers[1].normalStrength = 0.9;
    d.layers[1].breakup = 0.95;
    d.layers[2].tint = 0x9c7a44;
    d.layers[2].tileMetres = 11;
    d.layers[3].surface = 'rock';
    d.layers[3].tint = 0x7a5a2c;
    d.layers[3].tileMetres = 12;
    d.cliffs.surface = 'rock';
    d.cliffs.tileMetres = 8;
    d.cliffs.tint = 0x8a6434;
    d.distantTint = 0xc08b45;
    return d;
  }

  // -- construction ----------------------------------------------------------

  protected decorate(): void {
    this.chitin = this.batch(
      'chitin',
      // Not a chitin surface, and the reasoning is worth writing down.
      // `hiveChitin` and `chitin` bake an explicit plate lattice — about ten by
      // eighteen scutes per UV unit — because they were authored for a
      // creature's back. Tiled small it is visible wallpaper on a twenty-metre
      // tower; stretched to architectural scale it becomes giant wet scales that
      // read as polished meat. There is no tile size at which a scale texture is
      // a *building*. So the masses take a geological surface tinted into the
      // world's amber, and the chitin identity is carried where it is true: by
      // the silhouettes, and by `shell` below at genuine creature scale.
      this.surface('rock', { repeat: 1, color: 0x8a6234, roughness: 1, metalness: 0 }),
      { tile: 5.5, collide: true, surface: 'chitin' },
    );
    this.resin = this.batch(
      'resin',
      this.surface('organic', { repeat: 1, color: 0x8d5c26, roughness: 0.72, normalScale: 0.7 }),
      { tile: 9, collide: true, surface: 'organic' },
    );
    // Old chitin, bleached by the dust. The value break that keeps a wall of
    // nest from being one brown mass.
    this.husk = this.batch(
      'husk',
      this.surface('concrete', { repeat: 1, color: 0xc2a075, roughness: 1, normalScale: 0.85 }),
      { tile: 6.5, collide: true, surface: 'chitin' },
    );
    // Creature scale: teeth, rims and shell plate, where an 18 cm scute is
    // exactly right and the iridescence in the recipe is the point.
    this.shell = this.batch(
      'shell',
      this.surface('hiveChitin', { repeat: 1, color: 0xa8712f, roughness: 0.8, metalness: 0.15 }),
      { tile: 1.8, collide: true, surface: 'chitin' },
    );
    this.flesh = this.batch(
      'brood',
      this.surface('flesh', { repeat: 1, color: 0xb8794a, roughness: 0.55 }),
      { tile: 3.2, collide: true, surface: 'flesh' },
    );
    // The inside of a tunnel. Near-black and unlit, so a mouth reads as a hole
    // in the world rather than a dark patch painted on a mound.
    this.voidBatch = this.batch(
      'gullet',
      this.own(
        new THREE.MeshStandardMaterial({
          color: 0x0d0705,
          roughness: 1,
          metalness: 0,
        }),
      ),
      { tile: 0, collide: false, castShadow: false },
    );

    this.veinMat = this.own(
      new THREE.MeshStandardMaterial({
        color: 0x3a1e08,
        emissive: new THREE.Color(HIVE_AMBER),
        emissiveIntensity: 2.8,
        roughness: 0.5,
        metalness: 0,
      }),
    );
    this.glowBatch = this.batch('veins', this.veinMat, {
      tile: 0,
      collide: false,
      castShadow: false,
    });

    this.clutchMat = this.own(
      new THREE.MeshStandardMaterial({
        color: 0x6b3a12,
        emissive: new THREE.Color(HIVE_PALE),
        emissiveIntensity: 4.0,
        roughness: 0.36,
        metalness: 0,
      }),
    );

    this.shaftMat = this.own(
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: true,
      }),
    );
    this.shafts = this.batch('shafts', this.shaftMat, {
      tile: 0,
      collide: false,
      castShadow: false,
      receiveShadow: false,
      renderOrder: 5,
    });

    this.grit = this.batch(
      'grit',
      // Bleached, so shell fragments read light against the dark nest floor.
      this.surface('concrete', { repeat: 1, color: 0xd6bb92, roughness: 1 }),
      // `castShadow` is on, and it is the reason any of this reads. Captures of
      // the first attempt showed a bare ground plane with the scatter provably
      // present in it: a 20 cm stone lit from the same direction as the ground
      // it lies on has no edge until it drops a contact shadow. One merged mesh,
      // so the whole near field costs one extra shadow draw.
      { tile: 0.9, collide: false, surface: 'chitin', castShadow: true },
    );

    this.buildForeground();
    this.buildAvenue();
    this.buildGallery();
    this.buildRedoubt();
    this.buildArena();
    this.buildArenaDais();
    this.buildCover();
    this.buildSpires();
    this.buildFlora();
    this.buildNearField();
    this.buildSpores();
  }

  /** The two framing masses that own the left and right edges of the frame. */
  private buildForeground(): void {
    // Left: a resin buttress leaning into frame, with the nest wall behind it.
    const left = this.atSpawn(12.5, -8.5);
    this.buttress(left, this.yawFrom(-0.5), 9.5, 3.4);
    const leftBack = this.atSpawn(19, -13);
    this.buttress(leftBack, this.yawFrom(-0.8), 13, 4.2);

    // Right: a broken chitin column, snapped at two thirds, its top lying in
    // the dirt beside it. A silhouette with a story reads better than a whole one.
    const right = this.atSpawn(15, 9.5);
    const shaftGeo = this.temp(
      revolved(
        [
          [2.4, 0],
          [2.0, 3.2],
          [1.75, 6.4],
          [1.55, 9.0],
          [1.3, 10.4],
        ],
        11,
        0.16,
        this.rng,
      ),
    );
    this.chitin.addAt(shaftGeo, right, this.rng.range(0, TAU), 1, 0.05, 0.09);
    const capGeo = this.temp(prism(7, 1.7, 4.4, 0.5, this.rng));
    _tmp.copy(right).addScaledVector(this.viewRight, 3.6).addScaledVector(this.viewForward, 1.2);
    _tmp.y = this.groundAt(_tmp.x, _tmp.z) + 0.9;
    aim(_m, _tmp, _dir.copy(this.viewForward).setY(0.35), 0.6, 1.15);
    this.husk.add(capGeo, _m);
    this.veinRun(right, 10.2, 4);

    // A low resin lip across the immediate foreground, which is what actually
    // stops the bottom of the frame from being an empty apron of ground.
    for (let i = 0; i < 5; i++) {
      const p = this.atSpawn(6.5 + this.rng.range(-1.2, 1.4), -7 + i * 3.6);
      const g = this.temp(tapered(2.6, 0.9 + this.rng.next() * 0.7, 1.5, 0.4, 0.3, 0.12, this.rng));
      this.resin.addAt(g, p, this.rng.range(0, TAU), 1, 0.12, 0.1);
    }
  }

  /**
   * The processional canyon. Two walls of nest converging on an arch, ribbed so
   * the perspective has something to run along, with web strands overhead.
   */
  private buildAvenue(): void {
    const segments = Math.round(9 * this.detail) + 4;
    for (let i = 0; i < segments; i++) {
      const t = i / (segments - 1);
      const forward = 20 + t * 62;
      // The walls pinch at the arch and flare into the arena, so the sightline
      // is genuinely claustrophobic before it opens.
      const pinch = 1 - Math.exp(-Math.pow((forward - 34) / 16, 2)) * 0.45;
      const halfWidth = (15 + t * 16) * pinch;
      for (const side of [-1, 1]) {
        const p = this.atSpawn(forward + this.rng.range(-2, 2), side * halfWidth);
        const h = 11 + this.rng.next() * 15 + t * 6;
        // Tall and narrow, with the waist pinched: at radius 3.6 over 12 m these
        // read as cooling towers, and a nest wall is a stack of fused tubes.
        const rad = 1.5 + this.rng.next() * 1.1;
        const wall = this.temp(
          revolved(
            [
              [rad * 1.5, 0],
              [rad * 1.05, h * 0.22],
              [rad * 1.25, h * 0.45],
              [rad * 0.8, h * 0.72],
              [rad * 0.95, h * 0.88],
              [rad * 0.3, h],
            ],
            11,
            0.26,
            this.rng,
          ),
        );
        (this.rng.bool(0.65) ? this.chitin : this.husk).addAt(
          wall,
          p,
          this.rng.range(0, TAU),
          1,
          this.rng.range(-0.08, 0.08),
          -side * (0.06 + this.rng.next() * 0.14),
        );
        // Ribbing: the vertical detail that makes the wall read as grown rather
        // than extruded, and the thing the raking sun actually models.
        const ribs = 3;
        for (let r = 0; r < ribs; r++) {
          const rib = this.temp(
            tube(
              [
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0.5, h * 0.4, -0.3),
                new THREE.Vector3(0.2, h * 0.8, 0.4),
                new THREE.Vector3(-0.4, h * 1.02, 0.1),
              ],
              0.42,
              0.16,
              5,
            ),
          );
          this.resin.addAt(rib, p, (r / ribs) * TAU + this.rng.range(0, 1), 1);
        }
        if (this.rng.bool(0.4)) this.veinRun(p, h * 0.95, 3);
      }
    }

    // The arch: the frame within the frame, and the strongest leading line in
    // the level. Two legs and a sagging span, deliberately asymmetric.
    const archL = this.atSpawn(34, -12.5);
    const archR = this.atSpawn(34, 12.5);
    this.buttress(archL, this.yawFrom(0.4), 15, 3.0);
    this.buttress(archR, this.yawFrom(-0.4), 17, 3.2);
    const span: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const p = new THREE.Vector3().lerpVectors(archL, archR, t);
      // Catenary sag, plus a lean so the span is not a flat croquet hoop.
      p.y = archL.y + 14.2 + Math.sin(t * Math.PI) * 3.4 - Math.pow(t - 0.5, 2) * 3.0;
      p.addScaledVector(this.viewForward, Math.sin(t * Math.PI) * 1.6);
      span.push(p);
    }
    this.chitin.add(this.temp(tube(span, 1.9, 1.5, 8)));
    for (let i = 1; i < span.length - 1; i += 2) {
      const drip = [
        span[i].clone(),
        span[i].clone().add(new THREE.Vector3(0, -1.8 - this.rng.next() * 2.4, 0)),
      ];
      this.resin.add(this.temp(tube(drip, 0.3, 0.06, 5)));
    }

    // Web strands: strung across the avenue at three heights so there is always
    // something between the player and the sky.
    for (let i = 0; i < Math.round(7 * this.detail); i++) {
      const forward = 24 + this.rng.next() * 54;
      const a = this.atSpawn(forward, -14 - this.rng.next() * 6);
      const b = this.atSpawn(forward + this.rng.range(-5, 5), 14 + this.rng.next() * 6);
      const height = 11 + this.rng.next() * 8;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 6; k++) {
        const t = k / 6;
        const p = new THREE.Vector3().lerpVectors(a, b, t);
        p.y = a.y + height - Math.sin(t * Math.PI) * (2.2 + this.rng.next() * 2.6);
        pts.push(p);
      }
      this.husk.add(this.temp(tube(pts, 0.34, 0.26, 5)));
    }

    // Light breaking through the web. Three shafts, placed where the strands
    // are thickest, which is the one thing that makes the overhead read.
    const shaftColor = new THREE.Color(HIVE_PALE).convertSRGBToLinear();
    for (let i = 0; i < 3; i++) {
      const p = this.atSpawn(30 + i * 18, -8 + i * 9);
      const geo = this.temp(shaftCone(1.6, 6.5, 26, shaftColor, 9));
      _tmp.set(p.x, p.y + 13, p.z);
      // Leaned toward the sun so the shafts agree with the key light.
      aim(_m, _tmp, _dir.copy(this.sunDirection).setY(2.4).normalize(), 0, 1);
      this.shafts.add(geo, _m);
    }
  }

  /** The brood arena: a bowl the canyon empties into, and where the nest lives. */
  private buildArena(): void {
    const centre = this.atSpawn(84, 2);
    const pad = this.padHeight(centre, 26, 12);
    this.arenaCentre.copy(centre);

    // A ring of resin pillars: cover for the player, and the thing that gives
    // the arena a readable edge instead of trailing off into terrain.
    const pillars = Math.round(11 * this.detail) + 5;
    for (let i = 0; i < pillars; i++) {
      const a = (i / pillars) * TAU + 0.3;
      const r = 22 + this.rng.range(-3, 4);
      const x = centre.x + Math.cos(a) * r;
      const z = centre.z + Math.sin(a) * r;
      const p = new THREE.Vector3(x, this.groundAt(x, z), z);
      const h = 4.5 + this.rng.next() * 7;
      const g = this.temp(
        revolved(
          [
            [1.9, 0],
            [1.4, h * 0.5],
            [1.1, h * 0.86],
            [0.5, h],
          ],
          8,
          0.24,
          this.rng,
        ),
      );
      (this.rng.bool(0.5) ? this.resin : this.chitin).addAt(
        g,
        p,
        this.rng.range(0, TAU),
        1,
        this.rng.range(-0.1, 0.1),
        this.rng.range(-0.1, 0.1),
      );
    }

    // Three tunnel mouths in the far rim, aimed back at the player. These are
    // the spawn volumes, and the player should be able to *see* where the count
    // is coming from.
    // Kept inside 108 m of the landing point, which is as far as the nav grid
    // reaches: the centre mouth used to sit at 112 and its spawn volume with it,
    // so the mouth the player could see was the one nothing ever came out of.
    const mouths: Array<[number, number]> = [
      [100, -26],
      [102, 4],
      [98, 30],
    ];
    for (const [f, r] of mouths) {
      const p = this.atSpawn(f, r);
      this.tunnelMouth(p, this.yawFrom(0), 4.6, 6.4);
      this.ventPoints.push(p.clone().setY(p.y + 2));
    }

    // Egg clutches. Three, placed on the thirds of the arena rather than in the
    // middle, each with a real point light in it — this is the coloured fill the
    // amber sky cannot provide down here in the shadow of the walls.
    const clutches: Array<[number, number]> = [
      [17, -8.5],
      [34, 13],
      [58, -15],
      [80, 8],
    ];
    for (const [f, r] of clutches) {
      const p = this.atSpawn(f, r);
      this.eggClutch(p, 7 + Math.round(this.rng.next() * 4));
      const light = new THREE.PointLight(HIVE_AMBER, 9, 30, 2);
      light.position.set(p.x, p.y + 1.4, p.z);
      light.castShadow = false;
      this.props.add(light);
      this.clutchLights.push(light);
      this.ventPoints.push(p.clone().setY(p.y + 1));
    }
    void pad;
  }

  // -- depth: the redoubt ----------------------------------------------------

  /**
   * A broken shell of old nest at the mouth of the avenue: the position the
   * hold objective is actually held from.
   *
   * "Hold the avenue" was a caption over a kill count on open ground. It is now
   * sixty seconds inside a twenty-metre circle with the count arriving from
   * three sides, and that is only a fight worth having if there is something to
   * hold. So: a ring of waist and full-height carapace with both ends of the
   * canyon axis left open — the way in behind, the sightline up the avenue
   * ahead — two raised husk pads inside it that a single jump reaches, and gaps
   * in the wall wide enough that a swarm gets in. The player is meant to be
   * turning, not camping.
   */
  private buildRedoubt(): void {
    const rng = this.rng;
    const centre = this.atSpawn(22, 0);
    this.avenueMouth.copy(centre);
    const pad = this.padHeight(centre, 12, 11);

    // The horseshoe. Open across the avenue side so the sightline up the canyon
    // — the level's strongest leading line — is never blocked.
    const segments = 20;
    for (let i = 0; i < segments; i++) {
      // Measured off the *spawn* bearing, so `a = 0` is the side the player
      // walks in from and `a = PI` is the side that faces up the canyon. Both
      // are left open: the near one is the way in, the far one is the level's
      // strongest leading line and walling it off would cost the whole shot.
      const a = (i / segments) * TAU;
      if (Math.abs(a) < 0.5 || Math.abs(a - TAU) < 0.5) continue;
      if (Math.abs(a - Math.PI) < 0.55) continue;
      if (rng.next() < 0.16) continue; // and this is a ruin, not a fort
      const r = 11 + rng.range(-1, 1.4);
      const x = centre.x + Math.sin(a + this.spawnYaw) * r;
      const z = centre.z + Math.cos(a + this.spawnYaw) * r;
      const full = rng.next() < 0.45;
      const h = full ? 2.7 + rng.range(-0.3, 0.6) : 1.2 + rng.range(-0.1, 0.35);
      const g = this.temp(
        revolved(
          [
            [2.1, 0],
            [1.7, h * 0.4],
            [1.85, h * 0.75],
            [1.3, h],
          ],
          9,
          0.2,
          rng,
        ),
      );
      (rng.bool(0.55) ? this.husk : this.chitin).addAt(
        g,
        new THREE.Vector3(x, this.groundAt(x, z) - 0.35, z),
        rng.range(0, TAU),
        1,
        rng.range(-0.06, 0.06),
        rng.range(-0.06, 0.06),
      );
    }

    // Two raised pads inside the horseshoe: 1.6 m, which a single jump clears,
    // so getting height costs nothing but standing on it costs cover.
    for (const side of [-1, 1]) {
      const p = new THREE.Vector3(
        centre.x + this.viewRight.x * side * 5.6 - this.viewForward.x * 3.4,
        0,
        centre.z + this.viewRight.z * side * 5.6 - this.viewForward.z * 3.4,
      );
      p.y = this.groundAt(p.x, p.z);
      const top = Math.max(p.y, pad) + 1.65;
      const g = this.temp(
        revolved(
          [
            [3.9, 0],
            [3.7, top - p.y - 0.35],
            [3.4, top - p.y],
            [3.3, top - p.y + 0.08],
          ],
          14,
          0.05,
          rng,
        ),
      );
      this.husk.addAt(g, p.clone().setY(p.y - 0.5), rng.range(0, TAU));
      // A lip on the outboard edge, so standing up there is still cover.
      const lip = this.temp(tapered(3.4, 1.0, 1.0, 0.18, 0, 0.14, rng));
      this.chitin.addAt(
        lip,
        new THREE.Vector3(
          p.x + this.viewRight.x * side * 2.6,
          top - 0.15,
          p.z + this.viewRight.z * side * 2.6,
        ),
        this.spawnYaw + side * 1.57,
      );
      this.ventPoints.push(new THREE.Vector3(p.x, top + 0.3, p.z));
    }

    // A clutch in the middle of the redoubt: the amber fill that stops the
    // inside of the position from going to silhouette when the sun is behind
    // the avenue walls.
    this.eggClutch(new THREE.Vector3(centre.x, this.groundAt(centre.x, centre.z), centre.z), 6);
    const light = new THREE.PointLight(HIVE_AMBER, 8, 26, 2);
    light.position.set(centre.x, centre.y + 1.3, centre.z);
    light.castShadow = false;
    this.props.add(light);
    this.clutchLights.push(light);
  }

  // -- depth: the covered gallery --------------------------------------------

  /**
   * Twenty metres of the avenue with a roof on it.
   *
   * The canyon reads as a corridor but it is open to the sky for its whole
   * length, so the walk up it has one lighting condition and one tempo. Arching
   * the walls together over the middle third gives the route a genuine interior:
   * the amber sky is cut off, the vein glow on the walls becomes the dominant
   * source, and the two shafts that come through the holes are the only daylight
   * — which is the moment the arena's opening actually lands against.
   *
   * Seven metres of headroom, so the nav grid keeps every cell under it walkable
   * and the fight comes through the gallery rather than stopping at its mouth.
   */
  private buildGallery(): void {
    const rng = this.rng;
    const near = 42;
    const far = 64;
    const halfW = 9.5;
    const roofY = 7.2;
    const ribs = 8;
    for (let i = 0; i <= ribs; i++) {
      const t = i / ribs;
      const f = near + (far - near) * t;
      const a = this.atSpawn(f, -halfW);
      const b = this.atSpawn(f, halfW);
      // A pointed arch, leaning slightly down the canyon so the run of them has
      // a direction.
      const apexY = Math.max(a.y, b.y) + roofY + rng.range(-0.3, 0.4);
      const pts = [
        a.clone(),
        a.clone().lerp(b, 0.22).setY(a.y + roofY * 0.72),
        a.clone().lerp(b, 0.5).setY(apexY),
        a.clone().lerp(b, 0.78).setY(b.y + roofY * 0.72),
        b.clone(),
      ];
      for (const q of pts) q.addScaledVector(this.viewForward, Math.sin(t * Math.PI) * 0.9);
      this.chitin.add(this.temp(tube(pts, 1.5, 1.5, 8)));
      if (i > 0 && rng.next() < 0.75) {
        // Webbing between the ribs: the roof itself, in panels so it can be
        // missing in places.
        const g = this.temp(
          tapered((far - near) / ribs + 0.6, 0.6, halfW * 2 - 1.2, 0.04, 0, 0.3, rng),
        );
        const p = this.atSpawn(f - (far - near) / ribs / 2, rng.range(-1.2, 1.2), 0);
        p.y = this.groundAt(p.x, p.z) + roofY - rng.range(0.4, 1.1);
        this.husk.addAt(g, p, this.spawnYaw + Math.PI / 2, 1, 0, rng.range(-0.05, 0.05));
      }
      if (i % 2 === 0) this.veinRun(a, roofY * 0.9, 2);
    }

    // Two shafts through the holes in the roof, which is the only reason a
    // covered stretch reads as covered rather than as dark.
    const shaftColor = new THREE.Color(HIVE_PALE).convertSRGBToLinear();
    for (let i = 0; i < 2; i++) {
      const p = this.atSpawn(47 + i * 11, -3 + i * 6);
      const geo = this.temp(shaftCone(1.1, 3.8, 12, shaftColor, 8));
      _tmp.set(p.x, p.y + 6.4, p.z);
      aim(_m, _tmp, _dir.copy(this.sunDirection).setY(2.6).normalize(), 0, 1);
      this.shafts.add(geo, _m);
    }

    // Detritus on the gallery floor: bones, husks, chewed shell. An interior is
    // where the near field is closest to the camera, so it is where litter
    // matters most.
    for (let i = 0; i < Math.round(30 * this.detail) + 10; i++) {
      const p = this.atSpawn(near + rng.next() * (far - near), rng.range(-halfW + 1, halfW - 1), -0.05);
      const g = this.temp(
        tapered(rng.range(0.2, 0.8), rng.range(0.1, 0.35), rng.range(0.25, 1.1), 0.3, 0, 0.28, rng),
      );
      (rng.bool(0.5) ? this.grit : this.shell).addAt(
        g,
        p,
        rng.range(0, TAU),
        1,
        rng.range(-0.4, 0.4),
        rng.range(-0.4, 0.4),
      );
    }
  }

  // -- depth: the arena dais -------------------------------------------------

  /**
   * A raised carapace platform in the middle of the brood arena, with a ramp of
   * fused husk up one side.
   *
   * The boss arena was a flat bowl with a ring of pillars round the edge, so the
   * Hivelord fight had exactly one shape: back to the rim, everything in front.
   * Three metres of height in the centre turns it into a contested object — high
   * ground the swarm floods around rather than climbs, worth taking and hard to
   * hold, which is the fight a 5200 HP boss deserves.
   */
  private buildArenaDais(): void {
    const rng = this.rng;
    const centre = this.arenaCentre;
    const pad = this.padHeight(centre, 12, 11);
    const top = pad + 3.0;

    const body = this.temp(
      revolved(
        [
          [10.5, 0],
          [10.0, 1.4],
          [8.6, 3.0],
          [8.2, 3.4],
          [8.1, 3.5],
        ],
        20,
        0.05,
        rng,
      ),
    );
    this.chitin.addAt(body, new THREE.Vector3(centre.x, pad - 0.5, centre.z), this.spawnYaw);

    // The ramp, coming up the avenue side so the player meets it head on. Short
    // of the rim on purpose, with a landing across the last couple of metres —
    // a flight run all the way to the edge buries its top treads in the dais.
    // Inside the top face's 8.1 m radius, so the landing ends *on* the dais and
    // not over its sloped flank.
    const edge = new THREE.Vector3(
      centre.x - this.viewForward.x * 7.6,
      top,
      centre.z - this.viewForward.z * 7.6,
    );
    const foot = new THREE.Vector3(
      edge.x - this.viewForward.x * 8.5,
      0,
      edge.z - this.viewForward.z * 8.5,
    );
    foot.y = this.groundAt(foot.x, foot.z);
    const rampTop = this.stairs(this.husk, foot, this.spawnYaw, top - foot.y, 4.4, 0.8, 0.42);
    this.landing(this.husk, rampTop, edge, 4.4);

    // Broken parapet round three-quarters of the rim: cover on top, and the
    // silhouette that makes the dais read as a thing from across the arena.
    for (let i = 0; i < 14; i++) {
      const a = this.spawnYaw + (i / 14) * TAU;
      // `a = spawnYaw` points back down the avenue at the player, which is the
      // side the ramp arrives on — so that is the arc the parapet leaves open.
      const fwdDot = Math.cos((i / 14) * TAU);
      if (fwdDot > 0.72) continue; // the ramp mouth stays clear
      if (rng.next() < 0.2) continue;
      const r = 7.6;
      const p = new THREE.Vector3(
        centre.x + Math.sin(a) * r,
        top - 0.55,
        centre.z + Math.cos(a) * r,
      );
      const g = this.temp(
        tapered(2.3, 1.25 + rng.range(-0.2, 0.5), 1.0, 0.2, 0, 0.16, rng),
      );
      this.shell.addAt(g, p, a, 1, 0, rng.range(-0.05, 0.05));
    }

    // A clutch on the crown: the boss arena's key fill light, and the reason the
    // dais is lit from within rather than being a black mesa.
    this.eggClutch(new THREE.Vector3(centre.x, top - 0.4, centre.z), 5);
    const light = new THREE.PointLight(HIVE_PALE, 11, 34, 2);
    light.position.set(centre.x, top + 1.6, centre.z);
    light.castShadow = false;
    this.props.add(light);
    this.clutchLights.push(light);
    this.ventPoints.push(new THREE.Vector3(centre.x, top + 0.6, centre.z));
  }

  // -- depth: cover ----------------------------------------------------------

  /**
   * Fighting cover the length of the avenue and around the arena floor.
   *
   * The Unnumbered come in numbers and from three mouths at once, so the player
   * needs a back and a corner about every fifteen metres or the whole route is a
   * fighting retreat. Waist-high fused husk to shoot over, full-height carapace
   * to break the spitmaws' line. Collidable, so the squads bake cover off them
   * too — the same block serves both sides of the fight, which is the point.
   */
  private buildCover(): void {
    const rng = this.rng;
    /** forward, right, full-height. */
    const sites: Array<[number, number, boolean]> = [
      [30, -7, false], [34, 8, false], [40, -10, true], [45, 6, false],
      [50, -6, false], [55, 9, true], [60, -9, false], [66, 5, false],
      [70, -14, true], [74, 12, false], [78, -8, false], [82, 16, true],
      [86, -17, false], [90, 9, false], [94, -12, true], [98, 5, false],
      [102, -20, false], [106, 18, false],
    ];
    for (const [f, r, full] of sites) {
      const p = this.atSpawn(f + rng.range(-1.6, 1.6), r + rng.range(-1.6, 1.6), -0.45);
      if (this.slopeAt(p.x, p.z) > 0.6) continue;
      const h = full ? 2.7 + rng.range(-0.2, 0.5) : 1.2 + rng.range(-0.1, 0.3);
      const g = this.temp(
        revolved(
          [
            [full ? 1.9 : 2.4, 0],
            [full ? 1.5 : 2.1, h * 0.45],
            [full ? 1.6 : 2.2, h * 0.8],
            [full ? 1.0 : 1.7, h],
          ],
          9,
          0.22,
          rng,
        ),
      );
      (rng.bool(0.5) ? this.husk : this.chitin).addAt(
        g,
        p,
        rng.range(0, TAU),
        1,
        rng.range(-0.07, 0.07),
        rng.range(-0.07, 0.07),
      );
      // A resin skirt, so the block is grown into the floor.
      const skirt = this.temp(
        revolved([[3.4, 0], [2.9, 0.3], [2.2, 0.55], [1.8, 0.65]], 10, 0.2, rng),
      );
      this.resin.addAt(skirt, p.clone().setY(p.y - 0.15), rng.range(0, TAU));
      if (rng.next() < 0.4) this.veinRun(p, h * 0.9, 2);
    }
  }

  // -- depth: the near field -------------------------------------------------

  /**
   * The first twenty-five metres of nest floor: shell chips, husk fragments and
   * the chewed grit a colony leaves behind.
   */
  private buildNearField(): void {
    const rng = this.rng;
    const chip = [
      this.temp(tapered(0.52, 0.22, 0.38, 0.35, 0, 0.16, rng)),
      this.temp(prism(5, 0.26, 0.4, 0.5, rng)),
      this.temp(tapered(0.9, 0.16, 0.42, 0.3, 0, 0.22, rng)),
    ];
    const count = Math.round(220 * this.detail);
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const a = i * 2.399963;
      const d = 1.6 + Math.pow(t, 0.6) * 18;
      const p = this.atSpawn(Math.cos(a) * d, Math.sin(a) * d, -0.03);
      if (this.slopeAt(p.x, p.z) > 0.6) continue;
      this.grit.addAt(
        chip[i % chip.length],
        p,
        rng.range(0, TAU),
        rng.range(1.1, 2.8),
        rng.range(-0.4, 0.4),
        rng.range(-0.4, 0.4),
      );
    }

    // Broken egg shell — the same shape as a live clutch, opened. It says what
    // happened here without a word of text.
    const half = this.temp(
      revolved([[0.05, 0], [0.6, 0.32], [0.72, 0.85], [0.66, 1.15]], 10, 0.18, rng),
    );
    for (let i = 0; i < Math.round(26 * this.detail) + 10; i++) {
      const a = rng.range(0, TAU);
      const d = 3 + rng.next() * 14;
      const p = this.atSpawn(Math.cos(a) * d, Math.sin(a) * d, -0.25);
      this.shell.addAt(
        half,
        p,
        rng.range(0, TAU),
        rng.range(1.2, 2.6),
        rng.range(1.4, 2.6),
        rng.range(-0.6, 0.6),
      );
    }

    // Three larger husks close in, so the near field has real shapes as well as
    // texture — a bare ground plane with only gravel on it still reads bare.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + 0.6;
      const d = 4.5 + rng.next() * 6;
      const p = this.atSpawn(Math.cos(a) * d, Math.sin(a) * d, -0.4);
      if (this.slopeAt(p.x, p.z) > 0.6) continue;
      const g = this.temp(
        revolved([[1.7, 0], [1.4, 0.7], [1.5, 1.4], [0.7, 2.0]], 9, 0.24, rng),
      );
      this.husk.addAt(g, p, rng.range(0, TAU), 1, rng.range(0.8, 1.5), rng.range(-0.4, 0.4));
    }
  }

  /** The horizon: one great spire, two lesser, and a nest skyline behind them. */
  private buildSpires(): void {
    this.spire(this.atSpawn(182, 34), 96, 11.5);
    this.spire(this.atSpawn(224, -62), 71, 9);
    this.spire(this.atSpawn(258, 96), 62, 8);

    // A scatter of distant spires so the horizon is nest in every direction.
    // Placed on a ring beyond the play space; no collision, no shadows, low
    // segment counts — they are silhouette, and silhouette is all they need.
    const count = Math.round(9 * this.detail) + 3;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + this.rng.range(-0.2, 0.2);
      const r = 320 + this.rng.next() * 260;
      const x = this.spawnPos.x + Math.cos(a) * r;
      const z = this.spawnPos.z + Math.sin(a) * r;
      const p = new THREE.Vector3(x, this.groundAt(x, z) - 2, z);
      const h = 45 + this.rng.next() * 60;
      const g = this.temp(
        revolved(
          [
            [h * 0.13, 0],
            [h * 0.1, h * 0.3],
            [h * 0.065, h * 0.62],
            [h * 0.035, h * 0.85],
            [0.6, h],
          ],
          8,
          0.2,
          this.rng,
        ),
      );
      this.husk.addAt(g, p, this.rng.range(0, TAU), 1, this.rng.range(-0.05, 0.05), this.rng.range(-0.05, 0.05));
    }
  }

  /** Giant fungal forms — the only soft silhouette on a world of hard chitin. */
  private buildFlora(): void {
    const count = Math.round(14 * this.detail) + 6;
    for (let i = 0; i < count; i++) {
      // Golden-angle spread through the play space, biased away from the avenue
      // centre line so nothing grows in the middle of the shot.
      const t = (i + 0.5) / count;
      const a = i * 2.399963;
      const r = 18 + Math.sqrt(t) * 96;
      const forward = Math.cos(a) * r + 40;
      const right = Math.sin(a) * r * 1.15;
      if (Math.abs(right) < 9 && forward < 70) continue;
      const p = this.atSpawn(forward, right);
      if (this.slopeAt(p.x, p.z) > 0.6) continue;
      this.fungus(p, 3.5 + this.rng.next() * 9.5);
    }
  }

  // -- shape builders --------------------------------------------------------

  /** A yaw relative to the authored view heading. */
  private yawFrom(offset: number): number {
    return this.spawnYaw + offset;
  }

  /** A leaning chitin buttress: the level's structural workhorse. */
  private buttress(base: THREE.Vector3, yaw: number, height: number, radius: number): void {
    const g = this.temp(
      revolved(
        [
          [radius, 0],
          [radius * 0.82, height * 0.28],
          [radius * 0.6, height * 0.6],
          [radius * 0.42, height * 0.85],
          [radius * 0.2, height],
        ],
        10,
        0.2,
        this.rng,
      ),
    );
    this.chitin.addAt(g, base, yaw, 1, this.rng.range(0.04, 0.13), this.rng.range(-0.12, 0.12));
    // Root flares: three tapered wedges spreading into the ground so the base
    // does not read as a cylinder set on a plane.
    for (let i = 0; i < 3; i++) {
      const a = yaw + (i / 3) * TAU + this.rng.range(-0.3, 0.3);
      _tmp.set(base.x + Math.cos(a) * radius * 0.8, base.y + 0.1, base.z + Math.sin(a) * radius * 0.8);
      const flare = this.temp(
        tapered(radius * 0.9, height * 0.3, radius * 0.7, 0.65, radius * 0.35, 0.1, this.rng),
      );
      aim(_m, _tmp, _dir.set(Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5), a, 1);
      this.resin.add(flare, _m);
    }
  }

  /**
   * A tunnel mouth. A ring of inward-leaning teeth around a recessed cone, set
   * in a low mound — the cone is what makes it read as a hole; without it a
   * mouth is just a ring of spikes.
   */
  private tunnelMouth(centre: THREE.Vector3, yaw: number, radius: number, height: number): void {
    const facing = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    // The mound the mouth is set into.
    const mound = this.temp(
      revolved(
        [
          [radius * 2.4, 0],
          [radius * 2.1, height * 0.35],
          [radius * 1.6, height * 0.72],
          [radius * 1.25, height],
        ],
        12,
        0.18,
        this.rng,
      ),
    );
    this.chitin.addAt(mound, centre, this.rng.range(0, TAU), 1);

    // The gullet: a cone driven back into the mound, near-black and unlit.
    const gullet = this.temp(
      revolved(
        [
          [radius * 1.15, 0],
          [radius * 0.9, -2.2],
          [radius * 0.45, -5.0],
          [0.2, -8.5],
        ],
        10,
        0.1,
        this.rng,
      ),
    );
    _tmp.copy(centre).addScaledVector(facing, radius * 0.5).setY(centre.y + height * 0.55);
    aim(_m, _tmp, _dir.copy(facing).setY(0.55).normalize(), 0, 1);
    this.voidBatch.add(gullet, _m);

    // Teeth around the rim, leaning inward and varying in length.
    const teeth = 11;
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * TAU;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      // Ellipse in the plane facing `yaw`, tilted back so the mouth looks up.
      const side = new THREE.Vector3(-facing.z, 0, facing.x);
      _tmp
        .copy(centre)
        .addScaledVector(side, ux * radius * 1.15)
        .addScaledVector(facing, radius * 0.45 + uy * radius * 0.25)
        .setY(centre.y + height * 0.55 + uy * radius * 0.72);
      _dir
        .copy(side)
        .multiplyScalar(-ux * 0.7)
        .addScaledVector(facing, 0.55)
        .addScaledVector(_up, -uy * 0.55)
        .normalize();
      const len = 1.5 + this.rng.next() * 1.9;
      const tooth = this.temp(prism(5, 0.42, len, 0.55, this.rng));
      aim(_m, _tmp, _dir, this.rng.range(0, TAU), 1);
      this.shell.add(tooth, _m);
    }
    this.veinRun(centre, height * 1.1, 4);
  }

  /** A clutch of eggs, glowing from within. */
  private eggClutch(centre: THREE.Vector3, count: number): void {
    const shell = this.temp(
      revolved(
        [
          [0.05, 0],
          [0.62, 0.35],
          [0.78, 0.95],
          [0.6, 1.6],
          [0.28, 2.0],
          [0.05, 2.15],
        ],
        9,
        0.12,
        this.rng,
      ),
    );
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + this.rng.range(-0.4, 0.4);
      const r = this.rng.next() * 2.9;
      const x = centre.x + Math.cos(a) * r;
      const z = centre.z + Math.sin(a) * r;
      const y = this.groundAt(x, z) - 0.15;
      const scale = 0.7 + this.rng.next() * 0.85;
      _tmp.set(x, y, z);
      this.flesh.addAt(shell, _tmp, this.rng.range(0, TAU), scale, this.rng.range(-0.18, 0.18), this.rng.range(-0.18, 0.18));
      // The light inside. A smaller ovoid on the emissive material, so the egg
      // has a bright core seen through a lit shell rather than a glowing skin.
      if (this.rng.bool(0.75)) {
        _tmp.set(x, y + 0.5 * scale, z);
        const core = this.temp(
          revolved(
            [
              [0.04, 0],
              [0.34, 0.3],
              [0.4, 0.7],
              [0.22, 1.05],
              [0.03, 1.2],
            ],
            7,
            0.1,
            this.rng,
          ),
        );
        this.batch('clutch', this.clutchMat, { tile: 0, collide: false, castShadow: false }).addAt(
          core,
          _tmp,
          0,
          scale,
        );
      }
    }
    // Resin webbing tying the clutch to the ground.
    for (let i = 0; i < 5; i++) {
      const a = this.rng.range(0, TAU);
      const p0 = new THREE.Vector3(centre.x, centre.y + 1.6, centre.z);
      const p1 = new THREE.Vector3(
        centre.x + Math.cos(a) * 3.6,
        centre.y + 0.1,
        centre.z + Math.sin(a) * 3.6,
      );
      this.resin.add(this.temp(tube([p0, p0.clone().lerp(p1, 0.5).setY(centre.y + 1.1), p1], 0.12, 0.05, 4)));
    }
  }

  /** A giant fungal form: stalk, cap, and a ring of emissive gills beneath it. */
  private fungus(base: THREE.Vector3, height: number): void {
    const capR = height * (0.32 + this.rng.next() * 0.18);
    const lean = this.rng.range(-0.14, 0.14);
    const stalk = this.temp(
      revolved(
        [
          [height * 0.13, 0],
          [height * 0.085, height * 0.35],
          [height * 0.075, height * 0.7],
          [height * 0.1, height * 0.92],
        ],
        9,
        0.16,
        this.rng,
      ),
    );
    this.husk.addAt(stalk, base, this.rng.range(0, TAU), 1, lean, lean * 0.6);

    const cap = this.temp(
      revolved(
        [
          [0.1, 0],
          [capR * 0.55, -height * 0.06],
          [capR * 0.92, -height * 0.14],
          [capR, -height * 0.04],
          [capR * 0.86, height * 0.06],
          [capR * 0.4, height * 0.16],
          [0.1, height * 0.19],
        ],
        13,
        0.1,
        this.rng,
      ),
    );
    _tmp.set(
      base.x + Math.sin(lean) * height * 0.9,
      base.y + height * 0.92,
      base.z + Math.sin(lean * 0.6) * height * 0.9,
    );
    this.chitin.addAt(cap, _tmp, this.rng.range(0, TAU), 1, lean, lean * 0.6);

    // Gills. Emissive, but only a ring of them under the cap where the light
    // would actually be trapped — a fully emissive cap is the cardboard-cutout
    // failure this world already had to be rescued from.
    const gill = this.temp(
      revolved(
        [
          [capR * 0.35, 0],
          [capR * 0.8, -height * 0.03],
          [capR * 0.82, -height * 0.05],
          [capR * 0.36, -height * 0.02],
        ],
        12,
        0.05,
        this.rng,
      ),
    );
    _tmp.y -= height * 0.045;
    this.glowBatch.addAt(gill, _tmp, 0, 1, lean, lean * 0.6);

    // Spore light under the cap: one glow card, cheap, and it sells the volume.
    if (height > 6.5) {
      const card = this.temp(
        glowCross(capR * 1.5, height * 0.5, new THREE.Color(HIVE_AMBER).convertSRGBToLinear()),
      );
      _tmp.y -= height * 0.42;
      this.shafts.addAt(card, _tmp, this.rng.range(0, TAU), 1);
      this.ventPoints.push(_tmp.clone());
    }
  }

  /**
   * A hive spire.
   *
   * Grown, not built: a bulging revolved trunk whose profile swells and pinches
   * three times on the way up, lateral horns thrown off at the pinches, a crown
   * of spikes, and root buttresses spreading into the ground. The horns are what
   * make the silhouette readable as black shape from 180 m — a smooth taper at
   * that distance is a traffic cone.
   */
  private spire(base: THREE.Vector3, height: number, radius: number): void {
    const rings: Array<[number, number]> = [];
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Three swellings, decaying with height, over an exponential taper.
      const taper = Math.pow(1 - t, 0.78);
      const swell = 1 + Math.sin(t * Math.PI * 3.1) * 0.22 * (1 - t * 0.7);
      rings.push([Math.max(0.5, radius * taper * swell), t * height]);
    }
    rings.push([0.35, height * 1.04]);
    const trunk = this.temp(revolved(rings, 14, 0.09, this.rng));
    this.chitin.addAt(trunk, base, this.rng.range(0, TAU), 1, this.rng.range(-0.02, 0.02), this.rng.range(-0.02, 0.02));

    // Horns at the pinch points, sweeping up and out.
    const horns = 7;
    for (let i = 0; i < horns; i++) {
      const t = 0.22 + (i / horns) * 0.62;
      const a = i * 2.399963;
      const r = radius * Math.pow(1 - t, 0.78) * 0.9;
      _tmp.set(base.x + Math.cos(a) * r, base.y + t * height, base.z + Math.sin(a) * r);
      const len = height * (0.09 + this.rng.next() * 0.11);
      const horn = this.temp(
        revolved(
          [
            [len * 0.22, 0],
            [len * 0.16, len * 0.45],
            [len * 0.09, len * 0.8],
            [0.2, len],
          ],
          7,
          0.12,
          this.rng,
        ),
      );
      aim(_m, _tmp, _dir.set(Math.cos(a), 0.85 + this.rng.next() * 0.5, Math.sin(a)), 0, 1);
      this.shell.add(horn, _m);
    }

    // Crown: a ring of spikes around the tip.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + this.rng.range(-0.2, 0.2);
      _tmp.set(
        base.x + Math.cos(a) * radius * 0.16,
        base.y + height * 0.9,
        base.z + Math.sin(a) * radius * 0.16,
      );
      const spike = this.temp(prism(5, radius * 0.1, height * 0.13, 0.75, this.rng));
      aim(_m, _tmp, _dir.set(Math.cos(a) * 0.55, 1, Math.sin(a) * 0.55), 0, 1);
      this.chitin.add(spike, _m);
    }

    // Root buttresses, spreading into the ground so the tower has weight.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + this.rng.range(-0.25, 0.25);
      const outR = radius * (1.9 + this.rng.next() * 1.1);
      const x = base.x + Math.cos(a) * outR;
      const z = base.z + Math.sin(a) * outR;
      const foot = new THREE.Vector3(x, this.groundAt(x, z), z);
      const top = new THREE.Vector3(
        base.x + Math.cos(a) * radius * 0.75,
        base.y + height * 0.3,
        base.z + Math.sin(a) * radius * 0.75,
      );
      const mid = foot.clone().lerp(top, 0.55);
      mid.y -= height * 0.05;
      this.resin.add(this.temp(tube([foot, mid, top], radius * 0.34, radius * 0.12, 6)));
    }

    this.veinRun(base, height * 0.75, 6);

    // Mouths in the flank, high up: the spire is inhabited, and at this distance
    // a dark opening is the cheapest way to say so.
    for (let i = 0; i < 3; i++) {
      const a = this.rng.range(0, TAU);
      const t = 0.3 + this.rng.next() * 0.4;
      const r = radius * Math.pow(1 - t, 0.78);
      _tmp.set(base.x + Math.cos(a) * r * 0.9, base.y + t * height, base.z + Math.sin(a) * r * 0.9);
      const hole = this.temp(
        revolved(
          [
            [radius * 0.26, 0],
            [radius * 0.2, -radius * 0.4],
            [0.15, -radius * 0.9],
          ],
          8,
          0.1,
          this.rng,
        ),
      );
      aim(_m, _tmp, _dir.set(Math.cos(a), 0.25, Math.sin(a)), 0, 1);
      this.voidBatch.add(hole, _m);
    }
  }

  /** A run of emissive resin veins up a structure. */
  private veinRun(base: THREE.Vector3, height: number, strands: number): void {
    for (let i = 0; i < strands; i++) {
      const a = this.rng.range(0, TAU);
      const pts: THREE.Vector3[] = [];
      const steps = 5;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const wob = Math.sin(t * 5 + a) * 0.45;
        pts.push(
          new THREE.Vector3(
            base.x + Math.cos(a) * (1.2 + wob) * (1 - t * 0.6),
            base.y + t * height,
            base.z + Math.sin(a) * (1.2 + wob) * (1 - t * 0.6),
          ),
        );
      }
      this.glowBatch.add(this.temp(tube(pts, 0.11, 0.04, 4)));
    }
  }

  /**
   * Airborne spores.
   *
   * `VfxSystem.ambientDust` already gives fine particulate; this is the coarse
   * layer on top — slow, glowing motes that drift upward and read as *alive*.
   * One draw call, wrapped in a box that rides with the camera, so no particle
   * is ever respawned on the CPU.
   */
  private buildSpores(): void {
    const count = Math.round(520 * this.detail);
    const extent = 46;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = this.rng.range(-extent, extent);
      pos[i * 3 + 1] = this.rng.range(-extent, extent);
      pos[i * 3 + 2] = this.rng.range(-extent, extent);
      seed[i] = this.rng.next();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.extraGeometry.push(geo);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(HIVE_PALE).convertSRGBToLinear() },
        uCentre: { value: new THREE.Vector3() },
        uExtent: { value: extent },
        uTime: { value: 0 },
        uStrength: { value: 0.5 },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        varying float vFade;
        varying float vSeed;
        uniform vec3 uCentre;
        uniform float uExtent;
        uniform float uTime;
        void main(){
          // Drift: up, with a lazy lateral wander. Folded into the box that
          // rides with the camera, so the field is endless for free.
          vec3 p = position;
          p.y += uTime * (0.25 + aSeed * 0.5);
          p.x += sin(uTime * 0.21 + aSeed * 43.0) * 1.8;
          p.z += cos(uTime * 0.17 + aSeed * 27.0) * 1.8;
          p = mod(p - uCentre + uExtent, uExtent * 2.0) - uExtent;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = length(mv.xyz);
          vFade = smoothstep(1.2, 5.0, d) * (1.0 - smoothstep(uExtent * 0.45, uExtent, d));
          vSeed = aSeed;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp((2.0 + aSeed * 5.0) * 30.0 / max(d, 1.0), 1.0, 9.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vFade;
        varying float vSeed;
        uniform vec3 uColor;
        uniform float uStrength;
        uniform float uTime;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.04, length(d));
          float flicker = 0.72 + 0.28 * sin(uTime * (1.1 + vSeed * 2.6) + vSeed * 31.0);
          gl_FragColor = vec4(uColor * a * vFade * flicker * uStrength, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.sporeMat = this.own(mat);
    this.spores = new THREE.Points(geo, mat);
    this.spores.frustumCulled = false;
    this.spores.renderOrder = 6;
    this.props.add(this.spores);
  }

  // -- mission ---------------------------------------------------------------

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
      { id: 'hive.mouth.left', forward: 100, right: -26, radius: 24, minPlayerDistance: 6 },
      { id: 'hive.mouth.centre', forward: 102, right: 4, radius: 24, minPlayerDistance: 6 },
      { id: 'hive.mouth.right', forward: 98, right: 30, radius: 24, minPlayerDistance: 6 },
      // The avenue itself, so the defensive stand at its mouth is pressed from
      // up the canyon and not only from the flanks.
      { id: 'hive.avenue', forward: 56, right: -6, radius: 16, minPlayerDistance: 12 },
      { id: 'hive.avenue.left', forward: 44, right: -24, radius: 14, minPlayerDistance: 12 },
      { id: 'hive.avenue.right', forward: 46, right: 24, radius: 14, minPlayerDistance: 12 },
      // Behind the player: the nest does not respect a front line.
      { id: 'hive.flank', forward: -26, right: 18, radius: 16, minPlayerDistance: 16 },
    ];
  }

  /**
   * Chapter 4 — **The Count**.
   *
   * The one chapter whose objective verbs were nearly honest already, made
   * literal. The first wave is a sixty-second `hold` at the avenue mouth inside
   * twenty metres — the game's defensive set piece, which is why the redoubt
   * exists and why the count arrives from up the canyon and from behind at the
   * same time. The second is an arrival at the arena floor rather than a kill
   * quota that could be filled without moving. The third is the clutch.
   *
   * And the Hivelord finally turns up. The Broodmother that used to close this
   * world at 1100 HP stays in the last wave as an elite.
   */
  protected encounterScript(): EncounterScript {
    return {
      id: 'hive-prime.brood',
      title: 'The Count',
      completesLevel: true,
      score: 4200,
      waves: [
        {
          delay: 4,
          triggerFraction: 0,
          objective: 'Hold the avenue mouth',
          trigger: { kind: 'hold', position: this.avenueMouth, radius: 20, seconds: 60 },
          units: [
            { archetype: 'insect_swarmling', count: 14 },
            { archetype: 'insect_soldier', count: 5 },
            { archetype: 'insect_spitmaw', count: 2 },
          ],
          volumes: ['hive.avenue', 'hive.avenue.left', 'hive.avenue.right', 'hive.flank'],
        },
        {
          delay: 3,
          triggerFraction: 0.5,
          objective: 'Push to the brood arena',
          trigger: { kind: 'reach', position: this.arenaCentre, radius: 16 },
          units: [
            { archetype: 'insect_soldier', count: 4 },
            { archetype: 'insect_spitmaw', count: 2 },
            { archetype: 'insect_swarmling', count: 6 },
          ],
          volumes: ['hive.mouth.centre', 'hive.mouth.left', 'hive.mouth.right'],
        },
        {
          delay: 2.5,
          triggerFraction: 0.7,
          objective: 'Break the clutch',
          units: [
            { archetype: 'insect_ravager', count: 2 },
            { archetype: 'insect_broodmother', count: 1 },
            { archetype: 'insect_spitmaw', count: 2 },
            { archetype: 'insect_swarmling', count: 10 },
          ],
          volumes: ['hive.mouth.centre', 'hive.mouth.left', 'hive.mouth.right'],
        },
      ],
      boss: { archetype: 'insect_hivelord', count: 1 },
      bossObjective: 'Kill the Hivelord',
      bossDelay: 5,
    };
  }

  // -- frame -----------------------------------------------------------------

  protected override tick(ctx: FrameContext): void {
    const t = ctx.elapsed;

    // The nest breathes. A slow, shared pulse across every emissive in the
    // level, offset between the veins and the clutches so they never beat in
    // lockstep, which is what would make it read as a flashing light.
    this.veinMat.emissiveIntensity = 2.6 + Math.sin(t * 0.55) * 0.4;
    this.clutchMat.emissiveIntensity = 3.8 + Math.sin(t * 0.8 + 1.7) * 0.8;
    for (let i = 0; i < this.clutchLights.length; i++) {
      this.clutchLights[i].intensity = 8.4 + Math.sin(t * 0.8 + i * 2.1) * 1.8;
    }
    this.shaftMat.opacity = 0.19 + Math.sin(t * 0.31) * 0.05;

    if (this.sporeMat) {
      this.sporeMat.uniforms.uTime.value = t;
      (this.sporeMat.uniforms.uCentre.value as THREE.Vector3).copy(this.camPos);
      if (this.spores) this.spores.position.copy(this.camPos);
    }

    // Spore bursts from the vents, on a slow rota. Only ever the nearest few
    // matter, so the emitter is cursored rather than iterated.
    this.ventTimer -= ctx.dt;
    if (this.ventTimer <= 0 && this.ventPoints.length > 0) {
      this.ventTimer = 1.4;
      this.ventCursor = (this.ventCursor + 1) % this.ventPoints.length;
      const p = this.ventPoints[this.ventCursor];
      if (p.distanceToSquared(this.camPos) < 90 * 90) {
        this.vfx.impact(p, _up, 'organic', 0.55 + clamp01(this.rng.next()) * 0.5);
      }
    }
  }

  override dispose(): void {
    for (const l of this.clutchLights) l.dispose();
    this.clutchLights.length = 0;
    for (const g of this.extraGeometry) g.dispose();
    this.extraGeometry.length = 0;
    this.spores = null;
    this.sporeMat = null;
    super.dispose();
  }
}

registerPlanet(
  'hive-prime',
  (deps: PlanetDeps, descriptor: PlanetDescriptor) => new HivePrimeLevel(deps, descriptor),
);
