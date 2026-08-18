/**
 * ParticlePool — the GPU-simulated particle substrate every other effect draws on.
 *
 * The whole system is built around one rule: **the CPU only ever writes on
 * spawn**. A particle's entire trajectory — drag, gravity, turbulence, floor
 * bounce, size curve, spin — is a closed-form function of `t = u_time - spawn`
 * evaluated in the vertex shader. That means a 400-particle explosion costs one
 * burst of attribute writes and then literally zero per-frame CPU work, and it
 * means the simulation is frame-rate independent for free.
 *
 * Storage is a ring buffer per family with `addUpdateRange()` partial uploads,
 * so a spawn burst re-uploads only the slots it touched instead of the whole
 * 9000-particle buffer.
 *
 * Blending is *premultiplied alpha* everywhere (src=ONE, dst=1-SRC_ALPHA). That
 * single choice lets additive and alpha-blended particles live in the same draw
 * call: a fragment that writes `vec4(rgb, 0)` is pure additive, one that writes
 * `vec4(rgb*a, a)` is normal alpha, and anything in between is a correct blend
 * of the two. Smoke can be lit and occluding while the embers inside it glow,
 * without splitting the family.
 */
import * as THREE from 'three';
import { GLSL_NOISE } from '@/gfx/materials/glsl';

export type ParticleShape = 'puff' | 'fire' | 'spark' | 'glow' | 'chip' | 'mote';

const SHAPE_ID: Record<ParticleShape, number> = {
  puff: 0,
  fire: 1,
  spark: 2,
  glow: 3,
  chip: 4,
  mote: 5,
};

/** Shapes whose fragment stage needs the noise library. Keeps programs small. */
const NEEDS_NOISE: Record<ParticleShape, boolean> = {
  puff: true,
  fire: true,
  spark: false,
  glow: false,
  chip: false,
  mote: false,
};

export interface FamilyOptions {
  capacity: number;
  shape: ParticleShape;
  /** Stretch the quad along screen-space velocity (sparks, tracer wake). */
  stretch?: boolean;
  /** Fold the trajectory off a horizontal plane at `SpawnDesc.floorY`. */
  bounce?: boolean;
  /** Soft-particle fade distance in metres. 0 disables. */
  soften?: number;
  renderOrder?: number;
}

const _col = new THREE.Color();

/**
 * A spawn request. One shared mutable instance is reused for every emit in the
 * frame — chaining setters keeps the recipe code readable without allocating.
 */
export class SpawnDesc {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  r = 1;
  g = 1;
  b = 1;
  life = 1;
  size0 = 0.2;
  size1 = 0.4;
  /** Velocity damping coefficient, 1/s. Higher = stops faster. */
  drag = 1.5;
  /** Downward acceleration, m/s². */
  gravity = 0;
  /** Quad spin rate, rad/s. */
  spin = 0;
  opacity = 1;
  /** Screen-space velocity stretch factor (stretch families only). */
  stretch = 0;
  floorY = -1e9;
  turbulence = 0;
  /** Seconds to delay the spawn — this is how effect *sequences* are built. */
  delay = 0;

  reset(): this {
    this.x = this.y = this.z = 0;
    this.vx = this.vy = this.vz = 0;
    this.r = this.g = this.b = 1;
    this.life = 1;
    this.size0 = 0.2;
    this.size1 = 0.4;
    this.drag = 1.5;
    this.gravity = 0;
    this.spin = 0;
    this.opacity = 1;
    this.stretch = 0;
    this.floorY = -1e9;
    this.turbulence = 0;
    this.delay = 0;
    return this;
  }

