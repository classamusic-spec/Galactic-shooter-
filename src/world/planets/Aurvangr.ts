/**
 * Aurvangr — the Frozen Marches.
 *
 * A glacier shelf under a sun that never climbs past six degrees. Everything in
 * the art direction follows from that single fact: the key light rakes, so every
 * vertical surface gets a bright windward face and a twenty-metre shadow, and
 * the whole composition is built to put those shadows *across* the frame rather
 * than behind the geometry.
 *
 * The shot the level is designed around: the player lands on a shelf looking
 * away from the sun (the aurora is additive and simply disappears against the
 * bright twilight aureole, so the spawn heading is scored to face away from it),
 * with a fallen frost-iron column framing the left edge and a serac wall the
 * right, a processional avenue of rune-carved pillars leading into the ruined
 * Jötunn hall, and the Great Gate standing on the horizon a hundred and sixty
 * metres out as the one unmistakable landmark.
 *
 * Registers itself with the planet registry on import.
 */
import * as THREE from 'three';
import type { FrameContext, PlanetDescriptor } from '@/types';
import type { EncounterScript } from '@/gameplay/ai/EncounterDirector';
import { cloneAtmosphere, ATMOSPHERES, type AtmosphereProfile } from '@/gfx/sky/AtmosphereProfile';
import { terrainRecipe } from '@/gfx/terrain/TerrainBuilder';
import type { TerrainDescriptor } from '@/gfx/terrain/HeightField';
import { clamp, TAU } from '@/util/math';
import { settings } from '@/core/Settings';
import {
  PlanetLevel,
  cloneRecipe,
  prism,
  revolved,
  tapered,
  tube,
  type PropBatch,
  type SpawnVolumeSpec,
} from './PlanetLevel';
import { registerPlanet, type PlanetDeps } from './index';
// Sibling worlds, imported for their registration side effect: pulling in any
// one planet module makes every planet this owner ships available to the star
// map, which is what the code-split registry in `index.ts` is for.
import './ZetaReticuli';
import './Khepri';

/**
 * Nordic rune light. The faction identity colour (0x9fd8ff) is only a few
 * percent off white, so through bloom every glyph clipped to a flat white bar
 * and the hall read as a lit office block. This is the same hue with the
 * saturation it needs to survive the bloom pass and still read as *blue*.
 */
const RUNE_BLUE = 0x2f93e6;

const _pos = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** A rune light waiting to be built, in descending order of how much it matters. */
interface RuneLightSpot {
  position: THREE.Vector3;
  intensity: number;
  range: number;
  /** Higher survives a lower tier's budget. */
  priority: number;
}

class AurvangrLevel extends PlanetLevel {
  private iron!: PropBatch;
  private stone!: PropBatch;
  private ice!: PropBatch;
  private snow!: PropBatch;
  private dark!: PropBatch;
  private rune!: PropBatch;
  /** Near-field grit: chips, pebbles, scuff. Never collides — it is dressing. */
  private grit!: PropBatch;

  /**
   * Real lights for the rune glyphs.
   *
   * An emissive material makes a surface *bright*; it does not make it a light
   * source. Before these, every rune band on this world was a hard-edged flat
   * rectangle with no falloff on the iron around it and no pool on the snow
   * below it, which is exactly how tape reads. Draco IX and Hive Prime already
   * back their emissives with point lights; this is the same pattern.
   */
  private readonly runeLights: THREE.PointLight[] = [];
  private readonly runeBase: number[] = [];
  private readonly runeSpots: RuneLightSpot[] = [];

  /** The rune stone on the dais — chapter one's destructible objective. */
  private readonly runeStonePos = new THREE.Vector3();
  /** Far end of the processional avenue: the first objective's arrival point. */
  private readonly avenueEnd = new THREE.Vector3();

  /** Crest points where spindrift is thrown off the drifts. */
  private readonly drifts: THREE.Vector3[] = [];
  private spindriftTimer = 0;
  private driftCursor = 0;

  constructor(deps: PlanetDeps, descriptor: PlanetDescriptor) {
    super(deps, descriptor, {
      navRadius: 124,
      // Additive aurora against a bright sky is invisible; the long shadows also
      // only read when they come toward the camera. Both want the sun behind us.
      // Side-lit, not back-lit. `away` scores a heading highest when it points
      // directly opposite the sun, which is the one arrangement where no shadow
      // can ever be seen: a 6.5 degree sun throws a 38 m monolith's shadow 330 m
      // *behind* the caster, past the readable ground. The lighting was correct
      // and the composition was hiding it. `across` rakes the same shadows over
      // the frame, and the aurora — the reason `away` was chosen — sits opposite
      // the sun rather than opposite the camera, so it still reads.
      spawnFacing: 'across',
      spawnSearchRadius: 105,
      dust: { density: 0.6, color: 0xd8e9ff, size: 0.05 },
    });
  }

  protected override atmosphere(): AtmosphereProfile {
    const a = cloneAtmosphere(ATMOSPHERES.aurvangr);
    // A six-degree sun throws shadows several times longer than the default
    // frustum is wide; without this the hall's own shadow is clipped mid-floor.
    a.shadowExtent = 190;
    a.auroraStrength = 1.35;
    // Measured: the scattering integral hands the DirectionalLight only 0.77
    // units at this sun elevation — six degrees of atmosphere eats most of it —
    // and the default hemisphere fill is 0.39, which put every vertical face in
    // the level at pure black. Snow has an albedo near 0.85 and a glacier shelf
    // is a gigantic reflector, so a strong cold fill is the physically honest
    // answer as well as the one the frame needs.
    a.ambientIntensity = 0.95;
    return a;
  }

  protected override recipe(): TerrainDescriptor {
    const d = cloneRecipe(terrainRecipe('aurvangr'));
    // Open review defect: the macro silhouette reads as dunes rather than
    // mountains. Deepen the valleys and take some smoothing out of the erosion
    // so the ridge line has corners in it.
    d.ridgePower = 2.55;
    d.erosion = 0.92;
    // The level is set *on a glacier shelf*, and the recipe's landing basin is
    // the only thing in the height field that can make one. At 52 m it is barely
    // a clearing; the composition needs a couple of hundred metres of standable
    // ground with the peaks ringing it, which is also the shot the world is for.
    d.flattenRadius = 250;
    // Above the ice layer's 46 m height window on purpose: at 6 m the shelf came
    // out as exposed glacier, whose 16 m tile reads as a marbled swirl under
    // foot. Wind-packed snow is the right surface for a shelf and gives the
    // props a bright plane to be dark against.
    d.flattenHeight = 52;
    // A glacier shelf does not grow grass. The stock recipe scatters a dark
    // tussock at 0.55 density which, on a bright snow plane, reads as a field of
    // black specks; the ice-crystal growths take over its job.
    for (const e of d.flora.entries) {
      if (e.kind === 'crystal') {
        // More of them, but small: at the stock 1.15 max scale the scatter threw
        // four-metre shards that read as flat paper cut-outs at mid distance.
        e.density *= 3.4;
        e.maxScale = 0.4;
        e.minScale = 0.12;
      } else {
        e.density = 0;
      }
    }
    // The shelf was coming out a muddy tan: the base rock tint bleeds through
    // the snow overlay, and neither was cold enough for a world lit by a blue
    // sun. Both go colder and lighter so the ground is the frame's bright value.
    d.layers[0].tint = 0x8f9aa8;
    d.layers[0].desaturate = 0.9;
    d.layers[1].tint = 0xe4eef8;
    d.layers[1].desaturate = 0.96;
    // Less breakup so the snow actually covers, instead of leaving the warm
    // base rock showing through in streaks that read as mud on an ice world.
    d.layers[1].breakup = 0.45;
    return d;
  }

