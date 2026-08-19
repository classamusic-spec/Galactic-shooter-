/**
 * Draco IX — the Cinder Basin.
 *
 * A forge world, and the Legions' staging ground. Everything here is lit by two
 * things and only two things: a blood-red sun coming through an ash column, and
 * the lava itself. That is the whole art direction — **the ground is a light
 * source** — and it is what makes the world look different from "a red level".
 *
 * The composition, read from the spawn:
 *
 *  - Two basalt outcrops close in on the left and right edges, black, with
 *    glowing fissures splitting them. Dark foreground frame, and the fissures
 *    are the only bright thing in it, so the eye starts at the edges and travels
 *    inward.
 *  - A lava channel entering bottom-left and running away up the basin. It is a
 *    genuine leading line, and it carries five real point lights, so everything
 *    near it is underlit from below — the single most expensive-looking cue this
 *    world has.
 *  - A processional of obsidian obelisks flanking the approach, converging on
 *    the legion gate at 125 m: obsidian mass, bronze trim, crenellated wall,
 *    two towers, braziers burning either side of the arch.
 *  - The caldera on the horizon at 640 m, its rim glowing, with a black smoke
 *    column standing off it and two more columns at intermediate distance so
 *    the aerial perspective has something to measure itself against.
 *
 * Reptilian emissive identity is blood-red throughout, and the bronze is the
 * complementary accent that keeps the palette from being one hue.
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
import { settings } from '@/core/Settings';
import { GLSL_NOISE } from '@/gfx/materials/glsl';
import {
  PlanetLevel,
  bandRing,
  cloneRecipe,
  prism,
  revolved,
  tapered,
  tube,
  type PropBatch,
  type SpawnVolumeSpec,
} from './PlanetLevel';
import { registerPlanet, type PlanetDeps } from './index';

/** Reptilian emissive identity. Matches FACTION_IDENTITY.reptilian. */
const LAVA_HOT = 0xff5a14;
const LAVA_CORE = 0xffb038;
const BRONZE = 0xb07a35;

const _up = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();

/** Compose a matrix whose +Y axis points along `dir`. Kit shapes are Y-up. */
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

/**
 * Black smoke, standing in a column.
 *
 * Absorption, not emission: the column is alpha-blended dark so it *hides* the
 * sky behind it, and only its base picks up the lava's underlight. An additive
 * smoke plume is the classic tell of a cheap frame — real smoke against a bright
 * sky is a silhouette, not a glow.
 */
