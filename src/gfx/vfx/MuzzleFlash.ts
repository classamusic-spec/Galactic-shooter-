/**
 * MuzzleFlash — the first 50 ms of a shot.
 *
 * Three overlapping pieces, because a single sprite always reads as a sticker:
 *  1. a **star** billboard with hard radial spikes and a blown-out white core,
 *  2. a **plume** stretched along the barrel axis (unburnt propellant),
 *  3. a real **point light** that puts the flash on the walls and on the weapon
 *     model — the piece that separates a AAA muzzle flash from a decal.
 *
 * The light pool is fixed-size and allocated at construction so the scene's
 * light count never changes at runtime; shifting it mid-session would force a
 * full material recompile and stutter on every trigger pull.
 */
import * as THREE from 'three';

const _c = new THREE.Color();

interface FlashLight {
  light: THREE.PointLight;
  age: number;
  life: number;
  peak: number;
}

export class MuzzleFlashPool {
  readonly object: THREE.Mesh;
  readonly lights: THREE.PointLight[] = [];
  readonly capacity: number;

  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aPos: THREE.InstancedBufferAttribute;
  private aDir: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aA: THREE.InstancedBufferAttribute; // spawn, life, size, seed
  private aB: THREE.InstancedBufferAttribute; // kind, intensity, spikes, spare

  private head = 0;
  private wrapped = false;
  private dirtyLo = Infinity;
  private dirtyHi = -Infinity;
  private expireAt = -1;
  private time = 0;

  private slots: FlashLight[] = [];
  private lightCursor = 0;

