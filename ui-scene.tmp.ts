/** Scratch harness: boots the UI layer over a stand-in 3D scene. Delete when done. */
import * as THREE from 'three';
import { Engine } from '@/core/Engine';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import { UiRoot } from '@/ui/UiRoot';
import type { CollisionWorld, FrameContext, Level } from '@/types';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const engine = new Engine(canvas);

const scene = new THREE.Scene();
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(600, 32, 24),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uTop: { value: new THREE.Color(0x9fd0ef) }, uBot: { value: new THREE.Color(0xf4fbff) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} ',
    fragmentShader:
      'varying vec3 vP; uniform vec3 uTop; uniform vec3 uBot; void main(){ float h = clamp(vP.y/600.0*0.5+0.5,0.0,1.0); gl_FragColor = vec4(mix(uBot,uTop,pow(h,0.7)),1.0);} ',
  }),
);
scene.add(sky);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x6b7480, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

for (let i = 0; i < 26; i++) {
  const h = 2 + (i % 5) * 3;
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(3 + (i % 3), h, 3 + ((i * 7) % 4)),
    new THREE.MeshStandardMaterial({ color: i % 3 === 0 ? 0x2b3340 : 0x424c5c, roughness: 0.8 }),
  );
  m.position.set(Math.sin(i * 2.3) * (12 + i * 2.2), h / 2, -14 - (i % 9) * 7);
  m.rotation.y = i * 0.7;
  scene.add(m);
}
const sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
sun.position.set(30, 40, 12);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x2a2f38, 1.1));

const collision: CollisionWorld = {
  raycast: () => null,
  resolveCapsule: () => ({
    grounded: true,
    groundNormal: new THREE.Vector3(0, 1, 0),
    slope: 0,
    touchedWall: false,
    wallNormal: new THREE.Vector3(),
    landingImpact: 0,
  }),
  sampleGround: () => ({ y: 0, normal: new THREE.Vector3(0, 1, 0) }),
  lineOfSight: () => true,
};

const level: Level = {
  id: 'aurvangr',
  scene,
  collision,
  async load() {},
  update(_ctx: FrameContext) {},
  getSpawnPoint: () => ({ position: new THREE.Vector3(), yaw: 0 }),
  sunDirection: new THREE.Vector3(0.4, 0.7, 0.2),
  sunColor: new THREE.Color(0xfff0dd),
  fogColor: new THREE.Color(0xa8c8e0),
  dispose() {},
};

const ui = engine.add(new UiRoot(engine));
ui.onTravel = (id) => console.log('[harness] set course', id);
engine.setLevel(level);
engine.host.camera.position.set(0, 1.7, 8);
engine.host.camera.rotation.set(-0.06, 0, 0);
engine.state = 'playing';
engine.start();

// Background swaps so the HUD can be judged over a bright sky and a dark cave.
function setMood(bright: boolean): void {
  const u = (sky.material as THREE.ShaderMaterial).uniforms;
  (u.uTop.value as THREE.Color).set(bright ? 0x9fd0ef : 0x080b12);
  (u.uBot.value as THREE.Color).set(bright ? 0xf4fbff : 0x11161f);
  sun.intensity = bright ? 2.6 : 0.25;
}

const p = new THREE.Vector3();
(window as unknown as { T: unknown }).T = {
  engine,
  ui,
  settings,
  bright: () => setMood(true),
  dark: () => setMood(false),
  /** Simulate a burst of combat so the transient HUD elements are populated. */
  combat() {
    for (let i = 0; i < 5; i++) {
      p.set(Math.sin(i * 1.7) * 6, 1.4 + Math.cos(i) * 0.8, -12 - i * 2);
      events.emit('enemy:damaged', {
        amount: i === 2 ? 184 : 34 + i * 11,
        element: 'arc',
        region: i === 2 ? 'head' : 'body',
        precision: i === 2,
        point: p.clone(),
        normal: new THREE.Vector3(0, 1, 0),
        direction: new THREE.Vector3(0, 0, -1),
        sourceId: 0,
        remaining: 620 - i * 90,
        entityId: 40 + i,
      });
    }
    events.emit('hitmarker', { precision: true, kill: false, damage: 184 });
  },
};
document.getElementById('boot')?.remove();