  // -- construction ----------------------------------------------------------

  protected decorate(): void {
    this.iron = this.batch(
      'iron',
      // Metalness stays well under 1: a mirror metal on a world whose sky
      // integrates to almost nothing reflects nothing and renders black. Frost-
      // bound iron keeps a diffuse component and reads as metal anyway.
      this.surface('nordicIronwork', {
        repeat: 1,
        color: 0x93a6b8,
        roughness: 0.62,
        metalness: 0.45,
        envMapIntensity: 1.5,
      }),
      { tile: 1.5, collide: true, surface: 'metal' },
    );
    this.stone = this.batch(
      'stone',
      this.surface('rock', { repeat: 1, color: 0xb7c4d2, roughness: 0.92 }),
      { tile: 3.2, collide: true, surface: 'rock' },
    );
    this.ice = this.batch(
      'ice',
      this.surface('ice', { repeat: 1, color: 0xb6d8ec, roughness: 0.22, envMapIntensity: 1.6 }),
      { tile: 2.8, collide: true, surface: 'ice' },
    );
    this.snow = this.batch(
      'snow',
      this.surface('sand', { repeat: 1, color: 0xdfeaf6, roughness: 1, normalScale: 0.7 }),
      { tile: 5.5, collide: false, surface: 'ice' },
    );
    // The inside of a crevasse. Near-black, so the gap reads as depth rather
    // than as a painted line on the shelf.
    this.dark = this.batch(
      'crevasse',
      this.surface('obsidian', { repeat: 1, color: 0x1b2b3a, roughness: 0.35 }),
      { tile: 3, collide: true, surface: 'ice', castShadow: false },
    );
    // Kept deliberately dim: at 2.4 the glyph bands bloomed to flat white and
    // the hall read as a lit office block. Runes are cut lines that hold light,
    // not windows.
    // The near field was empty: no pebble, no chip, no scuff inside ten metres in
    // any frame, which is the single loudest "this is a camera in a clearing"
    // tell there is. Its own batch because none of the others may collide with
    // a two-centimetre stone chip.
    this.grit = this.batch(
      'grit',
      // Dark, because the shelf is the brightest value in the level: a chip the
      // same value as the snow it lies on is noise, not detail.
      this.surface('rock', { repeat: 1, color: 0x5d6773, roughness: 0.95 }),
      // `castShadow` is on, and it is the reason any of this reads. Captures of
      // the first attempt showed a bare ground plane with the scatter provably
      // present in it: a 20 cm stone lit from the same direction as the ground
      // it lies on has no edge until it drops a contact shadow. One merged mesh,
      // so the whole near field costs one extra shadow draw.
      { tile: 0.9, collide: false, surface: 'rock', castShadow: true },
    );
    this.rune = this.batch('rune', this.glow(RUNE_BLUE, 1.1), {
      tile: 0,
      collide: false,
      castShadow: false,
      receiveShadow: false,
    });

    this.buildGreatGate(120);
    this.buildHall(38, 96, 14);
    this.buildAvenue(15, 36);
    this.buildProcessional();
    this.buildBastion();
    this.buildNaveRoof(52, 84, 9.4);
    this.buildCover();
    this.buildForeground();
    this.buildNearField();
    this.buildCrevasses();
    this.buildDrifts();
    this.buildCrystalFields();
    this.installRuneLights();
  }

  /**
   * Turn the collected rune positions into real point lights, up to the tier's
   * budget.
   *
   * Every added light lengthens the forward light loop in *every* lit shader in
   * the scene, so this is a real per-pixel cost and not a free one — hence a
   * budget taken from `settings.profile` rather than a fixed count, and hence
   * `runeSpots` being pushed in descending order of importance so a low tier
   * loses the least valuable ones rather than an arbitrary set.
   */
  private installRuneLights(): void {
    const budget = Math.round(clamp(settings.profile.terrainDetail * 6, 2, 8));
    this.runeSpots.sort((a, b) => b.priority - a.priority);
    for (let i = 0; i < Math.min(budget, this.runeSpots.length); i++) {
      const spot = this.runeSpots[i];
      const light = new THREE.PointLight(RUNE_BLUE, spot.intensity, spot.range, 2);
      light.position.copy(spot.position);
      // Nothing in this level is close enough to a rune for a shadow-casting
      // point light to earn its six cube faces.
      light.castShadow = false;
      this.props.add(light);
      this.runeLights.push(light);
      this.runeBase.push(spot.intensity);
    }
    this.runeSpots.length = 0;
  }

  /** Queue a rune light; `priority` decides which survive a low tier. */
  private queueRuneLight(
    position: THREE.Vector3,
    intensity: number,
    range: number,
    priority: number,
  ): void {
    this.runeSpots.push({ position: position.clone(), intensity, range, priority });
  }

  // -- the landmark ----------------------------------------------------------

  /**
   * The Great Gate: two canted monoliths and a snapped lintel, standing clear of
   * everything else on the horizon. Deliberately over-scaled — at 160 m a 30 m
   * silhouette subtends about ten degrees, which is what makes it read as a
   * landmark rather than as another rock.
   */
  private buildGreatGate(forward: number): void {
    const rng = this.rng;
    const legGeo = this.temp(tapered(8.6, 38, 7.4, 0.3, 1.3, 0.32, rng));
    const legGeoB = this.temp(tapered(8.2, 35, 7.2, 0.28, -1.1, 0.32, rng));
    const left = this.atSpawn(forward, -15);
    const right = this.atSpawn(forward, 15);
    const yaw = this.spawnYaw;

    this.iron.addAt(legGeo, left, yaw + 0.05, 1, 0, 0.028);
    this.iron.addAt(legGeoB, right, yaw - 0.04, 1, 0, -0.021);

    // Stone footings, so the iron does not appear to grow out of the snow.
    const foot = this.temp(tapered(12.5, 3.8, 11.5, 0.22, 0, 0.4, rng));
    this.stone.addAt(foot, left.clone().setY(left.y - 0.4), yaw + 0.05);
    this.stone.addAt(foot, right.clone().setY(right.y - 0.4), yaw - 0.04);

    // The lintel: snapped, so the gate silhouette has a broken tooth in it.
    const topY = Math.max(left.y, right.y) + 34.6;
    const spanA = this.temp(tapered(20, 5.4, 8.2, 0.08, 0, 0.28, rng));
    const spanB = this.temp(tapered(9, 5, 8, 0.14, 0, 0.34, rng));
    const mid = this.atSpawn(forward, -6);
    this.iron.addAt(spanA, mid.clone().setY(topY), yaw, 1, 0, 0.012);
    const stub = this.atSpawn(forward, 15.8);
    this.iron.addAt(spanB, stub.clone().setY(topY - 0.6), yaw, 1, 0, -0.13);

    // A fallen chunk of the lintel in the snow beneath the gap — the story of
    // the broken tooth, and a mid-ground shadow catcher.
    const chunk = this.temp(tapered(6.5, 4, 6.8, 0.2, 0, 0.5, rng));
    const chunkPos = this.atSpawn(forward - 7, 4.5, 0.4);
    this.iron.addAt(chunk, chunkPos, yaw + 0.7, 1, 0.42, 0.22);

    for (const leg of [left, right]) {
      for (let i = 0; i < 4; i++) {
        this.runeBand(leg, 4.3 - i * 0.2, leg.y + 7 + i * 7.4, 6, yaw, 0.26);
      }
      // One light per leg, sat at the second band. Range covers the leg's own
      // iron and lays a pool on the snow at its foot — the two things the flat
      // emissive rectangles could not do.
      this.queueRuneLight(leg.clone().setY(leg.y + 14), 26, 30, 90);
    }
    this.runeBand(mid.clone().setY(topY + 2.6), 6.4, topY + 2.6, 8, yaw, 0.3);
    this.queueRuneLight(mid.clone().setY(topY + 1.5), 22, 26, 40);

    // Gable wall behind, half-buried: gives the gate something to be a gate
    // *into* rather than a freestanding arch on an empty plain.
    for (let i = 0; i < 9; i++) {
      const f = forward + 14 + rng.range(-3, 3);
      const r = -26 + i * 6.5 + rng.range(-1.6, 1.6);
      const h = 6 + Math.max(0, 13 - Math.abs(r) * 0.55) + rng.range(-1.5, 3.5);
      const p = this.atSpawn(f, r, -1.2);
      const blk = this.temp(tapered(7.4, h, 5.4, 0.18, rng.range(-0.5, 0.5), 0.4, rng));
      this.stone.addAt(blk, p, yaw + rng.range(-0.12, 0.12), 1, 0, rng.range(-0.03, 0.03));
    }
  }

