/**
 * Hud — every persistent combat readout.
 *
 * Everything here is built once in the constructor and only *mutated* per
 * frame through the cached binds in `./dom`; nothing allocates, nothing is
 * re-created, and no string is written back into the DOM unless it changed.
 *
 * Gauge technique: each arc/bar segment is an SVG path with `pathLength="100"`,
 * so filling it to `f` is a single `stroke-dasharray="f*100 100"` write. That
 * gives real segmented arcs (with gaps, caps and per-segment flashes) for the
 * cost of one attribute per segment.
 */
import * as THREE from 'three';
import type { AbilityState, HudState, TargetState } from './UiRoot';
import { ELEMENT_COLOR, ELEMENT_GLYPH } from './ui.css';
import {
  arcPath,
  AttrBind,
  div,
  el,
  StyleBind,
  svg,
  TextBind,
  toggle,
  easeOutCubic,
} from './dom';
import { clamp01, damp } from '@/util/math';

/** Scratch for the waypoint projection. The HUD must not allocate per frame. */
const _wp = new THREE.Vector3();
const _wpProj = new THREE.Vector3();
const _wpView = new THREE.Vector3();

const HEALTH_SEGMENTS = 6;
const SHIELD_SEGMENTS = 8;
const MAX_PIPS = 24;
const COMPASS_TICKS = 24;
const COMPASS_MARKS = 10;
const HIT_ARCS = 8;
const COMPASS_HALF_FOV = 0.95; // radians visible either side of centre

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

interface Segment {
  fill: AttrBind;
  node: SVGPathElement;
}

interface CompassTick {
  node: HTMLElement;
  bearing: number;
  x: StyleBind;
  op: StyleBind;
}

interface CompassMark {
  node: HTMLElement;
  x: StyleBind;
  op: StyleBind;
}

interface HitArc {
  node: HTMLElement;
  rot: StyleBind;
  op: StyleBind;
}

interface BarUi {
  root: HTMLElement;
  name: TextBind;
  health: StyleBind;
  shield: StyleBind;
  shieldOn: HTMLElement;
  el: StyleBind;
  pop: StyleBind;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly state: HudState;
  private readonly camera: THREE.Camera;

  // vitals
  private readonly vitals: HTMLElement;
  private readonly healthSegs: Segment[] = [];
  private readonly shieldSegs: Segment[] = [];
  private readonly healthNum: TextBind;
  private readonly shieldNum: TextBind;
  private readonly vitalsFlash: StyleBind;

  // weapon
  private readonly weapon: HTMLElement;
  private readonly weaponName: TextBind;
  private readonly weaponFamily: TextBind;
  private readonly ammoCur: TextBind;
  private readonly ammoRes: TextBind;
  private readonly elementIcon: SVGPathElement;
  private readonly elementVar: StyleBind;
  private readonly pipRow: HTMLElement;
  private readonly pips: HTMLElement[] = [];
  private readonly magBar: HTMLElement;
  private readonly magBarFill: StyleBind;
  private readonly reloadFill: StyleBind;
  private readonly reloadRoot: HTMLElement;
  private readonly fireBind: StyleBind;
  private rarityClass = '';

  // abilities + super
  private readonly abilityUi: { root: HTMLElement; fill: AttrBind; pop: StyleBind }[] = [];
  private readonly superFill: StyleBind;
  private readonly superRoot: HTMLElement;
  private readonly superLabel: TextBind;

  // compass
  private readonly compassTicks: CompassTick[] = [];
  private readonly compassMarks: CompassMark[] = [];

  // objective waypoint
  private readonly waypoint: HTMLElement;
  private readonly waypointDist: TextBind;
  private readonly waypointLabel: TextBind;
  private readonly waypointPos: StyleBind;
  private readonly waypointRot: StyleBind;

  // objective
  private readonly objective: HTMLElement;
  private readonly objectiveText: TextBind;
  private readonly objectiveCount: TextBind;
  private readonly objectiveFill: StyleBind;

