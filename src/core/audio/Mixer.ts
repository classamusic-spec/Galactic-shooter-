/**
 * The mix bus.
 *
 * Four submixes (sfx / music / ambience / ui) feed a glue compressor and then a
 * brick-wall limiter before the destination. The limiter is what makes a
 * firefight survivable: a rocket, four rifles and a super can easily sum past
 * 0 dBFS, and without it the browser hard-clips into digital distortion.
 * A `DynamicsCompressorNode` with a 20:1 ratio, 1.5 ms attack and a −1.5 dBFS
 * threshold behaves as a competent limiter for game material.
 *
 * A single convolution reverb sits on an aux send. Its impulse responses are
 * synthesised (see `buildImpulseResponse`) — real rooms are just an early
 * reflection pattern over a frequency-dependent decay, and both are cheap to
 * generate.
 */
import { clamp, clamp01 } from '@/util/math';
import { type IrSpec, buildImpulseResponse } from './Dsp';

export type BusName = 'sfx' | 'music' | 'ambience' | 'ui';

export type ReverbPreset =
  | 'none'
  | 'small'
  | 'ship'
  | 'hall'
  | 'cave'
  | 'canyon'
  | 'outdoor'
  | 'ice'
  | 'jungle'
  | 'hive';

export const REVERB_PRESETS: Record<ReverbPreset, IrSpec> = {
  none: { decay: 0.05, preDelay: 0, damp: 8000, dampEnd: 4000, earlyCount: 0, earlyGain: 0, width: 0 },
  small: { decay: 0.42, preDelay: 0.004, damp: 6000, dampEnd: 1400, earlyCount: 9, earlyGain: 0.5, width: 0.5 },
  ship: { decay: 0.85, preDelay: 0.008, damp: 4200, dampEnd: 700, earlyCount: 14, earlyGain: 0.45, width: 0.55 },
  hall: { decay: 2.1, preDelay: 0.018, damp: 5200, dampEnd: 900, earlyCount: 18, earlyGain: 0.35, width: 0.8 },
  cave: { decay: 3.4, preDelay: 0.028, damp: 2600, dampEnd: 380, earlyCount: 12, earlyGain: 0.4, width: 0.9 },
  canyon: { decay: 2.6, preDelay: 0.052, damp: 3400, dampEnd: 520, earlyCount: 7, earlyGain: 0.6, width: 1 },
  outdoor: { decay: 1.15, preDelay: 0.03, damp: 3000, dampEnd: 600, earlyCount: 5, earlyGain: 0.28, width: 1 },
  ice: { decay: 2.9, preDelay: 0.024, damp: 7000, dampEnd: 1600, earlyCount: 10, earlyGain: 0.5, width: 0.95 },
  jungle: { decay: 0.9, preDelay: 0.012, damp: 2200, dampEnd: 400, earlyCount: 22, earlyGain: 0.2, width: 1 },
  hive: { decay: 2.2, preDelay: 0.02, damp: 1900, dampEnd: 320, earlyCount: 16, earlyGain: 0.42, width: 0.85 },
};

export class Mixer {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly glue: DynamicsCompressorNode;
  readonly buses: Record<BusName, GainNode>;
  /** Air-band roll-off on the ambience bed. See the constructor. */
  private ambienceTone: BiquadFilterNode;
  /** Aux send every spatial voice can tap. */
  readonly reverbSend: GainNode;
  private convolver: ConvolverNode;
  private reverbReturn: GainNode;
  private irCache = new Map<ReverbPreset, AudioBuffer>();
  private preset: ReverbPreset = 'outdoor';
  /** Per-bus analysers, attached lazily by `meter`. */
  private meters = new Map<BusName, AnalyserNode>();
  private meterBins: Float32Array<ArrayBuffer> | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(ctx.destination);

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.0015;
    this.limiter.release.value = 0.12;
    this.limiter.connect(this.master);

    this.glue = ctx.createDynamicsCompressor();
    this.glue.threshold.value = -16;
    this.glue.knee.value = 12;
    this.glue.ratio.value = 2.6;
    this.glue.attack.value = 0.012;
    this.glue.release.value = 0.24;
    this.glue.connect(this.limiter);

    const mk = (v: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(this.glue);
      return g;
    };
    // The ambience bed gets a roll-off of its own before it reaches the glue.
    //
    // Measured on Draco IX with nothing else playing: the bed ran 6.4 dB hotter
    // than the music (-54.5 against -60.9 dBFS) and owned the entire top of the
    // spectrum on its own -- 24 dB above the music at 4 kHz, where the score has
    // essentially nothing. Broadband noise with no musical content under it is
    // what the ear files as hiss, and the wind layer is literally a noise buffer
    // through a band-pass whose Q sits below 1, which is barely a filter. This
    // takes the air band off it so the bed reads as pressure rather than noise;
    // the level cut below does the rest.
    this.ambienceTone = ctx.createBiquadFilter();
    this.ambienceTone.type = 'lowpass';
    this.ambienceTone.frequency.value = 2400;
    this.ambienceTone.Q.value = 0.5;
    this.ambienceTone.connect(this.glue);

    const mkAmbience = (v: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(this.ambienceTone);
      return g;
    };

