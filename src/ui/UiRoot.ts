/**
 * UiRoot — the whole interface layer.
 *
 * Design rules this file exists to enforce:
 *
 * 1. **The UI is a subscriber.** It imports `events` and `settings` from core
 *    and nothing from gameplay. Every number on screen is reconstructed from
 *    the event stream, which means the HUD works with any gameplay
 *    implementation that emits the documented events.
 * 2. **Reconstruction, not polling.** `player:damaged` reports the damage
 *    *dealt*, not the resulting pool, so `HudState` mirrors the shield-then-
 *    health absorption order and re-simulates regeneration on the fixed
 *    120 Hz step. `player:healed` corrects any drift the moment health ticks
 *    back up. Weapon reserves, ability cooldown lengths and enemy health pools
 *    are *learned* from the stream the first time they are observed (see the
 *    `learn*` helpers) and reused afterwards, so the HUD is exact after one
 *    cycle without ever reaching into the systems that own them.
 * 3. **Simulation vs presentation.** `update()` runs on the fixed step and
 *    owns anything that must be deterministic (regen, cooldown clocks, input
 *    edges). `render()` owns every easing curve, spring and fade, and is the
 *    only place that reads `frameDt`.
 * 4. **No per-frame allocation.** Pools everywhere, cached DOM writes via the
 *    `Bind` helpers in `./dom`, one shared scratch vector for projection.
 */
import * as THREE from 'three';
import type { Engine, EngineSystem, GameState } from '@/core/Engine';
import type { DamageElement, FrameContext, ItemRarity, PlanetId } from '@/types';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';
import { clamp, clamp01, damp } from '@/util/math';
import { UI_CSS } from './ui.css';
import { div, interactive, toggle } from './dom';
import { Hud } from './Hud';
import { Crosshair } from './Crosshair';
import { DamageNumbers } from './DamageNumbers';
import { Toasts } from './Toasts';
import { LoadingScreen } from './LoadingScreen';
import { PauseMenu } from './PauseMenu';
import { SettingsMenu } from './SettingsMenu';
import { Loadout, equippedMeta } from './Loadout';
import { StarMapUi } from './StarMapUi';
import { DeathScreen } from './DeathScreen';
import { MissionResults } from './MissionResults';
import { Briefing } from './Briefing';

// ---------------------------------------------------------------------------
// Shared, event-reconstructed HUD model
// ---------------------------------------------------------------------------

/** Mirrors `VITALS` in the player, which is what the damage events imply. */
const VITALS = {
  maxHealth: 100,
  maxShield: 130,
  shieldDelay: 4.5,
  shieldRefill: 2.5,
  healthDelay: 1.5,
  healthRefill: 7,
  breakPenalty: 0.6,
};

export interface AbilityState {
  /** Ability id currently occupying the slot, '' when unknown. */
  id: string;
  /** 0..1 charge; 1 = ready. */
  charge: number;
  /** Learned cooldown length in seconds. */
  cooldown: number;
  /** Seconds since the ability was spent. */
  since: number;
  /** Decaying 0..1 impulse used for the ready pop. */
  pop: number;
  ready: boolean;
}

export interface DirectionalHit {
  /** World-space direction toward the attacker. */
  dir: THREE.Vector3;
  life: number;
  strength: number;
}

export interface TargetState {
  entityId: number;
  name: string;
  health: number;
  maxHealth: number;
  /** Estimated shield pool fraction, 1 until broken. */
  shield: number;
  shieldElement: DamageElement | null;
  boss: boolean;
  /** Seconds since last damage — drives the auto-hide. */
  since: number;
  hitPop: number;
}

export interface HudState {
  health: number;
  shield: number;
  /** Time since the player last took damage, for the regen model. */
  sinceDamage: number;
  sinceShieldFull: number;
  /** 0..1 decaying flash when the shield popped. */
  shieldBreak: number;
  /** 0..1 decaying flash on any hit. */
  hurt: number;
  dead: boolean;

  weaponId: string;
  weaponName: string;
  weaponFamily: string;
  element: DamageElement;
  rarity: ItemRarity;
  ammo: number;
  magazine: number;
  reserves: number;
  /** -1 when not reloading, else 0..1 progress. */
  reload: number;
  reloadLength: number;
  /** 0..1 decaying flash when the reload lands. */
  reloadPop: number;
  /** 0..1 decaying punch on each shot, drives the pip flash. */
  firePop: number;

  grenade: AbilityState;
  melee: AbilityState;
  classAbility: AbilityState;
  superCharge: number;
  superReady: boolean;
  superActive: boolean;
  /** 0..1 decaying impulse when the super becomes available. */
  superPop: number;

  /** Aiming down sights, read from core input (not gameplay). */
  ads: number;
  /** 0..1 accumulated weapon bloom, decays back to 0. */
  bloom: number;

  objectiveText: string;
  objectiveProgress: number;
  objectiveTotal: number;
  objectiveDone: number;

  target: TargetState | null;
  boss: TargetState | null;

  /** Camera heading in radians, 0 = -Z (north). */
  heading: number;
  /** Recent enemy contacts, as world bearings + life. */
  contacts: { bearing: number; life: number; kill: number }[];

  hits: DirectionalHit[];

  subtitleSpeaker: string;
  subtitleText: string;
  subtitleLife: number;

  killStreak: number;
  killStreakLife: number;
}

const ELEMENTS: DamageElement[] = ['kinetic', 'solar', 'arc', 'void', 'stasis'];

