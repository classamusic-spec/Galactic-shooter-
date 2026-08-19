/**
 * SettingsMenu — a real control for every field in `UserSettings`.
 *
 * Each row writes straight through `settings.patch({...})`, which persists to
 * localStorage and emits `settings:changed`; the renderer, post chain and HUD
 * all pick the change up on the next frame, so every slider is a live preview.
 * `sync()` reads the store back so an external change (the debug console, a
 * tier auto-drop) is reflected without the row fighting the store.
 */
import type { QualityTier } from '@/types';
import type { UserSettings } from '@/core/Settings';
import { settings } from '@/core/Settings';
import { div, interactive, StyleBind, TextBind, toggle } from './dom';

/**
 * Mirrors the defaults in `core/Settings`. Duplicated deliberately: the store
 * does not export them, and RESET must not depend on reload order. `tier` is
 * excluded — it is hardware-detected and resetting it would be a downgrade on
 * good machines.
 */
const DEFAULTS: Omit<UserSettings, 'tier'> = {
  fov: 95,
  sensitivity: 0.0022,
  touchSensitivity: 0.0035,
  adsSensitivityScale: 0.65,
  invertY: false,
  padSensitivity: 170,
  stickDeadzone: 0.08,
  aimAssist: 0.7,
  vibration: 0.8,
  masterVolume: 0.85,
  sfxVolume: 1,
  ambienceVolume: 0.55,
  musicVolume: 0.6,
  reducedMotion: false,
  damageNumbers: true,
  crosshairStyle: 'dynamic',
  frameBudgetMs: 15.5,
  adaptiveResolution: true,
  showFps: false,
  filmGrain: 0.035,
  chromaticAberration: 0.5,
  vignette: 0.75,
  motionBlurStrength: 0.6,
  bloomStrength: 1,
  exposure: 1,
};

/** Footer legend, per input device. See PauseMenu.setDevice for the reasoning. */
const HINTS = {
  key: 'Arrows — navigate      Left / Right — adjust      Esc — back',
  pad: 'D-pad ↑↓ — navigate      D-pad ←→ — adjust      ○ — back',
} as const;

interface Row {
  node: HTMLElement;
  page: number;
  left(): void;
  right(): void;
  activate(): void;
  sync(): void;
}

const PAGES = ['Display', 'Image', 'Gameplay', 'Audio'];

export class SettingsMenu {
  visible = false;

  private readonly root: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly tabs: HTMLElement[] = [];
  private readonly pages: HTMLElement[] = [];
  private readonly rows: Row[] = [];
  private readonly hint: TextBind;

  /** Swap the footer legend between keyboard and PlayStation glyphs. */
  setDevice(pad: boolean): void {
    this.hint.set(pad ? HINTS.pad : HINTS.key);
  }
  private page = 0;
  /** -1 = the tab rail has the cursor; otherwise an index into `pageRows()`. */
  private index = -1;
  private syncing = false;