  // -- the hall --------------------------------------------------------------

  /**
   * The ruined Jötunn hall. Two ruined block walls draped over the terrain, an
   * interior colonnade of rune-carved iron pillars, collapsed roof beams thrown
   * across the nave as diagonals, and a rune stone on the dais at the far end as
   * the focal point the avenue and the walls both point at.
   */
  private buildHall(near: number, far: number, halfWidth: number): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    const courseGeo = [
      this.temp(tapered(4.2, 2.3, 3.1, 0.08, 0, 0.16, rng)),
      this.temp(tapered(3.6, 2.1, 3.0, 0.1, 0, 0.2, rng)),
      this.temp(tapered(4.6, 2.5, 3.2, 0.06, 0, 0.14, rng)),
    ];

    // -- walls, one block at a time so the ruin follows the ground ----------
    for (const side of [-1, 1]) {
      let f = near;
      while (f < far) {
        const step = 3.9 + rng.range(-0.3, 0.3);
        // Ruined: whole stretches are simply gone.
        const gap = rng.next() < 0.16;
        if (!gap) {
          const t = (f - near) / (far - near);
          // Higher near the dais, torn down near the entrance.
          const courses = Math.max(1, Math.round(1.4 + t * 3.2 + rng.range(-0.9, 0.9)));
          const r = side * (halfWidth + rng.range(-0.35, 0.35));
          const base = this.atSpawn(f, r, -0.5);
          for (let c = 0; c < courses; c++) {
            const g = courseGeo[(c + (f | 0)) % courseGeo.length];
            _pos.set(base.x, base.y + c * 2.1, base.z);
            this.stone.addAt(
              g,
              _pos.clone(),
              yaw + rng.range(-0.06, 0.06),
              1,
              rng.range(-0.012, 0.012),
              rng.range(-0.02, 0.02),
            );
          }
          // Fallen blocks at the foot of the wall.
          if (rng.next() < 0.3) {
            const p = this.atSpawn(f + rng.range(-1.5, 1.5), r - side * rng.range(2.2, 5), 0.25);
            this.stone.addAt(
              courseGeo[0],
              p,
              yaw + rng.range(0, TAU),
              0.85,
              rng.range(0.3, 1.3),
              rng.range(-0.5, 0.5),
            );
          }
        }
        f += step;
      }
    }

    // -- interior colonnade --------------------------------------------------
    const pillarGeo = this.temp(tapered(2.5, 11.5, 2.5, 0.24, 0, 0.12, rng));
    const brokenGeo = this.temp(tapered(2.6, 6.2, 2.6, 0.16, 0, 0.5, rng));
    for (let i = 0; i < 8; i++) {
      const f = near + 7 + i * ((far - near - 12) / 7);
      for (const side of [-1, 1]) {
        const r = side * 8.2;
        const p = this.atSpawn(f, r, -0.3);
        const roll = rng.next();
        if (roll < 0.2) {
          // Toppled: a long horizontal shape among verticals, and a shadow that
          // runs across the nave instead of down it.
          const dir = yaw + side * 1.35 + rng.range(-0.3, 0.3);
          this.iron.addAt(pillarGeo, p.clone().setY(p.y + 1.2), dir, 1, Math.PI / 2 - 0.06, 0);
        } else if (roll < 0.42) {
          this.iron.addAt(brokenGeo, p, yaw + rng.range(-0.1, 0.1), 1, 0, rng.range(-0.05, 0.05));
          if (rng.next() < 0.5) this.runeBand(p, 1.15, p.y + 2.4, 4, yaw);
        } else {
          this.iron.addAt(pillarGeo, p, yaw + rng.range(-0.06, 0.06));
          // One band per column, and only on some of them: a glyph on every
          // face of every pillar is a light show, not a carved inscription.
          if (rng.next() < 0.55) this.runeBand(p, 1.25, p.y + 3.1, 4, yaw);
          // Capital: a wider block so the colonnade has a top line.
          const cap = this.temp(tapered(3.4, 1.5, 3.4, -0.12, 0, 0.1, rng));
          this.iron.addAt(cap, p.clone().setY(p.y + 11.2), yaw);
        }
      }
    }

    // -- collapsed roof beams ------------------------------------------------
    for (let i = 0; i < 5; i++) {
      const f = near + 12 + i * 22 + rng.range(-4, 4);
      const side = i % 2 === 0 ? -1 : 1;
      const a = this.atSpawn(f, side * (halfWidth - 0.5), 6.5 + rng.range(0, 3));
      const b = this.atSpawn(f + rng.range(-5, 5), -side * rng.range(1, 6), 0.5);
      const beam = this.temp(
        tube(
          [a, a.clone().lerp(b, 0.35), a.clone().lerp(b, 0.7), b],
          rng.range(0.5, 0.8),
          rng.range(0.35, 0.55),
          6,
        ),
      );
      this.iron.add(beam);
    }