  // targets
  private readonly targetBar: BarUi;
  private readonly bossBar: BarUi;
  private readonly bossSegments: HTMLElement;

  // misc
  private readonly hitArcs: HitArc[] = [];
  private readonly subtitle: HTMLElement;
  private readonly subtitleSpeaker: TextBind;
  private readonly subtitleText: TextBind;
  private readonly streak: HTMLElement;
  private readonly streakText: TextBind;

  // smoothed values
  private sHealth = 1;
  private sShield = 1;
  private sSuper = 0;
  private sTargetHealth = 1;
  private sBossHealth = 1;
  private sBossShield = 1;
  private sTargetShield = 1;
  private time = 0;

  constructor(parent: HTMLElement, state: HudState, camera: THREE.Camera) {
    this.state = state;
    this.camera = camera;
    this.root = div('gf-hud', parent);

    // -- vitals (bottom-left) ------------------------------------------------
    this.vitals = div('gf-vitals', this.root);
    this.vitalsFlash = new StyleBind(this.vitals, '--flash');
    const vsvg = svg('svg', { class: 'gf-vitals-svg', viewBox: '0 0 150 150' }, this.vitals);
    const cx = 16;
    const cy = 138;

    // Track + fill for both rings. Angles run from just below horizontal up to
    // just short of vertical, hugging the corner of the frame.
    const a0 = -0.14;
    const a1 = -Math.PI / 2 - 0.12;
    this.buildRing(vsvg, cx, cy, 118, SHIELD_SEGMENTS, a0, a1, 'shield', this.shieldSegs);
    this.buildRing(vsvg, cx, cy, 99, HEALTH_SEGMENTS, a0 + 0.02, a1 + 0.02, 'health', this.healthSegs);

    const readout = div('gf-vitals-readout', this.vitals);
    const hRow = div('gf-vitals-row', readout);
    this.healthNum = new TextBind(div('gf-vitals-hp', hRow));
    div('gf-vitals-cap', hRow).textContent = 'HP';
    const sRow = div('gf-vitals-row is-shield', readout);
    this.shieldNum = new TextBind(div('gf-vitals-sh', sRow));
    div('gf-vitals-cap', sRow).textContent = 'SHIELD';

    // -- weapon (bottom-right) ----------------------------------------------
    this.weapon = div('gf-weapon', this.root);
    this.elementVar = new StyleBind(this.weapon, '--el');
    const head = div('gf-weapon-head', this.weapon);
    const names = div('gf-weapon-names', head);
    this.weaponName = new TextBind(div('gf-weapon-name', names));
    this.weaponFamily = new TextBind(div('gf-weapon-family', names));
    const icon = svg('svg', { class: 'gf-weapon-el', viewBox: '0 0 24 24' }, head);
    this.elementIcon = svg('path', { d: ELEMENT_GLYPH.kinetic }, icon) as SVGPathElement;

    this.pipRow = div('gf-pips', this.weapon);
    for (let i = 0; i < MAX_PIPS; i++) this.pips.push(div('gf-pip', this.pipRow));
    this.magBar = div('gf-magbar', this.weapon);
    this.magBarFill = new StyleBind(div('gf-magbar-fill', this.magBar), 'width');

    const ammo = div('gf-weapon-ammo', this.weapon);
    this.ammoCur = new TextBind(div('gf-ammo-cur', ammo));
    div('gf-ammo-slash', ammo).textContent = '/';
    this.ammoRes = new TextBind(div('gf-ammo-res', ammo));

    this.reloadRoot = div('gf-reload', this.weapon);
    div('gf-reload-label', this.reloadRoot).textContent = 'RELOADING';
    this.reloadFill = new StyleBind(div('gf-reload-fill', this.reloadRoot), 'width');
    this.fireBind = new StyleBind(this.weapon, '--fire');

    // -- abilities + super (bottom-centre) ----------------------------------
    const abilities = div('gf-abilities', this.root);
    this.superRoot = div('gf-super', abilities);
    const superTrack = div('gf-super-track', this.superRoot);
    this.superFill = new StyleBind(div('gf-super-fill', superTrack), 'width');
    div('gf-super-notches', superTrack);
    this.superLabel = new TextBind(div('gf-super-label', this.superRoot));

    const pipRow = div('gf-ability-row', abilities);
    const abilityDefs: { cls: string; key: string; glyph: string }[] = [
      { cls: 'grenade', key: 'Q', glyph: 'M12 3.2 14.4 6h-4.8L12 3.2Zm0 3.4a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8Zm0 2.2a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z' },
      { cls: 'melee', key: 'V', glyph: 'M6 18.6 15.4 9.2l-1.6-1.6L4.4 17l1.6 1.6ZM16.6 3.4l4 4-3.2 3.2-4-4 3.2-3.2Z' },
      { cls: 'class', key: 'E', glyph: 'M12 3.4 19.6 8v8L12 20.6 4.4 16V8L12 3.4Zm0 2.6L6.6 9.2v5.6L12 18l5.4-3.2V9.2L12 6Z' },
    ];
    for (const def of abilityDefs) {
      const node = div(`gf-ability is-${def.cls}`, pipRow);
      const s = svg('svg', { viewBox: '0 0 44 44', class: 'gf-ability-svg' }, node);
      svg('circle', { class: 'gf-ability-track', cx: 22, cy: 22, r: 18, pathLength: 100 }, s);
      const fill = svg(
        'circle',
        { class: 'gf-ability-fill', cx: 22, cy: 22, r: 18, pathLength: 100, 'stroke-dasharray': '0 100' },
        s,
      );
      const g = svg('svg', { viewBox: '0 0 24 24', class: 'gf-ability-glyph' }, node);
      svg('path', { d: def.glyph }, g);
      div('gf-ability-key', node).textContent = def.key;
      this.abilityUi.push({
        root: node,
        fill: new AttrBind(fill, 'stroke-dasharray'),
        pop: new StyleBind(node, '--pop'),
      });
    }

    // -- top centre column ---------------------------------------------------
    const top = div('gf-top', this.root);
    const compass = div('gf-compass', top);
    const strip = div('gf-compass-strip', compass);
    for (let i = 0; i < COMPASS_TICKS; i++) {
      const bearing = (i / COMPASS_TICKS) * Math.PI * 2;
      const major = i % 3 === 0;
      const node = div(`gf-compass-tick${major ? ' is-major' : ''}`, strip);
      if (major) el('i', 'gf-compass-label', node).textContent = CARDINALS[i / 3];
      this.compassTicks.push({
        node,
        bearing,
        x: new StyleBind(node, '--x'),
        op: new StyleBind(node, 'opacity'),
      });
    }
    for (let i = 0; i < COMPASS_MARKS; i++) {
      const node = div('gf-compass-mark', strip);
      this.compassMarks.push({
        node,
        x: new StyleBind(node, '--x'),
        op: new StyleBind(node, 'opacity'),
      });
    }
    div('gf-compass-caret', compass);

    this.bossBar = this.buildBar(top, 'gf-boss');
    this.bossSegments = div('gf-boss-notches', this.bossBar.root);
    this.targetBar = this.buildBar(top, 'gf-target');

    // -- objective (top-left) ------------------------------------------------
    this.objective = div('gf-objective', this.root);
    div('gf-objective-cap', this.objective).textContent = 'Objective';
    this.objectiveText = new TextBind(div('gf-objective-text', this.objective));
    const oBar = div('gf-objective-bar', this.objective);
    this.objectiveFill = new StyleBind(div('gf-objective-fill', oBar), 'width');
    this.objectiveCount = new TextBind(div('gf-objective-count', this.objective));

    // -- objective waypoint --------------------------------------------------
    //
    // The objective was a line of text with no direction attached to it, which
    // is why "Advance up the avenue" did not tell anyone where the avenue was.
    this.waypoint = div('gf-waypoint', this.root);
    this.waypointPos = new StyleBind(this.waypoint, 'transform');
    const wpMark = div('gf-waypoint-mark', this.waypoint);
    this.waypointRot = new StyleBind(wpMark, 'transform');
    this.waypointLabel = new TextBind(div('gf-waypoint-label', this.waypoint));
    this.waypointDist = new TextBind(div('gf-waypoint-dist', this.waypoint));

    // -- directional damage arcs --------------------------------------------
    const hits = div('gf-hits', this.root);
    for (let i = 0; i < HIT_ARCS; i++) {
      const node = div('gf-hit', hits);
      const s = svg('svg', { viewBox: '0 0 200 200' }, node);
      // Halo / casing / core, all on the same radius — a cheap taper that keeps
      // the indicator readable over both a bright sky and a black cave.
      svg('path', { class: 'gf-hit-halo', d: arcPath(100, 100, 88, -Math.PI * 0.568, -Math.PI * 0.432) }, s);
      svg('path', { class: 'gf-hit-outer', d: arcPath(100, 100, 88, -Math.PI * 0.556, -Math.PI * 0.444) }, s);
      svg('path', { class: 'gf-hit-inner', d: arcPath(100, 100, 88, -Math.PI * 0.552, -Math.PI * 0.448) }, s);
      this.hitArcs.push({
        node,
        rot: new StyleBind(node, '--rot'),
        op: new StyleBind(node, 'opacity'),
      });
    }

    // -- subtitles + streak --------------------------------------------------
    this.subtitle = div('gf-subtitle', this.root);
    this.subtitleSpeaker = new TextBind(div('gf-subtitle-speaker', this.subtitle));
    this.subtitleText = new TextBind(div('gf-subtitle-text', this.subtitle));

    this.streak = div('gf-streak', this.root);
    this.streakText = new TextBind(div('gf-streak-num', this.streak));
    div('gf-streak-cap', this.streak).textContent = 'Multi-kill';
  }