  constructor(parent: HTMLElement) {
    this.root = div('gf-modal gf-settings', parent);
    interactive(div('gf-modal-backdrop', this.root));

    const panel = interactive(div('gf-panel is-settings', this.root));
    const head = div('gf-panel-head', panel);
    div('gf-panel-kicker', head).textContent = 'Vanguard Field Configuration';
    div('gf-panel-title', head).textContent = 'Settings';
    div('gf-panel-rule', panel);

    const body = div('gf-settings-body', panel);
    this.rail = div('gf-tabs', body);
    const pageHost = div('gf-settings-pages', body);
    for (let i = 0; i < PAGES.length; i++) {
      const tab = interactive(document.createElement('button'));
      tab.className = 'gf-tab';
      tab.type = 'button';
      tab.textContent = PAGES[i];
      tab.addEventListener('click', () => this.setPage(i));
      this.rail.appendChild(tab);
      this.tabs.push(tab);
      this.pages.push(div('gf-settings-page', pageHost));
    }

    // -- Display -------------------------------------------------------------
    this.enumRow(0, 'Quality Tier', 'Shadow, SSAO, particle and texture budgets.',
      [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']],
      () => settings.user.tier,
      (v) => settings.setTier(v as QualityTier));
    this.sliderRow(0, 'Field of View', 'Horizontal FOV in degrees.', 70, 120, 1,
      () => settings.user.fov, (v) => this.patch({ fov: v }), (v) => `${v.toFixed(0)}°`);
    this.toggleRow(0, 'Adaptive Resolution', 'Trade pixels for frame time under load.',
      () => settings.user.adaptiveResolution, (v) => this.patch({ adaptiveResolution: v }));
    this.sliderRow(0, 'Frame Budget', 'Target frame time the adaptive scaler aims for.',
      8, 33, 0.5, () => settings.user.frameBudgetMs, (v) => this.patch({ frameBudgetMs: v }),
      (v) => `${v.toFixed(1)} ms · ${Math.round(1000 / v)} fps`);
    this.toggleRow(0, 'Performance Overlay', 'FPS, draw calls, triangles and program count.',
      () => settings.user.showFps, (v) => this.patch({ showFps: v }));

    // -- Image ---------------------------------------------------------------
    this.sliderRow(1, 'Exposure', 'Tone-mapping exposure.', 0.4, 2, 0.02,
      () => settings.user.exposure, (v) => this.patch({ exposure: v }), two);
    this.sliderRow(1, 'Bloom', 'Emissive glow strength.', 0, 2, 0.02,
      () => settings.user.bloomStrength, (v) => this.patch({ bloomStrength: v }), two);
    this.sliderRow(1, 'Film Grain', 'Sensor grain over the final image.', 0, 0.15, 0.005,
      () => settings.user.filmGrain, (v) => this.patch({ filmGrain: v }), three);
    this.sliderRow(1, 'Chromatic Aberration', 'Lens fringing at the frame edge.', 0, 2, 0.05,
      () => settings.user.chromaticAberration, (v) => this.patch({ chromaticAberration: v }), two);
    this.sliderRow(1, 'Vignette', 'Corner falloff.', 0, 1.5, 0.05,
      () => settings.user.vignette, (v) => this.patch({ vignette: v }), two);
    this.sliderRow(1, 'Motion Blur', 'Per-object motion blur strength.', 0, 1, 0.05,
      () => settings.user.motionBlurStrength, (v) => this.patch({ motionBlurStrength: v }), two);

    // -- Gameplay ------------------------------------------------------------
    this.sliderRow(2, 'Look Sensitivity', 'Radians of yaw per pixel of mouse travel.',
      0.0004, 0.006, 0.0001, () => settings.user.sensitivity,
      (v) => this.patch({ sensitivity: v }), (v) => (v * 1000).toFixed(2));
    this.sliderRow(2, 'ADS Sensitivity', 'Multiplier applied while aiming.', 0.2, 1.5, 0.05,
      () => settings.user.adsSensitivityScale, (v) => this.patch({ adsSensitivityScale: v }), two);
    this.toggleRow(2, 'Invert Look', 'Flip the vertical aim axis.',
      () => settings.user.invertY, (v) => this.patch({ invertY: v }));
    this.sliderRow(2, 'Stick Sensitivity', 'Degrees turned per second at full stick.',
      60, 400, 5, () => settings.user.padSensitivity,
      (v) => this.patch({ padSensitivity: v }), (v) => `${v.toFixed(0)}°/s`);
    this.sliderRow(2, 'Stick Deadzone', 'Stick travel ignored around centre.',
      0.02, 0.35, 0.01, () => settings.user.stickDeadzone,
      (v) => this.patch({ stickDeadzone: v }), pct);
    this.sliderRow(2, 'Aim Assist', 'Controller only. Slows the look near a target and eases the crosshair on.',
      0, 1, 0.05, () => settings.user.aimAssist, (v) => this.patch({ aimAssist: v }), pct);
    this.sliderRow(2, 'Vibration', 'Controller rumble strength.', 0, 1, 0.05,
      () => settings.user.vibration, (v) => this.patch({ vibration: v }), pct);
    this.enumRow(2, 'Crosshair', 'Reticle style.',
      [['dynamic', 'Dynamic'], ['static', 'Static'], ['dot', 'Dot']],
      () => settings.user.crosshairStyle,
      (v) => this.patch({ crosshairStyle: v as UserSettings['crosshairStyle'] }));
    this.toggleRow(2, 'Damage Numbers', 'Floating damage readouts on hit.',
      () => settings.user.damageNumbers, (v) => this.patch({ damageNumbers: v }));
    this.toggleRow(2, 'Reduced Motion', 'Damp screen shake, flashes and UI motion.',
      () => settings.user.reducedMotion, (v) => this.patch({ reducedMotion: v }));

    // -- Audio ---------------------------------------------------------------
    this.sliderRow(3, 'Master Volume', 'Overall output level.', 0, 1, 0.01,
      () => settings.user.masterVolume, (v) => this.patch({ masterVolume: v }), pct);
    this.sliderRow(3, 'Effects Volume', 'Weapons, impacts, world.', 0, 1, 0.01,
      () => settings.user.sfxVolume, (v) => this.patch({ sfxVolume: v }), pct);
    this.sliderRow(3, 'Music Volume', 'The score.', 0, 1, 0.01,
      () => settings.user.musicVolume, (v) => this.patch({ musicVolume: v }), pct);
    this.sliderRow(3, 'Ambience Volume', 'Wind, atmosphere and world beds.', 0, 1, 0.01,
      () => settings.user.ambienceVolume, (v) => this.patch({ ambienceVolume: v }), pct);

    const foot = div('gf-panel-foot is-split', panel);
    this.hint = new TextBind(div('gf-foot-hint', foot));
    this.setDevice(false);
    const reset = interactive(document.createElement('button'));
    reset.className = 'gf-btn is-small';
    reset.type = 'button';
    reset.textContent = 'Reset to Defaults';
    reset.addEventListener('click', () => {
      settings.patch({ ...DEFAULTS });
      this.sync();
    });
    foot.appendChild(reset);

    this.setPage(0);
  }

  // -- row builders ----------------------------------------------------------

  private shell(page: number, label: string, desc: string): { row: HTMLElement; control: HTMLElement; value: TextBind } {
    const row = div('gf-row', this.pages[page]);
    const text = div('gf-row-text', row);
    div('gf-row-label', text).textContent = label;
    div('gf-row-desc', text).textContent = desc;
    const right = div('gf-row-control', row);
    const control = div('gf-row-widget', right);
    const value = new TextBind(div('gf-row-value', right));
    return { row, control, value };
  }

  private patch(p: Partial<UserSettings>): void {
    if (this.syncing) return;
    settings.patch(p);
  }

  private sliderRow(
    page: number,
    label: string,
    desc: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (v: number) => void,
    format: (v: number) => string,
  ): void {
    const { row, control, value } = this.shell(page, label, desc);
    const input = interactive(document.createElement('input'));
    input.type = 'range';
    input.className = 'gf-slider';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    control.appendChild(input);
    const fillVar = new StyleBind(input, '--f');

    const write = (v: number): void => {
      const clamped = Math.min(max, Math.max(min, v));
      set(Math.round(clamped / step) * step);
      apply();
    };
    const apply = (): void => {
      const v = get();
      input.value = String(v);
      fillVar.num(((v - min) / (max - min)) * 100, '%');
      value.set(format(v));
    };
    input.addEventListener('input', () => write(parseFloat(input.value)));
    row.addEventListener('mouseenter', () => this.focusRow(row));

    apply();
    this.rows.push({
      node: row,
      page,
      left: () => write(get() - step),
      right: () => write(get() + step),
      activate: () => write(get() + step),
      sync: apply,
    });
  }

  private toggleRow(
    page: number,
    label: string,
    desc: string,
    get: () => boolean,
    set: (v: boolean) => void,
  ): void {
    const { row, control, value } = this.shell(page, label, desc);
    const btn = interactive(document.createElement('button'));
    btn.type = 'button';
    btn.className = 'gf-switch';
    div('gf-switch-knob', btn);
    control.appendChild(btn);
    const apply = (): void => {
      const v = get();
      toggle(btn, 'is-on', v);
      value.set(v ? 'On' : 'Off');
    };
    const flip = (): void => {
      set(!get());
      apply();
    };
    btn.addEventListener('click', flip);
    row.addEventListener('mouseenter', () => this.focusRow(row));
    apply();
    this.rows.push({ node: row, page, left: flip, right: flip, activate: flip, sync: apply });
  }

  private enumRow(
    page: number,
    label: string,
    desc: string,
    options: [string, string][],
    get: () => string,
    set: (v: string) => void,
  ): void {
    const { row, control, value } = this.shell(page, label, desc);
    const chips: HTMLButtonElement[] = [];
    for (const [id, text] of options) {
      const chip = interactive(document.createElement('button'));
      chip.type = 'button';
      chip.className = 'gf-chip';
      chip.textContent = text;
      chip.addEventListener('click', () => {
        set(id);
        apply();
      });
      control.appendChild(chip);
      chips.push(chip);
    }
    const apply = (): void => {
      const cur = get();
      for (let i = 0; i < options.length; i++) toggle(chips[i], 'is-on', options[i][0] === cur);
      value.set(options.find((o) => o[0] === cur)?.[1] ?? '—');
    };
    const cycle = (d: number): void => {
      const cur = options.findIndex((o) => o[0] === get());
      const next = (cur + d + options.length) % options.length;
      set(options[next][0]);
      apply();
    };
    row.addEventListener('mouseenter', () => this.focusRow(row));
    apply();
    this.rows.push({
      node: row,
      page,
      left: () => cycle(-1),
      right: () => cycle(1),
      activate: () => cycle(1),
      sync: apply,
    });
  }

  // -- navigation ------------------------------------------------------------

  private pageRows(): Row[] {
    return this.rows.filter((r) => r.page === this.page);
  }

  private focusRow(node: HTMLElement): void {
    const rows = this.pageRows();
    const i = rows.findIndex((r) => r.node === node);
    if (i >= 0) {
      this.index = i;
      this.highlight();
    }
  }

  private setPage(p: number): void {
    this.page = p;
    this.index = -1;
    for (let i = 0; i < this.pages.length; i++) {
      toggle(this.pages[i], 'is-on', i === p);
      toggle(this.tabs[i], 'is-on', i === p);
    }
    this.highlight();
  }

  private highlight(): void {
    toggle(this.rail, 'is-active', this.index < 0);
    const rows = this.pageRows();
    for (let i = 0; i < rows.length; i++) toggle(rows[i].node, 'is-active', i === this.index);
  }

  nav(delta: number): void {
    const rows = this.pageRows();
    if (this.index < 0 && delta > 0) this.index = 0;
    else if (this.index === 0 && delta < 0) this.index = -1;
    else if (this.index >= 0) this.index = Math.min(rows.length - 1, Math.max(0, this.index + delta));
    this.highlight();
    if (this.index >= 0) rows[this.index].node.scrollIntoView({ block: 'nearest' });
  }

  navX(delta: number): void {
    if (this.index < 0) {
      this.setPage((this.page + delta + PAGES.length) % PAGES.length);
      return;
    }
    const row = this.pageRows()[this.index];
    if (!row) return;
    if (delta < 0) row.left();
    else row.right();
  }

  activate(): void {
    if (this.index < 0) return;
    this.pageRows()[this.index]?.activate();
  }

  open(): void {
    if (this.visible) return;
    this.visible = true;
    this.index = -1;
    toggle(this.root, 'is-on', true);
    this.sync();
    this.highlight();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    toggle(this.root, 'is-on', false);
  }

  /** Re-read the store into every control. */
  sync(): void {
    this.syncing = true;
    for (const r of this.rows) r.sync();
    this.syncing = false;
  }

  render(_dt: number): void {
    /* CSS handles the transitions */
  }

  dispose(): void {
    this.root.remove();
  }
}

const two = (v: number): string => v.toFixed(2);
const three = (v: number): string => v.toFixed(3);
const pct = (v: number): string => `${Math.round(v * 100)}%`;