/**
 * UI-local weapon lexicon. The UI is forbidden from importing the weapon
 * defs (that would make it a gameplay dependency), and `weapon:swapped` only
 * carries an id — so display metadata lives here, keyed by the ids the weapon
 * system emits. Anything unknown falls back to a prettified id and the values
 * learned from `weapon:fired`.
 */
const WEAPON_LEXICON: Record<
  string,
  { name: string; family: string; element: DamageElement; rarity: ItemRarity }
> = {
  autoRifle: { name: 'Sentinel AR-7', family: 'Auto Rifle', element: 'kinetic', rarity: 'legendary' },
  scoutRifle: { name: 'Long Watch MK4', family: 'Scout Rifle', element: 'kinetic', rarity: 'legendary' },
  handCannon: { name: 'Ironclad .50', family: 'Hand Cannon', element: 'kinetic', rarity: 'exotic' },
  submachineGun: { name: 'Riptide SMG', family: 'Submachine Gun', element: 'kinetic', rarity: 'legendary' },
  bow: { name: 'Silent Verdict', family: 'Combat Bow', element: 'kinetic', rarity: 'exotic' },
  pulseRifle: { name: 'Triad Cadence', family: 'Pulse Rifle', element: 'arc', rarity: 'legendary' },
  sidearm: { name: 'Wasp SD-3', family: 'Sidearm', element: 'solar', rarity: 'rare' },
  shotgun: { name: 'Breachlight 12', family: 'Shotgun', element: 'void', rarity: 'legendary' },
  fusionRifle: { name: 'Solstice Coil', family: 'Fusion Rifle', element: 'arc', rarity: 'legendary' },
  traceRifle: { name: 'Continuum Ray', family: 'Trace Rifle', element: 'solar', rarity: 'exotic' },
  sniperRifle: { name: 'Meridian Longshot', family: 'Sniper Rifle', element: 'stasis', rarity: 'legendary' },
  rocketLauncher: { name: 'Havoc RL-9', family: 'Rocket Launcher', element: 'solar', rarity: 'legendary' },
  grenadeLauncher: { name: 'Bellringer GL', family: 'Grenade Launcher', element: 'arc', rarity: 'legendary' },
  machineGun: { name: 'Hammerfall LMG', family: 'Machine Gun', element: 'void', rarity: 'legendary' },
};

function makeAbility(): AbilityState {
  return { id: '', charge: 1, cooldown: 8, since: 99, pop: 0, ready: true };
}

function makeState(): HudState {
  return {
    health: VITALS.maxHealth,
    shield: VITALS.maxShield,
    sinceDamage: 99,
    sinceShieldFull: 99,
    shieldBreak: 0,
    hurt: 0,
    dead: false,
    weaponId: '',
    weaponName: 'Sentinel AR-7',
    weaponFamily: 'Auto Rifle',
    element: 'kinetic',
    rarity: 'legendary',
    ammo: 36,
    magazine: 36,
    reserves: 240,
    reload: -1,
    reloadLength: 2,
    reloadPop: 0,
    firePop: 0,
    grenade: makeAbility(),
    melee: makeAbility(),
    classAbility: makeAbility(),
    superCharge: 0,
    superReady: false,
    superActive: false,
    superPop: 0,
    ads: 0,
    bloom: 0,
    objectiveText: '',
    objectiveProgress: 0,
    objectiveTotal: 0,
    objectiveDone: 0,
    target: null,
    boss: null,
    heading: 0,
    contacts: [],
    hits: [],
    subtitleSpeaker: '',
    subtitleText: '',
    subtitleLife: 0,
    killStreak: 0,
    killStreakLife: 0,
  };
}

