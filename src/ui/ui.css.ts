/**
 * The whole interface stylesheet, injected once as a single <style> tag.
 *
 * Design language — Federation military-scientific:
 *   · 1px cyan hairlines (#5fe4ff) as the primary stroke, gold (#ffc46b) for
 *     legendary and warning states, blood-orange (#ff5a4c) for damage.
 *   · angular cut corners (clip-path) instead of border-radius, everywhere.
 *   · dark translucent panel fills with a faint scanline so the HUD reads over
 *     both a white ice sky and a black cave.
 *   · uppercase, wide-tracked headings; tabular numerals on every readout.
 *
 * Scaling: one root unit `--u` (a clamped vmin) drives every dimension, so the
 * layout is identical in proportion at 1280×720 and at 4K, and `env(safe-area-
 * inset-*)` is folded into the frame padding for notched displays.
 */
import type { DamageElement, FactionId, ItemRarity } from '@/types';

export const ELEMENT_COLOR: Record<DamageElement, string> = {
  kinetic: '#dfeaf6',
  solar: '#ff8f3c',
  arc: '#79e6ff',
  void: '#b98cff',
  stasis: '#6fa6ff',
};

/** 24×24 glyph paths, one per damage element. */
export const ELEMENT_GLYPH: Record<DamageElement, string> = {
  kinetic: 'M12 2.6 21 12l-9 9.4L3 12l9-9.4Zm0 4.1L6.9 12l5.1 5.4L17.1 12 12 6.7Z',
  solar: 'M12 2.4c2.6 4.1 6.6 5.6 6.6 10.2A6.6 6.6 0 0 1 12 21.6 6.6 6.6 0 0 1 5.4 12.6C5.4 8 9.4 6.5 12 2.4Zm0 6.2c-1.4 2-3 2.9-3 5a3 3 0 0 0 6 0c0-2.1-1.6-3-3-5Z',
  arc: 'M13.6 2.2 5.4 13.1h4.6L9 21.8l9-11.4h-4.9l.5-8.2Z',
  void: 'M12 2.6 21.4 12 12 21.4 2.6 12 12 2.6Zm0 5.1a4.3 4.3 0 1 0 0 8.6 4.3 4.3 0 0 0 0-8.6Z',
  stasis: 'M12 2.2 15.4 8l6.4.5-4.6 4.6 1.6 6.4-6.8-3.2-6.8 3.2 1.6-6.4L2.2 8.5 8.6 8 12 2.2Z',
};

export const RARITY_COLOR: Record<ItemRarity, string> = {
  common: '#c3cfda',
  uncommon: '#57d98a',
  rare: '#4f9dff',
  legendary: '#ffc46b',
  exotic: '#ffe98a',
};

export const RARITY_LABEL: Record<ItemRarity, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  legendary: 'Legendary',
  exotic: 'Exotic',
};

export const FACTION_COLOR: Record<FactionId, string> = {
  federation: '#5fe4ff',
  nordic: '#9fd8ff',
  grey: '#b39bff',
  mantis: '#a8e05a',
  insectoid: '#ffb04a',
  reptilian: '#ff6b5a',
};

export const FACTION_NAME: Record<FactionId, string> = {
  federation: 'Federation Vanguard',
  nordic: 'Jötunn Clans',
  grey: 'The Custodians',
  mantis: 'Bladed Broods',
  insectoid: 'The Unnumbered',
  reptilian: 'Drakoni Warhosts',
};

export const FACTION_SPECIES: Record<FactionId, string> = {
  federation: 'Human — Vanguard Division',
  nordic: 'Jötunn — Cold-Forged Raiders',
  grey: 'Custodian — Synthetic Archivists',
  mantis: 'Mantid — Canopy Hunters',
  insectoid: 'Hive Drone — Unnumbered Brood',
  reptilian: 'Drakoni — Volcanic Warhost',
};

export const THREAT_WORDS = ['Moderate', 'Elevated', 'High', 'Severe', 'Cataclysmic'];