    this.buses = {
      sfx: mk(1),
      music: mk(0.55),
      ambience: mkAmbience(0.22),
      // UI bypasses the glue compressor's pumping so a hitmarker is never
      // ducked by the gunshot that caused it.
      ui: (() => {
        const g = ctx.createGain();
        g.gain.value = 0.9;
        g.connect(this.limiter);
        return g;
      })(),
    };

    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.4;
    this.convolver.connect(this.reverbReturn).connect(this.glue);

    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(this.convolver);

    this.setReverb('outdoor', 0.4);
  }

  ir(preset: ReverbPreset): AudioBuffer {
    let buf = this.irCache.get(preset);
    if (!buf) {
      buf = buildImpulseResponse(this.ctx, REVERB_PRESETS[preset], 0x1000 + preset.length * 7919);
      this.irCache.set(preset, buf);
    }
    return buf;
  }

  setReverb(preset: ReverbPreset, wet: number): void {
    const p = REVERB_PRESETS[preset] ? preset : 'outdoor';
    if (p !== this.preset) {
      this.preset = p;
      this.convolver.buffer = this.ir(p);
    } else if (!this.convolver.buffer) {
      this.convolver.buffer = this.ir(p);
    }
    this.reverbReturn.gain.setTargetAtTime(clamp01(wet), this.ctx.currentTime, 0.25);
  }

  get reverbPreset(): ReverbPreset {
    return this.preset;
  }

  /**
   * Ambience is its own control now. It used to ride the effects slider while
   * the settings menu described it under "Music Volume — score and ambience
   * beds", so the one slider a player would reach for to quiet the wash was the
   * one slider that did nothing to it. Whatever the level, the bed belongs
   * under the score rather than over it, so the ceiling here is 0.3 against the
   * old 0.7.
   */
  setVolumes(master: number, sfx: number, music: number, ambience: number): void {
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(clamp(master, 0, 1.5), t, 0.05);
    this.buses.sfx.gain.setTargetAtTime(clamp(sfx, 0, 1.5), t, 0.05);
    this.buses.ui.gain.setTargetAtTime(clamp(sfx, 0, 1.5) * 0.9, t, 0.05);
    this.buses.ambience.gain.setTargetAtTime(clamp(ambience, 0, 1) * 0.3, t, 0.05);
    this.buses.music.gain.setTargetAtTime(clamp(music, 0, 1.5) * 0.9, t, 0.05);
  }

  /**
   * Spectrum of one bus, in dBFS per octave band.
   *
   * Mixing by ear is not available here, so this is how a claim about the mix
   * gets checked. A bed that reads as "white noise" and one that reads as
   * "wind" differ in exactly this measurement -- noise is flat across the
   * bands, air rolls off above its centre -- and the difference is invisible in
   * the source, where both are a noise buffer through a filter.
   */
  meter(bus: BusName): { rms: number; bands: number[]; flatness: number } {
    let an = this.meters.get(bus);
    if (!an) {
      an = this.ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.6;
      this.buses[bus].connect(an);
      this.meters.set(bus, an);
      this.meterBins = new Float32Array(new ArrayBuffer(an.frequencyBinCount * 4));
    }
    const bins =
      this.meterBins ?? new Float32Array(new ArrayBuffer(an.frequencyBinCount * 4));
    this.meterBins = bins;
    an.getFloatFrequencyData(bins);
    const nyquist = this.ctx.sampleRate / 2;
    const edges = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    const bands: number[] = [];
    let sumLin = 0;
    let sumLog = 0;
    let counted = 0;
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = Math.floor((edges[i] / nyquist) * bins.length);
      const hi = Math.min(bins.length, Math.ceil((edges[i + 1] / nyquist) * bins.length));
      let acc = 0;
      let n = 0;
      for (let k = lo; k < hi; k++) {
        const db = bins[k];
        if (!Number.isFinite(db)) continue;
        acc += Math.pow(10, db / 20);
        n++;
      }
      const lin = n > 0 ? acc / n : 0;
      bands.push(Math.round(20 * Math.log10(Math.max(1e-7, lin)) * 10) / 10);
      if (lin > 1e-7) {
        sumLin += lin;
        sumLog += Math.log(lin);
        counted++;
      }
    }
    // Spectral flatness: geometric over arithmetic mean across the bands. 1 is
    // white noise, near 0 is a tone or a band-limited texture.
    const flatness =
      counted > 0 ? Math.exp(sumLog / counted) / (sumLin / counted) : 0;
    let energy = 0;
    for (const b of bands) energy += Math.pow(10, b / 20);
    return {
      rms: Math.round(20 * Math.log10(Math.max(1e-7, energy / bands.length)) * 10) / 10,
      bands,
      flatness: Math.round(flatness * 1000) / 1000,
    };
  }

  /** Live gain reduction on the limiter, dB (negative). Useful for diagnostics. */
  get reduction(): number {
    return this.limiter.reduction;
  }

  dispose(): void {
    this.master.disconnect();
    this.limiter.disconnect();
    this.glue.disconnect();
    this.convolver.disconnect();
    this.reverbReturn.disconnect();
    this.reverbSend.disconnect();
    this.ambienceTone.disconnect();
    for (const b of Object.values(this.buses)) b.disconnect();
    this.irCache.clear();
  }
}