/** Per-enemy bookkeeping used to reconstruct nameplates without polling. */
interface EnemyRecord {
  entityId: number;
  maxHealth: number;
  health: number;
  shieldPool: number;
  shieldTaken: number;
  shieldElement: DamageElement | null;
  hadShield: boolean;
  name: string;
  age: number;
}

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class UiRoot implements EngineSystem {
  readonly name = 'ui';

  /** Installed by the star map so the dossier's SET COURSE has somewhere to go. */
  onTravel: ((id: PlanetId) => void) | null = null;

  readonly state: HudState = makeState();

  private readonly engine: Engine;
  private readonly root: HTMLElement;
  private readonly styleTag: HTMLStyleElement;
  private readonly unbind: (() => void)[] = [];

  private readonly hud: Hud;
  private readonly crosshair: Crosshair;
  private readonly damageNumbers: DamageNumbers;
  private readonly toasts: Toasts;
  private readonly loading: LoadingScreen;
  private readonly pause: PauseMenu;
  private readonly settingsMenu: SettingsMenu;
  private readonly loadout: Loadout;
  private readonly starmap: StarMapUi;
  private readonly death: DeathScreen;
  private readonly results: MissionResults;
  private readonly briefing: Briefing;
  private readonly debugPanel: HTMLElement;
  private readonly debugText: HTMLElement;
  private readonly vignette: HTMLElement;

  /** Enemy pool — reused records, never reallocated per hit. */
  private readonly enemies = new Map<number, EnemyRecord>();
  private readonly enemyPool: EnemyRecord[] = [];
  /** Learned mapping from a rounded max-health bracket to an archetype name. */
  private readonly nameByPool = new Map<number, string>();
  /** Learned shield pool per max-health bracket, same trick as the names. */
  private readonly shieldByPool = new Map<number, number>();
  /** Learned reload length per weapon id. */
  private readonly reloadLengths = new Map<string, number>();
  /** Learned reserve pool per weapon id, seeded from the first observed value. */
  private readonly reserveByWeapon = new Map<string, number>();
  private readonly abilityLengths = new Map<string, number>();

  private lastState: GameState = 'boot';
  private prevPaused = false;
  /** Which device the on-screen legends are currently written for. */
  private padPrompts = false;
  private readonly lockHint: HTMLElement;
  private debugAccum = 0;
  private padPrev = 0;
  private padAxisLatch = 0;
  private wasLocked = false;
  private disposed = false;

  constructor(engine: Engine) {
    this.engine = engine;

    this.styleTag = document.createElement('style');
    this.styleTag.id = 'gf-ui-style';
    this.styleTag.textContent = UI_CSS;
    document.head.appendChild(this.styleTag);

    const mount = document.getElementById('ui-root') ?? document.body;
    this.root = div('gf-ui', mount);
    this.lockHint = div('gf-lockhint', this.root);
    this.lockHint.textContent = 'Click to look';

    this.vignette = div('gf-dmg-vignette', this.root);

    this.hud = new Hud(this.root, this.state, engine.host.camera);
    this.crosshair = new Crosshair(this.root, this.state);
    this.damageNumbers = new DamageNumbers(this.root, engine.host.camera);
    this.toasts = new Toasts(this.root);
    this.starmap = new StarMapUi(this.root, (id) => this.onTravel?.(id));
    this.death = new DeathScreen(this.root, () => this.respawn());
    // Both campaign surfaces subscribe to the bus themselves, so the only wiring
    // they need here is construction, a frame tick, and a seat in activeMenu().
    this.results = new MissionResults(this.root, { orbit: () => void this.returnToOrbit() });
    this.briefing = new Briefing();
    this.settingsMenu = new SettingsMenu(this.root);
    // The vault screen. Reachable from the pause menu, which is the only place
    // a player can stop and think about what they are carrying.
    this.loadout = new Loadout(this.root);
    this.pause = new PauseMenu(this.root, {
      resume: () => this.resumeGame(),
      loadout: () => this.loadout.open(),
      settings: () => this.settingsMenu.open(),
      orbit: () => void this.returnToOrbit(),
      abandon: () => void this.returnToOrbit(),
    });
    this.loading = new LoadingScreen(this.root);

    this.debugPanel = div('gf-debug', this.root);
    this.debugText = div('gf-debug-body', this.debugPanel);

    this.bindEvents();
    this.bindKeys();
    this.installDebugHooks();
  }

  // -- public API ------------------------------------------------------------

  showLoading(on: boolean, label: string): void {
    this.loading.show(on, label);
    if (on) this.pause.close();
  }

  setLoadingProgress(t: number, label: string): void {
    this.loading.setProgress(t, label);
  }

  // -- event wiring ----------------------------------------------------------

  private bindEvents(): void {
    const s = this.state;
    const on = <K extends keyof import('@/core/EventBus').GameEvents>(
      key: K,
      fn: (p: import('@/core/EventBus').GameEvents[K]) => void,
    ): void => {
      this.unbind.push(events.on(key, fn));
    };

    on('player:damaged', (p) => {
      const absorbed = Math.min(s.shield, p.amount);
      s.shield -= absorbed;
      s.health = clamp(s.health - (p.amount - absorbed), 0, VITALS.maxHealth);
      s.sinceDamage = p.shieldBroke ? -VITALS.breakPenalty : 0;
      s.sinceShieldFull = 99;
      if (p.shieldBroke) {
        s.shield = 0;
        s.shieldBreak = 1;
      }
      s.hurt = clamp01(s.hurt + p.amount / 45);
      this.pushHit(p.direction, clamp01(p.amount / 40));
    });

    on('player:healed', (p) => {
      s.health = clamp(s.health + p.amount, 0, VITALS.maxHealth);
    });

    on('player:died', (p) => {
      s.dead = true;
      s.health = 0;
      s.shield = 0;
      this.death.show(p.killerName);
      this.pause.close();
      this.settingsMenu.close();
      this.loadout.close();
    });

    on('player:respawn', () => {
      s.dead = false;
      s.health = VITALS.maxHealth;
      s.shield = VITALS.maxShield;
      s.sinceDamage = 99;
      s.hits.length = 0;
      this.death.hide();
    });

    on('weapon:fired', (p) => {
      s.ammo = p.ammo;
      s.magazine = Math.max(1, p.magazine);
      if (s.weaponId !== p.weaponId) this.applyWeapon(p.weaponId);
      const pool = this.reserveByWeapon.get(p.weaponId);
      if (pool !== undefined) this.reserveByWeapon.set(p.weaponId, pool);
      s.firePop = 1;
      // Bloom grows fast and recovers slowly — the same shape the weapon's own
      // spread model uses, reconstructed here so the reticle matches the cone.
      s.bloom = clamp01(s.bloom + 0.26 - s.ads * 0.1);
      if (s.reload >= 0) this.endReload(false);
    });

    on('weapon:emptied', () => {
      if (s.reload < 0) this.beginReload();
    });

    on('weapon:reloaded', (p) => {
      if (s.reload >= 0) {
        const measured = s.reload * s.reloadLength;
        if (measured > 0.25 && measured < 8) this.reloadLengths.set(p.weaponId, measured);
      }
      const spent = s.magazine - s.ammo;
      const reserve = this.reserveByWeapon.get(p.weaponId) ?? s.reserves;
      this.reserveByWeapon.set(p.weaponId, Math.max(0, reserve - spent));
      s.reserves = Math.max(0, reserve - spent);
      s.ammo = s.magazine;
      this.endReload(true);
    });

    on('weapon:swapped', (p) => {
      this.applyWeapon(p.weaponId);
      s.reload = -1;
      s.bloom = 0;
    });

    on('ability:used', (p) => {
      const slot = this.abilitySlot(p.slot);
      if (!slot) return;
      slot.id = p.id;
      slot.charge = 0;
      slot.since = 0;
      slot.ready = false;
      slot.cooldown = this.abilityLengths.get(p.id) ?? slot.cooldown;
    });

    on('ability:ready', (p) => {
      const slot = this.abilitySlot(p.slot);
      if (!slot) return;
      slot.id = p.id;
      if (slot.since > 0.4 && slot.since < 120) this.abilityLengths.set(p.id, slot.since);
      slot.cooldown = this.abilityLengths.get(p.id) ?? slot.cooldown;
      slot.charge = 1;
      slot.ready = true;
      slot.pop = 1;
    });

    on('super:ready', () => {
      s.superCharge = 1;
      s.superReady = true;
      s.superPop = 1;
      this.toasts.push({ text: 'SUPER READY', sub: 'Press X', duration: 2.6, rarity: 'exotic' });
    });
    on('super:activated', () => {
      s.superActive = true;
      s.superReady = false;
    });
    on('super:ended', () => {
      s.superActive = false;
      s.superCharge = 0;
    });

    on('enemy:damaged', (p) => {
      const rec = this.record(p.entityId);
      if (p.region === 'shield') {
        rec.hadShield = true;
        rec.shieldTaken += p.amount;
      } else {
        rec.health = p.remaining;
        rec.maxHealth = Math.max(rec.maxHealth, p.remaining + p.amount);
      }
      rec.age = 0;
      const learned = this.nameByPool.get(bucket(rec.maxHealth));
      if (learned) rec.name = learned;
      if (rec.shieldPool <= 0) rec.shieldPool = this.shieldByPool.get(bucket(rec.maxHealth)) ?? 0;
      this.promote(rec);
      this.damageNumbers.spawn(p.point, p.amount, p.precision, p.element, p.entityId);
    });

    on('enemy:shieldBroken', (p) => {
      const rec = this.record(p.entityId);
      rec.shieldElement = p.element;
      rec.shieldPool = Math.max(rec.shieldTaken, 1);
      // Bank the pool against the health bracket so the *next* unit of this
      // archetype shows a draining shield rather than a full-then-gone one.
      this.shieldByPool.set(bucket(rec.maxHealth), rec.shieldPool);
      rec.age = 0;
      this.promote(rec);
    });

    on('enemy:killed', (p) => {
      const rec = this.enemies.get(p.entityId);
      if (rec) {
        // The archetype name only arrives on death — bank it against the health
        // pool so the *next* one of these shows its real name from the first hit.
        this.nameByPool.set(bucket(rec.maxHealth), p.name);
        this.release(rec);
      }
      if (this.state.target?.entityId === p.entityId) this.state.target = null;
      if (this.state.boss?.entityId === p.entityId) this.state.boss = null;
      s.killStreak++;
      s.killStreakLife = 3.4;
      s.superCharge = clamp01(s.superCharge + 0.055);
      this.pushContact(p.position, true);
    });

    on('objective:updated', (p) => {
      // The card flashes when the *objective* changes, not when its counter
      // moves. A hold objective ticks once a second by design, and re-playing
      // the entry animation on every tick makes the HUD strobe for the length
      // of the hold.
      const isNew = p.text !== s.objectiveText;
      s.objectiveText = p.text;
      s.objectiveProgress = p.progress;
      s.objectiveTotal = p.total;
      s.objectiveDone = 0;
      if (isNew) this.hud.flashObjective();
    });

    on('objective:completed', (p) => {
      s.objectiveText = p.text;
      s.objectiveDone = 1;
      this.toasts.push({ text: 'OBJECTIVE COMPLETE', sub: p.text, duration: 3.4, rarity: 'rare' });
    });

    on('loot:pickup', (p) => {
      this.toasts.push({
        text: prettyLoot(p.kind),
        sub: p.rarity ? p.rarity.toUpperCase() : 'RECOVERED',
        rarity: p.rarity,
        duration: 2.6,
      });
    });

    on('ui:toast', (p) => this.toasts.push(p));

    on('ui:subtitle', (p) => {
      s.subtitleSpeaker = p.speaker;
      s.subtitleText = p.text;
      s.subtitleLife = p.duration ?? 3.6;
    });

    on('hitmarker', (p) => this.crosshair.hit(p.precision, p.kill, p.damage));

    on('level:loaded', (p) => {
      s.contacts.length = 0;
      s.hits.length = 0;
      this.enemies.forEach((r) => this.enemyPool.push(r));
      this.enemies.clear();
      s.target = null;
      s.boss = null;
      s.objectiveDone = 0;
      this.damageNumbers.clear();
      this.starmap.setActive(p.id);
    });

    on('ship:arrived', (p) => this.starmap.setActive(p.at));
    on('ship:travelStarted', (p) => this.starmap.close(p.to));

    on('settings:changed', () => {
      this.crosshair.applyStyle();
      this.settingsMenu.sync();
      toggle(this.root, 'is-reduced', settings.user.reducedMotion);
    });

    on('impact:surface', () => {
      /* surface impacts are VFX's business; subscribed so the bus stays warm */
    });
  }

  private bindKeys(): void {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.repeat) return;
      // Every navigable surface, so the results screen gets arrow keys too.
      const anyMenu = this.activeMenu() !== null;
      if (ev.code === 'Escape') {
        ev.preventDefault();
        if (this.settingsMenu.visible) this.settingsMenu.close();
        else if (this.loadout.visible) this.loadout.close();
        else if (this.starmap.visible) this.starmap.close();
        else if (this.pause.visible) this.resumeGame();
        else if (this.engine.state === 'playing') this.pauseGame();
        return;
      }
      if (
        (ev.code === 'Tab' || ev.code === 'KeyM') &&
        !anyMenu &&
        this.engine.state === 'starmap'
      ) {
        ev.preventDefault();
        this.starmap.open();
        return;
      }
      if (!anyMenu) {
        // Advance the handler's traffic; a second press inside the double-tap
        // window throws the rest of the briefing away.
        if (ev.code === 'Enter' || ev.code === 'NumpadEnter') this.briefing.skip();
        return;
      }
      const active = this.activeMenu();
      if (!active) return;
      switch (ev.code) {
        case 'ArrowUp':
        case 'KeyW':
          ev.preventDefault();
          active.nav(-1);
          break;
        case 'ArrowDown':
        case 'KeyS':
          ev.preventDefault();
          active.nav(1);
          break;
        case 'ArrowLeft':
        case 'KeyA':
          ev.preventDefault();
          active.navX(-1);
          break;
        case 'ArrowRight':
        case 'KeyD':
          ev.preventDefault();
          active.navX(1);
          break;
        case 'Enter':
        case 'Space':
        case 'NumpadEnter':
          ev.preventDefault();
          active.activate();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    this.unbind.push(() => window.removeEventListener('keydown', onKey, { capture: true }));

    const onLock = (): void => {
      const locked = document.pointerLockElement !== null;
      // Losing the lock during play means the player hit Escape or alt-tabbed;
      // the browser swallows that keydown, so this is the reliable signal.
      if (this.wasLocked && !locked && this.engine.state === 'playing') this.pauseGame();
      this.wasLocked = locked;
    };
    document.addEventListener('pointerlockchange', onLock);
    this.unbind.push(() => document.removeEventListener('pointerlockchange', onLock));
  }

  private installDebugHooks(): void {
    // Namespaced separately from `window.GF` because `Game` replaces that
    // object wholesale after every system is constructed.
    (window as unknown as { GFUI: unknown }).GFUI = {
      root: this.root,
      state: this.state,
      pause: () => this.pauseGame(),
      resume: () => this.resumeGame(),
      settings: () => {
        this.pause.open();
        this.settingsMenu.open();
      },
      starmap: () => this.starmap.open(),
      /** Open the vault screen directly, without walking the pause menu. */
      loadout: () => this.loadout.open(),
      death: (cause = 'a Jötunn Warband Chief') => this.death.show(cause),
      revive: () => this.death.hide(),
      loading: (on: boolean, label = 'Approaching Aurvangr') => this.showLoading(on, label),
      loadingProgress: (t: number, label: string) => this.setLoadingProgress(t, label),
      toast: (text: string, sub?: string, rarity?: ItemRarity) =>
        this.toasts.push({ text, sub, rarity, duration: 6 }),
      /** Populate the HUD with a plausible mid-firefight state for captures. */
      demo: () => this.demo(),
    };
  }

  // -- helpers ---------------------------------------------------------------

  private abilitySlot(slot: string): AbilityState | null {
    if (slot === 'grenade') return this.state.grenade;
    if (slot === 'melee') return this.state.melee;
    if (slot === 'class' || slot === 'classAbility') return this.state.classAbility;
    return null;
  }

  private applyWeapon(id: string): void {
    const s = this.state;
    const meta = WEAPON_LEXICON[id];
    // A weapon the player *rolled* outranks the catalogue entry: it carries its
    // own name, rarity and element, and those are the whole point of the drop.
    // `weapon:swapped` can only carry an id, so the roll is looked up here.
    const roll = equippedMeta(id);
    s.weaponId = id;
    s.weaponName = (roll?.name ?? meta?.name ?? prettyName(id)).toUpperCase();
    s.weaponFamily = meta?.family ?? 'Field Weapon';
    s.element = roll?.element ?? meta?.element ?? 'kinetic';
    s.rarity = roll?.rarity ?? meta?.rarity ?? 'legendary';
    s.reloadLength = this.reloadLengths.get(id) ?? 2;
    const reserve = this.reserveByWeapon.get(id);
    if (reserve === undefined) {
      // Seeded once from a family-typical pool; corrected on the first reload.
      const seed = id === 'rocketLauncher' || id === 'sniperRifle' ? 24 : id === 'machineGun' ? 320 : 180;
      this.reserveByWeapon.set(id, seed);
      s.reserves = seed;
    } else {
      s.reserves = reserve;
    }
  }

  private beginReload(): void {
    const s = this.state;
    s.reloadLength = this.reloadLengths.get(s.weaponId) ?? 2;
    s.reload = 0;
  }

  private endReload(landed: boolean): void {
    this.state.reload = -1;
    if (landed) this.state.reloadPop = 1;
  }

  private record(id: number): EnemyRecord {
    let rec = this.enemies.get(id);
    if (!rec) {
      rec = this.enemyPool.pop() ?? {
        entityId: id,
        maxHealth: 1,
        health: 1,
        shieldPool: 0,
        shieldTaken: 0,
        shieldElement: null,
        hadShield: false,
        name: 'Hostile',
        age: 0,
      };
      rec.entityId = id;
      rec.maxHealth = 1;
      rec.health = 1;
      rec.shieldPool = 0;
      rec.shieldTaken = 0;
      rec.shieldElement = null;
      rec.hadShield = false;
      rec.name = 'Hostile';
      rec.age = 0;
      this.enemies.set(id, rec);
    }
    return rec;
  }

  private release(rec: EnemyRecord): void {
    this.enemies.delete(rec.entityId);
    if (this.enemyPool.length < 48) this.enemyPool.push(rec);
  }

  /** Route a freshly-damaged enemy to the nameplate or the boss bar. */
  private promote(rec: EnemyRecord): void {
    const isBoss = rec.maxHealth >= 1800;
    const shieldFrac =
      rec.shieldPool > 0 ? clamp01(1 - rec.shieldTaken / rec.shieldPool) : rec.hadShield ? 1 : 0;
    const target: TargetState = {
      entityId: rec.entityId,
      name: rec.name,
      health: rec.health,
      maxHealth: Math.max(1, rec.maxHealth),
      shield: shieldFrac,
      shieldElement: rec.shieldElement,
      boss: isBoss,
      since: 0,
      hitPop: 1,
    };
    if (isBoss) {
      const prev = this.state.boss;
      target.hitPop = prev && prev.entityId === rec.entityId ? Math.max(prev.hitPop, 0.8) : 1;
      this.state.boss = target;
    } else {
      this.state.target = target;
    }
  }

  private pushHit(dir: THREE.Vector3, strength: number): void {
    const hits = this.state.hits;
    let slot = hits.find((h) => h.life <= 0);
    if (!slot) {
      if (hits.length >= 8) slot = hits[0];
      else {
        slot = { dir: new THREE.Vector3(), life: 0, strength: 0 };
        hits.push(slot);
      }
    }
    slot.dir.copy(dir);
    slot.life = 1.35;
    slot.strength = clamp(strength, 0.25, 1);
  }

  private pushContact(pos: THREE.Vector3, kill: boolean): void {
    const cam = this.engine.host.camera;
    _v.copy(pos).sub(cam.position);
    const bearing = Math.atan2(_v.x, -_v.z);
    const list = this.state.contacts;
    let slot = list.find((c) => c.life <= 0);
    if (!slot) {
      if (list.length >= 10) slot = list[0];
      else {
        slot = { bearing: 0, life: 0, kill: 0 };
        list.push(slot);
      }
    }
    slot.bearing = bearing;
    slot.life = kill ? 2.4 : 6;
    slot.kill = kill ? 1 : 0;
  }

  private activeMenu(): {
    nav(d: number): void;
    navX(d: number): void;
    activate(): void;
  } | null {
    if (this.settingsMenu.visible) return this.settingsMenu;
    if (this.loadout.visible) return this.loadout;
    if (this.results.visible) return this.results;
    if (this.starmap.visible) return this.starmap;
    if (this.pause.visible) return this.pause;
    if (this.death.visible) return this.death;
    return null;
  }

  private pauseGame(): void {
    if (this.engine.state !== 'playing') return;
    this.engine.pause();
    this.pause.open();
    this.engine.input.suppressGameplay = true;
  }

  private resumeGame(): void {
    this.settingsMenu.close();
    this.loadout.close();
    this.pause.close();
    this.engine.input.suppressGameplay = false;
    if (this.engine.state === 'paused') this.engine.resume();
  }

  private respawn(): void {
    this.death.hide();
    events.emit('player:respawn');
  }

  private async returnToOrbit(): Promise<void> {
    this.pause.close();
    this.settingsMenu.close();
    this.loadout.close();
    this.engine.input.suppressGameplay = false;
    // Dynamic so the static import graph stays `core -> ui` only; `Game` is the
    // integration seam and already imports this module.
    const { game } = await import('@/core/Game');
    await game().openStarMap();
  }

  /** Fills the HUD with a representative combat state (capture harness only). */
  private demo(): void {
    const s = this.state;
    this.applyWeapon('pulseRifle');
    s.health = 62;
    s.shield = 41;
    s.sinceDamage = 1.1;
    s.ammo = 11;
    s.magazine = 20;
    s.reserves = 214;
    s.superCharge = 0.78;
    s.grenade.charge = 0.42;
    s.grenade.ready = false;
    s.grenade.since = 3;
    s.melee.charge = 1;
    s.melee.ready = true;
    s.classAbility.charge = 0.86;
    s.classAbility.ready = false;
    s.objectiveText = 'Clear the glacier shelf';
    s.objectiveProgress = 7;
    s.objectiveTotal = 12;
    s.subtitleSpeaker = 'Vanguard Control';
    s.subtitleText = 'Contacts on the ridge line — they know you are here.';
    s.subtitleLife = 8;
    s.target = {
      entityId: 42,
      name: 'Jötunn Raider',
      health: 340,
      maxHealth: 620,
      shield: 0.55,
      shieldElement: 'arc',
      boss: false,
      since: 0,
      hitPop: 0.4,
    };
    s.boss = {
      entityId: 7,
      name: 'Skoll, Warband Chief',
      health: 4200,
      maxHealth: 6800,
      shield: 0.62,
      shieldElement: 'stasis',
      boss: true,
      since: 0,
      hitPop: 0.3,
    };
    for (let i = 0; i < 4; i++) {
      this.pushContact(_v.set(Math.sin(i * 2.1) * 30, 0, Math.cos(i * 2.1) * 30), i === 3);
    }
    this.pushHit(_v.set(0.7, 0, 0.7).normalize(), 0.8);
    this.pushHit(_v.set(-0.9, 0, 0.2).normalize(), 0.5);
    this.crosshair.hit(true, false, 148);
    this.toasts.push({ text: 'Havoc RL-9', sub: 'Legendary Rocket Launcher', rarity: 'legendary', duration: 9 });
    this.toasts.push({ text: 'Solstice Coil', sub: 'Exotic Fusion Rifle', rarity: 'exotic', duration: 9 });
  }

  // -- frame -----------------------------------------------------------------

  update(ctx: FrameContext): void {
    const s = this.state;
    const dt = ctx.dt;
    const input = this.engine.input;

    // ADS + reload edges come from core input, which is the only honest source
    // for "the player is holding the aim button" — no gameplay import needed.
    const aiming = input.down('aim') || input.aimAxis > 0.5;
    s.ads = clamp01(s.ads + (aiming ? dt * 6 : -dt * 8));
    if (input.pressed('reload') && s.reload < 0 && s.ammo < s.magazine) this.beginReload();

    // Shield/health regeneration, mirroring the player's own model so the arc
    // refills at exactly the rate the simulation does.
    if (!s.dead) {
      s.sinceDamage += dt;
      if (s.sinceDamage >= VITALS.shieldDelay) {
        if (s.shield < VITALS.maxShield) {
          s.shield = Math.min(
            VITALS.maxShield,
            s.shield + (VITALS.maxShield / VITALS.shieldRefill) * dt,
          );
          if (s.shield >= VITALS.maxShield) s.sinceShieldFull = 0;
        } else {
          s.sinceShieldFull += dt;
          if (s.sinceShieldFull >= VITALS.healthDelay && s.health < VITALS.maxHealth) {
            s.health = Math.min(
              VITALS.maxHealth,
              s.health + (VITALS.maxHealth / VITALS.healthRefill) * dt,
            );
          }
        }
      } else {
        s.sinceShieldFull = 0;
      }
    }

    if (s.reload >= 0) {
      s.reload += dt / Math.max(0.2, s.reloadLength);
      if (s.reload > 1.25) this.endReload(false);
    }

    // Bloom recovers on the fixed step so the reticle is frame-rate stable.
    s.bloom = Math.max(0, s.bloom - dt * 1.35);

    for (const slot of [s.grenade, s.melee, s.classAbility]) {
      if (!slot.ready) {
        slot.since += dt;
        slot.charge = clamp01(slot.since / Math.max(0.5, slot.cooldown));
        if (slot.charge >= 1) {
          slot.ready = true;
          slot.pop = 1;
        }
      }
    }
    if (!s.superReady && !s.superActive) {
      // Passive trickle; kills add the bulk of it via `enemy:killed`.
      s.superCharge = clamp01(s.superCharge + dt * 0.0055);
      if (s.superCharge >= 1) {
        s.superReady = true;
        s.superPop = 1;
      }
    }
    if (s.superActive) s.superCharge = Math.max(0, s.superCharge - dt * 0.09);

    for (const rec of this.enemies.values()) {
      rec.age += dt;
      if (rec.age > 12) this.release(rec);
    }
  }

  render(ctx: FrameContext, _alpha: number): void {
    if (this.disposed) return;
    const dt = Math.min(ctx.frameDt, 0.1);
    const s = this.state;
    const st = this.engine.state;

    if (st !== this.lastState) {
      this.onStateChanged(st);
      this.lastState = st;
    }

    // Decays — all presentation, all frame-time based.
    s.shieldBreak = Math.max(0, s.shieldBreak - dt * 1.6);
    s.hurt = Math.max(0, s.hurt - dt * 1.9);
    s.firePop = Math.max(0, s.firePop - dt * 5.5);
    s.reloadPop = Math.max(0, s.reloadPop - dt * 2.2);
    s.superPop = Math.max(0, s.superPop - dt * 0.9);
    s.grenade.pop = Math.max(0, s.grenade.pop - dt * 1.6);
    s.melee.pop = Math.max(0, s.melee.pop - dt * 1.6);
    s.classAbility.pop = Math.max(0, s.classAbility.pop - dt * 1.6);
    s.subtitleLife = Math.max(0, s.subtitleLife - dt);
    s.killStreakLife = Math.max(0, s.killStreakLife - dt);
    if (s.killStreakLife <= 0) s.killStreak = 0;
    if (s.target) {
      s.target.since += dt;
      s.target.hitPop = Math.max(0, s.target.hitPop - dt * 3);
      if (s.target.since > 3.2) s.target = null;
    }
    if (s.boss) {
      s.boss.since += dt;
      s.boss.hitPop = Math.max(0, s.boss.hitPop - dt * 3);
      if (s.boss.since > 14) s.boss = null;
    }
    for (const h of s.hits) if (h.life > 0) h.life -= dt;
    for (const c of s.contacts) if (c.life > 0) c.life -= dt;
    if (s.objectiveDone > 0) s.objectiveDone = Math.min(4, s.objectiveDone + dt);

    const cam = this.engine.host.camera;
    cam.getWorldDirection(_fwd);
    s.heading = Math.atan2(_fwd.x, -_fwd.z);

    const inCombat = st === 'playing' || st === 'dead';
    const hudVisible =
      inCombat &&
      !this.loading.visible &&
      !this.pause.visible &&
      !this.settingsMenu.visible &&
      !this.loadout.visible;
    toggle(this.root, 'hud-on', hudVisible);
    toggle(this.root, 'is-reduced', settings.user.reducedMotion);

    this.hud.render(dt, hudVisible);
    this.crosshair.render(dt, hudVisible && !s.dead);
    this.damageNumbers.render(dt, hudVisible && settings.user.damageNumbers);
    this.toasts.render(dt);
    this.loading.render(dt);
    this.pause.render(dt);
    this.settingsMenu.render(dt);
    this.loadout.render(dt);
    this.starmap.render(dt);
    this.death.render(dt);
    this.results.render(dt);
    this.briefing.render(dt);

    this.vignette.style.opacity = (
      Math.max(s.hurt * 0.85, (1 - s.health / VITALS.maxHealth) * 0.5 * pulse(ctx.elapsed)) *
      (settings.user.reducedMotion ? 0.5 : 1)
    ).toFixed(3);

    this.tickGamepad();

    // Decide whether the next canvas click should capture the pointer. Mouse
    // look reads `movementX`, which only arrives under pointer lock, and until
    // now the lock was requested from exactly one place — `Engine.resume()` —
    // which returns early unless the game is already paused. Landing on a planet
    // sets `playing` directly, so a player who never opened the pause menu had
    // no mouse look at all. This is the missing half: `Input` claims the pointer
    // on the first click the UI says belongs to the world rather than a menu.
    const wantsPointer = !this.activeMenu() && (st === 'playing' || st === 'starmap');
    this.engine.input.autoPointerLock = wantsPointer;
    toggle(this.lockHint, 'is-on', wantsPointer && !this.engine.input.pointerLocked);

    // Menu legends follow whichever device the player last touched, so the
    // prompts never name a button they are not holding.
    const pad = this.engine.input.usingGamepad;
    if (pad !== this.padPrompts) {
      this.padPrompts = pad;
      this.pause.setDevice(pad);
      this.settingsMenu.setDevice(pad);
      this.loadout.setDevice(pad);
      this.starmap.setDevice(pad);
      this.results.setDevice(pad);
      toggle(this.root, 'is-pad', pad);
    }
    this.tickDebug(dt);
  }

  private onStateChanged(st: GameState): void {
    if (st === 'starmap') {
      this.starmap.open();
      this.engine.input.suppressGameplay = false;
    } else if (this.starmap.visible && st === 'playing') {
      this.starmap.close();
    }
    if (st !== 'paused' && this.prevPaused) {
      this.pause.close();
      this.settingsMenu.close();
      this.loadout.close();
    }
    this.prevPaused = st === 'paused';
    if (st === 'playing') this.engine.input.suppressGameplay = false;
  }

  /** Gamepad menu navigation. Only polled while a menu is up. */
  private tickGamepad(): void {
    const menu = this.activeMenu();
    if (!menu || typeof navigator.getGamepads !== 'function') {
      this.padPrev = 0;
      this.padAxisLatch = 0;
      return;
    }
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) if (pads[i]) pad = pads[i];
    if (!pad) return;

    const up = !!pad.buttons[12]?.pressed || (pad.axes[1] ?? 0) < -0.55;
    const down = !!pad.buttons[13]?.pressed || (pad.axes[1] ?? 0) > 0.55;
    const left = !!pad.buttons[14]?.pressed || (pad.axes[0] ?? 0) < -0.55;
    const right = !!pad.buttons[15]?.pressed || (pad.axes[0] ?? 0) > 0.55;
    const accept = !!pad.buttons[0]?.pressed;
    const back = !!pad.buttons[1]?.pressed;

    const mask =
      (up ? 1 : 0) | (down ? 2 : 0) | (left ? 4 : 0) | (right ? 8 : 0) | (accept ? 16 : 0) | (back ? 32 : 0);
    const edge = mask & ~this.padPrev;
    this.padPrev = mask;
    if (edge & 1) menu.nav(-1);
    if (edge & 2) menu.nav(1);
    if (edge & 4) menu.navX(-1);
    if (edge & 8) menu.navX(1);
    if (edge & 16) menu.activate();
    if (edge & 32) {
      if (this.settingsMenu.visible) this.settingsMenu.close();
      else if (this.loadout.visible) this.loadout.close();
      else if (this.pause.visible) this.resumeGame();
    }
  }

  private tickDebug(dt: number): void {
    const on = settings.user.showFps;
    toggle(this.debugPanel, 'is-on', on);
    if (!on) return;
    this.debugAccum += dt;
    if (this.debugAccum < 0.25) return;
    this.debugAccum = 0;
    const e = this.engine;
    const st = e.host.stats;
    this.debugText.textContent =
      `${e.fps.toFixed(0)} FPS   ${e.frameMs.toFixed(2)} ms\n` +
      `draw ${st.calls}   tris ${(st.triangles / 1000).toFixed(1)}k\n` +
      `prog ${st.programs}   geo ${st.geometries}\n` +
      `tier ${settings.user.tier}   res ${(settings.resolutionScale * 100).toFixed(0)}%`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unbind) off();
    this.unbind.length = 0;
    this.hud.dispose();
    this.crosshair.dispose();
    this.damageNumbers.dispose();
    this.toasts.dispose();
    this.loading.dispose();
    this.pause.dispose();
    this.settingsMenu.dispose();
    this.loadout.dispose();
    this.starmap.dispose();
    this.death.dispose();
    this.results.dispose();
    this.briefing.dispose();
    this.root.remove();
    this.styleTag.remove();
    delete (window as unknown as { GFUI?: unknown }).GFUI;
  }
}

// ---------------------------------------------------------------------------

const pulse = (t: number): number => 0.55 + 0.45 * Math.sin(t * 5.2);

/** Health pools are float-noisy; bucket them so the learned names stick. */
const bucket = (v: number): number => Math.round(v / 5) * 5;

function prettyName(id: string): string {
  return id
    .replace(/[-_]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function prettyLoot(kind: string): string {
  switch (kind) {
    case 'ammo':
      return 'AMMO';
    case 'heavyAmmo':
      return 'HEAVY AMMO';
    case 'orb':
      return 'ORB OF POWER';
    case 'engram':
      return 'ENGRAM';
    case 'health':
      return 'FIELD REPAIR';
    default:
      return prettyName(kind).toUpperCase();
  }
}

export type { GameState };
export const UI_ELEMENTS = ELEMENTS;
export { VITALS as UI_VITALS };
export { clamp01 as uiClamp01, damp as uiDamp };