export const UI_CSS = `
/* ===================================================================== */
/* Tokens                                                                 */
/* ===================================================================== */
.gf-ui {
  --u: clamp(11px, 1.18vmin, 24px);
  --pad-x: calc(var(--u) * 2.1 + env(safe-area-inset-left, 0px));
  --pad-r: calc(var(--u) * 2.1 + env(safe-area-inset-right, 0px));
  --pad-y: calc(var(--u) * 1.7 + env(safe-area-inset-bottom, 0px));
  --pad-t: calc(var(--u) * 2.2 + env(safe-area-inset-top, 0px));

  --cy: #5fe4ff;
  --cy-dim: rgba(95, 228, 255, 0.34);
  --cy-faint: rgba(95, 228, 255, 0.14);
  --gold: #ffc46b;
  --red: #ff5a4c;
  --ink: #05070d;
  --text: #e6f3ff;
  --text-dim: #93b0c8;
  --text-faint: #66809a;

  --panel: linear-gradient(158deg, rgba(11, 22, 35, 0.9) 0%, rgba(6, 11, 19, 0.95) 100%);
  --panel-line: inset 0 0 0 1px rgba(95, 228, 255, 0.26);
  --cut: 12px;

  position: absolute;
  inset: 0;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
  letter-spacing: 0.02em;
  overflow: hidden;
}
.gf-ui * { box-sizing: border-box; }
:where(.gf-ui) :where(button) {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  margin: 0;
  padding: 0;
  cursor: pointer;
  text-align: left;
  letter-spacing: inherit;
  font-variant-numeric: inherit;
}
:where(.gf-ui) :where(button):focus { outline: none; }
:where(.gf-ui) :where(input) { font: inherit; }

/* shared decorations ---------------------------------------------------- */
.gf-cut, .gf-panel, .gf-toast, .gf-objective, .gf-row, .gf-btn, .gf-chip {
  clip-path: polygon(
    0 var(--cut), var(--cut) 0, 100% 0,
    100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%);
}
.gf-scan::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    to bottom, rgba(120, 200, 255, 0.045) 0 1px, transparent 1px 3px);
  mix-blend-mode: screen;
}

/* ===================================================================== */
/* HUD frame                                                              */
/* ===================================================================== */
.gf-hud {
  position: absolute;
  inset: 0;
  opacity: 0;
  isolation: isolate;
  transition: opacity 260ms ease;
}
.gf-hud.is-on { opacity: 1; }
/* Top and bottom scrims. Shipped HUDs all do this: without a value floor under
   the readouts, thin type dies the moment the player looks at a white sky. */
.gf-hud::before,
.gf-hud::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  z-index: -1;
  pointer-events: none;
}
.gf-hud::before {
  top: 0;
  height: 16%;
  background: linear-gradient(180deg, rgba(3, 6, 11, 0.5), rgba(3, 6, 11, 0));
}
.gf-hud::after {
  bottom: 0;
  height: 24%;
  background: linear-gradient(0deg, rgba(3, 6, 11, 0.52), rgba(3, 6, 11, 0) 88%);
}

.gf-dmg-vignette {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse at 50% 50%, rgba(255, 40, 30, 0) 42%, rgba(190, 24, 18, 0.75) 100%);
  mix-blend-mode: screen;
  transition: opacity 90ms linear;
}

/* --- vitals (bottom-left) --------------------------------------------- */
.gf-vitals {
  position: absolute;
  left: var(--pad-x);
  bottom: var(--pad-y);
  width: calc(var(--u) * 20);
  --flash: 0;
  filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.75));
}

.gf-vitals-svg { display: block; width: 100%; height: auto; overflow: visible; }
.gf-ring-track {
  fill: none;
  stroke: rgba(10, 20, 30, 0.72);
  stroke-linecap: butt;
}
.gf-ring-fill { fill: none; stroke-linecap: butt; transition: none; }
.gf-ring.is-shield .gf-ring-track { stroke-width: 8; }
.gf-ring.is-shield .gf-ring-fill {
  stroke-width: 8;
  stroke: var(--cy);
  filter: drop-shadow(0 0 calc(2px + var(--flash) * 10px) rgba(95, 228, 255, 0.85));
}
.gf-ring.is-health .gf-ring-track { stroke-width: 13; }
.gf-ring.is-health .gf-ring-fill {
  stroke-width: 13;
  stroke: #eaf6ff;
}
.gf-vitals.is-low .gf-ring.is-health .gf-ring-fill { stroke: var(--gold); }
.gf-vitals.is-critical .gf-ring.is-health .gf-ring-fill {
  stroke: var(--red);
  animation: gf-pulse 0.72s ease-in-out infinite;
}
.gf-vitals.is-broken .gf-ring.is-shield .gf-ring-track {
  stroke: rgba(255, 255, 255, calc(0.15 + var(--flash) * 0.75));
}
.gf-vitals-readout {
  position: absolute;
  left: calc(var(--u) * 2.2);
  bottom: calc(var(--u) * 1.4);
}
.gf-vitals-row { display: flex; align-items: baseline; gap: calc(var(--u) * 0.45); }
.gf-vitals-hp {
  font-size: calc(var(--u) * 3.4);
  font-weight: 600;
  line-height: 0.95;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.9);
}
.gf-vitals.is-low .gf-vitals-hp { color: var(--gold); }
.gf-vitals.is-critical .gf-vitals-hp { color: var(--red); }
.gf-vitals-sh {
  font-size: calc(var(--u) * 1.35);
  font-weight: 600;
  color: var(--cy);
  line-height: 1.1;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
}
.gf-vitals.is-noshield .gf-vitals-sh { color: var(--text-faint); }
.gf-vitals-cap {
  font-size: calc(var(--u) * 0.78);
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--text-faint);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
}
.gf-vitals-row.is-shield { margin-top: calc(var(--u) * 0.25); }
.gf-vitals.is-critical { animation: gf-shudder 1.4s ease-in-out infinite; }

/* --- weapon (bottom-right) -------------------------------------------- */
.gf-weapon {
  position: absolute;
  isolation: isolate;
  right: var(--pad-r);
  bottom: var(--pad-y);
  --el: #dfeaf6;
  --fire: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: calc(var(--u) * 0.5);
  min-width: calc(var(--u) * 15);
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.92);
}
.gf-weapon-head { display: flex; align-items: center; gap: calc(var(--u) * 0.7); }
.gf-weapon-names { text-align: right; }
.gf-weapon-name {
  font-size: calc(var(--u) * 1.25);
  font-weight: 600;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--text);
}
.gf-weapon.is-legendary .gf-weapon-name { color: #ffdca6; }
.gf-weapon.is-exotic .gf-weapon-name { color: var(--gold); }
.gf-weapon-family {
  font-size: calc(var(--u) * 0.76);
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-top: calc(var(--u) * 0.12);
}
.gf-weapon-el {
  width: calc(var(--u) * 2.1);
  height: calc(var(--u) * 2.1);
  flex: none;
  fill: var(--el);
  filter: drop-shadow(0 0 calc(var(--u) * 0.4) color-mix(in srgb, var(--el) 60%, transparent));
}
.gf-weapon-ammo {
  display: flex;
  align-items: baseline;
  gap: calc(var(--u) * 0.35);
  line-height: 0.92;
}
.gf-ammo-cur {
  font-size: calc(var(--u) * 3.4);
  font-weight: 600;
  color: #f2f9ff;
  transform: scale(calc(1 + var(--fire) * 0.045));
  transform-origin: 100% 100%;
}
.gf-weapon.is-lowammo .gf-ammo-cur { color: var(--red); animation: gf-pulse 0.6s ease-in-out infinite; }
.gf-ammo-slash { font-size: calc(var(--u) * 1.3); color: var(--text-faint); }
.gf-ammo-res { font-size: calc(var(--u) * 1.5); color: var(--text-dim); font-weight: 600; }

.gf-pips {
  display: none;
  flex-wrap: nowrap;
  justify-content: flex-end;
  gap: calc(var(--u) * 0.3);
  margin: calc(var(--u) * 0.15) 0 calc(var(--u) * 0.1);
}
.gf-pips.is-on { display: flex; }
.gf-pip {
  width: calc(var(--u) * 0.62);
  height: calc(var(--u) * 0.62);
  flex: none;
  border-radius: 50%;
  background: var(--el);
  box-shadow: 0 0 calc(var(--u) * 0.3) color-mix(in srgb, var(--el) 55%, transparent),
    0 1px 2px rgba(0, 0, 0, 0.9);
  transition: background 110ms ease, opacity 110ms ease, transform 110ms ease;
}
.gf-pip.is-spent {
  background: rgba(120, 155, 185, 0.16);
  box-shadow: inset 0 0 0 1px rgba(160, 200, 230, 0.55), 0 1px 2px rgba(0, 0, 0, 0.8);
  transform: scale(0.72);
}
.gf-pip.is-hidden { display: none; }
.gf-weapon.is-lowammo .gf-pip:not(.is-spent) {
  background: var(--red);
  animation: gf-pulse 0.6s ease-in-out infinite;
}
.gf-magbar {
  display: none;
  width: calc(var(--u) * 13);
  height: calc(var(--u) * 0.42);
  background: rgba(10, 20, 30, 0.7);
  box-shadow: inset 0 0 0 1px rgba(120, 180, 220, 0.3);
}
.gf-magbar.is-on { display: block; }
.gf-magbar-fill {
  height: 100%;
  background: var(--el);
  box-shadow: 0 0 calc(var(--u) * 0.4) color-mix(in srgb, var(--el) 60%, transparent);
}
.gf-weapon.is-lowammo .gf-magbar-fill { background: var(--red); }

.gf-reload {
  position: absolute;
  right: 0;
  bottom: calc(100% + var(--u) * 0.5);
  width: calc(var(--u) * 13);
  height: calc(var(--u) * 1.15);
  opacity: 0;
  transform: translateY(calc(var(--u) * -0.3));
  transition: opacity 140ms ease, transform 140ms ease;
  background: rgba(6, 12, 20, 0.72);
  box-shadow: inset 0 0 0 1px rgba(95, 228, 255, 0.32);
  overflow: hidden;
}
.gf-reload.is-on { opacity: 1; transform: none; }
.gf-reload-label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: calc(var(--u) * 0.72);
  letter-spacing: 0.34em;
  text-transform: uppercase;
  color: #dff3ff;
  z-index: 2;
}
.gf-reload-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0;
  background: linear-gradient(90deg, rgba(95, 228, 255, 0.35), rgba(95, 228, 255, 0.72));
  border-right: 2px solid #cdf3ff;
  box-shadow: 0 0 calc(var(--u) * 0.7) rgba(95, 228, 255, 0.8);
}
.gf-weapon.is-reloadpop .gf-reload { box-shadow: inset 0 0 0 1px #cdf3ff; }

/* --- abilities + super (bottom-centre) --------------------------------- */
.gf-abilities {
  position: absolute;
  left: 50%;
  bottom: calc(var(--pad-y) + var(--u) * 1.1);
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: calc(var(--u) * 0.6);
}
.gf-super {
  position: relative;
  width: calc(var(--u) * 26);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: calc(var(--u) * 0.28);
}
.gf-super-track {
  position: relative;
  width: 100%;
  height: calc(var(--u) * 0.72);
  background: rgba(8, 16, 26, 0.78);
  box-shadow: inset 0 0 0 1px rgba(95, 228, 255, 0.3), 0 2px 6px rgba(0, 0, 0, 0.6);
  clip-path: polygon(
    calc(var(--u) * 0.6) 0, 100% 0, calc(100% - var(--u) * 0.6) 100%, 0 100%);
  overflow: hidden;
}
.gf-super-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0;
  background: linear-gradient(90deg, #2b6fa8, #7fdcff 70%, #d8f6ff);
  box-shadow: 0 0 calc(var(--u) * 0.6) rgba(95, 228, 255, 0.6);
}
.gf-super-notches {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    90deg, transparent 0 calc(10% - 1px), rgba(5, 10, 18, 0.85) calc(10% - 1px) 10%);
}
.gf-super-label {
  font-size: calc(var(--u) * 0.72);
  letter-spacing: 0.34em;
  text-transform: uppercase;
  color: var(--text-dim);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
}
.gf-super.is-ready .gf-super-fill {
  background: linear-gradient(90deg, #ffc46b, #fff3d0 45%, #ffc46b 60%, #fff3d0);
  background-size: 220% 100%;
  animation: gf-crawl 1.5s linear infinite;
  box-shadow: 0 0 calc(var(--u) * 1.2) rgba(255, 196, 107, 0.85);
}
.gf-super.is-ready .gf-super-track { box-shadow: inset 0 0 0 1px rgba(255, 196, 107, 0.85); }
.gf-super.is-ready .gf-super-label { color: var(--gold); animation: gf-pulse 1.1s ease-in-out infinite; }
.gf-super.is-active .gf-super-fill { background: linear-gradient(90deg, #ffffff, #b6ecff); }

.gf-ability-row { display: flex; gap: calc(var(--u) * 1.1); }
.gf-ability {
  --pop: 0;
  position: relative;
  width: calc(var(--u) * 3.1);
  height: calc(var(--u) * 3.1);
  transform: scale(calc(1 + var(--pop) * 0.16));
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.7));
}
.gf-ability-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.gf-ability-track { fill: rgba(8, 16, 26, 0.76); stroke: rgba(120, 180, 220, 0.26); stroke-width: 3; }
.gf-ability-fill {
  fill: none;
  stroke: var(--cy);
  stroke-width: 3;
  opacity: 0.85;
}
.gf-ability.is-ready .gf-ability-fill {
  stroke: #dff6ff;
  opacity: 1;
  filter: drop-shadow(0 0 calc(var(--u) * 0.4) rgba(95, 228, 255, 0.9));
}
.gf-ability-glyph {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 52%;
  height: 52%;
  transform: translate(-50%, -50%);
  fill: rgba(180, 210, 235, 0.55);
  transition: fill 160ms ease;
}
.gf-ability.is-ready .gf-ability-glyph { fill: #eaf9ff; }
.gf-ability-key {
  position: absolute;
  left: 50%;
  top: calc(100% + var(--u) * 0.2);
  transform: translateX(-50%);
  font-size: calc(var(--u) * 0.68);
  letter-spacing: 0.16em;
  color: var(--text-faint);
}
.gf-ability.is-melee .gf-ability-fill { stroke: #9fe8ff; }
.gf-ability.is-class .gf-ability-fill { stroke: #b8a6ff; }
.gf-ability.is-class.is-ready .gf-ability-fill { stroke: #ded5ff; }

/* --- top centre column ------------------------------------------------- */
.gf-top {
  position: absolute;
  left: 50%;
  top: var(--pad-t);
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: calc(var(--u) * 0.55);
  width: calc(var(--u) * 42);
  max-width: 68vw;
}
.gf-compass {
  position: relative;
  width: 100%;
  height: calc(var(--u) * 3);
}
.gf-compass::before {
  content: '';
  position: absolute;
  inset: auto 0 0 0;
  height: calc(var(--u) * 2.1);
  background: linear-gradient(180deg, rgba(5, 10, 17, 0) 0%, rgba(5, 10, 17, 0.55) 70%);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent);
}
.gf-compass-strip {
  position: absolute;
  inset: 0;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
}
.gf-compass-strip::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(var(--u) * 0.12);
  height: 1px;
  background: rgba(95, 228, 255, 0.28);
}
.gf-compass-tick {
  --x: 0%;
  position: absolute;
  /* The offset must be applied through left, not translateX: a percentage
     inside translateX() resolves against the tick's own 1px box. */
  left: calc(50% + var(--x));
  bottom: calc(var(--u) * 0.12);
  width: 1px;
  height: calc(var(--u) * 0.34);
  background: rgba(200, 228, 248, 0.75);
  transform: translateX(-50%);
}
.gf-compass-tick.is-major { height: calc(var(--u) * 0.72); width: 2px; background: #eaf7ff; }
.gf-compass-label {
  position: absolute;
  left: 50%;
  bottom: calc(var(--u) * 1.0);
  transform: translateX(-50%);
  font-size: calc(var(--u) * 0.82);
  font-style: normal;
  letter-spacing: 0.14em;
  color: #d7ecff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95);
}
.gf-compass-mark {
  --x: 0%;
  position: absolute;
  left: calc(50% + var(--x));
  bottom: calc(var(--u) * 2.25);
  width: calc(var(--u) * 0.44);
  height: calc(var(--u) * 0.44);
  background: var(--gold);
  transform: translateX(-50%) rotate(45deg);
  box-shadow: 0 0 calc(var(--u) * 0.35) rgba(255, 196, 107, 0.8);
}
.gf-compass-mark.is-kill { background: var(--red); }
.gf-compass-mark.is-edge { transform: translateX(-50%) rotate(45deg) scale(0.62); }
.gf-compass-caret {
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 0;
  height: 0;
  transform: translateX(-50%);
  border-left: calc(var(--u) * 0.34) solid transparent;
  border-right: calc(var(--u) * 0.34) solid transparent;
  border-bottom: calc(var(--u) * 0.42) solid var(--cy);
  filter: drop-shadow(0 0 calc(var(--u) * 0.3) rgba(95, 228, 255, 0.9));
}

/* target + boss bars ---------------------------------------------------- */
.gf-target, .gf-boss {
  --el: #8fb6d6;
  --pop: 0;
  width: 100%;
  opacity: 0;
  transform: translateY(calc(var(--u) * -0.4));
  transition: opacity 180ms ease, transform 180ms ease;
  pointer-events: none;
}
.gf-target.is-on, .gf-boss.is-on { opacity: 1; transform: none; }
.gf-target-name, .gf-boss-name {
  text-align: center;
  font-size: calc(var(--u) * 0.86);
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: #e2f1ff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.95);
  margin-bottom: calc(var(--u) * 0.22);
}
.gf-target-track, .gf-boss-track {
  position: relative;
  width: 100%;
  background: rgba(8, 16, 26, 0.74);
  box-shadow: inset 0 0 0 1px rgba(140, 190, 225, 0.32), 0 2px 5px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.gf-target-track { height: calc(var(--u) * 0.52); }
.gf-boss-track { height: calc(var(--u) * 0.95); }
.gf-target-health, .gf-boss-health {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0;
  background: linear-gradient(180deg, #ff8f7c, #e5402f);
  box-shadow: 0 0 calc(var(--u) * 0.4) rgba(229, 64, 47, calc(0.3 + var(--pop) * 0.7));
}
.gf-target-shield, .gf-boss-shield {
  position: absolute;
  inset: 0 auto 44% 0;
  width: 0;
  opacity: 0;
  border-bottom: 1px solid rgba(4, 8, 14, 0.85);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--el) 85%, white),
    color-mix(in srgb, var(--el) 70%, black));
  box-shadow: 0 0 calc(var(--u) * 0.5) color-mix(in srgb, var(--el) 70%, transparent);
}
.gf-target-shield.is-on, .gf-boss-shield.is-on { opacity: 1; }
.gf-boss-name { font-size: calc(var(--u) * 1.15); letter-spacing: 0.3em; color: #fff0e2; }
.gf-boss { margin-top: calc(var(--u) * 0.2); }
.gf-boss-notches {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: calc(var(--u) * 0.95);
  display: none;
  background: repeating-linear-gradient(
    90deg, transparent 0 calc(12.5% - 1px), rgba(5, 10, 18, 0.9) calc(12.5% - 1px) 12.5%);
  pointer-events: none;
}
.gf-boss-notches.is-on { display: block; }
.gf-boss { position: relative; }

/* --- objective (top-left) --------------------------------------------- */
.gf-objective {
  position: absolute;
  left: var(--pad-x);
  top: var(--pad-t);
  width: calc(var(--u) * 17);
  padding: calc(var(--u) * 0.65) calc(var(--u) * 0.85);
  background: var(--panel);
  box-shadow: var(--panel-line), 0 4px 14px rgba(0, 0, 0, 0.45);
  --cut: calc(var(--u) * 0.7);
  opacity: 0;
  transform: translateX(calc(var(--u) * -1));
  transition: opacity 240ms ease, transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
}
.gf-objective.is-on { opacity: 1; transform: none; }
.gf-objective.is-in { animation: gf-objin 460ms cubic-bezier(0.16, 1, 0.3, 1); }
.gf-objective-cap {
  font-size: calc(var(--u) * 0.68);
  letter-spacing: 0.34em;
  text-transform: uppercase;
  color: var(--cy);
}
.gf-objective-text {
  font-size: calc(var(--u) * 1.02);
  margin-top: calc(var(--u) * 0.2);
  color: var(--text);
  line-height: 1.25;
}
.gf-objective.is-done .gf-objective-text { text-decoration: line-through; color: var(--text-dim); }
.gf-objective-bar {
  position: relative;
  margin-top: calc(var(--u) * 0.45);
  height: calc(var(--u) * 0.24);
  background: rgba(120, 170, 205, 0.18);
}
.gf-objective-fill {
  height: 100%;
  width: 0;
  background: var(--cy);
  box-shadow: 0 0 calc(var(--u) * 0.5) rgba(95, 228, 255, 0.7);
  transition: width 300ms cubic-bezier(0.16, 1, 0.3, 1);
}
.gf-objective.is-done .gf-objective-fill { background: var(--gold); }
.gf-objective-count {
  margin-top: calc(var(--u) * 0.25);
  font-size: calc(var(--u) * 0.74);
  letter-spacing: 0.2em;
  color: var(--text-faint);
}

/* --- directional damage arcs ------------------------------------------ */
.gf-hits { position: absolute; inset: 0; pointer-events: none; }
.gf-hit {
  --rot: 0deg;
  position: absolute;
  left: 50%;
  top: 50%;
  width: min(104vmin, 104vw);
  height: min(104vmin, 104vw);
  transform: translate(-50%, -50%) rotate(var(--rot));
  opacity: 0;
}
.gf-hit svg { width: 100%; height: 100%; }
.gf-hit-halo {
  fill: none;
  stroke: rgba(255, 70, 52, 0.13);
  stroke-width: 4.6;
  stroke-linecap: round;
}
.gf-hit-outer { fill: none; stroke: rgba(0, 0, 0, 0.42); stroke-width: 2.4; stroke-linecap: round; }
.gf-hit-inner {
  fill: none;
  stroke: #ff6a58;
  stroke-width: 1.1;
  stroke-linecap: round;
  filter: drop-shadow(0 0 3px rgba(255, 60, 40, 0.95));
}

/* --- subtitle + streak ------------------------------------------------- */
.gf-subtitle {
  position: absolute;
  left: 50%;
  bottom: calc(var(--pad-y) + var(--u) * 9.2);
  transform: translate(-50%, calc(var(--u) * 0.4));
  width: min(calc(var(--u) * 40), 64vw);
  text-align: center;
  opacity: 0;
  transition: opacity 200ms ease, transform 200ms ease;
}
.gf-subtitle.is-on { opacity: 1; transform: translate(-50%, 0); }
.gf-subtitle-speaker {
  font-size: calc(var(--u) * 0.72);
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--cy);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.95);
}
.gf-subtitle-text {
  font-size: calc(var(--u) * 1.02);
  color: #eef7ff;
  line-height: 1.35;
  margin-top: calc(var(--u) * 0.12);
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.95);
}
.gf-streak {
  position: absolute;
  left: 50%;
  top: calc(50% + var(--u) * 3.6);
  transform: translate(-50%, calc(var(--u) * 0.4));
  text-align: center;
  opacity: 0;
  transition: opacity 160ms ease, transform 160ms ease;
}
.gf-streak.is-on { opacity: 1; transform: translate(-50%, 0); }
.gf-streak-num {
  font-size: calc(var(--u) * 1.7);
  font-weight: 600;
  color: var(--gold);
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.95);
}
.gf-streak-cap {
  font-size: calc(var(--u) * 0.64);
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--text-faint);
}

/* ===================================================================== */
/* Crosshair                                                              */
/* ===================================================================== */
.gf-cross {
  --gap: 4;
  --spread: 0;
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  opacity: 0;
  transition: opacity 140ms ease;
}
.gf-cross.is-on { opacity: 1; }
.gf-cross-dot,
.gf-cross-tick,
.gf-cross-corner {
  position: absolute;
  background: #f2fbff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.9), 0 0 5px rgba(0, 0, 0, 0.75);
}
.gf-cross-dot {
  left: -1px;
  top: -1px;
  width: 2px;
  height: 2px;
  border-radius: 50%;
}
.gf-cross-tick { width: 2px; height: calc(var(--u) * 0.8); left: -1px; top: 0; }
.gf-cross-tick.is-t { transform: translateY(calc(-1px * var(--gap) - 100%)); }
.gf-cross-tick.is-b { transform: translateY(calc(1px * var(--gap))); }
.gf-cross-tick.is-l {
  width: calc(var(--u) * 0.8);
  height: 2px;
  left: 0;
  top: -1px;
  transform: translateX(calc(-1px * var(--gap) - 100%));
}
.gf-cross-tick.is-r {
  width: calc(var(--u) * 0.8);
  height: 2px;
  left: 0;
  top: -1px;
  transform: translateX(calc(1px * var(--gap)));
}
.gf-cross-corner {
  width: calc(var(--u) * 0.34);
  height: 2px;
  opacity: calc(0.15 + var(--spread) * 0.6);
}
.gf-cross-corner.is-tl { transform: translate(calc(-1px * var(--gap) * 1.9 - 100%), calc(-1px * var(--gap) * 1.9)); }
.gf-cross-corner.is-tr { transform: translate(calc(1px * var(--gap) * 1.9), calc(-1px * var(--gap) * 1.9)); }
.gf-cross-corner.is-bl { transform: translate(calc(-1px * var(--gap) * 1.9 - 100%), calc(1px * var(--gap) * 1.9)); }
.gf-cross-corner.is-br { transform: translate(calc(1px * var(--gap) * 1.9), calc(1px * var(--gap) * 1.9)); }
.gf-cross.is-dot .gf-cross-tick,
.gf-cross.is-dot .gf-cross-corner { display: none; }
.gf-cross.is-dot .gf-cross-dot { width: 3px; height: 3px; left: -1.5px; top: -1.5px; }
.gf-cross.is-static .gf-cross-corner { display: none; }
.gf-cross.is-static .gf-cross-tick.is-t { transform: translateY(calc(-1px * 7 - 100%)); }
.gf-cross.is-static .gf-cross-tick.is-b { transform: translateY(7px); }
.gf-cross.is-static .gf-cross-tick.is-l { transform: translateX(calc(-1px * 7 - 100%)); }
.gf-cross.is-static .gf-cross-tick.is-r { transform: translateX(7px); }
.gf-cross.is-ads .gf-cross-dot { background: var(--cy); }

.gf-hitmark, .gf-killmark {
  --s: 1;
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}
.gf-hitmark-line, .gf-killmark-line {
  position: absolute;
  left: 0;
  top: 0;
  width: calc(var(--u) * 0.62);
  height: 2px;
  background: #ffffff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.85);
  transform-origin: 0 50%;
}
.gf-hitmark-line.is-a { transform: rotate(45deg) translateX(calc(var(--u) * 0.34 * var(--s))) scaleX(var(--s)); }
.gf-hitmark-line.is-b { transform: rotate(135deg) translateX(calc(var(--u) * 0.34 * var(--s))) scaleX(var(--s)); }
.gf-hitmark-line.is-c { transform: rotate(225deg) translateX(calc(var(--u) * 0.34 * var(--s))) scaleX(var(--s)); }
.gf-hitmark-line.is-d { transform: rotate(315deg) translateX(calc(var(--u) * 0.34 * var(--s))) scaleX(var(--s)); }
.gf-hitmark.is-precision .gf-hitmark-line {
  background: var(--gold);
  height: 3px;
  width: calc(var(--u) * 0.82);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.9), 0 0 6px rgba(255, 196, 107, 0.9);
}
.gf-killmark-line {
  background: #ff5a4c;
  height: 3px;
  width: calc(var(--u) * 1.05);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.9), 0 0 8px rgba(255, 70, 50, 0.9);
}
.gf-killmark-line.is-a { transform: rotate(45deg) translateX(calc(var(--u) * 0.5 * var(--s))) scaleX(var(--s)); }
.gf-killmark-line.is-b { transform: rotate(135deg) translateX(calc(var(--u) * 0.5 * var(--s))) scaleX(var(--s)); }
.gf-killmark-line.is-c { transform: rotate(225deg) translateX(calc(var(--u) * 0.5 * var(--s))) scaleX(var(--s)); }
.gf-killmark-line.is-d { transform: rotate(315deg) translateX(calc(var(--u) * 0.5 * var(--s))) scaleX(var(--s)); }
.gf-killmark-ring {
  position: absolute;
  left: 50%;
  top: 50%;
  width: calc(var(--u) * 3.2 * var(--s));
  height: calc(var(--u) * 3.2 * var(--s));
  transform: translate(-50%, -50%);
  border: 1px solid rgba(255, 90, 76, 0.65);
  border-radius: 50%;
}

/* ===================================================================== */
/* Damage numbers                                                         */
/* ===================================================================== */
.gf-dmgnums { position: absolute; inset: 0; pointer-events: none; opacity: 0; }
.gf-dmgnums.is-on { opacity: 1; }
.gf-dmg {
  --c: #dfeaf6;
  position: absolute;
  left: 0;
  top: 0;
  opacity: 0;
  white-space: nowrap;
  font-weight: 600;
  color: var(--c);
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.95), 0 0 8px rgba(0, 0, 0, 0.7);
  will-change: transform, opacity;
}
.gf-dmg.is-s { font-size: calc(var(--u) * 0.95); }
.gf-dmg.is-m { font-size: calc(var(--u) * 1.2); }
.gf-dmg.is-l { font-size: calc(var(--u) * 1.55); }
.gf-dmg.is-crit {
  font-size: calc(var(--u) * 1.85);
  letter-spacing: 0.02em;
  text-shadow: 0 2px 5px rgba(0, 0, 0, 0.95), 0 0 12px rgba(255, 210, 120, 0.75);
}
.gf-dmg.is-precision::after {
  content: '';
  position: absolute;
  left: 50%;
  top: -0.5em;
  width: 0.42em;
  height: 0.42em;
  transform: translateX(-50%) rotate(45deg);
  background: var(--c);
  box-shadow: 0 0 6px rgba(255, 210, 120, 0.8);
}

/* ===================================================================== */
/* Toasts                                                                 */
/* ===================================================================== */
.gf-toasts { position: absolute; inset: 0; pointer-events: none; }
.gf-banner {
  position: absolute;
  left: 50%;
  top: 26%;
  transform: translate(-50%, calc(var(--u) * 0.8));
  width: min(calc(var(--u) * 46), 78vw);
  text-align: center;
  opacity: 0;
  transition: opacity 320ms ease, transform 480ms cubic-bezier(0.16, 1, 0.3, 1);
}
.gf-banner.is-on { opacity: 1; transform: translate(-50%, 0); }
.gf-banner.is-out { opacity: 0; transform: translate(-50%, calc(var(--u) * -0.6)); }
.gf-banner-rule {
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--cy), transparent);
  transform: scaleX(0.2);
  transition: transform 620ms cubic-bezier(0.16, 1, 0.3, 1);
}
.gf-banner.is-on .gf-banner-rule { transform: scaleX(1); }
.gf-banner-title {
  font-size: calc(var(--u) * 2.6);
  font-weight: 600;
  letter-spacing: 0.38em;
  text-transform: uppercase;
  padding: calc(var(--u) * 0.5) 0 calc(var(--u) * 0.2);
  text-indent: 0.38em;
  color: #f0faff;
  text-shadow: 0 3px 12px rgba(0, 0, 0, 0.9), 0 0 30px rgba(95, 228, 255, 0.35);
}
.gf-banner-sub {
  font-size: calc(var(--u) * 0.92);
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--text-dim);
  padding-bottom: calc(var(--u) * 0.55);
  text-indent: 0.3em;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.9);
}
.gf-banner.is-nosub .gf-banner-sub { display: none; }

.gf-toast-stack {
  position: absolute;
  left: var(--pad-x);
  bottom: calc(var(--pad-y) + var(--u) * 16);
  display: flex;
  flex-direction: column;
  gap: calc(var(--u) * 0.4);
  width: calc(var(--u) * 19);
}
.gf-toast {
  --r: #c3cfda;
  --cut: calc(var(--u) * 0.6);
  position: relative;
  display: none;
  align-items: center;
  gap: calc(var(--u) * 0.6);
  padding: calc(var(--u) * 0.5) calc(var(--u) * 0.7) calc(var(--u) * 0.5) calc(var(--u) * 0.9);
  background: var(--panel);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--r) 40%, transparent),
    0 4px 14px rgba(0, 0, 0, 0.5);
  opacity: 0;
  transform: translateX(calc(var(--u) * -1.4));
  transition: opacity 280ms ease, transform 320ms cubic-bezier(0.16, 1, 0.3, 1);
}
.gf-toast.is-live { display: flex; }
.gf-toast.is-in { opacity: 1; transform: none; }
.gf-toast.is-out { opacity: 0; transform: translateX(calc(var(--u) * -1.4)); }
.gf-toast-edge {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: calc(var(--u) * 0.22);
  background: var(--r);
  box-shadow: 0 0 calc(var(--u) * 0.6) color-mix(in srgb, var(--r) 70%, transparent);
}
.gf-toast-body { flex: 1; min-width: 0; }
.gf-toast-title {
  font-size: calc(var(--u) * 0.98);
  font-weight: 600;
  letter-spacing: 0.13em;
  color: var(--r);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gf-toast-sub {
  font-size: calc(var(--u) * 0.7);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-top: calc(var(--u) * 0.1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gf-toast.is-nosub .gf-toast-sub { display: none; }
.gf-toast-tag {
  font-size: calc(var(--u) * 0.62);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--r) 75%, black);
  writing-mode: vertical-rl;
  opacity: 0.85;
}
.gf-toast.is-exotic { box-shadow: inset 0 0 0 1px rgba(255, 233, 138, 0.8), 0 0 22px rgba(255, 210, 110, 0.22); }
.gf-toast.is-legendary { box-shadow: inset 0 0 0 1px rgba(255, 196, 107, 0.6), 0 4px 16px rgba(0, 0, 0, 0.55); }

/* ===================================================================== */
/* Loading screen                                                         */
/* ===================================================================== */
.gf-loading {
  --accent: #5fe4ff;
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: radial-gradient(ellipse at 50% 42%, #0c1626 0%, #05070d 68%);
  opacity: 0;
  visibility: hidden;
  transition: opacity 420ms ease, visibility 0s linear 420ms;
  z-index: 40;
}
.gf-loading.is-on { opacity: 1; visibility: visible; transition-delay: 0s; }
.gf-loading-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(95, 228, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(95, 228, 255, 0.05) 1px, transparent 1px);
  background-size: calc(var(--u) * 4) calc(var(--u) * 4);
  -webkit-mask-image: radial-gradient(ellipse at 50% 45%, #000 10%, transparent 72%);
  mask-image: radial-gradient(ellipse at 50% 45%, #000 10%, transparent 72%);
}
.gf-loading-scan {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    to bottom, rgba(140, 210, 255, 0.05) 0 1px, transparent 1px 3px);
  opacity: 0.7;
}
.gf-loading-inner {
  position: relative;
  width: min(calc(var(--u) * 66), 86vw);
  text-align: center;
}
.gf-sigil {
  width: calc(var(--u) * 12);
  height: calc(var(--u) * 12);
  margin: 0 auto calc(var(--u) * 1.3);
  --accent: #5fe4ff;
}
.gf-sigil.is-small { width: calc(var(--u) * 4.6); height: calc(var(--u) * 4.6); margin: 0; }
.gf-sigil-svg { width: 100%; height: 100%; overflow: visible; }
.gf-sigil-ring { animation: gf-spin 44s linear infinite; transform-origin: 60px 60px; }
.gf-sigil-thin { fill: none; stroke: color-mix(in srgb, var(--accent) 45%, transparent); stroke-width: 1; }
.gf-sigil-tick { stroke: var(--accent); stroke-width: 2; }
.gf-sigil-line { fill: none; stroke: var(--accent); stroke-width: 2.4; stroke-linejoin: miter; }
.gf-sigil-stave { fill: none; stroke: var(--accent); stroke-width: 3.2; stroke-linecap: square; }
.gf-sigil-blade { fill: none; stroke: color-mix(in srgb, var(--accent) 70%, transparent); stroke-width: 2.6; }
.gf-sigil-fang { fill: none; stroke: var(--accent); stroke-width: 3; stroke-linejoin: miter; }
.gf-sigil-fill { fill: var(--accent); stroke: none; }
.gf-sigil-fill.is-dim { opacity: 0.4; }
.gf-sigil-hole { fill: #05070d; }
.gf-sigil-mark { filter: drop-shadow(0 0 calc(var(--u) * 0.5) color-mix(in srgb, var(--accent) 55%, transparent)); }

.gf-loading-kicker {
  font-size: calc(var(--u) * 0.74);
  letter-spacing: 0.42em;
  text-transform: uppercase;
  color: var(--accent);
  text-indent: 0.42em;
}
.gf-loading-title {
  font-size: calc(var(--u) * 4.4);
  font-weight: 600;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  text-indent: 0.26em;
  margin: calc(var(--u) * 0.4) 0 calc(var(--u) * 0.2);
  color: #f2faff;
  text-shadow: 0 0 calc(var(--u) * 2) color-mix(in srgb, var(--accent) 35%, transparent);
}
.gf-loading-sub {
  font-size: calc(var(--u) * 0.92);
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--text-dim);
  text-indent: 0.3em;
}
.gf-loading-flavour {
  font-size: calc(var(--u) * 1.08);
  color: var(--text-dim);
  line-height: 1.6;
  max-width: calc(var(--u) * 44);
  margin: calc(var(--u) * 1.4) auto calc(var(--u) * 1.8);
  opacity: 0.85;
}
.gf-loading-barrow { display: flex; align-items: center; gap: calc(var(--u) * 0.9); }
.gf-loading-bar {
  position: relative;
  flex: 1;
  height: calc(var(--u) * 0.36);
  background: rgba(120, 170, 210, 0.16);
  overflow: hidden;
}
.gf-loading-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0;
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 40%, #0a1a28), var(--accent));
  box-shadow: 0 0 calc(var(--u) * 1) color-mix(in srgb, var(--accent) 70%, transparent);
}
.gf-loading-sheen {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5), transparent);
  width: 30%;
  animation: gf-sheen 1.7s ease-in-out infinite;
}
.gf-loading-pct {
  font-size: calc(var(--u) * 0.88);
  letter-spacing: 0.16em;
  color: var(--accent);
  min-width: calc(var(--u) * 3);
  text-align: right;
}
.gf-loading-status {
  margin-top: calc(var(--u) * 0.7);
  font-size: calc(var(--u) * 0.7);
  letter-spacing: 0.34em;
  text-transform: uppercase;
  color: var(--text-faint);
  min-height: calc(var(--u) * 1);
}

/* ===================================================================== */
/* Modals (pause / settings / death)                                      */
/* ===================================================================== */
.gf-modal {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 0;
  visibility: hidden;
  transition: opacity 200ms ease, visibility 0s linear 200ms;
  z-index: 30;
}
.gf-modal.is-on { opacity: 1; visibility: visible; transition-delay: 0s; }
.gf-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(4, 7, 13, 0.62);
  backdrop-filter: blur(14px) saturate(0.7);
  -webkit-backdrop-filter: blur(14px) saturate(0.7);
}
.gf-panel {
  position: relative;
  --cut: calc(var(--u) * 1.1);
  background: var(--panel);
  box-shadow: var(--panel-line), 0 24px 70px rgba(0, 0, 0, 0.7);
  padding: calc(var(--u) * 1.8) calc(var(--u) * 2);
  transform: translateY(calc(var(--u) * 1.2)) scale(0.985);
  transition: transform 280ms cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
}
.gf-modal.is-on .gf-panel { transform: none; }
.gf-panel::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    to bottom, rgba(120, 200, 255, 0.035) 0 1px, transparent 1px 3px);
}
.gf-panel.is-pause { width: min(calc(var(--u) * 58), 90vw); }
.gf-panel.is-settings { width: min(calc(var(--u) * 62), 92vw); max-height: 88vh; display: flex; flex-direction: column; }
.gf-panel-kicker {
  font-size: calc(var(--u) * 0.7);
  letter-spacing: 0.4em;
  text-transform: uppercase;
  color: var(--cy);
  text-indent: 0.4em;
}
.gf-panel-title {
  font-size: calc(var(--u) * 2.3);
  font-weight: 600;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  text-indent: 0.3em;
  margin-top: calc(var(--u) * 0.15);
}
.gf-panel-rule {
  height: 1px;
  margin: calc(var(--u) * 1) 0 calc(var(--u) * 1.3);
  background: linear-gradient(90deg, var(--cy-dim), transparent 70%);
}
.gf-panel-foot {
  margin-top: calc(var(--u) * 1.4);
  padding-top: calc(var(--u) * 0.8);
  border-top: 1px solid rgba(95, 228, 255, 0.16);
  font-size: calc(var(--u) * 0.68);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--text-faint);
  white-space: pre;
}
.gf-panel-foot.is-split {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--u) * 1);
}
.gf-foot-hint { white-space: pre; }

/* pause layout ---------------------------------------------------------- */
.gf-pause-body { display: grid; grid-template-columns: 1fr 1.1fr; gap: calc(var(--u) * 2); }
.gf-pause-side { border-left: 1px solid rgba(95, 228, 255, 0.18); padding-left: calc(var(--u) * 1); order: 2; }
.gf-pause-side-cap {
  font-size: calc(var(--u) * 0.66);
  letter-spacing: 0.34em;
  text-transform: uppercase;
  color: var(--cy);
  margin-bottom: calc(var(--u) * 0.7);
}
.gf-kv {
  display: flex;
  justify-content: space-between;
  gap: calc(var(--u) * 1);
  padding: calc(var(--u) * 0.22) 0;
  font-size: calc(var(--u) * 0.82);
}
.gf-kv-k { color: var(--text-dim); }
.gf-kv-v { color: var(--text); letter-spacing: 0.12em; }

.gf-menu { display: flex; flex-direction: column; gap: calc(var(--u) * 0.4); order: 1; }
.gf-menu-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: calc(var(--u) * 0.7);
  padding: calc(var(--u) * 0.85) calc(var(--u) * 1);
  --cut: calc(var(--u) * 0.55);
  background: rgba(120, 180, 220, 0.05);
  box-shadow: inset 0 0 0 1px rgba(120, 180, 220, 0.16);
  transition: background 140ms ease, box-shadow 140ms ease, transform 140ms ease;
}
.gf-menu-item:hover { background: rgba(120, 190, 230, 0.1); }
.gf-menu-item.is-active {
  background: rgba(95, 228, 255, 0.14);
  box-shadow: inset 0 0 0 1px rgba(95, 228, 255, 0.7);
  transform: translateX(calc(var(--u) * 0.25));
}
.gf-menu-caret {
  width: 0;
  height: 0;
  border-left: calc(var(--u) * 0.42) solid var(--cy);
  border-top: calc(var(--u) * 0.3) solid transparent;
  border-bottom: calc(var(--u) * 0.3) solid transparent;
  opacity: 0;
  transition: opacity 140ms ease;
}
.gf-menu-item.is-active .gf-menu-caret { opacity: 1; }
.gf-menu-label {
  font-size: calc(var(--u) * 1.06);
  letter-spacing: 0.22em;
  text-transform: uppercase;
}
.gf-menu-item.is-danger .gf-menu-label { color: #ffb0a4; }
.gf-menu-item.is-danger.is-active { box-shadow: inset 0 0 0 1px rgba(255, 90, 76, 0.75); background: rgba(255, 90, 76, 0.14); }
.gf-menu-item.is-danger.is-active .gf-menu-caret { border-left-color: var(--red); }
.gf-menu-edge {
  position: absolute;
  right: calc(var(--u) * 0.7);
  width: calc(var(--u) * 1.6);
  height: 1px;
  background: rgba(95, 228, 255, 0.4);
}
.gf-menu-confirm {
  display: none;
  align-items: center;
  gap: calc(var(--u) * 0.6);
  padding: calc(var(--u) * 0.7);
  background: rgba(255, 90, 76, 0.1);
  box-shadow: inset 0 0 0 1px rgba(255, 90, 76, 0.4);
}
.gf-menu-confirm.is-on { display: flex; }
.gf-menu-confirm-text { flex: 1; font-size: calc(var(--u) * 0.78); color: #ffd0c8; line-height: 1.35; }

/* buttons --------------------------------------------------------------- */
.gf-btn {
  --cut: calc(var(--u) * 0.5);
  padding: calc(var(--u) * 0.55) calc(var(--u) * 1.2);
  font-size: calc(var(--u) * 0.82);
  letter-spacing: 0.24em;
  text-transform: uppercase;
  text-align: center;
  color: #dff2ff;
  background: rgba(120, 180, 220, 0.08);
  box-shadow: inset 0 0 0 1px rgba(120, 190, 230, 0.35);
  transition: background 140ms ease, box-shadow 140ms ease, color 140ms ease;
  white-space: nowrap;
}
.gf-btn:hover { background: rgba(95, 228, 255, 0.16); box-shadow: inset 0 0 0 1px var(--cy); }
.gf-btn.is-small { font-size: calc(var(--u) * 0.72); padding: calc(var(--u) * 0.42) calc(var(--u) * 0.9); }
.gf-btn.is-primary {
  color: #041018;
  background: linear-gradient(180deg, #9eeeff, #4bc8ee);
  box-shadow: 0 0 calc(var(--u) * 1.4) rgba(95, 228, 255, 0.4);
  font-weight: 600;
}
.gf-btn.is-primary:hover { background: linear-gradient(180deg, #c4f6ff, #6ad8f8); }
.gf-btn.is-danger { color: #ffd6cf; box-shadow: inset 0 0 0 1px rgba(255, 90, 76, 0.6); }
.gf-btn.is-danger:hover { background: rgba(255, 90, 76, 0.2); box-shadow: inset 0 0 0 1px var(--red); }
.gf-btn.is-wide { width: 100%; margin-top: calc(var(--u) * 1.2); }
.gf-btn.is-disabled { opacity: 0.4; pointer-events: none; }

/* settings layout ------------------------------------------------------- */
.gf-settings-body {
  display: grid;
  grid-template-columns: calc(var(--u) * 9) 1fr;
  gap: calc(var(--u) * 1.6);
  min-height: 0;
  flex: 1;
}
.gf-tabs { display: flex; flex-direction: column; gap: calc(var(--u) * 0.3); }
.gf-tab {
  padding: calc(var(--u) * 0.55) calc(var(--u) * 0.7);
  font-size: calc(var(--u) * 0.8);
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--text-faint);
  border-left: 2px solid transparent;
  transition: color 140ms ease, border-color 140ms ease, background 140ms ease;
}
.gf-tab:hover { color: var(--text-dim); }
.gf-tab.is-on {
  color: var(--cy);
  border-left-color: var(--cy);
  background: linear-gradient(90deg, rgba(95, 228, 255, 0.14), transparent);
}
.gf-tabs.is-active .gf-tab.is-on { background: linear-gradient(90deg, rgba(95, 228, 255, 0.26), transparent); }
.gf-settings-pages { min-height: 0; overflow: hidden; }
.gf-settings-page { display: none; max-height: 56vh; overflow-y: auto; padding-right: calc(var(--u) * 0.5); }
.gf-settings-page.is-on { display: block; }
.gf-settings-page::-webkit-scrollbar { width: 4px; }
.gf-settings-page::-webkit-scrollbar-thumb { background: rgba(95, 228, 255, 0.35); }

.gf-row {
  --cut: calc(var(--u) * 0.45);
  display: grid;
  grid-template-columns: 1fr calc(var(--u) * 18);
  align-items: center;
  gap: calc(var(--u) * 1);
  padding: calc(var(--u) * 0.55) calc(var(--u) * 0.7);
  margin-bottom: calc(var(--u) * 0.28);
  box-shadow: inset 0 0 0 1px transparent;
  transition: background 130ms ease, box-shadow 130ms ease;
}
.gf-row.is-active { background: rgba(95, 228, 255, 0.09); box-shadow: inset 0 0 0 1px rgba(95, 228, 255, 0.45); }
.gf-row-label { font-size: calc(var(--u) * 0.94); letter-spacing: 0.1em; }
.gf-row-desc { font-size: calc(var(--u) * 0.72); color: var(--text-faint); margin-top: calc(var(--u) * 0.1); line-height: 1.3; }
.gf-row-control { display: flex; align-items: center; gap: calc(var(--u) * 0.7); }
.gf-row-widget { flex: 1; display: flex; align-items: center; gap: calc(var(--u) * 0.25); min-width: 0; }
.gf-row-value {
  width: calc(var(--u) * 5.4);
  text-align: right;
  font-size: calc(var(--u) * 0.82);
  color: var(--cy);
  letter-spacing: 0.08em;
  flex: none;
}

.gf-slider {
  --f: 50%;
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: calc(var(--u) * 0.9);
  background: none;
  cursor: pointer;
}
.gf-slider::-webkit-slider-runnable-track {
  height: calc(var(--u) * 0.24);
  background: linear-gradient(90deg, var(--cy) var(--f), rgba(120, 170, 205, 0.22) var(--f));
}
.gf-slider::-moz-range-track {
  height: calc(var(--u) * 0.24);
  background: linear-gradient(90deg, var(--cy) var(--f), rgba(120, 170, 205, 0.22) var(--f));
}
.gf-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: calc(var(--u) * 0.42);
  height: calc(var(--u) * 0.9);
  margin-top: calc(var(--u) * -0.33);
  background: #dff6ff;
  box-shadow: 0 0 calc(var(--u) * 0.5) rgba(95, 228, 255, 0.9);
}
.gf-slider::-moz-range-thumb {
  border: 0;
  width: calc(var(--u) * 0.42);
  height: calc(var(--u) * 0.9);
  border-radius: 0;
  background: #dff6ff;
  box-shadow: 0 0 calc(var(--u) * 0.5) rgba(95, 228, 255, 0.9);
}

.gf-switch {
  position: relative;
  width: calc(var(--u) * 2.6);
  height: calc(var(--u) * 1.1);
  background: rgba(120, 170, 205, 0.16);
  box-shadow: inset 0 0 0 1px rgba(120, 190, 230, 0.3);
  transition: background 160ms ease, box-shadow 160ms ease;
}
.gf-switch.is-on { background: rgba(95, 228, 255, 0.28); box-shadow: inset 0 0 0 1px var(--cy); }
.gf-switch-knob {
  position: absolute;
  top: calc(var(--u) * 0.15);
  left: calc(var(--u) * 0.15);
  width: calc(var(--u) * 0.8);
  height: calc(var(--u) * 0.8);
  background: #9fc0d8;
  transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1), background 160ms ease;
}
.gf-switch.is-on .gf-switch-knob {
  transform: translateX(calc(var(--u) * 1.5));
  background: #eafaff;
  box-shadow: 0 0 calc(var(--u) * 0.5) rgba(95, 228, 255, 0.9);
}

.gf-chip {
  --cut: calc(var(--u) * 0.3);
  padding: calc(var(--u) * 0.28) calc(var(--u) * 0.6);
  font-size: calc(var(--u) * 0.72);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-faint);
  background: rgba(120, 170, 205, 0.1);
  box-shadow: inset 0 0 0 1px rgba(120, 190, 230, 0.2);
  transition: all 140ms ease;
  white-space: nowrap;
}
.gf-chip:hover { color: var(--text-dim); }
.gf-chip.is-on {
  color: #041018;
  background: var(--cy);
  box-shadow: 0 0 calc(var(--u) * 0.8) rgba(95, 228, 255, 0.5);
  font-weight: 600;
}

/* ===================================================================== */
/* Star map overlay                                                       */
/* ===================================================================== */
.gf-starmap {
  --accent: #5fe4ff;
  position: absolute;
  inset: 0;
  opacity: 0;
  visibility: hidden;
  transition: opacity 320ms ease, visibility 0s linear 320ms;
  z-index: 20;
}
.gf-starmap.is-on { opacity: 1; visibility: visible; transition-delay: 0s; }
.gf-starmap::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(180deg, rgba(4, 8, 14, 0.85), transparent 22%),
    linear-gradient(0deg, rgba(4, 8, 14, 0.85), transparent 20%);
}
.gf-starmap-head {
  position: absolute;
  left: 50%;
  top: var(--pad-t);
  transform: translateX(-50%);
  text-align: center;
}
.gf-starmap-kicker {
  font-size: calc(var(--u) * 0.7);
  letter-spacing: 0.42em;
  text-transform: uppercase;
  color: var(--cy);
  text-indent: 0.42em;
}
.gf-starmap-title {
  font-size: calc(var(--u) * 1.9);
  font-weight: 600;
  letter-spacing: 0.34em;
  text-transform: uppercase;
  text-indent: 0.34em;
  margin-top: calc(var(--u) * 0.2);
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.8);
}
.gf-starmap-list {
  position: absolute;
  left: var(--pad-x);
  top: 50%;
  transform: translateY(-50%);
  width: calc(var(--u) * 22);
  display: flex;
  flex-direction: column;
  gap: calc(var(--u) * 0.32);
}
.gf-starmap-cap {
  font-size: calc(var(--u) * 0.68);
  letter-spacing: 0.36em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-bottom: calc(var(--u) * 0.5);
}
.gf-planet {
  --accent: #5fe4ff;
  --cut: calc(var(--u) * 0.5);
  position: relative;
  display: flex;
  align-items: center;
  gap: calc(var(--u) * 0.7);
  padding: calc(var(--u) * 0.55) calc(var(--u) * 0.8);
  clip-path: polygon(
    0 var(--cut), var(--cut) 0, 100% 0,
    100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%);
  background: rgba(8, 16, 26, 0.66);
  box-shadow: inset 0 0 0 1px rgba(120, 180, 220, 0.16);
  transition: background 150ms ease, box-shadow 150ms ease, transform 150ms ease;
}
.gf-planet:hover { background: rgba(14, 28, 44, 0.8); }
.gf-planet.is-active {
  background: rgba(14, 30, 46, 0.9);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 80%, transparent),
    0 0 calc(var(--u) * 1.4) color-mix(in srgb, var(--accent) 25%, transparent);
  transform: translateX(calc(var(--u) * 0.3));
}
.gf-planet-dot {
  width: calc(var(--u) * 0.75);
  height: calc(var(--u) * 0.75);
  border-radius: 50%;
  flex: none;
  background: var(--accent);
  box-shadow: 0 0 calc(var(--u) * 0.7) var(--accent);
}
.gf-planet-text { flex: 1; min-width: 0; }
.gf-planet-name {
  font-size: calc(var(--u) * 1);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #e8f5ff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gf-planet-sub {
  font-size: calc(var(--u) * 0.66);
  letter-spacing: 0.12em;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: calc(var(--u) * 0.08);
}
.gf-planet-power {
  font-size: calc(var(--u) * 1);
  color: var(--accent);
  letter-spacing: 0.06em;
  flex: none;
}
.gf-planet-here {
  display: none;
  position: absolute;
  right: calc(var(--u) * 0.6);
  bottom: calc(var(--u) * 0.15);
  font-size: calc(var(--u) * 0.56);
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--gold);
}
.gf-planet.is-here .gf-planet-here { display: block; }
.gf-planet.is-here .gf-planet-power { color: var(--gold); }

.gf-dossier {
  position: absolute;
  right: var(--pad-r);
  top: 50%;
  transform: translateY(-50%);
  width: calc(var(--u) * 26);
  --cut: calc(var(--u) * 1);
  padding: calc(var(--u) * 1.3) calc(var(--u) * 1.4);
  background: var(--panel);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 32%, transparent),
    0 18px 50px rgba(0, 0, 0, 0.6);
  clip-path: polygon(
    0 var(--cut), var(--cut) 0, 100% 0,
    100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%);
}
.gf-dossier-head { display: flex; align-items: center; gap: calc(var(--u) * 0.9); }
.gf-dossier-titles { min-width: 0; }
.gf-dossier-name {
  font-size: calc(var(--u) * 1.5);
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: #f0faff;
}
.gf-dossier-sub {
  font-size: calc(var(--u) * 0.72);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--accent);
  margin-top: calc(var(--u) * 0.15);
}
.gf-dossier-rule {
  height: 1px;
  margin: calc(var(--u) * 0.9) 0;
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 55%, transparent), transparent);
}
.gf-dossier-desc { font-size: calc(var(--u) * 0.84); line-height: 1.55; color: var(--text-dim); }
.gf-dossier-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: calc(var(--u) * 0.7);
  margin-top: calc(var(--u) * 1.1);
}
.gf-stat { border-left: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); padding-left: calc(var(--u) * 0.55); }
.gf-stat-cap {
  font-size: calc(var(--u) * 0.6);
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.gf-stat-val { font-size: calc(var(--u) * 0.86); color: var(--text); margin-top: calc(var(--u) * 0.15); }
.gf-threat { display: flex; gap: calc(var(--u) * 0.24); margin-top: calc(var(--u) * 0.9); }
.gf-threat-pip {
  flex: 1;
  height: calc(var(--u) * 0.28);
  background: rgba(120, 170, 205, 0.18);
  transform: skewX(-18deg);
}
.gf-threat-pip.is-on {
  background: var(--accent);
  box-shadow: 0 0 calc(var(--u) * 0.6) color-mix(in srgb, var(--accent) 60%, transparent);
}
.gf-starmap-foot {
  position: absolute;
  left: 50%;
  bottom: var(--pad-y);
  transform: translateX(-50%);
  font-size: calc(var(--u) * 0.66);
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--text-faint);
  white-space: pre;
}

/* ===================================================================== */
/* Death screen                                                           */
/* ===================================================================== */
.gf-death { z-index: 35; }
.gf-settings { z-index: 32; }
.gf-death-wash {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse at 50% 50%, rgba(60, 6, 4, 0.35) 20%, rgba(3, 5, 9, 0.92) 90%);
  backdrop-filter: blur(6px) saturate(0.35);
  -webkit-backdrop-filter: blur(6px) saturate(0.35);
}
.gf-death-inner {
  position: relative;
  text-align: center;
  width: min(calc(var(--u) * 32), 84vw);
  transform: translateY(calc(var(--u) * 1));
  transition: transform 420ms cubic-bezier(0.16, 1, 0.3, 1);
}
.gf-death.is-on .gf-death-inner { transform: none; }
.gf-death-kicker {
  font-size: calc(var(--u) * 0.7);
  letter-spacing: 0.42em;
  text-transform: uppercase;
  color: #ff8676;
  text-indent: 0.42em;
}
.gf-death-title {
  font-size: calc(var(--u) * 3.6);
  font-weight: 600;
  letter-spacing: 0.34em;
  text-transform: uppercase;
  text-indent: 0.34em;
  margin: calc(var(--u) * 0.3) 0 calc(var(--u) * 0.4);
  color: #ffeae6;
  text-shadow: 0 0 calc(var(--u) * 2.4) rgba(255, 60, 40, 0.4);
}
.gf-death-cause {
  font-size: calc(var(--u) * 0.96);
  letter-spacing: 0.14em;
  color: var(--text-dim);
}
.gf-death-ring {
  position: relative;
  width: calc(var(--u) * 8);
  height: calc(var(--u) * 8);
  margin: calc(var(--u) * 1.4) auto calc(var(--u) * 0.4);
}
.gf-death-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.gf-death-ring-track { fill: none; stroke: rgba(255, 255, 255, 0.12); stroke-width: 3; }
.gf-death-ring-fill {
  fill: none;
  stroke: #ff6d5c;
  stroke-width: 3;
  filter: drop-shadow(0 0 6px rgba(255, 90, 76, 0.8));
}
.gf-death-count {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: calc(var(--u) * 2.6);
  font-weight: 600;
  color: #ffece8;
}
.gf-death-hint {
  margin-top: calc(var(--u) * 0.8);
  font-size: calc(var(--u) * 0.66);
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--text-faint);
}

/* ===================================================================== */
/* Debug overlay                                                          */
/* ===================================================================== */
.gf-debug {
  position: absolute;
  right: var(--pad-r);
  top: var(--pad-t);
  display: none;
  padding: calc(var(--u) * 0.5) calc(var(--u) * 0.75);
  background: rgba(5, 10, 16, 0.72);
  box-shadow: inset 0 0 0 1px rgba(95, 228, 255, 0.28);
  z-index: 12;
}
.gf-debug.is-on { display: block; }
.gf-debug-body {
  white-space: pre;
  font-size: calc(var(--u) * 0.72);
  line-height: 1.5;
  letter-spacing: 0.06em;
  color: #b8e8ff;
}

/* ===================================================================== */
/* Animation                                                              */
/* ===================================================================== */
@keyframes gf-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.42; } }
@keyframes gf-spin { to { transform: rotate(360deg); } }
@keyframes gf-crawl { to { background-position: -220% 0; } }
@keyframes gf-sheen {
  0% { transform: translateX(-120%); }
  60%, 100% { transform: translateX(430%); }
}
@keyframes gf-shudder {
  0%, 100% { transform: translate(0, 0); }
  25% { transform: translate(0.6px, -0.4px); }
  75% { transform: translate(-0.5px, 0.5px); }
}
@keyframes gf-objin {
  0% { opacity: 0; transform: translateX(calc(var(--u) * -1.2)); }
  100% { opacity: 1; transform: none; }
}

.gf-ui.is-reduced .gf-vitals.is-critical,
.gf-ui.is-reduced .gf-super.is-ready .gf-super-label,
.gf-ui.is-reduced .gf-weapon.is-lowammo .gf-ammo-cur,
.gf-ui.is-reduced .gf-weapon.is-lowammo .gf-pip:not(.is-spent) { animation: none; }
.gf-ui.is-reduced .gf-sigil-ring { animation-duration: 180s; }

@media (prefers-reduced-motion: reduce) {
  .gf-ui * { animation-duration: 0.001s !important; }
}
`;