  // -- construction helpers --------------------------------------------------

  private buildRing(
    parent: SVGElement,
    cx: number,
    cy: number,
    r: number,
    count: number,
    a0: number,
    a1: number,
    cls: string,
    out: Segment[],
  ): void {
    const g = svg('g', { class: `gf-ring is-${cls}` }, parent);
    const span = (a1 - a0) / count;
    const gap = Math.abs(span) * 0.11;
    for (let i = 0; i < count; i++) {
      const s0 = a0 + span * i + Math.sign(span) * gap * 0.5;
      const s1 = a0 + span * (i + 1) - Math.sign(span) * gap * 0.5;
      const d = arcPath(cx, cy, r, s0, s1);
      svg('path', { class: 'gf-ring-track', d, pathLength: 100, 'stroke-dasharray': '100 100' }, g);
      const fill = svg(
        'path',
        { class: 'gf-ring-fill', d, pathLength: 100, 'stroke-dasharray': '0 100' },
        g,
      ) as SVGPathElement;
      out.push({ node: fill, fill: new AttrBind(fill, 'stroke-dasharray') });
    }
  }

  private buildBar(parent: HTMLElement, cls: string): BarUi {
    const root = div(cls, parent);
    const name = new TextBind(div(`${cls}-name`, root));
    const track = div(`${cls}-track`, root);
    const health = div(`${cls}-health`, track);
    const shieldOn = div(`${cls}-shield`, track);
    return {
      root,
      name,
      health: new StyleBind(health, 'width'),
      shield: new StyleBind(shieldOn, 'width'),
      shieldOn,
      el: new StyleBind(root, '--el'),
      pop: new StyleBind(root, '--pop'),
    };
  }

