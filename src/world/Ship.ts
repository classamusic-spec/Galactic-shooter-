/**
 * The player's ship: an FS-9 "Kestrel" Federation interceptor.
 *
 * Flight is arcade-Newtonian — real momentum so a burn has consequences, but with
 * an assist that bleeds lateral drift so it stays pleasant on a mouse. The ship is
 * flown from a procedurally built cockpit interior; a chase view exists for the
 * cinematic approach shots the star map plays on arrival.
 */
import * as THREE from 'three';
import type { EngineSystem } from '@/core/Engine';
import type { Engine } from '@/core/Engine';
import type { FrameContext } from '@/types';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { events } from '@/core/EventBus';
import { audio } from '@/core/Audio';
import { settings } from '@/core/Settings';
import { clamp, clamp01, damp, dampVec3, lerp, scratch, smoothstep, TAU } from '@/util/math';

/** Flight tuning. Every value here was set by feel, then written down. */
export const FLIGHT = {
  /** Main engine acceleration, m/s². */
  thrust: 62,
  /** Afterburner multiplier. */
  boostMultiplier: 3.4,
  /** Reverse/retro thrust is deliberately weaker so stopping takes planning. */
  retroThrust: 26,
  /** Lateral/vertical translation thrusters. */
  strafeThrust: 34,
  /** Peak angular acceleration, rad/s². */
  pitchAccel: 3.1,
  yawAccel: 2.4,
  rollAccel: 5.2,
  /** Angular damping — how fast rotation bleeds off when you let go. */
  angularDamping: 3.6,
  /** Flight-assist lateral drift bleed, fraction/second. */
  driftAssist: 1.15,
  /** Hard speed cap, m/s. */
  maxSpeed: 240,
  boostMaxSpeed: 720,
  /** Boost fuel, seconds of continuous burn, and its refill rate. */
  boostCapacity: 4.5,
  boostRefill: 0.55,
  /** Auto-roll toward the orbital plane, rad/s², 0 disables. */
  levelAssist: 0.9,
  /** Camera shake per m/s² of acceleration. */
  shakePerG: 0.0016,
} as const;

export type ShipView = 'cockpit' | 'chase';

export class Ship implements EngineSystem {
  readonly name = 'ship';

  /** Ship root — the cockpit and exterior hang off this. */
  readonly root = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  readonly angularVelocity = new THREE.Vector3();

  /** True while the player is flying rather than on foot. */
  active = false;
  view: ShipView = 'cockpit';
  boostFuel = FLIGHT.boostCapacity;
  /** 0..1 throttle, held between frames like a real throttle lever. */
  throttle = 0;
  /** Set by the star map: the planet currently in landing range, if any. */
  landingTarget: { id: string; name: string; distance: number } | null = null;

  private engine: Engine;
  private materials: MaterialLibrary;
  private cockpit = new THREE.Group();
  private exterior = new THREE.Group();
  private thrusterGlow: THREE.Mesh[] = [];
  private thrusterLight!: THREE.PointLight;
  private engineHum: { stop(fade?: number): void; setVolume(v: number, fade?: number): void } | null =
    null;

  /** Visual-only smoothing state, driven in render() so it is frame-smooth. */
  private camLocal = new THREE.Vector3();
  private camShake = 0;
  private stickVisual = new THREE.Vector2();
  private boostVisual = 0;
  private disposables: Array<{ dispose(): void }> = [];
  private built = false;

  constructor(engine: Engine, materials: MaterialLibrary) {
    this.engine = engine;
    this.materials = materials;
    this.root.add(this.cockpit, this.exterior);
    this.root.matrixAutoUpdate = true;

    events.on('ship:enter', () => this.enter());
    events.on('ship:exit', () => this.exit());
    engine.add(this);
  }

  /** Build the geometry lazily — the ship is not needed until you reach orbit. */
  build(): void {
    if (this.built) return;
    this.built = true;
    this.buildExterior();
    this.buildCockpit();
  }

  attach(scene: THREE.Scene): void {
    this.build();
    scene.add(this.root);
  }

  enter(): void {
    this.build();
    this.active = true;
    this.view = 'cockpit';
    this.cockpit.visible = true;
    this.engineHum = audio.play('ship_engine_loop', { loop: true, volume: 0.0 }) ?? null;
    this.engineHum?.setVolume(0.35, 0.8);
  }

  exit(): void {
    this.active = false;
    this.cockpit.visible = false;
    this.engineHum?.stop(0.5);
    this.engineHum = null;
  }