    // -- the dais and the rune stone ----------------------------------------
    const daisCentre = this.atSpawn(far + 4, 0);
    const daisY = this.padHeight(daisCentre, 9, 11);
    for (let step = 0; step < 3; step++) {
      const w = 17 - step * 3.4;
      const slab = this.temp(tapered(w, 0.85, w * 0.72, 0.03, 0, 0.1, this.rng));
      this.stone.addAt(
        slab,
        new THREE.Vector3(daisCentre.x, daisY - 1.2 + step * 0.8, daisCentre.z),
        yaw,
      );
    }
    const stoneGeo = this.temp(tapered(3.6, 9.4, 1.5, 0.22, 0.35, 0.2, rng));
    const stonePos = new THREE.Vector3(daisCentre.x, daisY + 1.2, daisCentre.z);
    this.stone.addAt(stoneGeo, stonePos, yaw, 1, 0, 0.02);
    // A tall carved rune column on the face of the stone: the brightest thing in
    // the frame, at the vanishing point of the avenue.
    const glyph = this.temp(new THREE.BoxGeometry(0.34, 5.6, 0.16));
    for (let i = 0; i < 3; i++) {
      const gx = (i - 1) * 0.95;
      const p = new THREE.Vector3(
        stonePos.x - this.viewForward.x * 0.82 + this.viewRight.x * gx,
        daisY + 4.4,
        stonePos.z - this.viewForward.z * 0.82 + this.viewRight.z * gx,
      );
      this.rune.addAt(glyph, p, yaw);
    }
    // The campaign's first destructible objective. It has to be a real
    // `Damageable` with a hit proxy, not a decorated mesh: the batch it is drawn
    // in is static merged geometry and carries no target, so without this the
    // "destroy the rune stone" line would be a verb the code cannot check —
    // exactly the failure docs/MISSIONS.md exists to stop.
    this.runeStonePos.set(stonePos.x, daisY + 4.4, stonePos.z);
    // The proxy is deliberately a little larger than the stone it stands for.
    // `raycastAll` takes the world hit first and only prefers a proxy that is
    // *nearer*, so a capsule tucked inside its own mesh is unshootable — the
    // round stops on the collidable batch geometry and reports rock.
    this.destructible('aur.runestone', this.runeStonePos, 3200, {
      radius: 2.8,
      halfHeight: 4.2,
      surface: 'rock',
      onDestroyed: (prop) => this.breakDestructible(prop, 8),
    });