  // -- per-frame -------------------------------------------------------------

  flashObjective(): void {
    this.objective.classList.remove('is-in');
    void this.objective.offsetWidth; // force reflow so the animation restarts
    this.objective.classList.add('is-in');
  }

  render(dt: number, visible: boolean): void {
    toggle(this.root, 'is-on', visible);
    if (!visible) return;
    this.time += dt;
    const s = this.state;

    this.renderVitals(dt, s);
    this.renderWeapon(s);
    this.renderAbilities(dt, s);
    this.renderCompass(s);
    this.renderObjective(s);
    this.renderWaypoint(s);
    this.renderTargets(dt, s);
    this.renderHits(s);
    this.renderMisc(s);
  }

  private renderVitals(dt: number, s: HudState): void {
    const hFrac = clamp01(s.health / 100);
    const sFrac = clamp01(s.shield / 130);
    this.sHealth = damp(this.sHealth, hFrac, 14, dt);
    this.sShield = damp(this.sShield, sFrac, 18, dt);

    fillSegments(this.healthSegs, this.sHealth);
    fillSegments(this.shieldSegs, this.sShield);

    this.healthNum.set(String(Math.ceil(s.health)));
    this.shieldNum.set(String(Math.ceil(s.shield)));
    this.vitalsFlash.num(s.shieldBreak);
    toggle(this.vitals, 'is-low', hFrac < 0.4);
    toggle(this.vitals, 'is-critical', hFrac < 0.2);
    toggle(this.vitals, 'is-broken', s.shieldBreak > 0.01);
    toggle(this.vitals, 'is-noshield', sFrac <= 0.001);
  }