  setView(v: ShipView): void {
    this.view = v;
    this.cockpit.visible = v === 'cockpit' && this.active;
  }

  teleport(position: THREE.Vector3, lookAt?: THREE.Vector3): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    if (lookAt) {
      const m = scratch.ma.lookAt(position, lookAt, scratch.v3a.set(0, 1, 0));
      this.orientation.setFromRotationMatrix(m);
    }
    this.root.position.copy(position);
    this.root.quaternion.copy(this.orientation);
  }

  /** Forward axis in world space. */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.orientation);
  }

  get speed(): number {
    return this.velocity.length();
  }

  get boosting(): boolean {
    return this.boostVisual > 0.02;
  }

  // -- simulation -----------------------------------------------------------

  update(ctx: FrameContext): void {
    if (!this.active) {
      this.boostFuel = Math.min(FLIGHT.boostCapacity, this.boostFuel + FLIGHT.boostRefill * ctx.dt);
      return;
    }
    const input = this.engine.input;
    const dt = ctx.dt;

    // -- rotation: mouse look drives pitch/yaw, A/D roll ---------------------
    const look = input.consumeLook();
    // Mouse delta is already in radians of camera rotation; treat it as a
    // torque command so the ship has weight instead of snapping.
    const pitchCmd = clamp(look.pitch * 26, -1, 1);
    const yawCmd = clamp(look.yaw * 26, -1, 1);
    let rollCmd = 0;
    if (input.down('left')) rollCmd += 1;
    if (input.down('right')) rollCmd -= 1;

    this.angularVelocity.x += pitchCmd * FLIGHT.pitchAccel * dt;
    this.angularVelocity.y += yawCmd * FLIGHT.yawAccel * dt;
    this.angularVelocity.z += rollCmd * FLIGHT.rollAccel * dt;

    // Damping is what makes it feel like a machine rather than a spaceship-shaped
    // camera: let go and it settles, but not instantly.
    const damping = Math.exp(-FLIGHT.angularDamping * dt);
    this.angularVelocity.multiplyScalar(damping);

    if (FLIGHT.levelAssist > 0 && Math.abs(rollCmd) < 0.01) {
      // Bleed roll toward level with the ecliptic so the player never ends up
      // inverted without having asked for it.
      const up = scratch.v3a.set(0, 1, 0).applyQuaternion(this.orientation);
      const rollError = Math.atan2(up.x, up.y);
      this.angularVelocity.z -= rollError * FLIGHT.levelAssist * dt;
    }

    const spin = scratch.qa.setFromEuler(
      new THREE.Euler(
        this.angularVelocity.x * dt,
        this.angularVelocity.y * dt,
        this.angularVelocity.z * dt,
        'XYZ',
      ),
    );
    this.orientation.multiply(spin).normalize();

    // -- throttle & thrust ---------------------------------------------------
    const wantForward = input.down('forward') ? 1 : 0;
    const wantBack = input.down('back') ? 1 : 0;
    const throttleTarget = wantForward ? 1 : wantBack ? -1 : 0;
    this.throttle = damp(this.throttle, throttleTarget, 6, dt);

    const boostHeld = input.down('sprint') && this.throttle > 0.1 && this.boostFuel > 0;
    if (boostHeld) this.boostFuel = Math.max(0, this.boostFuel - dt);
    else this.boostFuel = Math.min(FLIGHT.boostCapacity, this.boostFuel + FLIGHT.boostRefill * dt);
    const boostAmount = boostHeld ? 1 : 0;

    const fwd = this.forward(scratch.v3b);
    const right = scratch.v3c.set(1, 0, 0).applyQuaternion(this.orientation);
    const up = scratch.v3d.set(0, 1, 0).applyQuaternion(this.orientation);

    const accel = scratch.v3a.set(0, 0, 0);
    const mainThrust =
      this.throttle >= 0
        ? this.throttle * FLIGHT.thrust * (1 + boostAmount * (FLIGHT.boostMultiplier - 1))
        : this.throttle * FLIGHT.retroThrust;
    accel.addScaledVector(fwd, mainThrust);

    // Translation thrusters — crouch/jump for vertical, so it maps to the pad.
    let vertical = 0;
    if (input.down('jump')) vertical += 1;
    if (input.down('crouch')) vertical -= 1;
    accel.addScaledVector(up, vertical * FLIGHT.strafeThrust);

    this.velocity.addScaledVector(accel, dt);

    // Flight assist: bleed the component of velocity that isn't along forward,
    // which is what stops the ship from endlessly crabbing after a hard turn.
    const alongForward = this.velocity.dot(fwd);
    const lateral = scratch.v3b.copy(this.velocity).addScaledVector(fwd, -alongForward);
    lateral.multiplyScalar(Math.exp(-FLIGHT.driftAssist * dt));
    this.velocity.copy(lateral).addScaledVector(fwd, alongForward);

    const cap = lerp(FLIGHT.maxSpeed, FLIGHT.boostMaxSpeed, boostAmount);
    if (this.velocity.lengthSq() > cap * cap) this.velocity.setLength(cap);

    this.position.addScaledVector(this.velocity, dt);

    this.root.position.copy(this.position);
    this.root.quaternion.copy(this.orientation);

    // -- feedback ------------------------------------------------------------
    this.boostVisual = damp(this.boostVisual, boostAmount, 8, dt);
    const gForce = accel.length();
    this.camShake = Math.max(this.camShake, gForce * FLIGHT.shakePerG * (1 + boostAmount * 2));
    this.camShake = damp(this.camShake, 0, 3.5, dt);

    if (this.engineHum) {
      const load = clamp01(Math.abs(this.throttle) * 0.6 + boostAmount * 0.4);
      this.engineHum.setVolume(0.18 + load * 0.5);
    }

    this.stickVisual.set(
      damp(this.stickVisual.x, yawCmd, 9, dt),
      damp(this.stickVisual.y, pitchCmd, 9, dt),
    );

    // Landing prompt is driven by the star map through `landingTarget`.
    if (this.landingTarget && this.engine.input.pressed('interact')) {
      events.emit('ship:travelStarted', { to: this.landingTarget.id as never });
    }
  }

  render(ctx: FrameContext, _alpha: number): void {
    if (!this.active) return;
    const cam = this.engine.host.camera;
    const t = ctx.elapsed;

    // Camera rides the ship. Cockpit view sits at the pilot's eye; chase view
    // trails behind with a spring so hard turns read as speed.
    const targetLocal =
      this.view === 'cockpit'
        ? scratch.v3a.set(0, 0.42, 0.15)
        : scratch.v3a.set(0, 2.6, 11 + this.boostVisual * 4.5);
    dampVec3(this.camLocal, targetLocal, this.view === 'cockpit' ? 40 : 7, ctx.frameDt);

    cam.quaternion.copy(this.orientation);
    cam.position.copy(this.position).add(
      scratch.v3b.copy(this.camLocal).applyQuaternion(this.orientation),
    );

    if (this.camShake > 1e-4 && !settings.user.reducedMotion) {
      const s = this.camShake;
      cam.position.x += Math.sin(t * 47.3) * s;
      cam.position.y += Math.sin(t * 39.1 + 1.7) * s;
      cam.rotateZ(Math.sin(t * 31.7) * s * 0.35);
    }

    // FOV stretches under boost — the cheapest and most effective speed cue.
    this.engine.host.applyFov(1 / (1 + this.boostVisual * 0.22));

    // Thruster glow scales with throttle; the light actually lights the hull.
    const glow = clamp01(Math.max(0, this.throttle)) * (1 + this.boostVisual * 2.2);
    for (let i = 0; i < this.thrusterGlow.length; i++) {
      const m = this.thrusterGlow[i];
      const flicker = 0.92 + Math.sin(t * 61 + i * 2.3) * 0.08;
      m.scale.set(1 + glow * 0.5, 1 + glow * 0.5, 0.5 + glow * 3.4 * flicker);
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.25 + glow * 0.7;
    }
    this.thrusterLight.intensity = glow * 26;
    this.thrusterLight.color.setHSL(0.53, 0.85, lerp(0.55, 0.72, this.boostVisual));

    this.exterior.visible = this.view === 'chase';
  }

  // -- construction ---------------------------------------------------------

  private track<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  /**
   * Exterior hull. Built from lofted cross-sections so the silhouette is a
   * deliberate shape — a forward-swept delta with twin nacelles — rather than
   * boxes glued together.
   */
  private buildExterior(): void {
    const hull = this.materials.get('fedHull') as THREE.Material;
    const panel = this.materials.get('fedPanel') as THREE.Material;
    const trim = this.materials.get('fedTrim') as THREE.Material;

    // Fuselage: a lofted sequence of rounded-rectangle rings.
    const rings: Array<{ z: number; w: number; h: number; r: number }> = [
      { z: -7.4, w: 0.5, h: 0.42, r: 0.22 },
      { z: -5.6, w: 1.15, h: 0.78, r: 0.3 },
      { z: -3.0, w: 1.72, h: 1.05, r: 0.34 },
      { z: 0.0, w: 1.95, h: 1.18, r: 0.36 },
      { z: 2.8, w: 1.74, h: 1.1, r: 0.34 },
      { z: 5.0, w: 1.28, h: 0.92, r: 0.3 },
      { z: 6.6, w: 0.72, h: 0.6, r: 0.24 },
    ];
    const fuselage = this.track(loftRings(rings, 16));
    const fuselageMesh = new THREE.Mesh(fuselage, hull);
    fuselageMesh.castShadow = true;
    this.exterior.add(fuselageMesh);

    // Forward-swept wings.
    for (const side of [1, -1]) {
      const wing = this.track(
        extrudeProfile(
          [
            [0.0, 0.0],
            [4.6, -1.5],
            [5.2, -0.55],
            [1.5, 2.5],
            [0.0, 2.1],
          ],
          0.26,
        ),
      );
      const wm = new THREE.Mesh(wing, panel);
      wm.scale.x = side;
      wm.position.set(side * 0.85, -0.12, -0.4);
      wm.castShadow = true;
      this.exterior.add(wm);

      // Nacelle + thruster bell.
      const nacelle = this.track(new THREE.CapsuleGeometry(0.34, 2.1, 6, 12));
      const nm = new THREE.Mesh(nacelle, hull);
      nm.rotation.x = Math.PI / 2;
      nm.position.set(side * 2.5, -0.05, 0.9);
      nm.castShadow = true;
      this.exterior.add(nm);

      const bell = this.track(new THREE.CylinderGeometry(0.26, 0.4, 0.5, 14, 1, true));
      const bm = new THREE.Mesh(bell, trim);
      bm.rotation.x = Math.PI / 2;
      bm.position.set(side * 2.5, -0.05, 2.2);
      this.exterior.add(bm);

      const glowGeo = this.track(new THREE.ConeGeometry(0.3, 1, 14, 1, true));
      const glowMat = this.track(
        new THREE.MeshBasicMaterial({
          color: 0x6fe8ff,
          transparent: true,
          opacity: 0.6,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      const gm = new THREE.Mesh(glowGeo, glowMat);
      gm.rotation.x = -Math.PI / 2;
      gm.position.set(side * 2.5, -0.05, 2.9);
      this.thrusterGlow.push(gm);
      this.exterior.add(gm);
    }

    // Dorsal fin + canopy blister so the top silhouette isn't flat.
    const fin = this.track(
      extrudeProfile(
        [
          [0, 0],
          [1.9, 0.2],
          [2.3, 1.5],
          [0.2, 1.1],
        ],
        0.14,
      ),
    );
    const fm = new THREE.Mesh(fin, panel);
    fm.rotation.y = Math.PI / 2;
    fm.position.set(0, 0.5, 1.6);
    this.exterior.add(fm);

    this.thrusterLight = new THREE.PointLight(0x6fe8ff, 0, 34, 2);
    this.thrusterLight.position.set(0, 0, 3.2);
    this.exterior.add(this.thrusterLight);
  }

  /**
   * Cockpit interior. Rendered on a near layer with the canopy as a thin shell,
   * so the frame occludes the view the way a real canopy does and gives the
   * whole star map a sense of being *inside* something.
   */
  private buildCockpit(): void {
    const hull = this.materials.get('fedHull') as THREE.Material;
    const trim = this.materials.get('fedTrim') as THREE.Material;

    // Canopy frame: ribs swept around the forward hemisphere.
    const ribCount = 5;
    for (let i = 0; i < ribCount; i++) {
      const a = (-0.62 + (i / (ribCount - 1)) * 1.24) * Math.PI;
      const curve = new THREE.CatmullRomCurve3(
        Array.from({ length: 9 }, (_, k) => {
          const t = k / 8;
          const el = (t - 0.5) * Math.PI * 0.72;
          const r = 1.32;
          return new THREE.Vector3(
            Math.sin(a) * Math.cos(el) * r,
            Math.sin(el) * r * 0.82 + 0.34,
            -Math.cos(a) * Math.cos(el) * r - 0.5,
          );
        }),
      );
      const geo = this.track(new THREE.TubeGeometry(curve, 18, 0.032, 6, false));
      this.cockpit.add(new THREE.Mesh(geo, hull));
    }

    // Coaming / dashboard: a swept surface below the sight line with inset
    // instrument panels that read as emissive detail rather than a texture.
    const dash = this.track(
      loftRings(
        [
          { z: -1.5, w: 1.5, h: 0.1, r: 0.05 },
          { z: -1.05, w: 1.42, h: 0.3, r: 0.09 },
          { z: -0.5, w: 1.3, h: 0.36, r: 0.1 },
        ],
        12,
      ),
    );
    const dm = new THREE.Mesh(dash, hull);
    dm.position.y = -0.28;
    this.cockpit.add(dm);

    for (let i = 0; i < 7; i++) {
      const w = 0.1 + (i % 3) * 0.05;
      const geo = this.track(new THREE.PlaneGeometry(w, 0.05));
      const mat = this.track(
        new THREE.MeshBasicMaterial({
          color: i % 4 === 0 ? 0xffc46b : 0x5fe4ff,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      const p = new THREE.Mesh(geo, mat);
      p.position.set(-0.5 + i * 0.17, -0.3, -0.86);
      p.rotation.x = -0.9;
      this.cockpit.add(p);
    }

    // Side consoles frame the view and give the eye something in the periphery.
    for (const side of [1, -1]) {
      const geo = this.track(new THREE.BoxGeometry(0.3, 0.36, 1.5));
      const m = new THREE.Mesh(geo, trim);
      m.position.set(side * 0.92, -0.42, -0.2);
      m.rotation.z = side * 0.22;
      this.cockpit.add(m);
    }

    this.cockpit.visible = false;
    // Cockpit geometry lives close to the camera; keep it out of shadow passes.
    this.cockpit.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
    });
  }

  dispose(): void {
    this.engineHum?.stop(0);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.thrusterGlow.length = 0;
    this.root.removeFromParent();
    this.root.clear();
    this.built = false;
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers — kept local because they are shaped by the ship's needs.
// ---------------------------------------------------------------------------

/**
 * Loft a stack of rounded-rectangle rings into a closed hull. Produces a hull
 * whose cross-section changes along Z, which is what gives a spacecraft its
 * "designed" read versus a stretched capsule.
 */
function loftRings(
  rings: ReadonlyArray<{ z: number; w: number; h: number; r: number }>,
  segments: number,
): THREE.BufferGeometry {
  const rows = rings.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const ringPoint = (
    ring: { w: number; h: number; r: number },
    t: number,
    out: THREE.Vector2,
  ): THREE.Vector2 => {
    // Superellipse: r controls how square the section is.
    const a = t * TAU;
    const n = lerp(2, 5.5, 1 - clamp01(ring.r * 2.6));
    const c = Math.cos(a);
    const s = Math.sin(a);
    const sx = Math.sign(c) || 1;
    const sy = Math.sign(s) || 1;
    return out.set(
      sx * Math.abs(c) ** (2 / n) * ring.w,
      sy * Math.abs(s) ** (2 / n) * ring.h,
    );
  };

  const p = new THREE.Vector2();
  for (let i = 0; i < rows; i++) {
    const ring = rings[i];
    for (let j = 0; j <= segments; j++) {
      const t = j / segments;
      ringPoint(ring, t, p);
      positions.push(p.x, p.y, ring.z);
      normals.push(p.x, p.y, 0);
      uvs.push(t, i / (rows - 1));
    }
  }
  const stride = segments + 1;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // Cap the ends with a fan so the hull is watertight.
  for (const [rowIndex, flip] of [
    [0, true],
    [rows - 1, false],
  ] as Array<[number, boolean]>) {
    const ring = rings[rowIndex];
    const centre = positions.length / 3;
    positions.push(0, 0, ring.z);
    normals.push(0, 0, flip ? -1 : 1);
    uvs.push(0.5, 0.5);
    for (let j = 0; j < segments; j++) {
      const a = rowIndex * stride + j;
      const b = a + 1;
      if (flip) indices.push(centre, b, a);
      else indices.push(centre, a, b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Extrude a 2D profile (XY) along Z with flat caps — used for wings and fins. */
function extrudeProfile(profile: ReadonlyArray<[number, number]>, thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(profile[0][0], profile[0][1]);
  for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i][0], profile[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: thickness * 0.28,
    bevelSize: thickness * 0.24,
    bevelSegments: 2,
    curveSegments: 2,
  });
  geo.center();
  geo.computeVertexNormals();
  return geo;
}