const SMOKE_VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vWorldP;
varying float vH;
uniform float uHeight;
void main(){
  vObj = position;
  vH = clamp(position.y / uHeight + 0.5, 0.0, 1.0);
  vWorldN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SMOKE_FRAG = /* glsl */ `
${GLSL_NOISE}
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vWorldP;
varying float vH;
uniform vec3 uSmoke;
uniform vec3 uUnderlight;
uniform float uTime;
uniform float uDensity;
uniform float uScale;

void main(){
  // Rising, shearing noise. The domain drifts down in Y, so the column reads as
  // material moving up through a fixed shape.
  vec3 q = vObj * uScale;
  q.y -= uTime * 0.75;
  q.xz += vec2(sin(vH * 3.1 + uTime * 0.12), cos(vH * 2.4 + uTime * 0.1)) * 1.4;
  float n = fbm3(q, 4, 2.08, 0.55) * 0.5 + 0.5;
  float billow = fbm3(q * 2.7 + 11.0, 3, 2.1, 0.5) * 0.5 + 0.5;
  float d = clamp(n * 0.7 + billow * 0.45, 0.0, 1.0);

  // Thin out at the top (dispersal) and just off the vent (it has not spread
  // yet), so the column has a waist rather than a hard cylindrical edge.
  d *= smoothstep(0.0, 0.16, vH) * (1.0 - smoothstep(0.55, 1.0, vH));
  // Soft silhouette: fade where the shell turns edge-on to the camera.
  vec3 N = normalize(vWorldN);
  vec3 V = normalize(cameraPosition - vWorldP);
  d *= pow(1.0 - abs(dot(N, V)), 0.55);

  float a = clamp(d * uDensity, 0.0, 1.0);
  // Lava underlight, strongest in the first fifth of the column.
  vec3 col = mix(uSmoke, uUnderlight, exp(-vH * 7.0) * 0.85);
  gl_FragColor = vec4(col * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class DracoIXLevel extends PlanetLevel {
  private basalt!: PropBatch;
  private stone!: PropBatch;
  private bronze!: PropBatch;
  private ash!: PropBatch;
  private lavaBatch!: PropBatch;
  private fissure!: PropBatch;
  /** Near-field scree: basalt chips, clinker, bronze scrap. Never collides. */
  private grit!: PropBatch;

  private lavaMat!: THREE.MeshStandardMaterial;
  private fissureMat!: THREE.MeshStandardMaterial;
  private readonly smokeMats: THREE.ShaderMaterial[] = [];
  private readonly lavaLights: THREE.PointLight[] = [];
  /** Authored intensity per lava light, so the pulse scales rather than resets. */
  private readonly lavaBase: number[] = [];
  private readonly extraGeometry: THREE.BufferGeometry[] = [];
  private embers: THREE.Points | null = null;
  private emberMat: THREE.ShaderMaterial | null = null;
  /** Points along the lava where embers and heat shimmer are emitted. */
  private readonly vents: THREE.Vector3[] = [];
  private ventTimer = 0;
  private ventCursor = 0;

  /** The legion gate's threshold — chapter five's first arrival point. */
  private readonly gatePos = new THREE.Vector3();

  constructor(deps: PlanetDeps, descriptor: PlanetDescriptor) {
    super(deps, descriptor, {
      navRadius: 138,
      // Three-quarter light: a 19-degree sun through ash gives a huge soft key,
      // and taking it across the frame is the only way the basalt keeps an edge.
      spawnFacing: 'across',
      spawnSearchRadius: 340,
      dust: { density: 0.8, color: 0xd8b9a4, size: 0.05 },
    });
  }

  protected override atmosphere(): AtmosphereProfile {
    const a = cloneAtmosphere(ATMOSPHERES['draco-ix']);
    // The signature of the world: the cloud deck is black smoke lit from below
    // by the basin. Push the underlight hard — it is what stops the sky reading
    // as a flat red gradient.
    a.cloudUnderlightStrength = 4.4;
    a.cloudCoverage = 0.56;
    a.shadowExtent = 145;
    return a;
  }

  protected override recipe(): TerrainDescriptor {
    const d = cloneRecipe(terrainRecipe('draco-ix'));
    // Open review defect: the macro silhouette rounds off. A basalt basin needs
    // corners in its ridge line, not dunes.
    d.ridgePower = 2.8;
    d.erosion = 0.9;
    return d;
  }

  // -- construction ----------------------------------------------------------

  protected decorate(): void {
    // Not `obsidian`: that surface is authored glassy — metalness 1, env
    // intensity 1.7 — and under five orange point lights a 3 m tile of it reads
    // as molten honeycomb rather than as rock. Basalt is dark, rough and finely
    // grained, so it is `rock` at a tight tile with the metal taken out.
    this.basalt = this.batch(
      'basalt',
      this.surface('rock', { repeat: 1, color: 0x39312d, roughness: 0.95, metalness: 0 }),
      { tile: 2.1, collide: true, surface: 'rock' },
    );
    this.stone = this.batch(
      'legionStone',
      this.surface('reptilianStone', { repeat: 1, color: 0x6b5346, roughness: 0.88 }),
      { tile: 3.6, collide: true, surface: 'rock' },
    );
    this.bronze = this.batch(
      'bronze',
      this.surface('metal', {
        repeat: 1,
        color: BRONZE,
        roughness: 0.34,
        metalness: 1,
        envMapIntensity: 1.5,
      }),
      { tile: 1.6, collide: true, surface: 'metal' },
    );
    this.ash = this.batch(
      'ash',
      this.surface('sand', { repeat: 1, color: 0x9c8d84, roughness: 1, normalScale: 0.75 }),
      { tile: 5.0, collide: false, surface: 'sand' },
    );

    // Lava. Its own material so it can be animated without touching the shared
    // library cache: a real PBR set for the crust relief, with the *albedo* fed
    // back in as the emissive map, so the glow follows the crust pattern instead
    // of being a uniform orange wash.
    const set = this.materials.pbr('rock');
    this.lavaMat = this.own(
      new THREE.MeshStandardMaterial({
        map: set.albedo,
        normalMap: set.normal,
        emissiveMap: set.albedo,
        color: 0x140a06,
        emissive: new THREE.Color(LAVA_HOT),
        emissiveIntensity: 3.2,
        roughness: 0.72,
        metalness: 0,
      }),
    );
    this.lavaBatch = this.batch('lava', this.lavaMat, {
      tile: 3.0,
      collide: false,
      castShadow: false,
      receiveShadow: false,
    });

    this.fissureMat = this.own(
      new THREE.MeshStandardMaterial({
        color: 0x1a0d07,
        emissive: new THREE.Color(LAVA_CORE),
        emissiveIntensity: 2.6,
        roughness: 0.55,
        metalness: 0,
      }),
    );
    this.fissure = this.batch('fissure', this.fissureMat, {
      tile: 0,
      collide: false,
      castShadow: false,
    });

    this.grit = this.batch(
      'grit',
      // Pale grey clinker, not black: the basin is already the darkest thing in
      // the game and a black chip on black basalt is invisible with or without a
      // shadow under it.
      this.surface('rock', { repeat: 1, color: 0x8b7f76, roughness: 0.98, metalness: 0 }),
      // `castShadow` is on, and it is the reason any of this reads. Captures of
      // the first attempt showed a bare ground plane with the scatter provably
      // present in it: a 20 cm stone lit from the same direction as the ground
      // it lies on has no edge until it drops a contact shadow. One merged mesh,
      // so the whole near field costs one extra shadow draw.
      { tile: 0.9, collide: false, surface: 'rock', castShadow: true },
    );

    this.buildForeground();
    this.buildLavaChannel();
    this.buildApproach();
    this.buildViaduct();
    this.buildFortress();
    this.buildCourtyard();
    this.buildCover();
    this.buildNearField();
    this.buildAshField();
    this.buildCaldera();
    this.buildSmoke();
    this.buildEmbers();
  }

  /** The two black masses that own the frame edges, split by glowing fissures. */
  private buildForeground(): void {
    const sites: Array<[number, number, number]> = [
      [13, -10.5, 8.5],
      [21, -15, 12],
      [16, 11, 10],
      [27, 17, 13.5],
    ];
    for (const [f, r, h] of sites) {
      const p = this.atSpawn(f, r);
      this.basaltStack(p, h, 3.2 + this.rng.next() * 1.6);
    }
    // A low shelf across the bottom of the frame, so the immediate foreground is
    // not bare ground.
    for (let i = 0; i < 6; i++) {
      const p = this.atSpawn(6 + this.rng.range(-1.5, 2.5), -9 + i * 3.4);
      const g = this.temp(tapered(3.4, 0.8 + this.rng.next() * 1.1, 2.1, 0.35, 0.4, 0.16, this.rng));
      this.basalt.addAt(g, p, this.rng.range(0, TAU), 1, 0.1, this.rng.range(-0.12, 0.12));
    }
  }

  /**
   * A basalt stack: columnar jointing, which is what basalt actually does, plus
   * a fissure driven through it that glows from inside.
   */
  private basaltStack(base: THREE.Vector3, height: number, radius: number): void {
    const columns = 5 + Math.round(this.rng.next() * 4);
    for (let i = 0; i < columns; i++) {
      const a = (i / columns) * TAU + this.rng.range(-0.25, 0.25);
      const rr = radius * (0.25 + this.rng.next() * 0.85);
      const x = base.x + Math.cos(a) * rr;
      const z = base.z + Math.sin(a) * rr;
      const h = height * (0.45 + this.rng.next() * 0.75);
      const g = this.temp(prism(6, radius * 0.42, h, 0.06, this.rng));
      _tmp.set(x, this.groundAt(x, z) - 0.4, z);
      this.basalt.addAt(g, _tmp, this.rng.range(0, TAU), 1, this.rng.range(-0.07, 0.07), this.rng.range(-0.07, 0.07));
    }
    // The fissure: a thin emissive wedge wedged between the columns, plus a
    // trickle of cooled crust down the outside.
    const fh = height * 0.7;
    const g = this.temp(tapered(0.34, fh, radius * 1.3, 0.55, 0.2, 0.06, this.rng));
    _tmp.set(base.x, base.y + 0.1, base.z);
    this.fissure.addAt(g, _tmp, this.rng.range(0, TAU), 1, 0.06, 0.04);
  }

  /**
   * The lava channel. Ground quads on the emissive material, basalt banks either
   * side, and real point lights along it — the underlight is the point.
   */
  private buildLavaChannel(): void {
    const path: THREE.Vector3[] = [];
    const steps = 54;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const forward = -16 + t * 168;
      // A lazy S so the channel is a curve through the frame rather than a rail.
      const right = -19 + Math.sin(t * 2.4) * 15 + t * 30;
      path.push(this.atSpawn(forward, right));
    }

    // Every corner gets its own ground sample and its own lift. The first cut of
    // this used 16 samples over 150 m and a 14 cm lift, and the terrain between
    // samples simply swallowed the whole channel: the world's defining light
    // source was invisible in the frame it was built for.
    const LIFT = 0.34;
    const surfaceY = (x: number, z: number): number => this.groundAt(x, z) + LIFT;
    const half = (i: number): number => 2.4 + Math.sin(i * 0.7) * 0.85 + Math.sin(i * 0.23) * 0.5;

    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      _tmp.subVectors(b, a);
      _tmp.y = 0;
      const len = _tmp.length();
      if (len < 0.01) continue;
      _tmp.multiplyScalar(1 / len);
      _tmp2.set(-_tmp.z, 0, _tmp.x);
      const ha = half(i);
      const hb = half(i + 1);

      const corner = (p: THREE.Vector3, s: number, w: number, out: number[]): void => {
        const x = p.x + _tmp2.x * s * w;
        const z = p.z + _tmp2.z * s * w;
        out.push(x, surfaceY(x, z), z);
      };
      const v: number[] = [];
      corner(a, -1, ha, v);
      corner(b, -1, hb, v);
      corner(b, 1, hb, v);
      corner(a, -1, ha, v);
      corner(b, 1, hb, v);
      corner(a, 1, ha, v);
      const quad = new THREE.BufferGeometry();
      quad.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      quad.computeVertexNormals();
      this.lavaBatch.add(this.temp(quad));

      // Cooled crust piled either side: the rim is what catches the underlight
      // and stops the channel reading as a stripe painted on the ground.
      if (i % 2 === 0) {
        for (const side of [-1, 1]) {
          const bx = a.x + _tmp2.x * side * (ha + 1.0);
          const bz = a.z + _tmp2.z * side * (ha + 1.0);
          const bank = this.temp(
            tapered(2.2, 0.9 + this.rng.next() * 1.3, len * 2.4, 0.42, 0.35, 0.2, this.rng),
          );
          _tmp.set(bx, this.groundAt(bx, bz) - 0.25, bz);
          const yaw = Math.atan2(b.x - a.x, b.z - a.z);
          this.basalt.addAt(bank, _tmp, yaw, 1, 0, side * 0.2);
        }
      }
      if (i % 9 === 0) this.vents.push(new THREE.Vector3(a.x, surfaceY(a.x, a.z) + 0.2, a.z));
    }

    // Lights along the channel.
    //
    // `decay` is 1, not 2, and that is the whole fix for "Draco IX has no
    // floor". An inverse-square point light standing in for two hundred metres
    // of open lava is simply the wrong model: a *line* source falls off as 1/d,
    // not 1/d^2, and at the previous intensity 9 / decay 2 each light delivered
    // 9/400 = 0.02 at twenty metres — nothing. Measured on a real capture, 68%
    // of the frame sat below L=25 and the bottom 40% carried no readable form,
    // which is an automatic fail in the rubric. With a linear falloff the same
    // light reaches across the basin the way the thing it is modelling does.
    //
    // Count comes from the tier, since every light is a per-pixel cost in every
    // lit shader in the scene.
    const channelLights = Math.round(clamp(settings.profile.terrainDetail * 7, 4, 9));
    for (let i = 0; i < channelLights; i++) {
      const p = path[3 + Math.floor((i * (path.length - 8)) / channelLights)];
      const light = new THREE.PointLight(LAVA_HOT, 26, 90, 1);
      light.position.set(p.x, this.groundAt(p.x, p.z) + 2.0, p.z);
      light.castShadow = false;
      this.props.add(light);
      this.lavaLights.push(light);
      this.lavaBase.push(26);
    }
  }

  /** Obelisks flanking the road to the gate: the level's leading lines. */
  private buildApproach(): void {
    const pairs = Math.round(6 * this.detail) + 2;
    for (let i = 0; i < pairs; i++) {
      const t = i / (pairs - 1);
      const forward = 34 + t * 46;
      const spread = 13 - t * 3.5;
      for (const side of [-1, 1]) {
        const p = this.atSpawn(forward, side * spread);
        const h = 7.5 + this.rng.next() * 2.4;
        const shaft = this.temp(tapered(2.0, h, 2.0, 0.32, 0, 0.05, this.rng));
        this.stone.addAt(shaft, p, this.spawnYaw, 1, 0, 0);
        // Bronze collar and a capstone: the legion's material language, and the
        // only specular in the mid-ground.
        const collar = this.temp(bandRing(1.05, 1.55, 12));
        _tmp.set(p.x, p.y + h * 0.72, p.z);
        this.bronze.addAt(collar, _tmp, this.spawnYaw, 1);
        const cap = this.temp(prism(4, 1.15, 1.9, 0.75, this.rng));
        _tmp.set(p.x, p.y + h, p.z);
        this.bronze.addAt(cap, _tmp, this.spawnYaw + Math.PI / 4, 1);
        // A fissure glowing at the base, so the row reads at distance.
        if (i % 2 === 0) {
          const gl = this.temp(tapered(0.3, 1.5, 1.9, 0.5, 0, 0.04, this.rng));
          _tmp.set(p.x, p.y + 0.05, p.z);
          this.fissure.addAt(gl, _tmp, this.spawnYaw, 1);
        }
      }
    }
  }

  /** The legion gate: the landmark the whole basin points at. */
  private buildFortress(): void {
    // 88 m, not 126.
    //
    // The nav grid is capped at 288 cells an axis at 0.75 m, so it covers 216 m
    // — plus or minus 108 m from the landing point — and every spawn volume
    // beyond that silently failed to place anything, which on this world was the
    // gate and both wall volumes: the entire legion fight arrived from the one
    // channel volume behind the player. The fortress has to sit far enough
    // inside that radius for its *courtyard* to be navigable too, because that
    // is where the last objective is. Bringing it in also improves the shot: at
    // 88 m a 22 m gatehouse subtends about fourteen degrees rather than ten,
    // which is what a final-chapter landmark should do to a frame.
    const centre = this.atSpawn(88, 4);
    const pad = this.padHeight(centre, 34, 12);
    const yaw = this.spawnYaw;
    const right = this.viewRight;
    const fwd = this.viewForward;

    const wallH = 13;
    const halfSpan = 34;
    const gateHalf = 5.5;

    // Curtain wall, built in blocks so the silhouette has a course line and the
    // raking sun has something to bite on.
    const blocks = 26;
    for (let i = 0; i < blocks; i++) {
      const t = i / (blocks - 1);
      const off = (t - 0.5) * 2 * halfSpan;
      if (Math.abs(off) < gateHalf + 1.2) continue;
      const x = centre.x + right.x * off;
      const z = centre.z + right.z * off;
      const h = wallH + Math.sin(i * 1.9) * 0.8;
      const g = this.temp(tapered(3.0, h, 4.4, 0.12, 0, 0.1, this.rng));
      _tmp.set(x, pad - 1.2, z);
      this.stone.addAt(g, _tmp, yaw, 1);
      // Crenellations.
      if (i % 2 === 0) {
        const merlon = this.temp(tapered(1.7, 2.1, 3.2, 0.2, 0, 0.06, this.rng));
        _tmp.set(x, pad - 1.2 + h, z);
        this.basalt.addAt(merlon, _tmp, yaw, 1);
      }
    }

    // Gate arch: two piers, a lintel, and a bronze portcullis frame.
    for (const side of [-1, 1]) {
      const x = centre.x + right.x * side * (gateHalf + 1.6);
      const z = centre.z + right.z * side * (gateHalf + 1.6);
      const pier = this.temp(tapered(4.6, wallH + 3.5, 5.6, 0.14, 0, 0.08, this.rng));
      _tmp.set(x, pad - 1.2, z);
      this.basalt.addAt(pier, _tmp, yaw, 1);
      // Brazier on the pier: a real fill light at the objective, which is what
      // draws the eye to the gate rather than past it.
      const bowl = this.temp(
        revolved(
          [
            [0.35, 0],
            [0.9, 0.9],
            [1.25, 1.6],
            [1.1, 1.85],
          ],
          10,
          0.06,
          this.rng,
        ),
      );
      _tmp.set(x, pad - 1.2 + wallH + 3.5, z);
      this.bronze.addAt(bowl, _tmp, yaw, 1);
      const fire = this.temp(prism(6, 0.95, 2.2, 0.7, this.rng));
      _tmp.y += 1.5;
      this.fissure.add(this.temp(fire.clone()).applyMatrix4(_m.makeTranslation(_tmp.x, _tmp.y, _tmp.z)));
      // A brazier really is a point source, so this one keeps inverse-square.
      const light = new THREE.PointLight(LAVA_CORE, 24, 34, 2);
      light.position.copy(_tmp);
      light.castShadow = false;
      this.props.add(light);
      this.lavaLights.push(light);
      this.lavaBase.push(24);
    }
    const lintel = this.temp(tapered(gateHalf * 2 + 7, 3.6, 5.8, 0.08, 0, 0.08, this.rng));
    _tmp.copy(centre).setY(pad - 1.2 + wallH);
    this.stone.addAt(lintel, _tmp, yaw, 1);
    // The gateway is a way *through*, and now it genuinely is one: this used to
    // be a full-height slab that sealed the arch, so the fortress the objective
    // pointed at could never be entered. What is left is the header above a
    // 5.8 m opening, which keeps the dark band over the arch that made the
    // gateway read while leaving the passage clear.
    const header = this.temp(tapered(gateHalf * 2, wallH - 5.8, 1.4, 0.02, 0, 0, this.rng));
    _tmp.copy(centre).addScaledVector(fwd, 2.6).setY(pad - 1.4 + 5.8);
    this.basalt.addAt(header, _tmp, yaw, 1);
    // The threshold, in world space: what "advance on the legion gate" is
    // measured against.
    this.gatePos.copy(centre).setY(pad);

    // Towers either end. Taller than the wall, so the fortification has a
    // silhouette rather than a straight line.
    for (const side of [-1, 1]) {
      const x = centre.x + right.x * side * (halfSpan + 3);
      const z = centre.z + right.z * side * (halfSpan + 3);
      const th = wallH + 9;
      const tower = this.temp(
        revolved(
          [
            [5.4, 0],
            [4.6, th * 0.35],
            [4.2, th * 0.75],
            [4.9, th * 0.9],
            [4.4, th],
          ],
          10,
          0.05,
          this.rng,
        ),
      );
      _tmp.set(x, pad - 2, z);
      this.stone.addAt(tower, _tmp, yaw, 1);
      const crown = this.temp(bandRing(4.2, 5.3, 12));
      _tmp.y = pad - 2 + th;
      this.bronze.addAt(crown, _tmp, yaw, 1);
      // Standard: a bronze pole and a hanging banner, which gives the tower a
      // vertical accent and the faction a flag.
      const pole = this.temp(tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 7.5, 0)], 0.16, 0.1, 5));
      this.bronze.addAt(pole, _tmp, 0, 1);
      const banner = this.temp(tapered(3.2, 4.6, 0.16, 0.25, 0.5, 0.05, this.rng));
      _tmp2.copy(_tmp).addScaledVector(fwd, 0.2).setY(_tmp.y + 2.4);
      this.fissure.addAt(banner, _tmp2, yaw, 1, 0.05, 0);
    }
  }

  // -- depth: the courtyard and the Choir core -------------------------------

  /**
   * Inside the fortress: a walled court, a colonnade with a roof on it down both
   * sides, and the Choir core on a plinth at the far end.
   *
   * This is the campaign's only true interior and its last objective in one
   * piece. The court is open to the sky so the braziers on the wall still read,
   * but the two side galleries are roofed, dark, and connect the gate to the
   * core — which gives the final fight a shape: a killing floor in the middle
   * that the Tyrant owns, and two covered runs down the flanks that the player
   * does. The core keeps burning while the arena spawns, so the wave is a race
   * between damage output and attrition rather than a queue of kills.
   */
  private buildCourtyard(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    const fwd = this.viewForward;
    const right = this.viewRight;
    const gate = this.gatePos;

    // The basin's recipe only flattens the central fifty metres, so the ground
    // under a court eighty-eight metres out is whatever the ridge noise left
    // there. One floor level for the whole court, taken as the highest ground it
    // covers *and* the gate's own pad, so the court never sits below its own
    // doorway and every block is sunk far enough to meet a falling slope.
    const courtCentre = new THREE.Vector3(gate.x + fwd.x * 13, 0, gate.z + fwd.z * 13);
    const floor = Math.max(gate.y, this.padHeight(courtCentre, 20, 13));

    /** A point `along` metres inside the gate and `across` to its right. */
    const at = (along: number, across: number, lift = 0): THREE.Vector3 =>
      new THREE.Vector3(
        gate.x + fwd.x * along + right.x * across,
        floor + lift,
        gate.z + fwd.z * along + right.z * across,
      );

    // 26 m deep, which puts the core 106 m from the landing point — inside the
    // 108 m the nav grid reaches, so the wave that guards it can arrive at all.
    // A deeper court would look better and fight worse.
    const depth = 26;
    const halfW = 17;

    // Side walls and the rear wall, in courses.
    for (let i = 0; i < 14; i++) {
      const along = 3 + (i / 13) * (depth - 3);
      for (const side of [-1, 1]) {
        const h = 9 + Math.sin(i * 1.7) * 0.7;
        const g = this.temp(tapered(2.8, h + 4, 3.4, 0.12, 0, 0.1, rng));
        this.stone.addAt(g, at(along, side * halfW, -4), yaw, 1);
        if (i % 2 === 0) {
          const merlon = this.temp(tapered(1.5, 1.8, 2.6, 0.2, 0, 0.06, rng));
          this.basalt.addAt(merlon, at(along, side * halfW, h), yaw, 1);
        }
      }
    }
    for (let i = 0; i < 13; i++) {
      const across = -halfW + (i / 12) * halfW * 2;
      const g = this.temp(tapered(3.0, 14 + Math.sin(i * 2.1) * 0.8, 3.0, 0.12, 0, 0.1, rng));
      this.stone.addAt(g, at(depth, across, -4), yaw, 1);
    }
    // Deliberately no floor slab. The nav grid samples terrain height and then
    // rejects any cell whose downward probe finds a surface above it, so paving
    // the court would make its interior unwalkable and the guard wave would
    // stall outside the gate it came through. The court's floor is the basin;
    // the walls are sunk four metres to meet it wherever it falls away.

    // The two roofed galleries. Piers, architrave, roof slabs — the only place
    // in the game where the sun is off entirely and the fire is all there is.
    for (const side of [-1, 1]) {
      const across = side * (halfW - 4.6);
      for (let i = 0; i < 8; i++) {
        const along = 4.5 + i * 3.4;
        // Inboard of the roof's centre line, so the slab is carried between the
        // pier row and the curtain wall rather than cantilevered off both.
        const foot = at(along, across - side * 3.2);
        const gy = this.groundAt(foot.x, foot.z);
        // The piers reach from whatever the ground is up to one architrave
        // height, so the colonnade's top line is level even where the basin
        // is not.
        const pier = this.temp(tapered(1.7, floor + 4.3 - gy, 1.7, 0.14, 0, 0.05, rng));
        this.stone.addAt(pier, foot.clone().setY(gy), yaw, 1);
        const collar = this.temp(bandRing(0.9, 1.35, 10));
        this.bronze.addAt(collar, at(along, across - side * 3.2, 4.3), yaw, 1);
        if (i < 7) {
          // Sitting *on* the capitals at 4.3, not floating a metre over them.
          const slab = this.temp(tapered(3.5, 0.7, 8.2, 0.04, 0, 0.08, rng));
          this.stone.addAt(slab, at(along + 1.7, across, 4.3), yaw + Math.PI / 2, 1);
        }
      }
      // A firing step along the outside of each gallery: 1.5 m, one jump, and a
      // view over the killing floor. Placed off local ground rather than the
      // court's nominal floor, so it is a step and not a floating shelf.
      for (let i = 0; i < 6; i++) {
        const along = 6 + i * 4;
        const p = at(along, side * (halfW - 1.6));
        p.y = this.groundAt(p.x, p.z) - 0.5;
        const g = this.temp(tapered(3.6, 2.0, 2.6, 0.06, 0, 0.06, rng));
        this.basalt.addAt(g, p, yaw, 1);
      }
    }

    // The plinth and the core. 18 m in, which is 106 m from the landing point.
    const plinth = this.temp(
      revolved(
        [
          [6.2, 0],
          [5.8, 1.1],
          [4.4, 2.2],
          [4.0, 2.6],
        ],
        16,
        0.03,
        rng,
      ),
    );
    const plinthFoot = at(depth - 8, 0);
    plinthFoot.y = Math.min(floor, this.groundAt(plinthFoot.x, plinthFoot.z)) - 0.4;
    this.stone.addAt(plinth, plinthFoot, yaw);
    // Measured off the plinth it stands on rather than the court's nominal
    // floor, so the core cannot end up hanging in the air over a low corner.
    const corePos = plinthFoot.clone().setY(plinthFoot.y + 3.8);
    // A bronze cage: four canted ribs, so the core is *held* rather than
    // floating, and so its light is broken up into blades instead of a blob.
    for (let i = 0; i < 4; i++) {
      const a = yaw + (i / 4) * TAU + 0.4;
      const foot = corePos.clone().add(new THREE.Vector3(Math.sin(a) * 3.6, -1.2, Math.cos(a) * 3.6));
      const head = corePos.clone().add(new THREE.Vector3(Math.sin(a) * 1.1, 3.6, Math.cos(a) * 1.1));
      const mid = foot.clone().lerp(head, 0.5).add(new THREE.Vector3(Math.sin(a) * 0.9, 0, Math.cos(a) * 0.9));
      this.bronze.add(this.temp(tube([foot, mid, head], 0.34, 0.2, 6)));
    }
    this.bronze.addAt(this.temp(bandRing(3.1, 3.9, 26)), corePos.clone().setY(corePos.y - 1.3), yaw);
    // The core itself: an emissive polyhedron, on the material the lava uses, so
    // it pulses with the world rather than sitting outside it.
    const core = this.temp(new THREE.IcosahedronGeometry(2.3, 1));
    this.fissure.addAt(core, corePos, yaw, new THREE.Vector3(1, 1.15, 1));
    const shroud = this.temp(new THREE.IcosahedronGeometry(3.1, 1));
    this.fissure.addAt(shroud, corePos, yaw + 0.6, new THREE.Vector3(0.8, 1.4, 0.8));

    const light = new THREE.PointLight(LAVA_CORE, 30, 46, 2);
    light.position.copy(corePos);
    light.castShadow = false;
    this.props.add(light);
    this.lavaLights.push(light);
    this.lavaBase.push(30);
    this.vents.push(corePos.clone().setY(corePos.y - 2.4));

    this.destructible('draco.core', corePos, 9000, {
      radius: 2.9,
      halfHeight: 1.2,
      surface: 'energy',
      onDestroyed: (prop) => this.breakDestructible(prop, 12),
    });

    // Legion standards down the court, and braziers at the plinth: the court has
    // to look garrisoned, not archaeological.
    for (const side of [-1, 1]) {
      const p = at(depth - 8, side * 8.5, 0);
      const bowl = this.temp(
        revolved(
          [
            [0.4, 0],
            [0.95, 1.0],
            [1.3, 1.7],
            [1.15, 1.95],
          ],
          10,
          0.06,
          rng,
        ),
      );
      p.y = this.groundAt(p.x, p.z) - 0.3;
      const pole = this.temp(tapered(0.5, 3.5, 0.5, 0.3, 0, 0.04, rng));
      this.stone.addAt(pole, p, yaw, 1);
      this.bronze.addAt(bowl, p.clone().setY(p.y + 3.2), yaw, 1);
      const fire = this.temp(prism(6, 0.8, 1.9, 0.7, rng));
      this.fissure.addAt(fire, p.clone().setY(p.y + 4.9), yaw, 1);
      this.vents.push(p.clone().setY(p.y + 5.2));
    }

    // Rubble and scorch on the court floor, so the interior has a near field of
    // its own — this is the frame the player spends the last fight inside.
    for (let i = 0; i < Math.round(46 * this.detail) + 16; i++) {
      const p = at(rng.range(2, depth - 1), rng.range(-halfW + 2, halfW - 2));
      p.y = this.groundAt(p.x, p.z) + 0.04;
      const g = this.temp(
        tapered(rng.range(0.25, 1.1), rng.range(0.12, 0.45), rng.range(0.3, 1.0), 0.3, 0, 0.3, rng),
      );
      (rng.next() < 0.75 ? this.grit : this.basalt).addAt(
        g,
        p,
        rng.range(0, TAU),
        1,
        rng.range(-0.4, 0.4),
        rng.range(-0.4, 0.4),
      );
    }
  }

  // -- depth: the viaduct ----------------------------------------------------

  /**
   * A legion causeway running up the west side of the basin, three metres over
   * the ash, ending in a platform that looks straight down the approach at the
   * gate.
   *
   * The basin was a floor. Every fight in it happened on one plane, so the only
   * tactical variable was distance. This is the second plane: a route that
   * bypasses the obelisk road, stands three metres up in the channel's
   * underlight so a player on it is rim-lit against the smoke, and puts the gate
   * approach in enfilade. Getting on it costs a flight of steps; staying on it
   * costs cover, because the parapet is broken along half its length.
   */
  private buildViaduct(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    const from = this.atSpawn(40, -22);
    const to = this.atSpawn(76, -16);
    const deckY = Math.max(from.y, to.y) + 3.1;
    const spans = 11;

    for (let i = 0; i <= spans; i++) {
      const t = i / spans;
      const x = from.x + (to.x - from.x) * t;
      const z = from.z + (to.z - from.z) * t;
      const gy = this.groundAt(x, z);
      // Piers, so the causeway is carried rather than extruded.
      if (i < spans) {
        const pier = this.temp(tapered(3.0, deckY - gy + 0.8, 2.4, 0.1, 0, 0.06, rng));
        this.stone.addAt(pier, new THREE.Vector3(x, gy - 0.8, z), yaw, 1);
        // The arch between piers, which is what makes it a viaduct.
        const nx = from.x + (to.x - from.x) * ((i + 1) / spans);
        const nz = from.z + (to.z - from.z) * ((i + 1) / spans);
        const a = new THREE.Vector3(x, deckY - 2.4, z);
        const b = new THREE.Vector3((x + nx) * 0.5, deckY - 1.1, (z + nz) * 0.5);
        const c = new THREE.Vector3(nx, deckY - 2.4, nz);
        this.stone.add(this.temp(tube([a, b, c], 0.55, 0.55, 6)));
        // Deck slab.
        const len = Math.hypot(nx - x, nz - z) + 0.4;
        const slab = this.temp(tapered(4.6, 1.0, len, 0.03, 0, 0.05, rng));
        this.stone.addAt(
          slab,
          new THREE.Vector3((x + nx) * 0.5, deckY - 0.95, (z + nz) * 0.5),
          Math.atan2(nx - x, nz - z) + Math.PI,
        );
      }
      // Parapet, broken in places: cover where it stands, an exit where it does
      // not.
      if (i < spans && rng.next() < 0.62) {
        for (const side of [-1, 1]) {
          const px = x + this.viewRight.x * side * 2.5;
          const pz = z + this.viewRight.z * side * 2.5;
          const g = this.temp(tapered(2.2, 1.2 + rng.range(-0.15, 0.3), 0.7, 0.12, 0, 0.1, rng));
          this.stone.addAt(g, new THREE.Vector3(px, deckY - 0.1, pz), yaw, 1);
        }
      }
      if (i === spans) {
        // The head platform: wider, with a bronze standard so it is visible as
        // a destination from the landing point.
        const plat = this.temp(tapered(9, 1.2, 7, 0.05, 0, 0.08, rng));
        this.stone.addAt(plat, new THREE.Vector3(x, deckY - 1.05, z), yaw);
        const pole = this.temp(tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 6.5, 0)], 0.15, 0.09, 5));
        this.bronze.addAt(pole, new THREE.Vector3(x, deckY, z), 0, 1);
        const banner = this.temp(tapered(2.8, 4.0, 0.14, 0.25, 0.4, 0.05, rng));
        this.fissure.addAt(
          banner,
          new THREE.Vector3(x, deckY + 2.1, z).addScaledVector(this.viewForward, 0.2),
          yaw,
          1,
          0.05,
          0,
        );
        for (let k = 0; k < 4; k++) {
          const a = yaw + (k / 4) * TAU + 0.7;
          const g = this.temp(tapered(2.0, 1.25, 0.8, 0.14, 0, 0.1, rng));
          this.stone.addAt(
            g,
            new THREE.Vector3(x + Math.sin(a) * 3.4, deckY - 0.1, z + Math.cos(a) * 3.4),
            a,
            1,
          );
        }
      }
    }

    // The stair up, off the near end and facing the landing point so it is
    // legible as a way up rather than as more wall.
    const dirX = from.x - this.atSpawn(32, -25).x;
    const dirZ = from.z - this.atSpawn(32, -25).z;
    const dl = Math.hypot(dirX, dirZ) || 1;
    const edge = new THREE.Vector3(from.x - (dirX / dl) * 2.6, deckY, from.z - (dirZ / dl) * 2.6);
    const foot = new THREE.Vector3(edge.x - (dirX / dl) * 9, 0, edge.z - (dirZ / dl) * 9);
    foot.y = this.groundAt(foot.x, foot.z);
    const top = this.stairs(this.stone, foot, this.yawTowards(foot, edge), deckY - foot.y, 4.0, 0.8, 0.42);
    this.landing(this.stone, top, edge, 4.0);
  }

  // -- depth: cover ----------------------------------------------------------

  /**
   * Basalt spurs and legion barricades through the basin and up to the wall.
   *
   * The shield-line objective is fought at a curtain wall against legionaries
   * and pyroclasts — the two archetypes in the game with the longest reach — on
   * ground that was completely open. Cover here is deliberately dense on the
   * last thirty metres of the approach, which is where the fight stalls, and
   * thin in the middle, where it should be a run.
   */
  private buildCover(): void {
    const rng = this.rng;
    const yaw = this.spawnYaw;
    /** forward, right, full-height. */
    const sites: Array<[number, number, boolean]> = [
      [22, 9, false], [27, -7, false], [32, 12, true], [37, -5, false],
      [42, 8, false], [46, -13, true], [50, 6, false], [54, -8, false],
      [58, 14, true], [62, -6, false], [66, 9, false], [69, -12, true],
      [72, 5, false], [75, -9, false], [78, 13, true], [80, -15, false],
      [82, 7, false], [84, -6, true], [86, 12, false],
    ];
    for (const [f, r, full] of sites) {
      const p = this.atSpawn(f + rng.range(-1.5, 1.5), r + rng.range(-1.5, 1.5), -0.45);
      if (this.slopeAt(p.x, p.z) > 0.6) continue;
      const h = full ? 2.6 + rng.range(-0.2, 0.6) : 1.2 + rng.range(-0.1, 0.3);
      if (f > 62) {
        // Legion work: dressed stone with a bronze cap, because this close to
        // the wall the barricades are theirs.
        const g = this.temp(tapered(full ? 3.0 : 3.8, h + 0.6, 1.2, 0.08, 0, 0.08, rng));
        this.stone.addAt(g, p, yaw + rng.range(-0.4, 0.4), 1, 0, rng.range(-0.03, 0.03));
        this.bronze.addAt(
          this.temp(tapered(full ? 3.1 : 3.9, 0.22, 1.35, 0.06, 0, 0.05, rng)),
          p.clone().setY(p.y + h + 0.55),
          yaw + rng.range(-0.4, 0.4),
        );
      } else {
        // Basalt, columnar, thrown up by the basin itself.
        const cols = full ? 4 : 3;
        for (let k = 0; k < cols; k++) {
          const a = rng.range(0, TAU);
          const d = rng.range(0, 1.5);
          const q = new THREE.Vector3(p.x + Math.cos(a) * d, 0, p.z + Math.sin(a) * d);
          q.y = this.groundAt(q.x, q.z) - 0.5;
          const g = this.temp(prism(6, rng.range(0.7, 1.2), h + rng.range(0, 0.5) + 0.5, 0.05, rng));
          this.basalt.addAt(g, q, rng.range(0, TAU), 1, rng.range(-0.08, 0.08), rng.range(-0.08, 0.08));
        }
        if (rng.next() < 0.45) {
          const gl = this.temp(tapered(0.28, h * 0.7, 1.5, 0.5, 0, 0.05, rng));
          this.fissure.addAt(gl, p.clone().setY(p.y + 0.5), rng.range(0, TAU), 1, 0.05, 0);
        }
      }
    }
  }

  // -- depth: the near field -------------------------------------------------

  /**
   * Clinker, scree and burnt bronze scrap inside twenty-five metres.
   *
   * Reviewed frames of this world had a beautiful basin and nothing at all in
   * the first ten metres of it, so the ground under the player read as a smooth
   * shaded plane rather than as volcanic rubble. One draw call for the lot.
   */
  private buildNearField(): void {
    const rng = this.rng;
    const chip = [
      this.temp(prism(5, 0.25, 0.34, 0.15, rng)),
      this.temp(tapered(0.48, 0.24, 0.38, 0.3, 0, 0.15, rng)),
      this.temp(tapered(0.8, 0.15, 0.46, 0.25, 0, 0.22, rng)),
    ];
    const count = Math.round(220 * this.detail);
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const a = i * 2.399963;
      const d = 1.6 + Math.pow(t, 0.6) * 18;
      const p = this.atSpawn(Math.cos(a) * d, Math.sin(a) * d, -0.03);
      if (this.slopeAt(p.x, p.z) > 0.62) continue;
      this.grit.addAt(
        chip[i % chip.length],
        p,
        rng.range(0, TAU),
        rng.range(1.1, 2.8),
        rng.range(-0.4, 0.4),
        rng.range(-0.4, 0.4),
      );
    }

    // Cooling clinker: a handful of chips with a glowing crack still in them, so
    // the near field carries the world's key colour as well as its texture.
    for (let i = 0; i < Math.round(20 * this.detail) + 7; i++) {
      const a = rng.range(0, TAU);
      const d = 3 + rng.next() * 13;
      const p = this.atSpawn(Math.cos(a) * d, Math.sin(a) * d, -0.02);
      const g = this.temp(tapered(rng.range(0.35, 0.9), 0.09, rng.range(0.5, 1.5), 0.3, 0, 0.2, rng));
      this.fissure.addAt(g, p, rng.range(0, TAU), 1, rng.range(-0.2, 0.2), rng.range(-0.2, 0.2));
    }

    // Burnt legion scrap: a broken shield, a spear shaft, a helm. Bronze is the
    // world's complementary accent and this is the only place it appears close
    // enough to read as metal rather than as a highlight.
    for (let i = 0; i < 9; i++) {
      const a = rng.range(0, TAU);
      const d = 4 + rng.next() * 9;
      const p = this.atSpawn(Math.cos(a) * d, Math.sin(a) * d, 0.06);
      if (rng.next() < 0.5) {
        this.bronze.addAt(
          this.temp(bandRing(0.55, 0.95, 12)),
          p,
          rng.range(0, TAU),
          1,
          rng.range(0.4, 1.4),
          rng.range(-0.4, 0.4),
        );
      } else {
        this.bronze.add(
          this.temp(
            tube(
              [p.clone(), p.clone().add(new THREE.Vector3(rng.range(-1.6, 1.6), rng.range(0, 0.5), rng.range(-1.6, 1.6)))],
              0.07,
              0.05,
              5,
            ),
          ),
        );
      }
    }
  }

  /** Ash drifts: the one soft, pale value in a world of black and red. */
  private buildAshField(): void {
    const count = Math.round(18 * this.detail) + 6;
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const a = i * 2.399963;
      const r = 11 + Math.sqrt(t) * 98;
      const forward = Math.cos(a) * r + 34;
      const right = Math.sin(a) * r * 1.2;
      const p = this.atSpawn(forward, right);
      if (this.slopeAt(p.x, p.z) > 0.5) continue;
      const w = 6 + this.rng.next() * 13;
      const drift = this.temp(
        revolved(
          [
            [w, 0],
            [w * 0.78, 0.5 + this.rng.next() * 0.6],
            [w * 0.42, 1.1 + this.rng.next() * 0.9],
            [0.4, 1.5 + this.rng.next() * 1.1],
          ],
          9,
          0.28,
          this.rng,
        ),
      );
      this.ash.addAt(drift, p, this.rng.range(0, TAU), new THREE.Vector3(1, 1, 0.55 + this.rng.next() * 0.5));
    }
  }

  /** The caldera: the horizon landmark, 640 m out and 150 m high. */
  private buildCaldera(): void {
    const p = this.atSpawn(640, -110);
    const h = 150;
    const outer = 300;
    const cone = this.temp(
      revolved(
        [
          [outer, 0],
          [outer * 0.72, h * 0.32],
          [outer * 0.45, h * 0.66],
          [outer * 0.3, h * 0.92],
          [outer * 0.26, h],
          [outer * 0.21, h * 0.94],
        ],
        26,
        0.09,
        this.rng,
      ),
    );
    // No collision and no shadow: it is silhouette and atmosphere, and paying
    // for a 600 m shadow caster would buy nothing.
    const far = this.batch(
      'calderaMass',
      this.surface('rock', { repeat: 1, color: 0x2b2320, roughness: 0.96, metalness: 0 }),
      { tile: 14, collide: false, castShadow: false, receiveShadow: false },
    );
    far.addAt(cone, new THREE.Vector3(p.x, p.y - 12, p.z), this.rng.range(0, TAU), 1);

    // The rim, glowing. A ring band tucked just inside the crater lip.
    const rim = this.temp(bandRing(outer * 0.2, outer * 0.29, 34));
    this.fissure.addAt(rim, new THREE.Vector3(p.x, p.y - 12 + h * 0.95, p.z), 0, 1);

    // Lava streaks running down the flank, which is what gives the cone its
    // scale — a plain dark triangle on the horizon reads as a hill.
    for (let i = 0; i < 7; i++) {
      const a = this.rng.range(-1.2, 1.2) + Math.atan2(this.spawnPos.x - p.x, this.spawnPos.z - p.z);
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 5; k++) {
        const t = k / 5;
        const rr = outer * (0.26 + t * 0.62);
        const wob = Math.sin(t * 6 + i) * 0.08;
        pts.push(
          new THREE.Vector3(
            p.x + Math.sin(a + wob) * rr,
            p.y - 12 + h * (0.95 - t * 0.82),
            p.z + Math.cos(a + wob) * rr,
          ),
        );
      }
      this.fissure.add(this.temp(tube(pts, 2.6, 0.7, 4)));
    }

    this.smokeColumn(new THREE.Vector3(p.x, p.y - 12 + h * 0.9, p.z), 260, 430, 0.62);
  }

  /** Two nearer smoke columns, for aerial perspective to measure itself on. */
  private buildSmoke(): void {
    const a = this.atSpawn(210, 150);
    this.smokeColumn(new THREE.Vector3(a.x, a.y + 4, a.z), 34, 150, 0.5);
    const b = this.atSpawn(330, -60);
    this.smokeColumn(new THREE.Vector3(b.x, b.y + 4, b.z), 52, 210, 0.44);
  }

  /**
   * One column. A truncated cone shell, open-ended, with the smoke shader on it.
   * Not batched: each column needs its own height uniform, and three draw calls
   * for the world's defining silhouette is a bargain.
   */
  private smokeColumn(base: THREE.Vector3, radius: number, height: number, density: number): void {
    const geo = new THREE.CylinderGeometry(radius * 2.1, radius * 0.55, height, 18, 14, true);
    this.extraGeometry.push(geo);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uSmoke: { value: new THREE.Color(0x120c0a).convertSRGBToLinear() },
        uUnderlight: { value: new THREE.Color(LAVA_HOT).convertSRGBToLinear() },
        uTime: { value: 0 },
        uDensity: { value: density },
        uScale: { value: 26 / Math.max(height, 1) },
        uHeight: { value: height },
      },
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.own(mat);
    this.smokeMats.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(base.x, base.y + height * 0.5, base.z);
    mesh.renderOrder = 4;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.props.add(mesh);
  }

  /** Rising embers. One draw call, wrapped in a box that rides with the camera. */
  private buildEmbers(): void {
    const count = Math.round(600 * this.detail);
    const extent = 42;
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
        uHot: { value: new THREE.Color(LAVA_CORE).convertSRGBToLinear() },
        uCool: { value: new THREE.Color(LAVA_HOT).convertSRGBToLinear() },
        uCentre: { value: new THREE.Vector3() },
        uExtent: { value: extent },
        uTime: { value: 0 },
        uStrength: { value: 0.9 },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        varying float vFade;
        varying float vSeed;
        uniform vec3 uCentre;
        uniform float uExtent;
        uniform float uTime;
        void main(){
          // Embers rise fast and wander; the fold keeps the field endless.
          vec3 p = position;
          p.y += uTime * (1.6 + aSeed * 3.4);
          p.x += sin(uTime * 0.6 + aSeed * 51.0) * 2.4;
          p.z += cos(uTime * 0.5 + aSeed * 37.0) * 2.4;
          p = mod(p - uCentre + uExtent, uExtent * 2.0) - uExtent;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = length(mv.xyz);
          vFade = smoothstep(1.0, 4.0, d) * (1.0 - smoothstep(uExtent * 0.4, uExtent, d));
          vSeed = aSeed;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp((1.4 + aSeed * 2.6) * 26.0 / max(d, 1.0), 1.0, 6.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vFade;
        varying float vSeed;
        uniform vec3 uHot;
        uniform vec3 uCool;
        uniform float uStrength;
        uniform float uTime;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.03, length(d));
          // An ember cools as it climbs, and gutters as it goes.
          float life = fract(uTime * (0.09 + vSeed * 0.16) + vSeed);
          float flicker = 0.55 + 0.45 * sin(uTime * (6.0 + vSeed * 9.0) + vSeed * 61.0);
          vec3 col = mix(uHot, uCool, life) * flicker;
          gl_FragColor = vec4(col * a * vFade * (1.0 - life * 0.7) * uStrength, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.emberMat = this.own(mat);
    this.embers = new THREE.Points(geo, mat);
    this.embers.frustumCulled = false;
    this.embers.renderOrder = 6;
    this.props.add(this.embers);
  }

  /**
   * A pool right in front of the player.
   *
   * `PostFX` floors the volumetric medium at 0.004 regardless of the level's
   * fog, and Draco's sun is a huge blood-red disc, so the god-ray march came
   * back as hard-edged wedges across the whole sky. Halving the sun tint the
   * pass is handed keeps the shafts as shafts. Done after `super.load()` because
   * that is where the base copies the sky's sun colour in.
   */
  override async load(onProgress?: (t: number, label: string) => void): Promise<void> {
    await super.load(onProgress);
    this.sunColor.multiplyScalar(0.55);
  }

  // -- mission ---------------------------------------------------------------

  protected spawnVolumeSpecs(): SpawnVolumeSpec[] {
    return [
      // All of these used to sit 120-126 m out, past the 108 m the nav grid
      // actually covers, so they placed nothing at all and the whole legion
      // fight came from the single channel volume behind the player.
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
      { id: 'draco.court', forward: 100, right: -8, radius: 26, minPlayerDistance: 6 },
      { id: 'draco.gate', forward: 78, right: 4, radius: 26, minPlayerDistance: 6 },
      { id: 'draco.westWall', forward: 80, right: -28, radius: 14, minPlayerDistance: 14 },
      { id: 'draco.eastWall', forward: 80, right: 30, radius: 14, minPlayerDistance: 14 },
      { id: 'draco.viaduct', forward: 62, right: -28, radius: 14, minPlayerDistance: 14 },
      { id: 'draco.channel', forward: 52, right: 28, radius: 15, minPlayerDistance: 14 },
      { id: 'draco.rear', forward: -24, right: -10, radius: 17, minPlayerDistance: 16 },
    ];
  }

  /**
   * Chapter 5 — **Iron Choir**.
   *
   * The one world that already ended on a real boss, and the one whose middle
   * was hollow: "hold the basin" held nothing and the fortress the briefing
   * pointed at could not be entered. Now the approach is an arrival at the gate
   * threshold, the shield line is fought at the wall, and the third objective is
   * the campaign's last destructible — nine thousand points of Choir core on a
   * plinth inside the court, with the arena still spawning while it burns, which
   * is the only wave in the game whose `destroy` runs against live pressure
   * rather than after it.
   */
  protected encounterScript(): EncounterScript {
    return {
      id: 'draco-ix.legion',
      title: 'Iron Choir',
      completesLevel: true,
      score: 5200,
      waves: [
        {
          delay: 4,
          triggerFraction: 0,
          objective: 'Advance on the legion gate',
          trigger: { kind: 'reach', position: this.gatePos, radius: 14 },
          units: [
            { archetype: 'rept_skirmisher', count: 4 },
            { archetype: 'rept_legionary', count: 2 },
          ],
          volumes: ['draco.gate', 'draco.westWall', 'draco.viaduct'],
        },
        {
          delay: 3,
          triggerFraction: 0.6,
          objective: 'Break the shield line',
          units: [
            { archetype: 'rept_legionary', count: 5 },
            { archetype: 'rept_pyroclast', count: 3 },
            { archetype: 'rept_skirmisher', count: 3 },
          ],
          volumes: ['draco.gate', 'draco.westWall', 'draco.eastWall'],
        },
        {
          delay: 2.5,
          triggerFraction: 0.7,
          objective: 'Destroy the Choir core',
          trigger: { kind: 'destroy', targetId: 'draco.core' },
          units: [
            { archetype: 'rept_warbrute', count: 2 },
            { archetype: 'rept_ashpriest', count: 2 },
            { archetype: 'rept_legionary', count: 4 },
            { archetype: 'rept_skirmisher', count: 3 },
          ],
          volumes: ['draco.court', 'draco.gate', 'draco.eastWall'],
        },
      ],
      boss: { archetype: 'rept_tyrant', count: 1 },
      bossObjective: 'Kill Tyrant Vorrakh',
      bossDelay: 5,
    };
  }

  // -- frame -----------------------------------------------------------------

  protected override tick(ctx: FrameContext): void {
    const t = ctx.elapsed;

    // Lava breathes on a long, irregular cycle — two sines at incommensurate
    // rates, so it never reads as a loop.
    const pulse = 1 + Math.sin(t * 0.37) * 0.11 + Math.sin(t * 0.91 + 2.1) * 0.06;
    this.lavaMat.emissiveIntensity = 3.1 * pulse;
    this.fissureMat.emissiveIntensity = 2.5 * pulse;
    for (let i = 0; i < this.lavaLights.length; i++) {
      const l = this.lavaLights[i];
      // Scaled from each light's authored intensity rather than a single shared
      // constant: the channel and the braziers are different kinds of source and
      // a flat value here silently undid whichever of the two it did not match.
      l.intensity = this.lavaBase[i] * (pulse + Math.sin(t * 2.3 + i * 1.7) * 0.06);
    }
    for (const m of this.smokeMats) m.uniforms.uTime.value = t;

    if (this.emberMat) {
      this.emberMat.uniforms.uTime.value = t;
      (this.emberMat.uniforms.uCentre.value as THREE.Vector3).copy(this.camPos);
      if (this.embers) this.embers.position.copy(this.camPos);
    }

    // Occasional spatter off the channel, cursored so only one vent is ever
    // considered per tick.
    this.ventTimer -= ctx.dt;
    if (this.ventTimer <= 0 && this.vents.length > 0) {
      this.ventTimer = 1.1;
      this.ventCursor = (this.ventCursor + 1) % this.vents.length;
      const p = this.vents[this.ventCursor];
      if (p.distanceToSquared(this.camPos) < 80 * 80) {
        this.vfx.impact(p, _up, 'energy', 0.5 + clamp01(this.rng.next()) * 0.7);
      }
    }
  }

  override dispose(): void {
    for (const l of this.lavaLights) l.dispose();
    this.lavaLights.length = 0;
    this.lavaBase.length = 0;
    for (const g of this.extraGeometry) g.dispose();
    this.extraGeometry.length = 0;
    this.smokeMats.length = 0;
    this.embers = null;
    this.emberMat = null;
    super.dispose();
  }
}

registerPlanet(
  'draco-ix',
  (deps: PlanetDeps, descriptor: PlanetDescriptor) => new DracoIXLevel(deps, descriptor),
);