  private renderWeapon(s: HudState): void {
    this.weaponName.set(s.weaponName);
    this.weaponFamily.set(s.weaponFamily);
    this.ammoCur.set(String(Math.max(0, Math.round(s.ammo))));
    this.ammoRes.set(String(Math.max(0, Math.round(s.reserves))));
    this.elementVar.set(ELEMENT_COLOR[s.element]);
    const glyph = ELEMENT_GLYPH[s.element];
    if (this.elementIcon.getAttribute('d') !== glyph) this.elementIcon.setAttribute('d', glyph);

    const usePips = s.magazine <= MAX_PIPS;
    toggle(this.pipRow, 'is-on', usePips);
    toggle(this.magBar, 'is-on', !usePips);
    const lowAmmo = s.ammo / Math.max(1, s.magazine) <= 0.26;
    toggle(this.weapon, 'is-lowammo', lowAmmo && s.reload < 0);
    toggle(this.weapon, 'is-empty', s.ammo <= 0 && s.reload < 0);
    toggle(this.weapon, 'is-resupplied', s.ammoPop > 0.01);
    if (this.rarityClass !== s.rarity) {
      if (this.rarityClass) this.weapon.classList.remove(`is-${this.rarityClass}`);
      this.weapon.classList.add(`is-${s.rarity}`);
      this.rarityClass = s.rarity;
    }

    if (usePips) {
      for (let i = 0; i < MAX_PIPS; i++) {
        const pip = this.pips[i];
        const used = i >= s.magazine;
        toggle(pip, 'is-hidden', used);
        toggle(pip, 'is-spent', i >= s.ammo);
      }
    } else {
      this.magBarFill.num(clamp01(s.ammo / Math.max(1, s.magazine)) * 100, '%');
    }

    const reloading = s.reload >= 0;
    toggle(this.reloadRoot, 'is-on', reloading);
    if (reloading) this.reloadFill.num(clamp01(s.reload) * 100, '%');
    toggle(this.weapon, 'is-reloadpop', s.reloadPop > 0.02);
    this.fireBind.num(s.firePop);
  }

  private renderAbilities(dt: number, s: HudState): void {
    const slots: AbilityState[] = [s.grenade, s.melee, s.classAbility];
    for (let i = 0; i < this.abilityUi.length; i++) {
      const ui = this.abilityUi[i];
      const a = slots[i];
      ui.fill.set(`${(clamp01(a.charge) * 100).toFixed(1)} 100`);
      ui.pop.num(a.pop > 0 ? easeOutCubic(a.pop) : 0);
      toggle(ui.root, 'is-ready', a.ready);
    }
    this.sSuper = damp(this.sSuper, clamp01(s.superCharge), 10, dt);
    this.superFill.num(this.sSuper * 100, '%');
    toggle(this.superRoot, 'is-ready', s.superReady);
    toggle(this.superRoot, 'is-active', s.superActive);
    this.superLabel.set(
      s.superActive ? 'SUPER ACTIVE' : s.superReady ? 'SUPER READY' : `SUPER ${Math.floor(this.sSuper * 100)}%`,
    );
  }

