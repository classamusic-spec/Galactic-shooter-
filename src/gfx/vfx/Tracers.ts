/**
 * Tracers — bullet streaks that actually travel.
 *
 * A tracer is not a line from muzzle to impact; it is a short bright segment
 * that leaves the muzzle at `speed` and arrives at the hit point later. That
 * delay is the whole reason tracers read as *rounds in flight* rather than as
 * laser sights, and it costs nothing here because the head/tail positions are
 * `speed * (u_time - spawn)` evaluated in the vertex shader.
 *
 * The quad is a view-aligned ribbon between the two endpoints (cylindrical
 * billboard), so it keeps a constant screen width at any angle and never
 * degenerates when fired straight down the camera axis.
 *
 * Beams (trace rifle) reuse the same geometry with `mode = 1`: full length
 * immediately, short life, respawned every frame the trigger is held.
 */
import * as THREE from 'three';

const _c = new THREE.Color();

export class TracerPool {
  readonly object: THREE.Mesh;
  readonly capacity: number;

  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aOrig: THREE.InstancedBufferAttribute;
  private aDir: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aA: THREE.InstancedBufferAttribute; // spawn, dist, speed, len
  private aB: THREE.InstancedBufferAttribute; // width, opacity, mode, fadeIn

  private head = 0;
  private wrapped = false;
  private dirtyLo = Infinity;
  private dirtyHi = -Infinity;
  private expireAt = -1;
  private time = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(16, capacity);
    const n = this.capacity;

    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0],
        3,
      ),
    );
    this.geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);

    this.aOrig = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aDir = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    for (const a of [this.aOrig, this.aDir, this.aCol, this.aA, this.aB]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    this.geo.setAttribute('iOrig', this.aOrig);
    this.geo.setAttribute('iDir', this.aDir);
    this.geo.setAttribute('iCol', this.aCol);
    this.geo.setAttribute('iA', this.aA);
    this.geo.setAttribute('iB', this.aB);
    this.geo.instanceCount = 0;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uFade: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 iOrig;
        attribute vec3 iDir;
        attribute vec3 iCol;
        attribute vec4 iA;   // spawn, dist, speed, len
        attribute vec4 iB;   // width, opacity, mode, tailFade
        uniform float uTime;
        uniform float uFade;
        varying vec2 vUv;
        varying vec3 vCol;
        varying float vOpacity;
        varying float vTail;
        varying float vAge;

        void main() {
          vUv = uv;
          vCol = iCol;
          vTail = iB.w;

          float t = uTime - iA.x;
          float dist = iA.y;
          float speed = max(iA.z, 1.0);
          float len = iA.w;
          float total = iB.z > 0.5 ? 0.09 : (dist + len) / speed;
          float a = t / max(total, 1e-4);
          vAge = a;

          if (t < 0.0 || a >= 1.0 || dist <= 0.0) {
            vOpacity = 0.0;
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }

          float headD, tailD;
          if (iB.z > 0.5) {
            headD = dist;
            tailD = 0.0;
          } else {
            headD = min(t * speed, dist);
            tailD = clamp(t * speed - len, 0.0, dist);
          }

          vec3 A = iOrig + iDir * tailD;
          vec3 B = iOrig + iDir * headD;
          vec4 mvA = modelViewMatrix * vec4(A, 1.0);
          vec4 mvB = modelViewMatrix * vec4(B, 1.0);

          float u = position.y;
          vec3 mid = mix(mvA.xyz, mvB.xyz, u);
          vec3 seg = mvB.xyz - mvA.xyz;
          float segLen = length(seg);
          vec3 sdir = segLen > 1e-5 ? seg / segLen : vec3(0.0, 1.0, 0.0);
          vec3 toEye = normalize(-mid);
          vec3 side = cross(sdir, toEye);
          float sl = length(side);
          side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);

          vec3 vp = mid + side * (position.x * iB.x * 2.0);
          vOpacity = iB.y * uFade;
          gl_Position = projectionMatrix * vec4(vp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vCol;
        varying float vOpacity;
        varying float vTail;
        varying float vAge;
        void main() {
          float across = abs(vUv.x - 0.5) * 2.0;
          float core = 1.0 - smoothstep(0.0, 1.0, across);
          if (core <= 0.002) discard;
          float along = vUv.y;
          float a = core * core;
          a *= mix(vTail, 1.0, pow(along, 0.6));
          // Bright head cap so the leading edge reads as the round itself.
          a *= 1.0 + smoothstep(0.82, 1.0, along) * 1.4;
          a *= vOpacity * (1.0 - smoothstep(0.75, 1.0, vAge));
          if (a <= 0.002) discard;
          vec3 col = vCol * (1.0 + 7.0 * pow(core, 8.0));
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
    this.object.renderOrder = 14;
    this.object.name = 'vfx.tracers';
    this.object.matrixAutoUpdate = false;
  }

  private write(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    dist: number,
    speed: number,
    len: number,
    width: number,
    r: number,
    g: number,
    b: number,
    opacity: number,
    mode: number,
    tailFade: number,
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this.wrapped = true;
    const p3 = i * 3;
    const p4 = i * 4;
    this.aOrig.array[p3] = ox;
    this.aOrig.array[p3 + 1] = oy;
    this.aOrig.array[p3 + 2] = oz;
    this.aDir.array[p3] = dx;
    this.aDir.array[p3 + 1] = dy;
    this.aDir.array[p3 + 2] = dz;
    this.aCol.array[p3] = r;
    this.aCol.array[p3 + 1] = g;
    this.aCol.array[p3 + 2] = b;
    this.aA.array[p4] = this.time;
    this.aA.array[p4 + 1] = dist;
    this.aA.array[p4 + 2] = speed;
    this.aA.array[p4 + 3] = len;
    this.aB.array[p4] = width;
    this.aB.array[p4 + 1] = opacity;
    this.aB.array[p4 + 2] = mode;
    this.aB.array[p4 + 3] = tailFade;

    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
    const total = mode > 0.5 ? 0.09 : (dist + len) / Math.max(speed, 1);
    const death = this.time + total;
    if (death > this.expireAt) this.expireAt = death;
  }

  /**
   * Fire a travelling tracer. Two instances: a wide dim halo and a thin blown-out
   * core, which is what makes the streak bloom into a lens flare rather than
   * turning into a fat opaque worm.
   */
  fire(
    from: THREE.Vector3,
    to: THREE.Vector3,
    color: number,
    width: number,
    speed: number,
    intensity = 1,
  ): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.05) return;
    const ix = dx / dist;
    const iy = dy / dist;
    const iz = dz / dist;
    _c.setHex(color, THREE.SRGBColorSpace);
    const len = Math.min(Math.max(dist * 0.22, 1.6), 9);

    this.write(
      from.x, from.y, from.z, ix, iy, iz,
      dist, speed, len * 1.35, width * 3.2,
      _c.r * 0.5 * intensity, _c.g * 0.5 * intensity, _c.b * 0.5 * intensity,
      0.55, 0, 0.05,
    );
    this.write(
      from.x, from.y, from.z, ix, iy, iz,
      dist, speed, len, width,
      _c.r * 3.2 * intensity, _c.g * 3.2 * intensity, _c.b * 3.2 * intensity,
      1, 0, 0.12,
    );
  }

  /** Continuous beam. Short-lived; call every frame the beam is on. */
  beam(from: THREE.Vector3, to: THREE.Vector3, color: number, width: number): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.05) return;
    const ix = dx / dist;
    const iy = dy / dist;
    const iz = dz / dist;
    _c.setHex(color, THREE.SRGBColorSpace);
    this.write(
      from.x, from.y, from.z, ix, iy, iz, dist, 1e6, dist, width * 4.5,
      _c.r * 0.6, _c.g * 0.6, _c.b * 0.6, 0.5, 1, 0.75,
    );
    this.write(
      from.x, from.y, from.z, ix, iy, iz, dist, 1e6, dist, width * 1.1,
      _c.r * 5, _c.g * 5, _c.b * 5, 1, 1, 0.85,
    );
  }

  setSimTime(t: number): void {
    this.time = t;
  }

  flush(renderTime: number): void {
    this.mat.uniforms.uTime.value = renderTime;
    if (this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo;
      const c = this.dirtyHi - lo + 1;
      this.mark(this.aOrig, lo, c, 3);
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
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
