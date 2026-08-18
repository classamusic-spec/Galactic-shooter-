/**
 * DecalSystem — the memory of a firefight.
 *
 * Every decal is one instanced quad projected onto the surface tangent frame at
 * the hit point, nudged 1.5 cm along the normal and rendered with a polygon
 * offset so it never z-fights the wall it sits on. The mark itself is drawn
 * procedurally in the fragment shader from a `kind` + `variant` pair, which is
 * why a hundred bullet holes across six surface types still cost exactly one
 * draw call and zero texture memory.
 *
 * The buffer is a ring at `settings.profile.decalBudget`. Rather than popping
 * the oldest mark out of existence when the ring wraps, each instance carries a
 * monotonic sequence number and the shader fades it against the live head, so
 * the oldest quarter of the buffer dissolves continuously as new hits land.
 */
import * as THREE from 'three';
import type { SurfaceKind } from '@/types';
import { GLSL_NOISE } from '@/gfx/materials/glsl';

export type DecalKind = 'bulletHole' | 'scorch' | 'blood' | 'ichor' | 'crack' | 'energyBurn';

const KIND_ID: Record<DecalKind, number> = {
  bulletHole: 0,
  scorch: 1,
  blood: 2,
  ichor: 3,
  crack: 4,
  energyBurn: 5,
};

/** Bullet-hole variants. The shader branches on this to change the crater. */
const SURFACE_VARIANT: Record<SurfaceKind, number> = {
  rock: 0,
  concrete: 0,
  sand: 1,
  metal: 2,
  ice: 3,
  glass: 4,
  organic: 5,
  chitin: 5,
  flesh: 5,
  foliage: 1,
  water: 1,
  energy: 6,
};

/** Default mark colours per surface, sRGB. */
const SURFACE_COLOR: Record<SurfaceKind, number> = {
  rock: 0x2b2723,
  concrete: 0x33312e,
  sand: 0x6b5a41,
  metal: 0x24262a,
  ice: 0xbfe4f2,
  glass: 0xd8ecf5,
  organic: 0x3a1d18,
  chitin: 0x241a12,
  flesh: 0x47100d,
  foliage: 0x1e2a14,
  water: 0x9fc4d6,
  energy: 0x7fd8ff,
};

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _col = new THREE.Color();

export class DecalSystem {
  readonly object: THREE.Mesh;
  readonly capacity: number;

  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aCen: THREE.InstancedBufferAttribute;
  private aRight: THREE.InstancedBufferAttribute;
  private aUp: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aA: THREE.InstancedBufferAttribute; // spawn, life, kind, variant
  private aB: THREE.InstancedBufferAttribute; // seq, opacity, seed, rough