  private renderCompass(s: HudState): void {
    const heading = s.heading;
    for (const t of this.compassTicks) {
      let d = t.bearing - heading;
      d = ((d + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const inside = Math.abs(d) < COMPASS_HALF_FOV;
      t.op.num(inside ? Math.min(1, (COMPASS_HALF_FOV - Math.abs(d)) * 3.4) : 0);
      if (inside) t.x.num((d / COMPASS_HALF_FOV) * 50, '%');
    }
    const contacts = s.contacts;
    for (let i = 0; i < this.compassMarks.length; i++) {
      const m = this.compassMarks[i];
      const c = contacts[i];
      if (!c || c.life <= 0) {
        m.op.num(0);
        continue;
      }
      let d = c.bearing - heading;
      d = ((d + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const clamped = Math.max(-1, Math.min(1, d / COMPASS_HALF_FOV));
      m.x.num(clamped * 50, '%');
      m.op.num(Math.min(1, c.life * 0.9));
      toggle(m.node, 'is-edge', Math.abs(d) >= COMPASS_HALF_FOV);
      toggle(m.node, 'is-kill', c.kill > 0);
    }
  }

  /**
   * Put the objective on screen as a place, not a sentence.
   *
   * On screen it sits on the point itself with the range under it. Off screen
   * -- or behind the camera, where a raw projection flips the sign and lands
   * the marker on the wrong side -- it pins to the edge of the frame and turns
   * into an arrow, so it always answers "which way" even when the answer is
   * "behind you". A `clear` wave has no fixed point and reports none, and the
   * marker hides rather than pointing somewhere arbitrary.
   */
  private renderWaypoint(s: HudState): void {
    const m = s.objectiveMarker;
    const on = !!m && s.objectiveDone < 0.01;
    toggle(this.waypoint, 'is-on', on);
    if (!m || !on) return;

    _wp.set(m.x, m.y + 1.2, m.z);
    const dist = _wp.distanceTo(this.camera.position);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pad = Math.min(w, h) * 0.09;
    const cx = w * 0.5;
    const cy = h * 0.5;

    // View space decides "behind", not the projection. `project` mirrors a
    // point at your back through the origin, so a target directly behind lands
    // near the centre of the frame and the edge push sends it wherever the
    // rounding happens to fall -- measured, that was the top of the screen,
    // which reads as "straight ahead" for the one direction it is not.
    _wpView.copy(_wp).applyMatrix4(this.camera.matrixWorldInverse);
    const behind = _wpView.z > 0;
    let x: number;
    let y: number;
    if (behind) {
      // Nothing behind you has an on-screen position, so give it the only
      // honest one: down, and to whichever side you would turn to find it.
      x = cx + (_wpView.x >= 0 ? 1 : -1) * Math.min(1, Math.abs(_wpView.x) / 12) * cx;
      y = h;
    } else {
      _wpProj.copy(_wp).project(this.camera);
      x = (_wpProj.x * 0.5 + 0.5) * w;
      y = (-_wpProj.y * 0.5 + 0.5) * h;
    }
    const offscreen = behind || x < pad || x > w - pad || y < pad || y > h - pad;
    let angle = 0;
    if (offscreen) {
      // Push the direction out to the frame edge and keep it there.
      const dx = x - cx;
      const dy = y - cy;
      const kx = (w * 0.5 - pad) / Math.max(1e-3, Math.abs(dx));
      const ky = (h * 0.5 - pad) / Math.max(1e-3, Math.abs(dy));
      const k = Math.min(kx, ky);
      x = cx + dx * k;
      y = cy + dy * k;
      angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    }
    toggle(this.waypoint, 'is-edge', offscreen);
    this.waypointPos.set(`translate(${Math.round(x)}px, ${Math.round(y)}px)`);
    this.waypointRot.set(offscreen ? `rotate(${angle.toFixed(0)}deg)` : 'rotate(45deg)');
    this.waypointLabel.set(s.objectiveMarkerLabel);
    this.waypointDist.set(dist >= 1000 ? `${(dist / 1000).toFixed(1)}km` : `${Math.round(dist)}m`);
  }

  private renderObjective(s: HudState): void {
    const on = s.objectiveText.length > 0 && s.objectiveDone < 3.4;
    toggle(this.objective, 'is-on', on);
    if (!on) return;
    this.objectiveText.set(s.objectiveText);
    const total = Math.max(1, s.objectiveTotal);
    this.objectiveFill.num(clamp01(s.objectiveProgress / total) * 100, '%');
    this.objectiveCount.set(
      s.objectiveTotal > 0 ? `${Math.round(s.objectiveProgress)} / ${Math.round(s.objectiveTotal)}` : '',
    );
    toggle(this.objective, 'is-done', s.objectiveDone > 0);
  }

  private renderTargets(dt: number, s: HudState): void {
    const t = s.target;
    toggle(this.targetBar.root, 'is-on', !!t && !t.boss);
    if (t) {
      this.sTargetHealth = damp(this.sTargetHealth, clamp01(t.health / t.maxHealth), 16, dt);
      this.sTargetShield = damp(this.sTargetShield, clamp01(t.shield), 16, dt);
      this.applyBar(this.targetBar, t, this.sTargetHealth, this.sTargetShield);
    }
    const b = s.boss;
    toggle(this.bossBar.root, 'is-on', !!b);
    toggle(this.bossSegments, 'is-on', !!b);
    if (b) {
      this.sBossHealth = damp(this.sBossHealth, clamp01(b.health / b.maxHealth), 12, dt);
      this.sBossShield = damp(this.sBossShield, clamp01(b.shield), 12, dt);
      this.applyBar(this.bossBar, b, this.sBossHealth, this.sBossShield);
    }
  }

  private applyBar(ui: BarUi, t: TargetState, health: number, shield: number): void {
    ui.name.set(t.name.toUpperCase());
    ui.health.num(health * 100, '%');
    ui.shield.num(shield * 100, '%');
    toggle(ui.shieldOn, 'is-on', shield > 0.005);
    ui.el.set(t.shieldElement ? ELEMENT_COLOR[t.shieldElement] : '#8fb6d6');
    ui.pop.num(t.hitPop);
  }

  private renderHits(s: HudState): void {
    this.camera.getWorldDirection(_fwd);
    _right.copy(_fwd).cross(_up).normalize();
    for (let i = 0; i < this.hitArcs.length; i++) {
      const arc = this.hitArcs[i];
      const h = s.hits[i];
      if (!h || h.life <= 0) {
        arc.op.num(0);
        continue;
      }
      const f = h.dir.dot(_fwd);
      const r = h.dir.dot(_right);
      const angle = Math.atan2(r, f) * (180 / Math.PI);
      arc.rot.num(angle, 'deg');
      const life = clamp01(h.life / 1.35);
      arc.op.num(Math.min(1, life * 1.6) * (0.45 + h.strength * 0.55));
    }
  }

  private renderMisc(s: HudState): void {
    const subOn = s.subtitleLife > 0 && s.subtitleText.length > 0;
    toggle(this.subtitle, 'is-on', subOn);
    if (subOn) {
      this.subtitleSpeaker.set(s.subtitleSpeaker.toUpperCase());
      this.subtitleText.set(s.subtitleText);
    }
    const streakOn = s.killStreak >= 2 && s.killStreakLife > 0;
    toggle(this.streak, 'is-on', streakOn);
    if (streakOn) this.streakText.set(`${s.killStreak}x`);
  }

  dispose(): void {
    this.root.remove();
  }
}

function fillSegments(segs: Segment[], frac: number): void {
  const n = segs.length;
  for (let i = 0; i < n; i++) {
    const f = clamp01(frac * n - i);
    segs[i].fill.set(`${(f * 100).toFixed(1)} 100`);
    toggle(segs[i].node, 'is-partial', f > 0.001 && f < 0.999);
  }
}
