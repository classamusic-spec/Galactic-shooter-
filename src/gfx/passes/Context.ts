/**
 * The per-frame bundle every pass reads.
 *
 * Passing one context object instead of eight positional arguments keeps the
 * pass signatures stable as the chain grows, and — more importantly — guarantees
 * that SSAO, volumetrics, TAA and the composite are all looking at the *same*
 * matrices and the same quality profile in a given frame. Reading
 * `settings.profile` independently inside each pass is how you end up with SSAO
 * at one tier and volumetrics at another after a mid-frame tier switch.
 */
import type * as THREE from 'three';
import type { QualityProfile } from '@/types';
import type { UserSettings } from '@/core/Settings';
import type { FrameState, GBuffer } from './GBuffer';
import type { PassRunner } from './FullscreenPass';

export interface RenderContext {
  runner: PassRunner;
  renderer: THREE.WebGLRenderer;
  gbuffer: GBuffer;
  state: FrameState;
  profile: QualityProfile;
  user: UserSettings;
  /** Shared blue-noise tile. */
  noise: THREE.Texture;
  /** Wall-clock delta of the rendered frame, seconds. Clamped and non-zero. */
  frameDt: number;
  /** Seconds since boot, for animated grain and volumetric drift. */
  elapsed: number;
  /** Normalised direction *toward* the sun, world space. */
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  fogColor: THREE.Color;
  /** Full-resolution render size in device pixels. */
  width: number;
  height: number;
}