  private head = 0;
  private seq = 0;
  private wrapped = false;
  private dirtyLo = Infinity;
  private dirtyHi = -Infinity;
  private time = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(16, Math.floor(capacity));
    const n = this.capacity;

    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
        3,
      ),
    );
    this.geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);

    this.aCen = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aRight = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aUp = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    for (const a of [this.aCen, this.aRight, this.aUp, this.aCol, this.aA, this.aB]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    this.geo.setAttribute('iCen', this.aCen);
    this.geo.setAttribute('iRight', this.aRight);
    this.geo.setAttribute('iUp', this.aUp);
    this.geo.setAttribute('iCol', this.aCol);
    this.geo.setAttribute('iA', this.aA);
    this.geo.setAttribute('iB', this.aB);
    this.geo.instanceCount = 0;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uHead: { value: 0 },
        uCapacity: { value: this.capacity },
        uFade: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 iCen;
        attribute vec3 iRight;
        attribute vec3 iUp;
        attribute vec3 iCol;
        attribute vec4 iA;
        attribute vec4 iB;
        uniform float uTime;
        uniform float uHead;
        uniform float uCapacity;
        uniform float uFade;
        varying vec2 vUv;
        varying vec3 vCol;
        varying float vKind;
        varying float vVariant;
        varying float vSeed;
        varying float vOpacity;
        varying float vAge;
        varying float vAgeSec;

        void main() {
          vUv = uv;
          vCol = iCol;
          vKind = iA.z;
          vVariant = iA.w;
          vSeed = iB.z;

          float t = uTime - iA.x;
          float a = t / max(iA.y, 1e-4);
          vAge = a;
          vAgeSec = max(t, 0.0);

          // Pressure fade: the oldest 25% of the ring dissolves as it is reused.
          float slotAge = clamp((uHead - iB.x) / max(uCapacity, 1.0), 0.0, 1.0);
          float press = 1.0 - smoothstep(0.72, 1.0, slotAge);

          if (iA.y <= 0.0 || t < 0.0 || a >= 1.0 || press <= 0.001) {
            vOpacity = 0.0;
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          // Fade-in is in *seconds*, not a fraction of life. Scaling it by the
          // normalised age meant a 45-second bullet hole took 2.7 s to become
          // visible — every mark was invisible for the moment it mattered.
          vOpacity = iB.y * press * uFade
                   * smoothstep(0.0, 0.05, t)
                   * (1.0 - smoothstep(0.80, 1.0, a));

          vec3 wp = iCen + iRight * position.x + iUp * position.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader:
        GLSL_NOISE +
        /* glsl */ `
        varying vec2 vUv;
        varying vec3 vCol;
        varying float vKind;
        varying float vVariant;
        varying float vSeed;
        varying float vOpacity;
        varying float vAge;
        varying float vAgeSec;

        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          if (r > 1.0) discard;
          float ang = atan(p.y, p.x);
          vec2 sp = p * 1.7 + vec2(vSeed * 91.0, vSeed * 37.0);

          float a = 0.0;
          vec3 col = vCol;
          float emissive = 0.0;

          if (vKind < 0.5) {
            // ---- bullet hole ---------------------------------------------
            float wob = fbm(sp * 2.2, 3, 2.1, 0.5) * 0.22;
            float hole = 1.0 - smoothstep(0.22 + wob, 0.44 + wob, r);
            float rim = (1.0 - smoothstep(0.40 + wob, 0.78 + wob, r)) * smoothstep(0.18, 0.40, r);
            float dust = (1.0 - smoothstep(0.45, 1.0, r)) * (0.45 + 0.55 * (fbm(sp * 3.4, 3, 2.0, 0.5) * 0.5 + 0.5));

            if (vVariant < 0.5) {
              // rock / concrete: chipped crater, pale pulverised rim
              a = hole * 0.95 + rim * 0.55 + dust * 0.32;
              col = mix(vCol * 0.25, vCol * 2.6, rim * 0.8 + dust * 0.5);
            } else if (vVariant < 1.5) {
              // sand / soft: shallow dished depression, no hard edge
              a = (hole * 0.6 + dust * 0.5) * 0.8;
              col = mix(vCol * 0.45, vCol * 1.5, dust);
            } else if (vVariant < 2.5) {
              // metal: dark punch-through, bright deformed lip, radial scuff
              float streak = pow(max(0.0, 1.0 - r), 2.0)
                           * (0.5 + 0.5 * sin(ang * 9.0 + vSeed * 30.0));
              a = hole + rim * 0.9 + streak * 0.25;
              col = mix(vCol * 0.15, vec3(0.85, 0.87, 0.95), rim * 1.1 + streak * 0.4);
            } else if (vVariant < 3.5) {
              // ice: white shatter star
              float star = pow(max(0.0, 1.0 - r), 1.6)
                         * (0.35 + 0.65 * abs(sin(ang * 5.0 + vSeed * 19.0)));
              a = hole * 0.8 + star * 0.7;
              col = mix(vCol * 0.5, vec3(1.4, 1.7, 1.9), star);
              emissive = star * 0.25;
            } else if (vVariant < 4.5) {
              // glass: spiderweb
              float web = 0.0;
              for (int i = 0; i < 5; i++) {
                float fa = float(i) * 1.2566 + vSeed * 6.0;
                vec2 d = vec2(cos(fa), sin(fa));
                float lineD = abs(dot(p, vec2(-d.y, d.x)));
                web = max(web, (1.0 - smoothstep(0.0, 0.035, lineD)) * step(dot(p, d), 0.95));
              }
              float rings = 1.0 - smoothstep(0.0, 0.03, abs(fract(r * 3.0 + vSeed) - 0.5) - 0.34);
              a = hole * 0.9 + web * 0.85 + rings * 0.4 * step(r, 0.9);
              col = vec3(1.2, 1.5, 1.7);
              emissive = (web + rings) * 0.35;
            } else if (vVariant < 5.5) {
              // organic / chitin / flesh: wet dark puncture
              a = hole * 1.0 + rim * 0.45;
              col = mix(vCol * 0.2, vCol * 1.3, rim);
            } else {
              // energy surface: etched glow
              a = hole * 0.8 + rim * 0.6;
              col = vCol * 2.5;
              emissive = 1.0;
            }
          } else if (vKind < 1.5) {
            // ---- scorch ---------------------------------------------------
            float n = fbm(sp * 2.0, 4, 2.1, 0.55) * 0.5 + 0.5;
            float body = 1.0 - smoothstep(0.10, 0.88 + n * 0.14, r);
            a = clamp(body * (0.75 + n * 0.55), 0.0, 1.0);
            col = mix(vCol * 0.15, vCol * 1.6, n * body);
            // Cooling ember ring, only while fresh.
            // Ember decay is in seconds: tying it to normalised age left a
            // 50-second scorch glowing orange for the first 17 of them.
            float ember = (1.0 - smoothstep(0.0, 0.10, abs(r - 0.62 - n * 0.1)))
                        * (1.0 - smoothstep(0.0, 1.6, vAgeSec));
            col += vec3(1.5, 0.45, 0.08) * ember * 0.9;
            emissive = ember * 0.55;
          } else if (vKind < 3.5) {
            // ---- blood / ichor --------------------------------------------
            float n = fbm(sp * 2.6, 4, 2.2, 0.55) * 0.5 + 0.5;
            // Sampling the boundary on the unit circle keeps the outline
            // continuous and organic; a sin(4*ang) term made every splat a
            // four-pointed star.
            float edgeN = fbm(vec2(cos(ang), sin(ang)) * 2.3 + vSeed * 31.0, 3, 2.1, 0.5) * 0.5 + 0.5;
            float lobes = 0.40 + 0.34 * edgeN + 0.10 * n;
            float body = 1.0 - smoothstep(lobes - 0.10, lobes + 0.08, r);
            // Satellite droplets around the main splat.
            vec3 w = worley(p * 3.4 + vSeed * 17.0);
            float drops = (1.0 - smoothstep(0.10, 0.20, w.x))
                        * smoothstep(lobes, lobes + 0.5, r)
                        * step(0.45, w.z);
            a = body + drops * 0.85;
            // Wet centre reads darker and glossier than the drying edge.
            float wet = smoothstep(lobes, 0.0, r);
            col = mix(vCol * 0.5, vCol * (vKind < 2.5 ? 1.0 : 1.5), wet);
            if (vKind > 2.5) emissive = wet * 0.55;
            a *= 1.0 - vAge * 0.25;
          } else if (vKind < 4.5) {
            // ---- crack ------------------------------------------------------
            vec3 w = worley(p * 7.0 + vSeed * 31.0);
            float edge = (1.0 - smoothstep(0.0, 0.030, w.y - w.x)) * 0.5;
            float mask = 1.0 - smoothstep(0.15, 0.95, r);
            a = edge * mask;
            col = vCol * 0.5;
            // Radial fracture from the impact point on top of the cell network.
            float rad = 0.0;
            for (int i = 0; i < 6; i++) {
              float fa = float(i) * 1.0472 + vSeed * 8.0;
              vec2 d = vec2(cos(fa), sin(fa));
              float along = dot(p, d);
              // Taper each fracture so it is widest at the impact and dies out.
              float wdt = 0.012 + along * 0.030;
              rad = max(rad, (1.0 - smoothstep(0.0, max(wdt, 0.004), abs(dot(p, vec2(-d.y, d.x)))))
                            * step(0.0, along) * (1.0 - smoothstep(0.25, 0.95, along)));
            }
            a = max(a, rad);
          } else {
            // ---- energy burn ------------------------------------------------
            float n = fbm(sp * 3.0, 3, 2.1, 0.5) * 0.5 + 0.5;
            float ring = 1.0 - smoothstep(0.0, 0.16, abs(r - mix(0.35, 0.85, vAge)));
            float core = (1.0 - smoothstep(0.0, 0.75, r)) * (0.4 + n * 0.7);
            a = ring * 0.9 + core * 0.5;
            col = vCol * (1.1 + ring * 1.5);
            emissive = 1.0;
          }

          a *= vOpacity;
          if (a <= 0.004) discard;
          // Premultiplied output: emissive fraction blends additively, the rest
          // occludes the surface underneath.
          gl_FragColor = vec4(col * a, a * (1.0 - clamp(emissive, 0.0, 1.0)));
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    });

    this.object = new THREE.Mesh(this.geo, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
    this.object.name = 'vfx.decals';
    this.object.matrixAutoUpdate = false;
  }

  /** Map a surface kind to the mark a bullet leaves in it. */
  static kindForSurface(surface: SurfaceKind): DecalKind {
    switch (surface) {
      case 'glass':
        return 'crack';
      case 'flesh':
        return 'blood';
      case 'organic':
      case 'chitin':
        return 'ichor';
      case 'energy':
        return 'energyBurn';
      default:
        return 'bulletHole';
    }
  }

  static colorForSurface(surface: SurfaceKind): number {
    return SURFACE_COLOR[surface] ?? 0x2b2723;
  }

  /**
   * Place a decal. `normal` must be the surface normal; the tangent frame is
   * derived from it with a stable up-vector choice plus a random roll so
   * repeated hits on the same wall never form a visible grid.
   */
  place(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    kind: DecalKind,
    size: number,
    color: number,
    life = 45,
    opacity = 1,
    surface: SurfaceKind | null = null,
  ): void {
    if (size <= 0) return;
    const n = _v3a.copy(normal);
    if (n.lengthSq() < 1e-6) n.set(0, 1, 0);
    n.normalize();

    // Tangent frame with a random roll about the normal.
    const helper = Math.abs(n.y) > 0.92 ? _v3b.set(1, 0, 0) : _v3b.set(0, 1, 0);
    const right = _v3c.crossVectors(helper, n).normalize();
    const roll = Math.random() * Math.PI * 2;
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    // up = n x right, then rotate (right, up) by `roll` in the tangent plane.
    const ux = n.y * right.z - n.z * right.y;
    const uy = n.z * right.x - n.x * right.z;
    const uz = n.x * right.y - n.y * right.x;
    const half = size * 0.5;
    const rx = (right.x * cr + ux * sr) * half;
    const ry = (right.y * cr + uy * sr) * half;
    const rz = (right.z * cr + uz * sr) * half;
    const vx = (-right.x * sr + ux * cr) * half;
    const vy = (-right.y * sr + uy * cr) * half;
    const vz = (-right.z * sr + uz * cr) * half;

    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this.wrapped = true;
    this.seq++;

    const p3 = i * 3;
    const p4 = i * 4;
    // Lift off the surface: enough to clear depth precision at 4 km far plane,
    // small enough that the mark never floats at a grazing angle.
    const lift = 0.012 + size * 0.01;
    this.aCen.array[p3] = point.x + n.x * lift;
    this.aCen.array[p3 + 1] = point.y + n.y * lift;
    this.aCen.array[p3 + 2] = point.z + n.z * lift;
    this.aRight.array[p3] = rx;
    this.aRight.array[p3 + 1] = ry;
    this.aRight.array[p3 + 2] = rz;
    this.aUp.array[p3] = vx;
    this.aUp.array[p3 + 1] = vy;
    this.aUp.array[p3 + 2] = vz;
    _col.setHex(color, THREE.SRGBColorSpace);
    this.aCol.array[p3] = _col.r;
    this.aCol.array[p3 + 1] = _col.g;
    this.aCol.array[p3 + 2] = _col.b;

    this.aA.array[p4] = this.time;
    this.aA.array[p4 + 1] = life;
    this.aA.array[p4 + 2] = KIND_ID[kind];
    this.aA.array[p4 + 3] = surface ? (SURFACE_VARIANT[surface] ?? 0) : 0;

    this.aB.array[p4] = this.seq;
    this.aB.array[p4 + 1] = opacity;
    this.aB.array[p4 + 2] = Math.random();
    this.aB.array[p4 + 3] = 0;

    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
  }

  setSimTime(t: number): void {
    this.time = t;
  }

  flush(renderTime: number): void {
    this.mat.uniforms.uTime.value = renderTime;
    this.mat.uniforms.uHead.value = this.seq;
    if (this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo;
      const c = this.dirtyHi - lo + 1;
      this.mark(this.aCen, lo, c, 3);
      this.mark(this.aRight, lo, c, 3);
      this.mark(this.aUp, lo, c, 3);
      this.mark(this.aCol, lo, c, 3);
      this.mark(this.aA, lo, c, 4);
      this.mark(this.aB, lo, c, 4);
      this.dirtyLo = Infinity;
      this.dirtyHi = -Infinity;
    }
    this.geo.instanceCount = this.wrapped ? this.capacity : this.head;
  }

  private mark(attr: THREE.InstancedBufferAttribute, lo: number, count: number, item: number): void {
    attr.clearUpdateRanges();
    attr.addUpdateRange(lo * item, count * item);
    attr.needsUpdate = true;
  }

  setFade(f: number): void {
    this.mat.uniforms.uFade.value = f;
  }

  clear(): void {
    this.head = 0;
    this.wrapped = false;
    this.geo.instanceCount = 0;
    this.dirtyLo = Infinity;
    this.dirtyHi = -Infinity;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
