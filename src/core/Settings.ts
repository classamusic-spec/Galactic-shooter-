/** Quality tiers, user preferences, and adaptive resolution policy. */
import type { QualityProfile, QualityTier } from '@/types';
import { events } from './EventBus';
import { clamp } from '@/util/math';

const PROFILES: Record<QualityTier, QualityProfile> = {
  low: {
    tier: 'low',
    maxPixelRatio: 1,
    shadowMapSize: 1024,
    shadowCascades: 1,
    ssaoEnabled: false,
    ssaoSamples: 0,
    bloomEnabled: true,
    motionBlurEnabled: false,
    ssrEnabled: false,
    volumetricLightEnabled: false,
    volumetricSteps: 0,
    taaEnabled: false,
    anisotropy: 2,
    textureSize: 256,
    particleBudget: 1500,
    enemyBudget: 14,
    terrainDetail: 0.5,
    foliageDensity: 0.25,
    decalBudget: 48,
  },
  medium: {
    tier: 'medium',
    maxPixelRatio: 1.25,
    shadowMapSize: 2048,
    shadowCascades: 2,
    ssaoEnabled: true,
    ssaoSamples: 8,
    bloomEnabled: true,
    motionBlurEnabled: false,
    ssrEnabled: false,
    volumetricLightEnabled: true,
    volumetricSteps: 12,
    taaEnabled: false,
    anisotropy: 4,
    textureSize: 512,
    particleBudget: 4000,
    enemyBudget: 22,
    terrainDetail: 0.75,
    foliageDensity: 0.55,
    decalBudget: 96,
  },
  high: {
    tier: 'high',
    maxPixelRatio: 1.5,
    shadowMapSize: 2048,
    shadowCascades: 3,
    ssaoEnabled: true,
    ssaoSamples: 16,
    bloomEnabled: true,
    motionBlurEnabled: true,
    ssrEnabled: false,
    volumetricLightEnabled: true,
    volumetricSteps: 24,
    taaEnabled: true,
    anisotropy: 8,
    textureSize: 1024,
    particleBudget: 9000,
    enemyBudget: 32,
    terrainDetail: 1,
    foliageDensity: 0.85,
    decalBudget: 160,
  },
  ultra: {
    tier: 'ultra',
    maxPixelRatio: 2,
    shadowMapSize: 4096,
    shadowCascades: 4,
    ssaoEnabled: true,
    ssaoSamples: 24,
    bloomEnabled: true,
    motionBlurEnabled: true,
    ssrEnabled: true,
    volumetricLightEnabled: true,
    volumetricSteps: 40,
    taaEnabled: true,
    anisotropy: 16,
    textureSize: 2048,
    particleBudget: 16000,
    enemyBudget: 44,
    terrainDetail: 1.35,
    foliageDensity: 1,
    decalBudget: 256,
  },
};

export interface UserSettings {
  tier: QualityTier;
  /** Horizontal FOV in degrees. */
  fov: number;
  /** Radians of yaw per pixel of mouse movement at 1.0 sensitivity. */
  sensitivity: number;
  /** Radians of view rotation per pixel of touch-look drag. */
  touchSensitivity: number;
  adsSensitivityScale: number;
  invertY: boolean;
  /** Degrees of turn per second at full right-stick deflection. */
  padSensitivity: number;
  /** Radial deadzone as a fraction of stick travel. */
  stickDeadzone: number;
  /**
   * Aim-assist strength, 0..1. Gamepad only — a mouse never sees it. 0 turns
   * both friction and adhesion off entirely.
   */
  aimAssist: number;
  /** Controller vibration strength, 0..1. 0 disables it. */
  vibration: number;
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  /** Reduce full-screen flashes and heavy shake. */
  reducedMotion: boolean;
  /** Show numeric damage popups. */
  damageNumbers: boolean;
  crosshairStyle: 'dynamic' | 'static' | 'dot';
  /** Adaptive resolution keeps frame time near this target, ms. */
  frameBudgetMs: number;
  adaptiveResolution: boolean;
  showFps: boolean;
  filmGrain: number;
  chromaticAberration: number;
  vignette: number;
  motionBlurStrength: number;
  bloomStrength: number;
  exposure: number;
}

const STORAGE_KEY = 'gf.settings.v1';

function detectTier(): QualityTier {
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent);
  if (mobile) return cores >= 6 ? 'medium' : 'low';
  if (cores >= 12 && mem >= 8) return 'ultra';
  if (cores >= 8) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

class SettingsStore {
  user: UserSettings;
  /** Live resolution scale driven by the adaptive-resolution controller. */
  resolutionScale = 1;

  constructor() {
    this.user = {
      tier: detectTier(),
      fov: 95,
      sensitivity: 0.0022,
      touchSensitivity: 0.0035,
      adsSensitivityScale: 0.65,
      invertY: false,
      padSensitivity: 170,
      // 0.08 rather than the more common 0.15: the deadzone is radial here, so it
      // does not have to be widened to hide the square-hole artefact, and a
      // DualSense's resting noise sits well under it.
      stickDeadzone: 0.08,
      aimAssist: 0.7,
      vibration: 0.8,
      masterVolume: 0.85,
      sfxVolume: 1,
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
    this.load();
  }

  get profile(): QualityProfile {
    return PROFILES[this.user.tier];
  }

  setTier(tier: QualityTier): void {
    if (this.user.tier === tier) return;
    this.user.tier = tier;
    this.resolutionScale = 1;
    this.save();
    events.emit('settings:changed');
  }

  patch(partial: Partial<UserSettings>): void {
    Object.assign(this.user, partial);
    this.save();
    events.emit('settings:changed');
  }

  /** Called by the frame loop with a smoothed frame time in ms. */
  tickAdaptiveResolution(frameMs: number): void {
    if (!this.user.adaptiveResolution) {
      this.resolutionScale = 1;
      return;
    }
    const budget = this.user.frameBudgetMs;
    if (frameMs > budget * 1.18) {
      this.resolutionScale = clamp(this.resolutionScale - 0.02, 0.6, 1);
    } else if (frameMs < budget * 0.82) {
      this.resolutionScale = clamp(this.resolutionScale + 0.006, 0.6, 1);
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) Object.assign(this.user, JSON.parse(raw) as Partial<UserSettings>);
    } catch {
      /* first run, or storage blocked */
    }
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.user));
    } catch {
      /* storage blocked; settings stay in-memory */
    }
  }
}

export const settings = new SettingsStore();
export { PROFILES };
