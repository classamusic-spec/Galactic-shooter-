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

    this.buildForeground();
    this.buildLavaChannel();
    this.buildApproach();
    this.buildFortress();
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
      const p = this.atSpawn(7 + this.rng.range(-1.5, 1.5), -9 + i * 3.4);
      const g = this.temp(tapered(3.4, 0.7 + this.rng.next() * 0.8, 2.1, 0.35, 0.4, 0.16, this.rng));
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
      const forward = 48 + t * 66;
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
    const centre = this.atSpawn(126, 4);
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
    // A dark recess behind the arch, so the gateway reads as a way through.
    const recess = this.temp(tapered(gateHalf * 2, wallH, 1.2, 0.02, 0, 0, this.rng));
    _tmp.copy(centre).addScaledVector(fwd, 2.6).setY(pad - 1.4);
    this.basalt.addAt(recess, _tmp, yaw, 1);

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
      { id: 'draco.gate', forward: 126, right: 4, radius: 12 },
      { id: 'draco.westWall', forward: 120, right: -34, radius: 12 },
      { id: 'draco.eastWall', forward: 120, right: 38, radius: 12 },
      { id: 'draco.channel', forward: 58, right: 30, radius: 14, minPlayerDistance: 30 },
    ];
  }

  protected encounterScript(): EncounterScript {
    return {
      id: 'draco-ix.legion',
      completesLevel: true,
      score: 5200,
      waves: [
        {
          delay: 4,
          triggerFraction: 0,
          objective: 'Advance on the legion gate',
          units: [
            { archetype: 'rept_skirmisher', count: 4 },
            { archetype: 'rept_legionary', count: 2 },
          ],
          volumes: ['draco.gate', 'draco.westWall'],
        },
        {
          delay: 3,
          triggerFraction: 0.6,
          objective: 'Break the shield line',
          units: [
            { archetype: 'rept_legionary', count: 4 },
            { archetype: 'rept_pyroclast', count: 2 },
            { archetype: 'rept_skirmisher', count: 3 },
          ],
        },
        {
          delay: 2.5,
          triggerFraction: 0.7,
          objective: 'Hold the basin',
          units: [
            { archetype: 'rept_warbrute', count: 2 },
            { archetype: 'rept_ashpriest', count: 1 },
            { archetype: 'rept_legionary', count: 3 },
          ],
        },
      ],
      boss: { archetype: 'rept_tyrant', count: 1 },
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