    // The rune stone is the vanishing point of the avenue and the brightest
    // thing in the frame; it should be throwing light onto the dais it stands
    // on and the wall behind it, not sitting on them like a decal.
    this.queueRuneLight(new THREE.Vector3(stonePos.x, daisY + 4.4, stonePos.z), 20, 22, 80);
    // Braziers flanking the dais: two more emissive points, and they light the
    // stone from below the way a hall would have been lit.
    for (const side of [-1, 1]) {
      const p = this.atSpawn(far + 1, side * 7.5, 0);
      const bowl = this.temp(
        revolved(
          [
            [0.55, 0],
            [0.35, 0.9],
            [0.75, 1.8],
            [1.15, 2.5],
            [1.0, 2.72],
          ],
          9,
          0.06,
          rng,
        ),
      );
      this.iron.addAt(bowl, p, yaw);
      const fire = this.temp(new THREE.IcosahedronGeometry(0.85, 1));
      this.rune.addAt(fire, p.clone().setY(p.y + 2.85), yaw, new THREE.Vector3(1, 1.4, 1));
      // A brazier is a fire in a bowl. If it does not light the bowl and the
      // floor under it, it is a lamp painted on a wall.
      this.queueRuneLight(p.clone().setY(p.y + 2.9), 16, 18, 60);
    }
  }

  // -- the avenue ------------------------------------------------------------

  /** Paired standing stones between the spawn and the hall: the leading line. */
  private buildAvenue(from: number, to: number): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    const count = 6;
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const f = from + (to - from) * t;
      // The pair converges slightly as it recedes, which exaggerates the
      // perspective and drags the eye toward the gate.
      const r = 5.8 - t * 1.1;
      for (const side of [-1, 1]) {
        const p = this.atSpawn(f, side * r, -0.35);
        const h = 8.4 + rng.range(-1.4, 3.0) - t * 1.2;
        const g = this.temp(tapered(2.4, h, 1.9, 0.26, rng.range(-0.25, 0.25), 0.16, rng));
        const lean = rng.range(-0.07, 0.07);
        this.stone.addAt(g, p, yaw + rng.range(-0.15, 0.15), 1, lean, rng.range(-0.06, 0.06));
        if (rng.next() < 0.45) this.runeBand(p, 1.3, p.y + h * 0.62, 4, yaw, 0.2);
        // Snow packed against the windward foot.
        const drift = this.temp(
          revolved(
            [
              [2.2, 0],
              [1.9, 0.35],
              [1.0, 0.75],
              [0.2, 0.95],
            ],
            9,
            0.22,
            rng,
          ),
        );
        this.snow.addAt(
          drift,
          p.clone().setY(p.y - 0.15),
          yaw + 0.35,
          new THREE.Vector3(1.5, 1, 0.85),
        );
      }
    }
  }

  // -- foreground framing ----------------------------------------------------

  /**
   * The two dark shapes at the edges of the opening frame. Both are close and
   * both are unlit on the camera-facing side, which is what gives the shot its
   * dark foreground band — the single cheapest thing you can do for value
   * structure.
   */
  private buildForeground(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;

    // Framing has to be *vertical and close*. Two earlier versions used a
    // toppled column lying at eight metres, and it kept missing the frame — a
    // recumbent shape is only about two metres tall, so a metre of ground rise
    // between the camera and it is enough to swallow the whole thing. A standing
    // element at seven metres and five metres off-axis cannot be missed: that is
    // thirty-six degrees, comfortably inside a ninety-five degree frame, and it
    // fills the edge from the bottom of the shot to well above the horizon.
    const leftPost = this.temp(tapered(2.1, 7, 1.9, 0.22, 0.4, 0.2, rng));
    const lp = this.atSpawn(9.5, -6.5, -0.5);
    this.iron.addAt(leftPost, lp, yaw + 0.3, 1, 0.05, 0.11);
    this.runeBand(lp, 1.05, lp.y + 2.4, 4, yaw + 0.3, 0.16);
    this.runeBand(lp, 0.92, lp.y + 5.0, 4, yaw + 0.3, 0.15);
    // The framing post is nine metres from the camera: its rune light is the
    // only thing in the level that puts a coloured pool in the *foreground*,
    // which is what turns a dark framing element into a lit one.
    this.queueRuneLight(lp.clone().setY(lp.y + 3.6), 11, 14, 100);

    // Its snapped upper half in the snow behind it, so the post reads as a ruin.
    const fallen = this.temp(tapered(2.2, 13, 2.0, 0.3, 0, 0.35, rng));
    const fp = this.atSpawn(16, -11, 1.0);
    this.iron.addAt(fallen, fp, yaw + 0.55, 1, -Math.PI / 2 + 0.1, 0);

    const rubble = this.temp(tapered(2.0, 1.4, 1.9, 0.2, 0, 0.45, rng));
    for (let i = 0; i < 7; i++) {
      const p = this.atSpawn(8 + rng.range(0, 12), -5 - rng.range(0, 8), 0.15);
      this.stone.addAt(rubble, p, rng.range(0, TAU), rng.range(0.6, 1.2), rng.range(0, 0.6), 0);
    }

    // Right edge: a serac wall of upthrust glacier ice, stepping away from the
    // camera so it both frames and leads.
    for (let i = 0; i < 6; i++) {
      const f = 6.5 + i * 3.6 + rng.range(-0.8, 0.8);
      const r = 4.6 + i * 2.3 + rng.range(-0.6, 0.6);
      const p = this.atSpawn(f, r, -0.6);
      const h = 4.6 + rng.range(-1.0, 2.6) - i * 0.25;
      const blade = this.temp(prism(5, 1.2 + rng.range(0, 0.8), h, 0.34, rng));
      this.ice.addAt(
        blade,
        p,
        yaw + rng.range(-0.5, 0.5),
        new THREE.Vector3(1.5, 1, 0.75),
        rng.range(-0.1, 0.1),
        rng.range(-0.14, 0.14),
      );
    }
  }

  // -- crevasses -------------------------------------------------------------

  /**
   * Crevasse fields, cut obliquely across the approach so they read as hazard
   * lines the player has to route around — and so their lips throw a hard
   * shadow band across the mid-ground.
   */
  private buildCrevasses(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    const runs: Array<{ f: number; r: number; angle: number; length: number }> = [
      { f: 26, r: -6, angle: 1.15, length: 58 },
      { f: 52, r: 14, angle: -0.9, length: 46 },
      { f: 78, r: -18, angle: 1.45, length: 50 },
    ];
    const lipGeo = this.temp(tapered(3.2, 2.6, 1.5, 0.42, 0, 0.35, rng));
    const wallGeo = this.temp(new THREE.BoxGeometry(3.4, 5.2, 0.5));
    for (const run of runs) {
      const steps = Math.max(4, Math.round(run.length / 3.4));
      for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1) - 0.5;
        const along = t * run.length;
        const bend = Math.sin(t * 3.4) * 3.5;
        const f = run.f + Math.cos(run.angle) * along + bend * 0.4;
        const r = run.r + Math.sin(run.angle) * along + bend;
        const width = 1.5 + Math.cos(t * Math.PI) * 1.4;
        const face = yaw + run.angle;
        for (const side of [-1, 1]) {
          const off = side * width * 0.5;
          const p = this.atSpawn(
            f - Math.sin(run.angle) * off,
            r + Math.cos(run.angle) * off,
            -0.35,
          );
          const h = 0.7 + rng.range(0, 1.5);
          this.ice.addAt(
            lipGeo,
            p,
            face + rng.range(-0.2, 0.2),
            new THREE.Vector3(1, h, 1),
            0,
            side * 0.12,
          );
          // The inner face, sunk so only darkness shows between the lips.
          this.dark.addAt(
            wallGeo,
            p.clone().setY(p.y - 1.4),
            face,
            new THREE.Vector3(1, 1, 1),
            0,
            -side * 0.05,
          );
        }
      }
    }
  }

  // -- drifts and crystals ---------------------------------------------------

  /** Wind-carved snow drifts, all aligned to the recipe's wind heading. */
  private buildDrifts(): void {
    const rng = this.rng;
    const wind = 0.35;
    const count = Math.round(46 * this.detail);
    const profile: Array<[number, number]> = [
      [3.4, 0],
      [3.1, 0.5],
      [2.3, 1.05],
      [1.2, 1.5],
      [0.25, 1.72],
    ];
    for (let i = 0; i < count; i++) {
      const f = rng.range(-30, 150);
      const r = rng.range(-72, 72);
      // Keep the nave and the immediate spawn clear.
      if (f > 36 && f < 110 && Math.abs(r) < 12) continue;
      if (f > -4 && f < 6 && Math.abs(r) < 5) continue;
      const p = this.atSpawn(f, r, -0.3);
      if (this.slopeAt(p.x, p.z) > 0.5) continue;
      const s = rng.range(0.7, 2.3);
      const g = this.temp(revolved(profile, 10, 0.16, rng));
      this.snow.addAt(
        g,
        p,
        this.spawnYaw + wind + rng.range(-0.25, 0.25),
        new THREE.Vector3(s * rng.range(2.2, 4.2), s * rng.range(0.5, 1.0), s),
      );
      if (this.drifts.length < 40) {
        this.drifts.push(p.clone().setY(p.y + s * 1.2));
      }
    }
  }

  /** Hero ice-crystal growths: the world's one saturated colour note. */
  private buildCrystalFields(): void {
    const rng = this.rng;
    const clusters = Math.round(11 * this.detail);
    for (let i = 0; i < clusters; i++) {
      const f = i < 3 ? rng.range(6, 13) : rng.range(18, 130);
      const r = i < 3 ? (i % 2 === 0 ? -1 : 1) * rng.range(7, 11) : rng.range(-52, 52);
      const centre = this.atSpawn(f, r, -0.2);
      if (this.slopeAt(centre.x, centre.z) > 0.62) continue;
      const n = rng.int(3, 6);
      const scale = i < 3 ? rng.range(0.8, 1.2) : rng.range(0.45, 0.95);
      for (let k = 0; k < n; k++) {
        const a = rng.range(0, TAU);
        const d = rng.range(0, 1.5) * scale;
        const p = new THREE.Vector3(
          centre.x + Math.cos(a) * d,
          0,
          centre.z + Math.sin(a) * d,
        );
        p.y = this.groundAt(p.x, p.z) - 0.25;
        const h = rng.range(1.4, 3.4) * scale;
        const g = this.temp(prism(6, rng.range(0.22, 0.5) * scale, h, 0.42, rng));
        this.ice.addAt(
          g,
          p,
          rng.range(0, TAU),
          1,
          rng.range(-0.22, 0.22),
          rng.range(-0.22, 0.22),
        );
        // A brighter core inside the tallest shard of each cluster.
        if (k === 0) {
          const core = this.temp(prism(6, rng.range(0.1, 0.2) * scale, h * 0.7, 0.5, rng));
          this.rune.addAt(core, p.clone().setY(p.y + 0.2), 0, 1);
        }
      }
    }
  }

  // -- depth: the processional way -------------------------------------------

  /**
   * A flagged way from the landing point to the hall mouth.
   *
   * The avenue's standing stones already point at the hall, but a leading line
   * made only of objects at seven metres' spacing leaves the ground between them
   * blank — and blank ground is what the art audit called "a camera in a
   * clearing". A paved run does three jobs at once: it is a continuous line into
   * the frame, it is near-field detail from the player's boots outward, and it
   * is the first thing on this world that reads as *made* rather than *fallen*.
   *
   * Slabs sit 7 cm proud of the snow — under the 45 cm step height, so they can
   * never become a kerb the player trips on, and under the 30 cm the nav grid
   * treats as an obstruction, so they cost the AI nothing.
   */
  private buildProcessional(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    this.avenueEnd.copy(this.atSpawn(38, 0));

    // 0.4 m tall sunk 0.22: the flag stands 18 cm proud, which is under the
    // 45 cm step height and under the 30 cm the nav grid treats as an
    // obstruction, but far enough over the wind ripple to actually be seen.
    const slab = this.temp(tapered(3.2, 0.4, 2.6, 0.02, 0, 0.06, rng));
    for (let f = 3; f < 46; f += 2.55) {
      const t = (f - 3) / 43;
      // Two lanes near the camera, narrowing to one as the way recedes: the
      // convergence is what makes the run read as perspective rather than as a
      // stripe painted on the ground.
      const lanes = t < 0.55 ? [-1.45, 1.45] : [0];
      for (const lane of lanes) {
        if (rng.next() < 0.12) continue; // missing flags: this is a ruin
        const p = this.atSpawn(f + rng.range(-0.25, 0.25), lane + rng.range(-0.2, 0.2), -0.22);
        this.stone.addAt(
          slab,
          p,
          yaw + rng.range(-0.05, 0.05),
          1,
          rng.range(-0.02, 0.02),
          rng.range(-0.02, 0.02),
        );
      }
      // Kerb stones: a hard line either side, half-buried, so the way has edges.
      if (rng.next() < 0.7) {
        for (const side of [-1, 1]) {
          const p = this.atSpawn(f + rng.range(-0.6, 0.6), side * (3.3 + rng.range(-0.3, 0.3)), -0.34);
          const k = this.temp(tapered(1.5, 0.7, 0.8, 0.14, 0, 0.12, rng));
          this.stone.addAt(k, p, yaw + rng.range(-0.2, 0.2), 1, 0, rng.range(-0.09, 0.09));
        }
      }
    }

    // Wind-scoured snow lying over the flags, so the way is not a clean stripe.
    const scuff = this.temp(
      revolved(
        [
          [2.6, 0],
          [2.3, 0.12],
          [1.4, 0.22],
          [0.3, 0.28],
        ],
        8,
        0.3,
        rng,
      ),
    );
    for (let i = 0; i < Math.round(26 * this.detail) + 8; i++) {
      const p = this.atSpawn(rng.range(2, 48), rng.range(-6, 6), -0.1);
      this.snow.addAt(
        scuff,
        p,
        yaw + 0.35 + rng.range(-0.3, 0.3),
        new THREE.Vector3(rng.range(1.1, 2.4), rng.range(0.5, 1.1), rng.range(0.5, 0.9)),
      );
    }
  }

  // -- depth: verticality ----------------------------------------------------

  /**
   * The shield-wall bastion: a raised stone terrace overlooking the avenue and
   * the hall mouth, with a stair the movement kit can walk straight up.
   *
   * This is the level's only piece of *usable* height. The rule it is built to:
   * a ledge is only verticality if the player can reach it and wants to. The
   * stair answers the first (0.38 m risers, comfortably inside the 0.45 m step),
   * and the parapet answers the second — from up here the avenue is a shooting
   * gallery and the nave entrance is in view, which is worth the eight seconds
   * the climb costs.
   */
  private buildBastion(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    const centre = this.atSpawn(47, -20.5);
    const pad = this.padHeight(centre, 8, 9);
    const deckY = pad + 2.75;
    const halfW = 7.0;
    const halfD = 5.6;

    // Retaining courses. Built as blocks rather than one slab so the raking sun
    // finds a course line in the face instead of a flat plate.
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * TAU;
      const ex = Math.cos(a) * halfW;
      const ez = Math.sin(a) * halfD;
      const x = centre.x + this.viewRight.x * ex + this.viewForward.x * ez;
      const z = centre.z + this.viewRight.z * ex + this.viewForward.z * ez;
      const gy = this.groundAt(x, z);
      const g = this.temp(tapered(2.6, deckY - gy + 1.4, 2.2, 0.07, 0, 0.16, rng));
      this.stone.addAt(
        g,
        new THREE.Vector3(x, gy - 1.4, z),
        yaw + a,
        1,
        0,
        rng.range(-0.02, 0.02),
      );
    }
    // The deck itself, one slab, sunk so its top face is the walking surface.
    const deck = this.temp(tapered(halfW * 2 + 0.6, 1.1, halfD * 2 + 0.6, 0.02, 0, 0.06, rng));
    this.stone.addAt(deck, new THREE.Vector3(centre.x, deckY - 1.05, centre.z), yaw);

    // The stair, climbing from the avenue side, plus the landing that meets the
    // deck. The flight is deliberately short of the edge: a flight long enough
    // to reach it on flat ground runs *under* the deck on sloping ground, and a
    // player on those treads is inside a solid.
    const edge = new THREE.Vector3(
      centre.x - this.viewForward.x * (halfD + 0.5),
      deckY,
      centre.z - this.viewForward.z * (halfD + 0.5),
    );
    const foot = new THREE.Vector3(
      edge.x - this.viewForward.x * 9,
      0,
      edge.z - this.viewForward.z * 9,
    );
    foot.y = this.groundAt(foot.x, foot.z);
    const top = this.stairs(this.stone, foot, yaw, deckY - foot.y, 3.6, 0.8, 0.42);
    this.landing(this.stone, top, edge, 3.6);

    // Parapet: waist cover along the two edges that face the fight.
    for (let i = 0; i < 7; i++) {
      const ex = -halfW + 0.7 + (i / 6) * (halfW * 2 - 1.4);
      if (Math.abs(ex) < 1.9 && i % 2 === 0) continue; // embrasures to shoot through
      const x = centre.x + this.viewRight.x * ex + this.viewForward.x * halfD;
      const z = centre.z + this.viewRight.z * ex + this.viewForward.z * halfD;
      const g = this.temp(tapered(2.2, 1.15 + rng.range(-0.25, 0.35), 0.9, 0.1, 0, 0.14, rng));
      this.stone.addAt(g, new THREE.Vector3(x, deckY - 0.06, z), yaw, 1, 0, rng.range(-0.03, 0.03));
    }
    // An iron standard on the deck, so the bastion has a silhouette from below
    // and the player can see there is somewhere to go before they get there.
    const mast = this.temp(tapered(1.0, 6.4, 0.9, 0.4, 0.25, 0.1, rng));
    const mp = new THREE.Vector3(centre.x, deckY - 0.2, centre.z);
    this.iron.addAt(mast, mp, yaw + 0.2, 1, 0, 0.04);
    this.runeBand(mp, 0.75, deckY + 3.9, 4, yaw, 0.17);
  }

  // -- depth: interior -------------------------------------------------------

  /**
   * Roof the middle third of the nave.
   *
   * A level with no enclosed space has exactly one lighting condition, and every
   * fight in it reads the same. Thirty metres of covered hall gives the world a
   * second one: the sun is cut off, the rune light on the pillars becomes the
   * dominant source, and the player's route in and out of shadow becomes a
   * tactical choice rather than a walk. Roughly two panels in five are gone, so
   * the low sun drops hard bars of light across the floor through the holes —
   * which is the single cheapest interior lighting effect there is.
   *
   * Headroom is nine metres. The nav grid rejects any cell with less than 1.9 m
   * of clearance, so the hall stays fully navigable and the fight can happen
   * inside it rather than around it.
   */
  private buildNaveRoof(near: number, far: number, y: number): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    const halfW = 13.4;
    const bays = Math.max(3, Math.round((far - near) / 7.6));
    for (let b = 0; b <= bays; b++) {
      const f = near + ((far - near) * b) / bays;
      // Cross beam: pillar cap to pillar cap, the thing the panels sit on.
      const a = this.atSpawn(f, -halfW, y);
      const c = this.atSpawn(f, halfW, y);
      const mid = a.clone().lerp(c, 0.5);
      mid.y = y + this.groundAt(mid.x, mid.z) + 0.55;
      a.y = y + this.groundAt(a.x, a.z);
      c.y = y + this.groundAt(c.x, c.z);
      this.iron.add(this.temp(tube([a, mid, c], 0.55, 0.55, 6)));
      if (b === bays) break;

      // Panels, in two halves so a bay can lose one side and keep the other.
      for (const side of [-1, 1]) {
        if (rng.next() < 0.4) continue;
        const panelF = f + (far - near) / bays / 2;
        const p = this.atSpawn(panelF, side * halfW * 0.5, 0);
        p.y = this.groundAt(p.x, p.z) + y + 0.9 + rng.range(-0.2, 0.2);
        const slab = this.temp(
          tapered((far - near) / bays - 0.5, 0.7, halfW - 0.6, 0.03, 0, 0.22, rng),
        );
        this.stone.addAt(slab, p, yaw + Math.PI / 2, 1, 0, rng.range(-0.035, 0.035));
      }
    }

    // Rafters hanging off the broken edges, so the holes read as collapse.
    for (let i = 0; i < Math.round(9 * this.detail) + 3; i++) {
      const f = near + rng.range(0, far - near);
      const r = rng.range(-halfW, halfW);
      const top = this.atSpawn(f, r, 0);
      top.y = this.groundAt(top.x, top.z) + y + 0.4;
      const drop = top.clone();
      drop.y -= rng.range(1.6, 4.2);
      drop.x += rng.range(-1.6, 1.6);
      drop.z += rng.range(-1.6, 1.6);
      this.iron.add(this.temp(tube([top, drop], 0.28, 0.14, 5)));
    }
  }

  // -- depth: cover ----------------------------------------------------------

  /**
   * Waist and full-height cover through every space the encounter fights in.
   *
   * `CoverMap` is built from the collision world and consumed only by enemy AI,
   * so before this the *player* had nowhere to stand: a Jötunn line advancing
   * across open snow could only be answered by backing away. Every block here is
   * collidable, which means it serves both sides — the squad brain finds it as
   * cover on one bearing and the player finds it as cover on the other, which is
   * what makes a firefight read as a position rather than as a duel.
   *
   * Two heights only, and they mean different things: 1.15 m is fought *over*
   * from a stand and hidden behind from a crouch, 2.5 m breaks line of sight
   * outright and has to be flanked.
   */
  private buildCover(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    /** forward, right, full-height. */
    const sites: Array<[number, number, boolean]> = [
      // The avenue, staggered so there is always a next piece to move to.
      [19, -5.6, false], [24, 6.2, false], [30, -6.8, false], [35, 5.4, true],
      [41, -4.4, false], [44, 7.6, false],
      // The hall mouth: the shield line forms here, so it gets the hard cover.
      [39, -11.2, true], [40, 10.6, true], [46, 0.4, false],
      // The nave.
      [54, -10.4, false], [58, 9.8, true], [64, -5.2, false], [69, 6.4, false],
      [74, -9.6, true], [80, 8.2, false], [86, -4.8, false],
      // The dais, where the rune stone is defended from.
      [92, 6.8, false], [94, -7.4, false], [99, 9.2, true], [101, -9.6, false],
      // The great gate: the boss arena.
      [110, -13, true], [113, 12.4, true], [119, -7.2, false], [122, 8.4, false],
      [127, 0.6, false],
    ];
    for (const [f, r, full] of sites) {
      const p = this.atSpawn(f + rng.range(-1.2, 1.2), r + rng.range(-1, 1), -0.55);
      const h = full ? 2.5 + rng.range(-0.2, 0.5) : 1.15 + rng.range(-0.1, 0.25);
      const w = full ? 2.4 + rng.range(0, 1.1) : 3.0 + rng.range(0, 1.2);
      const g = this.temp(tapered(w, h + 0.55, 1.5 + rng.range(0, 0.7), 0.1, 0, 0.2, rng));
      this.stone.addAt(g, p, yaw + rng.range(-0.5, 0.5), 1, 0, rng.range(-0.05, 0.05));
      // Spoil banked against the windward face, so a block is not a crate.
      const spoil = this.temp(
        revolved(
          [
            [2.3, 0],
            [1.9, 0.3],
            [1.0, 0.62],
            [0.2, 0.8],
          ],
          8,
          0.24,
          rng,
        ),
      );
      this.snow.addAt(
        spoil,
        p.clone().setY(p.y + 0.4),
        yaw + 0.35,
        new THREE.Vector3(rng.range(1.1, 1.7), 1, 0.8),
      );
    }
  }

  // -- depth: the near field -------------------------------------------------

  /**
   * Everything inside fifteen metres of the player's boots.
   *
   * The audit finding this answers was literal: "no pebble, debris, leaf litter,
   * scuff or decal inside 10 m in any frame". A frame with nothing in the first
   * ten metres has no near value to read the mid-ground against, so the whole
   * shot flattens however good the distance is.
   *
   * Two numbers were wrong on the first pass and are worth recording. The pieces
   * were 15-50 cm, which is the size real gravel is and about a fifth of what
   * reads at eight metres through a 95-degree lens; and the batch did not cast
   * shadows, so nothing had a contact edge. Both are fixed here. It still costs
   * one draw call.
   */
  private buildNearField(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    const chipCount = Math.round(190 * this.detail);
    const chip = [
      this.temp(tapered(0.42, 0.22, 0.34, 0.3, 0, 0.11, rng)),
      this.temp(prism(5, 0.2, 0.38, 0.4, rng)),
      this.temp(tapered(0.3, 0.16, 0.62, 0.2, 0, 0.09, rng)),
    ];
    for (let i = 0; i < chipCount; i++) {
      // Golden-angle inside an 18 m disc, densest near the camera where it
      // counts. Tighter than the first pass: spreading the same count over 26 m
      // put four fifths of it past the distance it could be seen at.
      const t = i / chipCount;
      const a = i * 2.399963;
      const d = 1.8 + Math.pow(t, 0.62) * 17;
      const f = Math.cos(a) * d;
      const r = Math.sin(a) * d;
      const p = this.atSpawn(f, r, -0.03);
      if (this.slopeAt(p.x, p.z) > 0.55) continue;
      const s = rng.range(1.2, 3.0);
      this.grit.addAt(
        chip[i % chip.length],
        p,
        rng.range(0, TAU),
        s,
        rng.range(-0.3, 0.3),
        rng.range(-0.3, 0.3),
      );
    }

    // Ice shards worked out of the shelf by the frost — the near field's one
    // saturated note, and something for the low sun to burn through.
    // Deliberately few and low. The terrain recipe already scatters ice crystals
    // at more than triple the stock density and `buildCrystalFields` adds three
    // hand-placed clusters inside fifteen metres; forty more shards on top of
    // that turned the near field into a thicket of pale blue spikes that
    // competed with the serac wall for the eye.
    for (let i = 0; i < Math.round(20 * this.detail); i++) {
      const a = rng.range(0, TAU);
      const d = 4.5 + rng.next() * 11;
      const p = this.atSpawn(Math.cos(a) * d, Math.sin(a) * d, -0.12);
      const g = this.temp(prism(5, rng.range(0.16, 0.34), rng.range(0.45, 1.0), 0.45, rng));
      this.ice.addAt(g, p, rng.range(0, TAU), 1, rng.range(-0.3, 0.3), rng.range(-0.3, 0.3));
    }

    // Three broken rune fragments within arm's reach of the drop point: the
    // story of the place, told at a scale you can only read from close up.
    const frag: Array<[number, number, number]> = [
      [5.4, 3.6, 0.9],
      [7.8, -4.2, 1.25],
      [4.2, -5.8, 0.7],
    ];
    for (const [f, r, s] of frag) {
      const p = this.atSpawn(f, r, 0.12);
      const g = this.temp(tapered(1.5 * s, 2.6 * s, 1.2 * s, 0.2, 0.2, 0.28, rng));
      this.iron.addAt(g, p, yaw + rng.range(0, TAU), 1, Math.PI / 2 - rng.range(0.1, 0.5), 0.2);
      this.runeBand(p.clone().setY(p.y + 0.45), 0.62 * s, p.y + 0.45, 3, yaw, 0.12);
      for (let k = 0; k < 5; k++) {
        const q = p.clone();
        q.x += rng.range(-1.8, 1.8);
        q.z += rng.range(-1.8, 1.8);
        q.y = this.groundAt(q.x, q.z) - 0.04;
        this.grit.addAt(chip[k % chip.length], q, rng.range(0, TAU), rng.range(1.4, 3.2), 0, 0);
      }
    }

    // Half a dozen real boulders inside ten metres. Texture alone still reads as
    // a pattern on a plane; the frame needs a handful of objects with their own
    // silhouette and their own cast shadow to establish the scale of everything
    // behind them. These go in the collidable batch, so they double as the
    // smallest grade of cover.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + 0.9;
      const d = 5 + rng.next() * 6;
      const p = this.atSpawn(Math.cos(a) * d, Math.sin(a) * d, -0.3);
      if (this.slopeAt(p.x, p.z) > 0.6) continue;
      const g = this.temp(
        tapered(rng.range(0.9, 1.9), rng.range(0.5, 1.1), rng.range(0.8, 1.6), 0.28, 0, 0.35, rng),
      );
      this.stone.addAt(g, p, rng.range(0, TAU), 1, rng.range(-0.22, 0.22), rng.range(-0.22, 0.22));
    }
  }

  // -- shared detail ---------------------------------------------------------

  /** A ring of glyph slabs around a column, in the emissive batch. */
  private runeBand(
    centre: THREE.Vector3,
    radius: number,
    y: number,
    count: number,
    yaw: number,
    size = 0.16,
  ): void {
    // A rune is a cut line that holds light, so the glyph is a narrow vertical
    // stroke. At 0.34 m square these bloomed into rectangles that read as lit
    // windows and turned a ruin into an office block.
    const g = this.temp(new THREE.BoxGeometry(size, size * 4.2, size * 0.5));
    for (let i = 0; i < count; i++) {
      const a = yaw + (i / count) * TAU;
      const p = new THREE.Vector3(
        centre.x + Math.sin(a) * radius,
        y,
        centre.z + Math.cos(a) * radius,
      );
      this.rune.addAt(g, p, a);
    }
  }

  // -- combat ----------------------------------------------------------------

  protected spawnVolumeSpecs(): SpawnVolumeSpec[] {
    return [
      // 104, not 112: the nav grid is capped at 288 cells an axis at 0.75 m, so
      // it reaches 108 m from the landing point and a volume beyond that places
      // nothing at all. The Great Gate stays on the horizon at 120 m — it is a
      // landmark, not a fighting space.
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
      { id: 'aur.gate', forward: 104, right: 0, radius: 26, minPlayerDistance: 6 },
      { id: 'aur.hall.left', forward: 70, right: -24, radius: 18, minPlayerDistance: 12 },
      { id: 'aur.hall.right', forward: 70, right: 24, radius: 18, minPlayerDistance: 12 },
      { id: 'aur.dais', forward: 96, right: -18, radius: 26, minPlayerDistance: 6 },
      // Ahead of the landing point, either side of the avenue. The first wave
      // used to arrive from `aur.crevasse` and `aur.flank` — both *behind* the
      // player relative to the hall — while the objective said "advance", so the
      // fight pulled backwards for the whole of the line it was illustrating.
      { id: 'aur.avenue.left', forward: 46, right: -26, radius: 17, minPlayerDistance: 12 },
      { id: 'aur.avenue.right', forward: 48, right: 26, radius: 17, minPlayerDistance: 12 },
      { id: 'aur.crevasse', forward: 36, right: 32, radius: 16, minPlayerDistance: 14 },
      { id: 'aur.flank', forward: 18, right: -40, radius: 16, minPlayerDistance: 14 },
      { id: 'aur.rear', forward: -30, right: 8, radius: 18, minPlayerDistance: 16 },
    ];
  }

  /**
   * Chapter 1 — **Cold Contract**.
   *
   * Four objectives, four verbs the code checks. The first is an arrival at the
   * head of the avenue, so "advance" is measured in metres rather than in kills
   * and the skirmish spawns in front of the player instead of behind them. The
   * third is the campaign's first destructible: the rune stone on the dais is a
   * registered target with a real health bar, and the wave does not end until it
   * is rubble. The Allfather closes it — the boss this world was written for,
   * where a 1000 HP jarl used to stand in for a 4200 HP god. The jarl stays, as
   * an elite in the last wave, which is the rank he was designed at.
   */
  protected encounterScript(): EncounterScript {
    return {
      id: 'aurvangr.hall',
      title: 'Cold Contract',
      completesLevel: true,
      score: 2400,
      waves: [
        {
          delay: 5,
          triggerFraction: 0,
          objective: 'Advance up the avenue',
          volumes: ['aur.avenue.left', 'aur.avenue.right', 'aur.crevasse'],
          trigger: { kind: 'reach', position: this.avenueEnd, radius: 12 },
          units: [
            { archetype: 'nordic.thrall', count: 5 },
            { archetype: 'nordic.raider', count: 2 },
          ],
        },
        {
          delay: 3,
          triggerFraction: 0.65,
          objective: 'Break the shield line in the nave',
          volumes: ['aur.hall.left', 'aur.hall.right', 'aur.dais'],
          units: [
            { archetype: 'nordic.raider', count: 4 },
            { archetype: 'nordic.huscarl', count: 3 },
            { archetype: 'nordic.thrall', count: 4 },
          ],
        },
        {
          delay: 3,
          triggerFraction: 0.7,
          objective: 'Destroy the rune stone',
          // Not `aur.gate`: the player stands at the rune stone to break it and
          // the gate volume is four metres past it.
          volumes: ['aur.hall.left', 'aur.hall.right', 'aur.dais'],
          trigger: { kind: 'destroy', targetId: 'aur.runestone' },
          units: [
            { archetype: 'nordic.seer', count: 2 },
            { archetype: 'nordic.huscarl', count: 3 },
            { archetype: 'nordic.jarl', count: 1 },
            { archetype: 'nordic.raider', count: 3 },
          ],
        },
      ],
      boss: { archetype: 'nordic.allfather', count: 1 },
      bossObjective: 'Kill the Allfather',
      bossDelay: 5,
    };
  }

  // -- ambience --------------------------------------------------------------

  protected override tick(ctx: FrameContext): void {
    // Rune light is not a steady lamp: two incommensurate sines give it the slow
    // breathing a cut line holding light should have, and nothing in the frame
    // ever reads as a loop.
    const t = ctx.elapsed;
    for (let i = 0; i < this.runeLights.length; i++) {
      const l = this.runeLights[i];
      l.intensity = this.runeBase[i] * (1 + Math.sin(t * 0.53 + i * 1.9) * 0.09 + Math.sin(t * 1.31 + i * 0.7) * 0.05);
    }

    if (this.drifts.length === 0) return;
    this.spindriftTimer -= ctx.dt;
    if (this.spindriftTimer > 0) return;
    this.spindriftTimer = 0.42;
    // Walk the crest list rather than sampling randomly: every drift gets its
    // turn, and nothing is ever evaluated twice in a step.
    for (let tries = 0; tries < 6; tries++) {
      this.driftCursor = (this.driftCursor + 1) % this.drifts.length;
      const p = this.drifts[this.driftCursor];
      const d = p.distanceToSquared(this.camPos);
      if (d < 6 * 6 || d > 90 * 90) continue;
      this.vfx.impact(p, _up, 'ice', clamp(1.6 - Math.sqrt(d) * 0.012, 0.5, 1.4));
      return;
    }
  }

  override dispose(): void {
    for (const l of this.runeLights) l.dispose();
    this.runeLights.length = 0;
    this.runeBase.length = 0;
    super.dispose();
  }
}

registerPlanet('aurvangr', (deps, descriptor) => new AurvangrLevel(deps, descriptor));

export { AurvangrLevel };