  constructor(capacity: number, lightCount = 3) {
    this.capacity = Math.max(16, capacity);
    const n = this.capacity;

    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3),
    );
    this.geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);

    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aDir = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    for (const a of [this.aPos, this.aDir, this.aCol, this.aA, this.aB]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    this.geo.setAttribute('iPos', this.aPos);
    this.geo.setAttribute('iDir', this.aDir);
    this.geo.setAttribute('iCol', this.aCol);
    this.geo.setAttribute('iA', this.aA);
    this.geo.setAttribute('iB', this.aB);
    this.geo.instanceCount = 0;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uFade: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 iPos;
        attribute vec3 iDir;
        attribute vec3 iCol;
        attribute vec4 iA;   // spawn, life, size, seed
        attribute vec4 iB;   // kind, intensity, spikes, spare
        uniform float uTime;
        uniform float uFade;
        varying vec2 vUv;
        varying vec3 vCol;
        varying float vAge;
        varying float vSeed;
        varying float vKind;
        varying float vSpikes;
        varying float vIntensity;

        void main() {
          vUv = uv;
          vCol = iCol;
          vSeed = iA.w;
          vKind = iB.x;
          vSpikes = iB.z;
          float t = uTime - iA.x;
          float a = t / max(iA.y, 1e-4);
          vAge = a;
          vIntensity = iB.y * uFade;
          if (iA.y <= 0.0 || t < 0.0 || a >= 1.0) {
            vIntensity = 0.0;
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }

          // The flash punches out instantly and collapses; growth is front-loaded.
          float grow = 0.55 + 0.45 * pow(a, 0.35);
          float sz = iA.z * grow;

          vec4 mv;
          if (vKind < 0.5) {
            // Star: camera-facing, rolled by the seed so consecutive shots differ.
            mv = modelViewMatrix * vec4(iPos, 1.0);
            float rot = iA.w * 6.2831853;
            float c = cos(rot), s = sin(rot);
            vec2 q = (position.xy - vec2(0.0, 0.5)) * sz * 2.0;
            mv.xy += vec2(q.x * c - q.y * s, q.x * s + q.y * c);
          } else {
            // Plume: view-aligned ribbon from the muzzle along the barrel.
            vec3 A = iPos;
            vec3 B = iPos + normalize(iDir) * sz * 2.6;
            vec4 mvA = modelViewMatrix * vec4(A, 1.0);
            vec4 mvB = modelViewMatrix * vec4(B, 1.0);
            vec3 mid = mix(mvA.xyz, mvB.xyz, position.y);
            vec3 seg = mvB.xyz - mvA.xyz;
            float sl = length(seg);
            vec3 sdir = sl > 1e-5 ? seg / sl : vec3(0.0, 1.0, 0.0);
            vec3 side = cross(sdir, normalize(-mid));
            float sw = length(side);
            side = sw > 1e-5 ? side / sw : vec3(1.0, 0.0, 0.0);
            // Taper: fat at the muzzle, pinched at the tip.
            float taper = mix(1.0, 0.18, position.y);
            mid += side * (position.x * sz * 1.5 * taper);
            mv = vec4(mid, 1.0);
          }
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vCol;
        varying float vAge;
        varying float vSeed;
        varying float vKind;
        varying float vSpikes;
        varying float vIntensity;

        void main() {
          float a;
          vec3 col = vCol;
          if (vKind < 0.5) {
            vec2 p = (vUv - 0.5) * 2.0;
            float r = length(p);
            if (r > 1.0) discard;
            float ang = atan(p.y, p.x);
            // Odd spike count reads more like burning gas than a symmetric star.
            float spike = 0.30 + 0.70 * pow(abs(cos(ang * vSpikes * 0.5 + vSeed * 9.0)), 3.0);
            float shape = max(0.0, 1.0 - r / max(spike, 0.02));
            float core = exp(-r * r * 14.0);
            a = pow(shape, 1.9) * 0.85 + core;
            col = vCol * (0.8 + shape * 1.4) + vec3(1.0, 0.95, 0.85) * core * 5.0;
          } else {
            float across = abs(vUv.x - 0.5) * 2.0;
            float along = vUv.y;
            float body = (1.0 - smoothstep(0.0, 1.0, across)) * (1.0 - smoothstep(0.1, 1.0, along));
            a = pow(body, 1.6);
            col = vCol * (1.0 + 3.0 * pow(body, 4.0));
          }
          // Hard 1-frame punch then a fast collapse: the shape of real ignition.
          a *= (1.0 - smoothstep(0.0, 1.0, vAge * vAge)) * vIntensity;
          if (a <= 0.004) discard;
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
    this.object.renderOrder = 16;
    this.object.name = 'vfx.muzzle';
    this.object.matrixAutoUpdate = false;

    for (let i = 0; i < lightCount; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 16, 2);
      l.castShadow = false;
      l.name = `vfx.flashLight${i}`;
      this.lights.push(l);
      this.slots.push({ light: l, age: 1, life: 1, peak: 0 });
    }
  }

  private write(
    px: number, py: number, pz: number,
    dx: number, dy: number, dz: number,
    r: number, g: number, b: number,
    life: number, size: number, kind: number, intensity: number, spikes: number,
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this.wrapped = true;
    const p3 = i * 3;
    const p4 = i * 4;
    this.aPos.array[p3] = px;
    this.aPos.array[p3 + 1] = py;
    this.aPos.array[p3 + 2] = pz;
    this.aDir.array[p3] = dx;
    this.aDir.array[p3 + 1] = dy;
    this.aDir.array[p3 + 2] = dz;
    this.aCol.array[p3] = r;
    this.aCol.array[p3 + 1] = g;
    this.aCol.array[p3 + 2] = b;
    this.aA.array[p4] = this.time;
    this.aA.array[p4 + 1] = life;
    this.aA.array[p4 + 2] = size;
    this.aA.array[p4 + 3] = Math.random();
    this.aB.array[p4] = kind;
    this.aB.array[p4 + 1] = intensity;
    this.aB.array[p4 + 2] = spikes;
    this.aB.array[p4 + 3] = 0;
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
    const death = this.time + life;
    if (death > this.expireAt) this.expireAt = death;
  }

  /** `intensity` is the weapon's `muzzleIntensity`; ~0.15 (sidearm) to ~2.6. */
  flash(
    position: THREE.Vector3,
    direction: THREE.Vector3,
    intensity: number,
    color: number,
  ): void {
    const k = Math.max(0.08, intensity);
    _c.setHex(color, THREE.SRGBColorSpace);
    const size = 0.10 + k * 0.085;

    // Star: two layers, a wide soft one and a tight blown-out one.
    this.write(
      position.x, position.y, position.z,
      direction.x, direction.y, direction.z,
      _c.r * 1.6, _c.g * 1.45, _c.b * 1.15,
      0.055 + k * 0.012, size * 1.5, 0, Math.min(1.1, 0.45 + k * 0.35), 5,
    );
    this.write(
      position.x, position.y, position.z,
      direction.x, direction.y, direction.z,
      _c.r * 5.5 + 1.2, _c.g * 5.0 + 1.05, _c.b * 4.0 + 0.75,
      0.040, size * 0.8, 0, 1, 7,
    );
    // Plume down the barrel.
    this.write(
      position.x, position.y, position.z,
      direction.x, direction.y, direction.z,
      _c.r * 3.2 + 0.5, _c.g * 2.7 + 0.4, _c.b * 2.0 + 0.25,
      0.048, size * 1.15, 1, Math.min(1.2, 0.5 + k * 0.4), 0,
    );

    this.light(position, color, 6 + k * 14, 0.075);
  }

  /** Fire one of the pooled point lights. Used by explosions and impacts too. */
  light(position: THREE.Vector3, color: number, intensity: number, life: number): void {
    if (this.slots.length === 0) return;
    // Prefer a free slot; otherwise steal the one closest to finishing.
    let idx = -1;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].age >= this.slots[i].life) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      idx = this.lightCursor % this.slots.length;
      this.lightCursor++;
    }
    const s = this.slots[idx];
    s.light.position.copy(position);
    s.light.color.setHex(color, THREE.SRGBColorSpace);
    s.light.distance = Math.max(6, intensity * 0.9);
    s.peak = intensity;
    s.life = Math.max(0.02, life);
    s.age = 0;
    s.light.intensity = intensity;
  }

  setSimTime(t: number): void {
    this.time = t;
  }

  flush(renderTime: number, frameDt: number): void {
    this.mat.uniforms.uTime.value = renderTime;
    for (const s of this.slots) {
      if (s.age >= s.life) {
        if (s.light.intensity !== 0) s.light.intensity = 0;
        continue;
      }
      s.age += frameDt;
      const k = Math.max(0, 1 - s.age / s.life);
      s.light.intensity = s.peak * k * k;
    }

    if (this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo;
      const c = this.dirtyHi - lo + 1;
      this.mark(this.aPos, lo, c, 3);
      this.mark(this.aDir, lo, c, 3);
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

  setFade(f: number): void {
    this.mat.uniforms.uFade.value = f;
  }

  clear(): void {
    this.head = 0;
    this.wrapped = false;
    this.expireAt = -1;
    this.geo.instanceCount = 0;
    for (const s of this.slots) {
      s.age = s.life;
      s.light.intensity = 0;
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    for (const l of this.lights) l.dispose();
  }
}
