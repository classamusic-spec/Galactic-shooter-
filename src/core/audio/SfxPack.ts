/**
 * Recorded sound effects, layered over the synthesised bank.
 *
 * `public/sfx/<id>.mp3` replaces the baked buffer of the same id at boot; ids
 * with no file keep their synthesised version, and a failed fetch or decode
 * changes nothing. That is the whole contract — the procedural bank stays the
 * floor, so the game is never worse off for a missing or corrupt file.
 *
 * Three transforms are applied on the way in, and each one exists because a
 * generated file cannot be dropped straight into a game's sound bank:
 *
 * 1. **Leading silence is cut.** Generated effects routinely start with 50-200 ms
 *    of room tone. On a gunshot that is the difference between a weapon that
 *    fires when you click and one that fires a fifth of a second later; the
 *    bake's own diagnostic wants gun attacks under 5 ms.
 * 2. **Peak is matched to the buffer being replaced.** The synthesised bank was
 *    levelled per category — 0.72 for guns so overlapping shots leave the bus
 *    limiter headroom, 0.9 for a super cast, 0.4 for an idle creature murmur.
 *    Normalising to the old peak preserves every one of those relationships for
 *    free, and needs no table that could drift out of sync.
 * 3. **Downmix to mono.** Everything here is positional and goes through a
 *    PannerNode, where a stereo source only muddies the image, and mono halves
 *    the resident memory.
 */

/** Below this, a sample counts as silence for the purpose of trimming. */
const SILENCE = 0.004;
/** Keep this much of the run-up so a trimmed transient still has its rise. */
const PRE_ROLL_MS = 2;
/** Peak used when a recorded id has no synthesised counterpart to match. */
const DEFAULT_PEAK = 0.7;

/**
 * Ids that must fire the instant the player asks for them.
 *
 * Trimming silence is not enough for these. Asked for a gunshot, the model
 * routinely writes a *run-up* — a bow being drawn before the release, a rocket's
 * ignition swelling for a fifth of a second — which is not silence, so a silence
 * trim keeps all of it. Measured across the generated bank that left attacks as
 * long as 420 ms against a 5 ms budget, i.e. a weapon that fires a beat after the
 * trigger. For these ids the trim seeks the transient instead and throws the
 * run-up away.
 *
 * Everything else keeps its rise, because for a charge-up, a power-down or a
 * creature's breath the rise *is* the sound.
 */
const TRANSIENT_TRIM = [
  'gun_',
  'explosion_',
  'impact_',
  'melee_',
  'step_',
  'weapon_dryfire',
  'shield_break',
];

/** Fraction of peak that counts as "the transient has arrived". */
const TRANSIENT_LEVEL = 0.45;

/**
 * Peak below which a file is treated as a failed generation rather than a quiet
 * effect. Real effects come back near full scale; the failures come back two
 * orders of magnitude down.
 */
const MIN_USABLE_PEAK = 0.08;

export interface SfxManifest {
  ids: string[];
}

export interface SfxPackHost {
  readonly ctx: BaseAudioContext;
  /** Peak of the buffer currently registered under `id`, or null if there is none. */
  peakOf(id: string): number | null;
  /** Install a decoded replacement. */
  apply(id: string, buffer: AudioBuffer): void;
}

export class SfxPack {
  private host: SfxPackHost;
  private base: string;
  loaded = 0;
  failed = 0;
  /** Files that decoded but were unusable — see MIN_USABLE_PEAK. */
  rejected = 0;
  /** Ids that were actually installed, for the audit to measure. */
  readonly installed: string[] = [];

  constructor(host: SfxPackHost, base = 'sfx') {
    this.host = host;
    this.base = base;
  }

  /**
   * Fetch and install everything the manifest lists.
   *
   * Resolves once every file has landed *or* `deadlineMs` has passed, whichever
   * comes first — boot must not hang on a slow connection. Files that arrive
   * after the deadline still install themselves: the voice pool resolves buffers
   * at play time, so a late replacement simply takes effect from the next shot.
   */
  async load(deadlineMs = 12000): Promise<void> {
    let manifest: SfxManifest;
    try {
      const res = await fetch(`${this.base}/manifest.json`);
      if (!res.ok) throw new Error(`${res.status}`);
      manifest = (await res.json()) as SfxManifest;
    } catch {
      // No pack shipped. Entirely normal — the synthesised bank stands alone.
      return;
    }
    const ids = Array.isArray(manifest.ids) ? manifest.ids : [];
    if (!ids.length) return;

    const all = Promise.all(ids.map((id) => this.one(id)));
    await Promise.race([all, new Promise<void>((r) => setTimeout(r, deadlineMs))]);
  }