  at(v: THREE.Vector3): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  atXyz(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  vel(x: number, y: number, z: number): this {
    this.vx = x;
    this.vy = y;
    this.vz = z;
    return this;
  }

  /** Authoring colours are sRGB hex; the render target is linear. */
  tint(hex: number, intensity = 1): this {
    _col.setHex(hex, THREE.SRGBColorSpace);
    this.r = _col.r * intensity;
    this.g = _col.g * intensity;
    this.b = _col.b * intensity;
    return this;
  }

  tintRgb(r: number, g: number, b: number, intensity = 1): this {
    this.r = r * intensity;
    this.g = g * intensity;
    this.b = b * intensity;
    return this;
  }

  size(a: number, b: number): this {
    this.size0 = a;
    this.size1 = b;
    return this;
  }

  live(life: number, opacity = 1): this {
    this.life = life;
    this.opacity = opacity;
    return this;
  }
}

// ---------------------------------------------------------------------------
// Shader source
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec3 iCol;
attribute vec4 iA;   // spawn, life, size0, size1
attribute vec4 iB;   // drag, gravity, seed, spin
attribute vec4 iC;   // opacity, stretch, floorY, turbulence

uniform float uTime;
uniform float uFade;

varying vec3 vCol;
varying float vAge;
varying float vOpacity;
varying float vSeed;
varying vec2 vUv;
varying float vViewDist;
varying vec2 vProj;
varying vec3 vViewNormalHint;

void main() {
  vUv = uv;
  vCol = iCol;
  vSeed = iB.z;

  float life = iA.y;
  float t = uTime - iA.x;
  float a = t / max(life, 1e-4);
  vAge = a;

  if (life <= 0.0 || t < 0.0 || a >= 1.0) {
    // Retired or not yet born: collapse to a degenerate point behind the eye.
    vOpacity = 0.0;
    vViewDist = 1.0;
    vProj = vec2(-1.0, -1.0);
    vViewNormalHint = vec3(0.0, 0.0, 1.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // -- closed-form trajectory: linear drag + constant gravity ---------------
  float k = max(iB.x, 1e-3);
  float ik = 1.0 / k;
  float e = 1.0 - exp(-k * t);
  vec3 p = iPos + iVel * (e * ik);
  p.y -= iB.y * (t - e * ik) * ik;

  // Turbulence: three decorrelated sines. Cheap, and enough to stop a smoke
  // column reading as a set of parallel rails.
  float turb = iC.w;
  if (turb > 0.0) {
    float s = iB.z * 43.7;
    p += turb * t * vec3(
      sin(t * 1.7 + s),
      sin(t * 2.3 + s * 1.7) * 0.55,
      cos(t * 1.31 + s * 2.3)
    );
  }

  vec3 vel = iVel * exp(-k * t);
  vel.y -= iB.y * e * ik;

#ifdef GF_BOUNCE
  // Folding the parabola about the ground plane with an exponential decay reads
  // as a bounce that loses energy and settles, for the cost of two ALU ops.
  float dy = p.y - iC.z;
  if (dy < 0.0) {
    float damp = exp(-3.2 * t);
    p.y = iC.z - dy * 0.45 * damp;
    vel.y = abs(vel.y) * 0.45 * damp;
  }
#endif

  // Front-loaded growth. Real dust and fireballs do most of their expansion in
  // the first 20% of their life and then coast; a symmetric smoothstep makes
  // every puff look like an inflating balloon instead of a burst.
  float grow = mix(iA.z, iA.w, pow(a, 0.42));
  float sz = max(grow, 1e-4);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);

#ifdef GF_STRETCH
  vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
  float sp = length(vv.xy);
  vec2 dir = sp > 1e-4 ? vv.xy / sp : vec2(0.0, 1.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float len = sz * (1.0 + iC.y * sp);
  mv.xy += dir * (position.y * len) + perp * (position.x * sz);
  vViewNormalHint = vec3(dir, 0.0);
#else
  float rot = iB.z * 6.2831853 + iB.w * t;
  float c = cos(rot), s = sin(rot);
  vec2 q = position.xy * sz;
  mv.xy += vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  vViewNormalHint = vec3(0.0, 0.0, 1.0);
#endif

  vViewDist = -mv.z;
  // Fade out as the quad reaches the near plane so a particle spawned on the
  // camera does not flash the whole screen.
  vOpacity = iC.x * uFade * smoothstep(0.04, 0.45, vViewDist);

  gl_Position = projectionMatrix * mv;
  // projectionMatrix is only bound to the vertex stage; forward the two terms
  // the fragment stage needs to linearise the depth buffer.
  vProj = vec2(projectionMatrix[2][2], projectionMatrix[3][2]);
}
`;

const FRAG_HEAD = /* glsl */ `
uniform sampler2D uDepth;
uniform float uHasDepth;
uniform float uSoften;

varying vec3 vCol;
varying float vAge;
varying float vOpacity;
varying float vSeed;
varying vec2 vUv;
varying float vViewDist;
varying vec2 vProj;
varying vec3 vViewNormalHint;

/** Distance from the eye to the opaque scene behind this fragment, in metres. */
float gfSceneDist() {
  vec2 uvS = gl_FragCoord.xy / vec2(textureSize(uDepth, 0));
  float d = texture2D(uDepth, uvS).x;
  float ndc = d * 2.0 - 1.0;
  return vProj.y / (ndc + vProj.x);
}

float gfSoft() {
  if (uHasDepth < 0.5 || uSoften <= 0.0) return 1.0;
  float sd = gfSceneDist();
  if (sd <= 0.0 || sd > 1e5) return 1.0;
  return clamp((sd - vViewDist) / uSoften, 0.0, 1.0);
}

/** Fixed view-space key light so puffs and chips read as volumes, not discs. */
const vec3 GF_KEY = vec3(0.42, 0.72, 0.55);
`;

const FRAG_MAIN: Record<number, string> = {
  // -- puff: smoke and dust. Noise-eroded, lit, dissipating. -----------------
  0: /* glsl */ `
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;
  if (r > 1.0) discard;

  // Two noise scales, the second domain-warped by the first. Thresholding a
  // single octave only erodes the rim and leaves a cotton-ball interior; using
  // the density field to drive alpha *continuously* is what gives a puff
  // internal structure you can see through.
  vec2 np = p * 4.2 + vec2(vSeed * 61.0, vSeed * 137.0);
  float n = fbm(np, 3, 2.15, 0.55) * 0.5 + 0.5;
  float wisp = fbm(np * 2.6 + n * 1.5, 2, 2.0, 0.5) * 0.5 + 0.5;

  float base = pow(max(0.0, 1.0 - r), 1.25);
  float density = base * (0.10 + n * 1.35) * (0.5 + wisp * 0.95);
  // Dissipation opens holes in the cloud as it ages instead of just dimming it.
  float diss = 1.0 - smoothstep(0.02, 1.0, vAge);
  float a = clamp(density * mix(0.4, 1.5, diss) - (1.0 - diss) * 0.14, 0.0, 1.0);
  a *= smoothstep(0.0, 0.07, vAge);
  a *= vOpacity * gfSoft();
  if (a <= 0.004) discard;

  // Sphere-impostor normal + a density term standing in for self-shadowing.
  vec3 nrm = normalize(vec3(p * 2.2, sqrt(max(1e-4, 1.0 - r * r))));
  float lit = 0.20 + 0.80 * max(dot(nrm, GF_KEY), 0.0);
  lit *= mix(0.5, 1.35, n);
  vec3 col = vCol * lit;

  gl_FragColor = vec4(col * a, a);
  `,

  // -- fire: rolling volumetric core with an HDR white-hot centre ------------
  1: /* glsl */ `
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;
  if (r > 1.0) discard;

  // The third noise axis is time: the flame rolls instead of scrolling.
  float n = fbm3(vec3(p * 3.4, vAge * 2.4 + vSeed * 17.0), 3, 2.15, 0.55) * 0.5 + 0.5;
  float body = pow(max(0.0, 1.0 - r), 1.1) * (0.06 + n * 1.7);
  float thr = mix(0.10, 0.85, vAge);
  float a = clamp((body - thr) * 2.4, 0.0, 1.0);
  a *= smoothstep(0.0, 0.04, vAge);
  a *= vOpacity * gfSoft();
  if (a <= 0.003) discard;

  float heat = clamp(body * (1.25 - vAge * 1.1), 0.0, 1.4);
  vec3 col = vCol * (0.30 + heat * 1.15);
  col += vec3(1.0, 0.82, 0.55) * pow(clamp(heat, 0.0, 1.0), 7.0) * 1.8;
  // Sooty edge as it cools: the transition from flame to smoke in one sprite.
  col = mix(col, vCol * 0.06, smoothstep(0.45, 1.0, vAge) * (1.0 - heat));

  gl_FragColor = vec4(col * a, a * 0.30);
  `,

  // -- spark: stretched additive filament with a blown-out core --------------
  2: /* glsl */ `
  vec2 p = vUv - 0.5;
  float across = abs(p.x) * 2.0;
  float along = abs(p.y) * 2.0;
  float core = (1.0 - smoothstep(0.0, 0.6, across)) * (1.0 - smoothstep(0.05, 1.0, along));
  if (core <= 0.001) discard;

  float a = core * core;
  a *= 0.62 + 0.38 * sin(vSeed * 97.0 + vAge * 120.0);
  a *= 1.0 - smoothstep(0.40, 1.0, vAge);
  a *= vOpacity * gfSoft();
  if (a <= 0.002) discard;

  // Tight white core, coloured body: a broad white boost washes the element
  // colour out of every spark and they all read as the same generic sparkle.
  vec3 col = vCol * (1.0 + 3.0 * pow(core, 9.0));
  gl_FragColor = vec4(col * a, 0.0);
  `,

  // -- glow: soft radial light blob, pure additive ---------------------------
  3: /* glsl */ `
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;
  if (r > 1.0) discard;

  float a = exp(-r * r * 3.6);
  a *= 1.0 - smoothstep(0.0, 1.0, vAge * vAge);
  a *= vOpacity * gfSoft();
  if (a <= 0.002) discard;

  vec3 col = vCol * (1.0 + 3.5 * exp(-r * r * 16.0));
  gl_FragColor = vec4(col * a, 0.0);
  `,

  // -- chip: hard-edged shaded fleck of solid matter -------------------------
  4: /* glsl */ `
  vec2 p = (vUv - 0.5) * 2.0;
  float ang = atan(p.y, p.x);
  float rad = length(p);
  float edge = 0.58 + 0.30 * sin(ang * 3.0 + vSeed * 31.0) + 0.14 * sin(ang * 5.0 - vSeed * 17.0);
  if (rad > edge) discard;

  float facet = 0.5 + 0.5 * sin(vSeed * 23.0 + vAge * 26.0 + ang);
  float lit = 0.22 + 0.95 * facet;
  float a = vOpacity * (1.0 - smoothstep(0.72, 1.0, vAge)) * gfSoft();
  a *= smoothstep(edge, edge - 0.12, rad);
  if (a <= 0.002) discard;

  gl_FragColor = vec4(vCol * lit * a, a);
  `,

  // -- mote: tiny air particulate, mostly additive ---------------------------
  5: /* glsl */ `
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;
  if (r > 1.0) discard;
  float a = 1.0 - smoothstep(0.0, 1.0, r);
  a = a * a * vOpacity * sin(clamp(vAge, 0.0, 1.0) * 3.14159) * gfSoft();
  if (a <= 0.002) discard;
  gl_FragColor = vec4(vCol * a, a * 0.25);
  `,
};

function buildQuad(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  );
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// ---------------------------------------------------------------------------
// ParticleFamily
// ---------------------------------------------------------------------------

/** One draw call. One ring buffer. One blend mode. */
export class ParticleFamily {
  readonly object: THREE.Mesh;
  readonly capacity: number;
  readonly shape: ParticleShape;

  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aPos: THREE.InstancedBufferAttribute;
  private aVel: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aA: THREE.InstancedBufferAttribute;
  private aB: THREE.InstancedBufferAttribute;
  private aC: THREE.InstancedBufferAttribute;

  private head = 0;
  private wrapped = false;
  /** Dirty span in instance indices for this frame's partial upload. */
  private dirtyLo = Infinity;
  private dirtyHi = -Infinity;
  /** Latest death time across all live particles; drives the ring reset. */
  private expireAt = -1;
  private time = 0;
  private seedCounter = 0;

  constructor(opts: FamilyOptions) {
    this.capacity = Math.max(16, Math.floor(opts.capacity));
    this.shape = opts.shape;
    const n = this.capacity;

    this.geo = buildQuad();
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    for (const a of [this.aPos, this.aVel, this.aCol, this.aA, this.aB, this.aC]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    this.geo.setAttribute('iPos', this.aPos);
    this.geo.setAttribute('iVel', this.aVel);
    this.geo.setAttribute('iCol', this.aCol);
    this.geo.setAttribute('iA', this.aA);
    this.geo.setAttribute('iB', this.aB);
    this.geo.setAttribute('iC', this.aC);
    this.geo.instanceCount = 0;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const id = SHAPE_ID[opts.shape];
    const defines: Record<string, string> = {};
    if (opts.stretch) defines.GF_STRETCH = '1';
    if (opts.bounce) defines.GF_BOUNCE = '1';

    const frag =
      (NEEDS_NOISE[opts.shape] ? GLSL_NOISE : '') +
      FRAG_HEAD +
      `\nvoid main() {\n${FRAG_MAIN[id]}\n}\n`;

    this.mat = new THREE.ShaderMaterial({
      defines,
      uniforms: {
        uTime: { value: 0 },
        uFade: { value: 1 },
        uDepth: { value: null },
        uHasDepth: { value: 0 },
        uSoften: { value: opts.soften ?? 0 },
      },
      vertexShader: VERT,
      fragmentShader: frag,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    });

    this.object = new THREE.Mesh(this.geo, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = opts.renderOrder ?? 10;
    this.object.name = `vfx.particles.${opts.shape}`;
    this.object.matrixAutoUpdate = false;
  }

  /** Live-particle count is not tracked exactly; this is the drawn instance span. */
  get drawn(): number {
    return this.geo.instanceCount;
  }

  spawn(d: SpawnDesc): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this.wrapped = true;

    const p3 = i * 3;
    const p4 = i * 4;
    this.aPos.array[p3] = d.x;
    this.aPos.array[p3 + 1] = d.y;
    this.aPos.array[p3 + 2] = d.z;
    this.aVel.array[p3] = d.vx;
    this.aVel.array[p3 + 1] = d.vy;
    this.aVel.array[p3 + 2] = d.vz;
    this.aCol.array[p3] = d.r;
    this.aCol.array[p3 + 1] = d.g;
    this.aCol.array[p3 + 2] = d.b;

    const spawn = this.time + d.delay;
    this.aA.array[p4] = spawn;
    this.aA.array[p4 + 1] = d.life;
    this.aA.array[p4 + 2] = d.size0;
    this.aA.array[p4 + 3] = d.size1;

    this.seedCounter = (this.seedCounter + 1) % 4096;
    this.aB.array[p4] = d.drag;
    this.aB.array[p4 + 1] = d.gravity;
    this.aB.array[p4 + 2] = (this.seedCounter * 0.6180339887) % 1;
    this.aB.array[p4 + 3] = d.spin;

    this.aC.array[p4] = d.opacity;
    this.aC.array[p4 + 1] = d.stretch;
    this.aC.array[p4 + 2] = d.floorY;
    this.aC.array[p4 + 3] = d.turbulence;

    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
    const death = spawn + d.life;
    if (death > this.expireAt) this.expireAt = death;
  }

  /** Fixed-step tick: only advances the spawn clock. */
  setSimTime(t: number): void {
    this.time = t;
  }

  /** Per-frame: push the render clock and flush any partial upload. */
  flush(renderTime: number): void {
    this.mat.uniforms.uTime.value = renderTime;

    if (this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo;
      const count = this.dirtyHi - lo + 1;
      this.mark(this.aPos, lo, count, 3);
      this.mark(this.aVel, lo, count, 3);
      this.mark(this.aCol, lo, count, 3);
      this.mark(this.aA, lo, count, 4);
      this.mark(this.aB, lo, count, 4);
      this.mark(this.aC, lo, count, 4);
      this.dirtyLo = Infinity;
      this.dirtyHi = -Infinity;
    }

    if (renderTime > this.expireAt) {
      // Everything is dead: rewind the ring so the next burst starts at 0 and
      // the draw shrinks back to nothing instead of paying for stale slots.
      this.head = 0;
      this.wrapped = false;
      this.geo.instanceCount = 0;
    } else {
      this.geo.instanceCount = this.wrapped ? this.capacity : this.head;
    }
  }

  private mark(
    attr: THREE.InstancedBufferAttribute,
    lo: number,
    count: number,
    item: number,
  ): void {
    attr.clearUpdateRanges();
    attr.addUpdateRange(lo * item, count * item);
    attr.needsUpdate = true;
  }

  setDepthTexture(t: THREE.Texture | null): void {
    this.mat.uniforms.uDepth.value = t;
    this.mat.uniforms.uHasDepth.value = t ? 1 : 0;
  }

  setFade(f: number): void {
    this.mat.uniforms.uFade.value = f;
  }

  clear(): void {
    this.head = 0;
    this.wrapped = false;
    this.expireAt = -1;
    this.geo.instanceCount = 0;
    this.dirtyLo = Infinity;
    this.dirtyHi = -Infinity;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// RingFamily — expanding shock rings, ripples and hex shields
// ---------------------------------------------------------------------------

export type RingStyle = 'shock' | 'ripple' | 'hex' | 'flash';

const RING_STYLE: Record<RingStyle, number> = { shock: 0, ripple: 1, hex: 2, flash: 3 };

/**
 * A ring is one quad whose radius is animated in the shader. `oriented` rings
 * lie in the plane of a supplied normal (ground waves, water ripples); the rest
 * face the camera (airburst shock fronts, muzzle flash discs).
 */
export class RingFamily {
  readonly object: THREE.Mesh;
  readonly capacity: number;

  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aCen: THREE.InstancedBufferAttribute;
  private aNrm: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aA: THREE.InstancedBufferAttribute; // spawn, life, r0, r1
  private aB: THREE.InstancedBufferAttribute; // thickness, style, oriented, opacity

  private head = 0;
  private wrapped = false;
  private dirtyLo = Infinity;
  private dirtyHi = -Infinity;
  private expireAt = -1;
  private time = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(8, capacity);
    const n = this.capacity;
    this.geo = buildQuad();
    this.aCen = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aNrm = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    for (const a of [this.aCen, this.aNrm, this.aCol, this.aA, this.aB]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    this.geo.setAttribute('iCen', this.aCen);
    this.geo.setAttribute('iNrm', this.aNrm);
    this.geo.setAttribute('iCol', this.aCol);
    this.geo.setAttribute('iA', this.aA);
    this.geo.setAttribute('iB', this.aB);
    this.geo.instanceCount = 0;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uFade: { value: 1 },
        uDepth: { value: null },
        uHasDepth: { value: 0 },
        uSoften: { value: 0.6 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 iCen;
        attribute vec3 iNrm;
        attribute vec3 iCol;
        attribute vec4 iA;
        attribute vec4 iB;
        uniform float uTime;
        uniform float uFade;
        varying vec2 vUv;
        varying vec3 vCol;
        varying float vAge;
        varying float vThick;
        varying float vStyle;
        varying float vOpacity;
        varying float vViewDist;
        varying vec2 vProj;

        void main() {
          vUv = uv;
          vCol = iCol;
          vThick = iB.x;
          vStyle = iB.y;
          float t = uTime - iA.x;
          float a = t / max(iA.y, 1e-4);
          vAge = a;
          if (iA.y <= 0.0 || t < 0.0 || a >= 1.0) {
            vOpacity = 0.0; vViewDist = 1.0; vProj = vec2(-1.0);
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          // Shock fronts decelerate hard; a linear ramp reads like a cartoon.
          float ease = 1.0 - pow(1.0 - a, 2.4);
          float rad = mix(iA.z, iA.w, ease);
          vOpacity = iB.w * uFade;

          vec2 q = position.xy * 2.0 * rad;
          vec4 mv;
          if (iB.z > 0.5) {
            // Oriented: build a basis in the plane perpendicular to iNrm.
            vec3 n = normalize(iNrm);
            vec3 up = abs(n.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
            vec3 tx = normalize(cross(up, n));
            vec3 ty = cross(n, tx);
            vec3 wp = iCen + tx * q.x + ty * q.y;
            mv = modelViewMatrix * vec4(wp, 1.0);
          } else {
            mv = modelViewMatrix * vec4(iCen, 1.0);
            mv.xy += q;
          }
          vViewDist = -mv.z;
          gl_Position = projectionMatrix * mv;
          vProj = vec2(projectionMatrix[2][2], projectionMatrix[3][2]);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uDepth;
        uniform float uHasDepth;
        uniform float uSoften;
        varying vec2 vUv;
        varying vec3 vCol;
        varying float vAge;
        varying float vThick;
        varying float vStyle;
        varying float vOpacity;
        varying float vViewDist;
        varying vec2 vProj;

        float gfSoft() {
          if (uHasDepth < 0.5) return 1.0;
          vec2 uvS = gl_FragCoord.xy / vec2(textureSize(uDepth, 0));
          float d = texture2D(uDepth, uvS).x;
          float ndc = d * 2.0 - 1.0;
          float sd = vProj.y / (ndc + vProj.x);
          if (sd <= 0.0 || sd > 1e5) return 1.0;
          return clamp((sd - vViewDist) / uSoften, 0.0, 1.0);
        }

        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          if (r > 1.0) discard;
          float ang = atan(p.y, p.x);

          float a = 0.0;
          vec3 col = vCol;

          if (vStyle < 0.5) {
            // shock: thin bright leading edge with a soft inner wash
            float edge = 1.0 - smoothstep(0.0, vThick, abs(r - 0.92));
            // The interior wash must stay faint: at 0.35 the ring stopped being
            // a shock *front* and became a glowing dome over the whole blast.
            float wash = smoothstep(0.72, 0.95, r) * 0.10;
            a = edge + wash;
            col *= 1.0 + edge * 1.6;
          } else if (vStyle < 1.5) {
            // ripple: two separated concentric crests chasing the front. They
            // must not overlap or the ring fills in and reads as a solid disc.
            float f1 = 1.0 - smoothstep(0.0, vThick, abs(r - 0.95));
            float f2 = 1.0 - smoothstep(0.0, vThick * 1.2, abs(r - 0.58));
            a = f1 + f2 * 0.35;
          } else if (vStyle < 2.5) {
            // hex: faceted shield lattice. The interior grid is deliberately
            // faint — at full strength it blows the whole ring into a disc.
            float cells = 7.0;
            float hx = abs(sin(ang * cells * 0.5));
            float edge = 1.0 - smoothstep(0.0, vThick * (0.6 + hx * 0.9), abs(r - 0.90));
            float grid = smoothstep(0.92, 1.0, abs(sin(p.x * 22.0)) * abs(sin(p.y * 22.0)));
            a = edge + grid * smoothstep(0.45, 0.95, r) * 0.22;
            col *= 1.0 + edge * 1.8;
          } else {
            // flash: filled disc with radial spikes
            float spikes = 0.55 + 0.45 * abs(sin(ang * 6.0 + vAge * 3.0));
            a = pow(max(0.0, 1.0 - r / spikes), 2.6);
            col *= 1.0 + a * 2.0;
          }

          a = min(a, 1.35) * vOpacity * (1.0 - smoothstep(0.35, 1.0, vAge)) * gfSoft();
          if (a <= 0.003) discard;
          gl_FragColor = vec4(col * a, 0.0);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    });

    this.object = new THREE.Mesh(this.geo, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 12;
    this.object.name = 'vfx.rings';
    this.object.matrixAutoUpdate = false;
  }

  spawn(
    center: THREE.Vector3,
    normal: THREE.Vector3 | null,
    r0: number,
    r1: number,
    life: number,
    colorR: number,
    colorG: number,
    colorB: number,
    style: RingStyle,
    thickness = 0.12,
    opacity = 1,
    delay = 0,
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this.wrapped = true;
    const p3 = i * 3;
    const p4 = i * 4;
    this.aCen.array[p3] = center.x;
    this.aCen.array[p3 + 1] = center.y;
    this.aCen.array[p3 + 2] = center.z;
    this.aNrm.array[p3] = normal ? normal.x : 0;
    this.aNrm.array[p3 + 1] = normal ? normal.y : 1;
    this.aNrm.array[p3 + 2] = normal ? normal.z : 0;
    this.aCol.array[p3] = colorR;
    this.aCol.array[p3 + 1] = colorG;
    this.aCol.array[p3 + 2] = colorB;
    const spawn = this.time + delay;
    this.aA.array[p4] = spawn;
    this.aA.array[p4 + 1] = life;
    this.aA.array[p4 + 2] = r0;
    this.aA.array[p4 + 3] = r1;
    this.aB.array[p4] = thickness;
    this.aB.array[p4 + 1] = RING_STYLE[style];
    this.aB.array[p4 + 2] = normal ? 1 : 0;
    this.aB.array[p4 + 3] = opacity;

    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
    const death = spawn + life;
    if (death > this.expireAt) this.expireAt = death;
  }

  setSimTime(t: number): void {
    this.time = t;
  }

  flush(renderTime: number): void {
    this.mat.uniforms.uTime.value = renderTime;
    if (this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo;
      const c = this.dirtyHi - lo + 1;
      this.mark(this.aCen, lo, c, 3);
      this.mark(this.aNrm, lo, c, 3);
      this.mark(this.aCol, lo, c, 3);
      this.mark(this.aA, lo, c, 4);
      this.mark(this.aB, lo, c, 4);
      this.dirtyLo = Infinity;
      this.dirtyHi = -Infinity;
    }
    if (renderTime > this.expireAt) {
      this.head = 0;
      this.wrapped = false;
      this.geo.instanceCount = 0;
    } else {
      this.geo.instanceCount = this.wrapped ? this.capacity : this.head;
    }
  }

  private mark(attr: THREE.InstancedBufferAttribute, lo: number, count: number, item: number): void {
    attr.clearUpdateRanges();
    attr.addUpdateRange(lo * item, count * item);
    attr.needsUpdate = true;
  }

  setDepthTexture(t: THREE.Texture | null): void {
    this.mat.uniforms.uDepth.value = t;
    this.mat.uniforms.uHasDepth.value = t ? 1 : 0;
  }

  setFade(f: number): void {
    this.mat.uniforms.uFade.value = f;
  }

  clear(): void {
    this.head = 0;
    this.wrapped = false;
    this.expireAt = -1;
    this.geo.instanceCount = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// DustField — persistent ambient particulate inside a box
// ---------------------------------------------------------------------------

/**
 * Air motes. Entirely stateless on the CPU: every mote's position is
 * `fract(seed + drift * t)` remapped into the level bounds, so the field costs
 * one draw call and zero updates for as long as the level lives. This is the
 * cheapest single thing that makes a frame read as "expensive" — atmosphere.
 */
export class DustField {
  readonly object: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(32, capacity);
    this.geo = buildQuad();
    const seeds = new Float32Array(this.capacity * 4);
    for (let i = 0; i < this.capacity; i++) {
      seeds[i * 4] = Math.random();
      seeds[i * 4 + 1] = Math.random();
      seeds[i * 4 + 2] = Math.random();
      seeds[i * 4 + 3] = Math.random();
    }
    this.geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    this.geo.instanceCount = 0;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uFade: { value: 1 },
        uMin: { value: new THREE.Vector3(-40, 0, -40) },
        uSize: { value: new THREE.Vector3(80, 20, 80) },
        uColor: { value: new THREE.Color(0.6, 0.66, 0.8) },
        uScale: { value: 0.045 },
        uFollow: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 iSeed;
        uniform float uTime;
        uniform vec3 uMin;
        uniform vec3 uSize;
        uniform float uScale;
        uniform float uFollow;
        varying vec2 vUv;
        varying float vTwinkle;
        varying float vNear;
        void main() {
          vUv = uv;
          // Independent drift per axis; the y term is slow so motes hang.
          vec3 drift = vec3(
            0.020 + iSeed.w * 0.030,
            0.006 + iSeed.x * 0.012,
            0.016 + iSeed.y * 0.026
          );
          vec3 f = fract(iSeed.xyz + drift * uTime);
          // Follow mode wraps the field around the eye, so a few hundred motes
          // give an infinite haze instead of being lost in a level-sized volume.
          vec3 base = uFollow > 0.5 ? (cameraPosition - uSize * 0.5) : uMin;
          vec3 wp = base + f * uSize;
          vTwinkle = 0.35 + 0.65 * abs(sin(uTime * (0.7 + iSeed.z * 1.9) + iSeed.w * 12.0));
          float sz = uScale * (0.45 + iSeed.z);
          vec4 mv = modelViewMatrix * vec4(wp, 1.0);
          // Fade at the shell of the follow volume so wrapping never pops, and
          // very close to the eye so motes do not smear across the screen.
          float dist = length(wp - cameraPosition);
          float outer = length(uSize) * 0.5;
          vNear = smoothstep(0.35, 1.2, dist) * (1.0 - smoothstep(outer * 0.55, outer, dist));
          mv.xy += position.xy * sz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uFade;
        varying vec2 vUv;
        varying float vTwinkle;
        varying float vNear;
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p) * 2.0;
          if (r > 1.0) discard;
          float a = pow(1.0 - r, 2.0) * vTwinkle * uFade * vNear;
          if (a <= 0.004) discard;
          gl_FragColor = vec4(uColor * a, a * 0.18);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    });

    this.object = new THREE.Mesh(this.geo, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 9;
    this.object.name = 'vfx.dust';
    this.object.matrixAutoUpdate = false;
  }

  /**
   * `bounds === null` puts the field in camera-follow mode with a `size`-cubed
   * volume wrapped around the eye — the right choice for open worlds, where a
   * level-sized box would spread the same motes into invisibility.
   */
  configure(
    bounds: THREE.Box3 | null,
    count: number,
    color: THREE.Color,
    moteSize: number,
    followSize = 34,
  ): void {
    const u = this.mat.uniforms;
    if (bounds) {
      (u.uMin.value as THREE.Vector3).copy(bounds.min);
      (u.uSize.value as THREE.Vector3).subVectors(bounds.max, bounds.min);
      u.uFollow.value = 0;
    } else {
      (u.uSize.value as THREE.Vector3).setScalar(followSize);
      u.uFollow.value = 1;
    }
    (u.uColor.value as THREE.Color).copy(color);
    u.uScale.value = moteSize;
    this.geo.instanceCount = Math.max(0, Math.min(this.capacity, Math.floor(count)));
  }

  flush(renderTime: number): void {
    this.mat.uniforms.uTime.value = renderTime;
  }

  setFade(f: number): void {
    this.mat.uniforms.uFade.value = f;
  }

  clear(): void {
    this.geo.instanceCount = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// DebrisPool — CPU-simulated solid chunks
// ---------------------------------------------------------------------------

interface DebrisSlot {
  active: boolean;
  age: number;
  life: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: number;
  floorY: number;
  rest: number;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s3 = new THREE.Vector3();
const _euler = new THREE.Euler();

/**
 * Chunks big enough that a flat billboard would give the trick away: gibs,
 * rock shards, torn hull plate. Few enough (dozens) that a real CPU rigid-ish
 * integration with a ground bounce is cheaper than any shader gymnastics, and
 * they receive scene lighting, which is what sells them as solid matter.
 */
export class DebrisPool {
  readonly object: THREE.InstancedMesh;
  private slots: DebrisSlot[] = [];
  private geo: THREE.BufferGeometry;
  private mat: THREE.MeshStandardMaterial;
  private live = 0;

  constructor(capacity: number, material: THREE.MeshStandardMaterial, seed = 1) {
    this.geo = makeChunkGeometry(seed);
    this.mat = material;
    this.object = new THREE.InstancedMesh(this.geo, this.mat, Math.max(4, capacity));
    this.object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.object.frustumCulled = false;
    this.object.castShadow = false;
    this.object.receiveShadow = false;
    this.object.count = 0;
    this.object.name = 'vfx.debris';
    const n = this.object.instanceMatrix.count;
    this.object.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.object.instanceColor.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < n; i++) {
      this.slots.push({
        active: false,
        age: 0,
        life: 1,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        scale: 0.1,
        floorY: -1e9,
        rest: 0.35,
      });
    }
  }

  get capacity(): number {
    return this.slots.length;
  }

  spawn(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    scale: number,
    life: number,
    floorY: number,
    color: THREE.Color,
  ): void {
    let idx = -1;
    let oldest = -1;
    let oldestAge = -1;
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.slots[i].active) {
        idx = i;
        break;
      }
      const rel = this.slots[i].age / this.slots[i].life;
      if (rel > oldestAge) {
        oldestAge = rel;
        oldest = i;
      }
    }
    if (idx < 0) idx = oldest;
    if (idx < 0) return;
    const s = this.slots[idx];
    s.active = true;
    s.age = 0;
    s.life = life;
    s.pos.copy(pos);
    s.vel.copy(vel);
    s.spin.set(
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 26,
    );
    _euler.set(Math.random() * 6.283, Math.random() * 6.283, Math.random() * 6.283);
    s.quat.setFromEuler(_euler);
    s.scale = scale;
    s.floorY = floorY;
    s.rest = 0.3 + Math.random() * 0.25;
    this.object.setColorAt(idx, color);
    if (this.object.instanceColor) this.object.instanceColor.needsUpdate = true;
  }

  update(dt: number, gravity: number): void {
    let count = 0;
    let any = false;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active) continue;
      any = true;
      s.age += dt;
      if (s.age >= s.life) {
        s.active = false;
        continue;
      }
      s.vel.y -= gravity * dt;
      s.vel.multiplyScalar(1 - 0.6 * dt);
      s.pos.addScaledVector(s.vel, dt);
      if (s.pos.y < s.floorY + s.scale * 0.5) {
        s.pos.y = s.floorY + s.scale * 0.5;
        if (s.vel.y < 0) {
          s.vel.y = -s.vel.y * s.rest;
          s.vel.x *= 0.62;
          s.vel.z *= 0.62;
          s.spin.multiplyScalar(0.55);
        }
      }
      _euler.set(s.spin.x * dt, s.spin.y * dt, s.spin.z * dt);
      _q.setFromEuler(_euler);
      s.quat.multiply(_q).normalize();
      count = i + 1;
    }
    this.live = any ? count : 0;
  }

  /** Rebuild the instance matrices. Called once per rendered frame. */
  flush(): void {
    const n = this.live;
    for (let i = 0; i < n; i++) {
      const s = this.slots[i];
      if (!s.active) {
        _m4.makeScale(0, 0, 0);
      } else {
        // Shrink out over the last 25% so chunks do not blink out of existence.
        const k = 1 - Math.max(0, s.age / s.life - 0.75) * 4;
        _s3.setScalar(s.scale * Math.max(0, k));
        _m4.compose(s.pos, s.quat, _s3);
      }
      this.object.setMatrixAt(i, _m4);
    }
    this.object.count = n;
    this.object.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    for (const s of this.slots) s.active = false;
    this.live = 0;
    this.object.count = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.object.dispose();
  }
}

/**
 * An irregular chunk: an icosahedron with every vertex pushed along its own
 * normal by a hash. Flat-shaded, so the facets catch the key light and the
 * silhouette is never a sphere.
 */
export function makeChunkGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 0);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  for (let i = 0; i < arr.length; i += 3) {
    const h = Math.abs(Math.sin((arr[i] * 12.9898 + arr[i + 1] * 78.233 + arr[i + 2] * 37.719 + seed) * 43758.5453));
    const k = 0.55 + h * 0.85;
    arr[i] *= k;
    arr[i + 1] *= k * (0.6 + (h * 7) % 0.8);
    arr[i + 2] *= k;
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