  private async one(id: string): Promise<void> {
    try {
      const res = await fetch(`${this.base}/${id}.mp3`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const decoded = await this.host.ctx.decodeAudioData(await res.arrayBuffer());
      const transient = TRANSIENT_TRIM.some((p) => id.startsWith(p));
      const shaped = this.shape(decoded, this.host.peakOf(id) ?? DEFAULT_PEAK, transient);
      if (shaped) {
        this.host.apply(id, shaped);
        this.installed.push(id);
        this.loaded++;
      } else {
        this.rejected++;
      }
    } catch (err) {
      this.failed++;
      console.warn(`[sfx] ${id} unavailable; keeping the synthesised version`, err);
    }
  }

  /**
   * Trim, downmix and re-level. Returns null for a file that is entirely silent.
   * `transient` seeks past a generated run-up — see TRANSIENT_TRIM.
   */
  private shape(src: AudioBuffer, targetPeak: number, transient: boolean): AudioBuffer | null {
    const n = src.length;
    const channels = src.numberOfChannels;
    const mono = new Float32Array(n);
    if (channels === 1) {
      mono.set(src.getChannelData(0));
    } else {
      for (let c = 0; c < channels; c++) {
        const d = src.getChannelData(c);
        for (let i = 0; i < n; i++) mono[i] += d[i];
      }
      for (let i = 0; i < n; i++) mono[i] /= channels;
    }

    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(mono[i]);
      if (a > peak) peak = a;
    }
    // A generated effect that never gets above a whisper is a failed generation,
    // not a quiet one — the model occasionally returns near-silence for a prompt
    // it cannot place. Levelling it to the target peak would multiply its noise
    // floor by twenty and ship a hiss where the gunshot should be, so it is
    // rejected and the synthesised version stands.
    if (peak < MIN_USABLE_PEAK) return null;

    // Trim against a floor relative to this file's own peak, not an absolute
    // one, so a quiet effect is not cropped into its own body.
    const floor = Math.max(SILENCE, peak * 0.01);
    let start = 0;
    while (start < n && Math.abs(mono[start]) < floor) start++;
    let end = n;
    while (end > start && Math.abs(mono[end - 1]) < floor) end--;

    if (transient) {
      // Seek the onset unconditionally. A first guess bounded the cut to a
      // fraction of the file, but a generated bow release is half a second of
      // true silence followed by one hit — exactly the case that needs the cut
      // most, and exactly the case a proportional bound rejects. Only ids that
      // are supposed to start instantly are in TRANSIENT_TRIM, so there is no
      // rise here worth protecting.
      let hit = start;
      while (hit < end && Math.abs(mono[hit]) < peak * TRANSIENT_LEVEL) hit++;
      if (hit < end) start = hit;
    }

    const pre = Math.round((PRE_ROLL_MS / 1000) * src.sampleRate);
    start = Math.max(0, start - pre);
    const length = Math.max(1, end - start);

    const out = this.host.ctx.createBuffer(1, length, src.sampleRate);
    const dst = out.getChannelData(0);
    const gain = targetPeak / peak;
    for (let i = 0; i < length; i++) dst[i] = mono[start + i] * gain;

    // A hard cut at either edge is a click. Both ramps are short enough to leave
    // a transient intact — 1.5 ms in is well inside a gunshot's rise.
    const fadeIn = Math.min(Math.round(src.sampleRate * 0.0015), length >> 1);
    for (let i = 0; i < fadeIn; i++) dst[i] *= i / fadeIn;
    const fadeOut = Math.min(Math.round(src.sampleRate * 0.008), length >> 1);
    for (let i = 0; i < fadeOut; i++) dst[length - 1 - i] *= i / fadeOut;

    return out;
  }
}
