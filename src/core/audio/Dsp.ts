/**
 * Audio DSP primitives and the offline bake harness.
 *
 * Every sound in Galactic Federation is synthesised — there is not one audio
 * file in the build. The pattern is the same one a game-audio pipeline uses,
 * only the "recording session" happens in the browser at boot: build a node
 * graph, render it through an `OfflineAudioContext` far faster than real time,
 * and keep the result as an `AudioBuffer` that costs a single source node to
 * fire.
 *
 * The one non-obvious trick here is {@link bakeBatch}: jobs are packed several
 * to a timeline and sliced apart afterwards, which amortises per-context setup
 * — but the chunk length is capped, because Chrome keeps every scheduled source
 * node resident for the entire render, so one long timeline costs
 * O(nodes x totalDuration) and goes quadratic. Measured here: 60 s of jobs in
 * one context took over eight minutes; the same jobs in 3-second chunks take
 * about two seconds.
 */
import { Rng, clamp } from '@/util/math';

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

export type NoiseKind = 'white' | 'pink' | 'brown';

/** Fill a Float32Array with noise of the requested spectrum, peak-normalised. */
export function fillNoise(out: Float32Array, rng: Rng, kind: NoiseKind = 'white'): Float32Array {
  const n = out.length;
  if (kind === 'white') {
    for (let i = 0; i < n; i++) out[i] = rng.range(-1, 1);
    return out;
  }
  if (kind === 'brown') {
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + rng.range(-1, 1) * 0.08) * 0.997;
      out[i] = last;
    }
    return normalizeArray(out, 1);
  }
  // Paul Kellet's economical pink filter — flat enough for game use.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.range(-1, 1);
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return normalizeArray(out, 1);
}

export function normalizeArray(a: Float32Array, target = 1): Float32Array {
  let peak = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i]);
    if (v > peak) peak = v;
  }
  if (peak < 1e-9) return a;
  const g = target / peak;
  for (let i = 0; i < a.length; i++) a[i] *= g;
  return a;
}

/**
 * A per-context noise pool. Generating fresh noise for every one of ~250 bake
 * jobs is by far the most expensive part of the bake; three shared beds that
 * every job reads at a random offset is indistinguishable and ~40x cheaper.
 */
export class NoiseBank {
  private beds = new Map<NoiseKind, AudioBuffer>();
  private rng: Rng;

  constructor(private ctx: BaseAudioContext, seed = 0x51f3a2) {
    this.rng = new Rng(seed);
  }

  bed(kind: NoiseKind): AudioBuffer {
    let b = this.beds.get(kind);
    if (!b) {
      const seconds = 1.5;
      b = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * seconds), this.ctx.sampleRate);
      fillNoise(b.getChannelData(0), this.rng, kind);
      this.beds.set(kind, b);
    }
    return b;
  }

  /** A source node reading the shared bed from a random offset. */
  source(kind: NoiseKind = 'white', rate = 1): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.bed(kind);
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = src.buffer.duration;
    src.playbackRate.value = rate;
    return src;
  }

  get random(): Rng {
    return this.rng;
  }
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

export function gainNode(ctx: BaseAudioContext, value = 1): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

export function filter(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 0.707,
  gainDb = 0,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = clamp(freq, 10, ctx.sampleRate * 0.48);
  f.Q.value = clamp(q, 0.0001, 200);
  f.gain.value = gainDb;
  return f;
}

/**
 * A percussive envelope: near-instant attack, exponential-ish decay.
 * `attack` under ~0.3 ms is what makes a gunshot read as a gunshot; anything
 * slower and it turns into a "whoomp".
 */
export function percussiveGain(
  ctx: BaseAudioContext,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
  hold = 0,
): GainNode {
  const g = ctx.createGain();
  const p = Math.max(1e-4, peak);
  g.gain.setValueAtTime(1e-4, t0);
  g.gain.exponentialRampToValueAtTime(p, t0 + Math.max(0.00015, attack));
  if (hold > 0) g.gain.setValueAtTime(p, t0 + attack + hold);
  g.gain.exponentialRampToValueAtTime(1e-4, t0 + attack + hold + Math.max(0.004, decay));
  g.gain.setValueAtTime(0, t0 + attack + hold + Math.max(0.004, decay) + 0.001);
  return g;
}

/** A four-stage ADSR for sustained material (creature voices, music notes). */
export function adsrGain(
  ctx: BaseAudioContext,
  t0: number,
  peak: number,
  a: number,
  d: number,
  s: number,
  sustainTime: number,
  r: number,
): GainNode {
  const g = ctx.createGain();
  const p = Math.max(1e-4, peak);
  const sl = Math.max(1e-4, peak * s);
  g.gain.setValueAtTime(1e-4, t0);
  g.gain.exponentialRampToValueAtTime(p, t0 + Math.max(0.0005, a));
  g.gain.exponentialRampToValueAtTime(sl, t0 + a + Math.max(0.002, d));
  g.gain.setValueAtTime(sl, t0 + a + d + Math.max(0, sustainTime));
  g.gain.exponentialRampToValueAtTime(1e-4, t0 + a + d + sustainTime + Math.max(0.005, r));
  g.gain.setValueAtTime(0, t0 + a + d + sustainTime + r + 0.002);
  return g;
}

export function osc(
  ctx: BaseAudioContext,
  type: OscillatorType,
  freq: number,
): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = clamp(freq, 0.01, ctx.sampleRate * 0.45);
  return o;
}

/** Soft-clip curve for a WaveShaper — adds harmonics without buzz. */
export function saturator(ctx: BaseAudioContext, drive = 2): WaveShaperNode {
  const ws = ctx.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  ws.curve = curve;
  ws.oversample = '2x';
  return ws;
}

// ---------------------------------------------------------------------------
// Composite voices
// ---------------------------------------------------------------------------

export interface Mode {
  /** Hz. */
  f: number;
  /** Linear amplitude. */
  a: number;
  /** −60 dB time, seconds. */
  decay: number;
  /** Optional initial pitch drop (multiplier applied at t0, glides to 1). */
  bend?: number;
}

/**
 * Modal synthesis: a struck object is a bank of exponentially decaying
 * sinusoids at inharmonic frequency ratios. This is what separates "hit a rock"
 * from "hit a girder" far more than any noise layer does.
 */
export function modalBank(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  modes: readonly Mode[],
  level = 1,
): void {
  for (const m of modes) {
    const o = osc(ctx, 'sine', m.f);
    const g = ctx.createGain();
    const amp = Math.max(1e-4, m.a * level);
    g.gain.setValueAtTime(amp, t0);
    g.gain.exponentialRampToValueAtTime(amp * 1e-3, t0 + m.decay);
    g.gain.setValueAtTime(0, t0 + m.decay + 0.002);
    if (m.bend && m.bend !== 1) {
      o.frequency.setValueAtTime(m.f * m.bend, t0);
      o.frequency.exponentialRampToValueAtTime(m.f, t0 + Math.min(0.08, m.decay * 0.5));
    }
    o.connect(g).connect(dest);
    o.start(t0);
    o.stop(t0 + m.decay + 0.02);
  }
}

/**
 * A formant voice: a buzzy glottal source shaped by three resonant peaks. The
 * formant triple is what makes one creature read as a big reptile and another
 * as a chittering insect, using exactly the same source material.
 */
export interface FormantVoice {
  /** Fundamental at t0 and at the end of the phrase. */
  f0: number;
  f0End: number;
  /** Formant centre frequencies, Hz. */
  formants: readonly [number, number, number];
  /** Formant Q values. */
  qs: readonly [number, number, number];
  /** 0 = pure buzz, 1 = pure noise (hiss/rasp). */
  breath: number;
  /** Vibrato / growl depth as a fraction of f0. */
  growl: number;
  growlHz: number;
  duration: number;
  attack: number;
  release: number;
  level: number;
  /** Waveform of the glottal source. */
  wave: OscillatorType;
}

export function formantVoice(
  ctx: BaseAudioContext,
  bank: NoiseBank,
  dest: AudioNode,
  t0: number,
  v: FormantVoice,
): void {
  const sum = ctx.createGain();
  sum.gain.value = 1;

  const body = adsrGain(
    ctx,
    t0,
    v.level,
    v.attack,
    v.duration * 0.18,
    0.72,
    Math.max(0, v.duration - v.attack - v.duration * 0.18 - v.release),
    v.release,
  );

  // Source: buzz + breath, mixed.
  const buzzAmt = 1 - v.breath;
  if (buzzAmt > 0.01) {
    const o = osc(ctx, v.wave, v.f0);
    o.frequency.setValueAtTime(v.f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, v.f0End), t0 + v.duration);
    if (v.growl > 0) {
      const lfo = osc(ctx, 'sine', v.growlHz);
      const lg = gainNode(ctx, v.f0 * v.growl);
      lfo.connect(lg).connect(o.frequency);
      lfo.start(t0);
      lfo.stop(t0 + v.duration + 0.05);
    }
    const bg = gainNode(ctx, buzzAmt);
    o.connect(bg).connect(sum);
    o.start(t0);
    o.stop(t0 + v.duration + 0.05);
  }
  if (v.breath > 0.01) {
    const nz = bank.source('white');
    const ng = gainNode(ctx, v.breath * 0.8);
    nz.connect(ng).connect(sum);
    nz.start(t0, bank.random.range(0, 2));
    nz.stop(t0 + v.duration + 0.05);
  }

  // Three parallel formant resonators plus a gentle tilt.
  const tilt = filter(ctx, 'lowpass', 5200, 0.6);
  const amps = [1, 0.62, 0.34];
  for (let i = 0; i < 3; i++) {
    const bp = filter(ctx, 'bandpass', v.formants[i], v.qs[i]);
    const g = gainNode(ctx, amps[i]);
    sum.connect(bp).connect(g).connect(tilt);
  }
  // A little dry source keeps consonants from vanishing.
  const dry = gainNode(ctx, 0.12);
  sum.connect(dry).connect(tilt);

  tilt.connect(body).connect(dest);
}

// ---------------------------------------------------------------------------
// Impulse responses
// ---------------------------------------------------------------------------

export interface IrSpec {
  /** RT60 in seconds. */
  decay: number;
  /** Pre-delay before the diffuse tail, seconds. */
  preDelay: number;
  /** Lowpass cutoff at t=0, falling to `dampEnd` by the tail's end. */
  damp: number;
  dampEnd: number;
  /** Number of discrete early reflections. */
  earlyCount: number;
  earlyGain: number;
  /** Stereo decorrelation, 0..1. */
  width: number;
}

/**
 * A procedural impulse response: sparse early reflections over an
 * exponentially decaying, progressively darkened noise tail. Rendering it as
 * raw samples rather than through a node graph keeps the frequency-dependent
 * decay honest — real rooms lose highs much faster than lows.
 */
export function buildImpulseResponse(
  ctx: BaseAudioContext,
  spec: IrSpec,
  seed = 0x2ab1,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(64, Math.ceil((spec.decay + spec.preDelay) * sr));
  const buf = ctx.createBuffer(2, len, sr);
  const rng = new Rng(seed);
  const pre = Math.floor(spec.preDelay * sr);

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    // One-pole lowpass whose cutoff sweeps down across the tail.
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp((-6.9078 * t) / spec.decay);
      const cutoff = spec.damp + (spec.dampEnd - spec.damp) * (t / spec.decay);
      const a = 1 - Math.exp((-2 * Math.PI * Math.max(120, cutoff)) / sr);
      const x = rng.range(-1, 1) * env;
      lp += a * (x - lp);
      d[i] = lp;
    }
    // Early reflections: discrete, decorrelated per channel.
    for (let e = 0; e < spec.earlyCount; e++) {
      const t = spec.preDelay + Math.pow(rng.next(), 1.6) * Math.min(0.14, spec.decay * 0.4);
      const idx = Math.floor(t * sr) + (c === 1 ? Math.floor(rng.range(0, 40) * spec.width) : 0);
      if (idx >= 0 && idx < len) {
        d[idx] +=
          (rng.bool() ? 1 : -1) * spec.earlyGain * Math.exp((-6.9078 * t) / (spec.decay * 0.6));
      }
    }
    normalizeArray(d, 0.7);
  }
  // Channel decorrelation: blend the two channels back toward mono by (1-width).
  if (spec.width < 1) {
    const l = buf.getChannelData(0);
    const r = buf.getChannelData(1);
    const k = 1 - spec.width;
    for (let i = 0; i < len; i++) {
      const m = (l[i] + r[i]) * 0.5;
      l[i] = l[i] * (1 - k) + m * k;
      r[i] = r[i] * (1 - k) + m * k;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Bake harness
// ---------------------------------------------------------------------------

export interface BakeJob {
  id: string;
  /** Seconds of timeline this job occupies. Anything past it is cut off. */
  duration: number;
  build: (ctx: OfflineAudioContext, dest: AudioNode, t0: number, bank: NoiseBank) => void;
  /** Post-process: peak-normalise to this value (0 disables). */
  normalize?: number;
  /** Fade the last N seconds to zero, so a slice never ends on a step. */
  tailFade?: number;
}

/** Silence between jobs so one job's tail cannot bleed into the next slice. */
const JOB_GAP = 0.14;

/**
 * Render jobs offline and slice them apart.
 *
 * Jobs are packed onto a shared timeline in chunks rather than one job per
 * context, because per-context setup is not free. The chunk length is capped
 * hard, though: Chrome keeps every scheduled source node resident for the whole
 * render regardless of when it plays, so a single long timeline costs
 * O(nodes x totalDuration) — quadratic in the number of jobs. Measured here,
 * one 60-second timeline of ~2500 nodes took over eight minutes, while the same
 * work in 3-second chunks takes a couple of seconds.
 */
export async function bakeBatch(
  sampleRate: number,
  channels: number,
  jobs: readonly BakeJob[],
  seed = 0x9e3d,
  maxChunkSeconds = 3,
): Promise<Map<string, AudioBuffer>> {
  const out = new Map<string, AudioBuffer>();
  if (jobs.length === 0) return out;

  let start = 0;
  let chunkSeed = seed;
  while (start < jobs.length) {
    let end = start;
    let span = 0;
    // Always take at least one job, even if it alone exceeds the cap.
    do {
      span += jobs[end].duration + JOB_GAP;
      end++;
    } while (end < jobs.length && span + jobs[end].duration + JOB_GAP <= maxChunkSeconds);
    await renderChunk(sampleRate, channels, jobs.slice(start, end), chunkSeed, out);
    chunkSeed = (chunkSeed * 1664525 + 1013904223) >>> 0;
    start = end;
  }
  return out;
}

async function renderChunk(
  sampleRate: number,
  channels: number,
  jobs: readonly BakeJob[],
  seed: number,
  out: Map<string, AudioBuffer>,
): Promise<void> {
  let total = 0;
  const offsets: number[] = [];
  for (const j of jobs) {
    offsets.push(total);
    total += j.duration + JOB_GAP;
  }

  const ctx = new OfflineAudioContext({
    numberOfChannels: channels,
    length: Math.ceil((total + 0.1) * sampleRate),
    sampleRate,
  });
  const bank = new NoiseBank(ctx, seed);
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  for (let i = 0; i < jobs.length; i++) jobs[i].build(ctx, master, offsets[i], bank);

  const rendered = await ctx.startRendering();

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const startSample = Math.floor(offsets[i] * sampleRate);
    const len = Math.max(1, Math.floor(j.duration * sampleRate));
    const slice = new AudioBuffer({ numberOfChannels: channels, length: len, sampleRate });
    for (let c = 0; c < channels; c++) {
      const src = rendered.getChannelData(c);
      const dst = slice.getChannelData(c);
      for (let k = 0; k < len; k++) dst[k] = src[startSample + k] ?? 0;
    }
    if (j.tailFade && j.tailFade > 0) fadeTail(slice, j.tailFade);
    // A very short head fade guards against a previous job's ring bleeding in.
    // It must stay well under the transient it protects: at 0.4 ms it was
    // measurably eating the first four samples of every gunshot spike and
    // pushing the measured attack time past 5 ms.
    fadeHead(slice, 0.00008);
    if (j.normalize && j.normalize > 0) normalizeBuffer(slice, j.normalize);
    out.set(j.id, slice);
  }
}

export function normalizeBuffer(buf: AudioBuffer, target = 0.9): AudioBuffer {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
  }
  if (peak < 1e-9) return buf;
  const g = target / peak;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return buf;
}

export function fadeTail(buf: AudioBuffer, seconds: number): void {
  const n = Math.min(buf.length, Math.floor(seconds * buf.sampleRate));
  if (n <= 1) return;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[buf.length - n + i] *= 1 - t * t;
    }
  }
}

export function fadeHead(buf: AudioBuffer, seconds: number): void {
  const n = Math.min(buf.length, Math.floor(seconds * buf.sampleRate));
  if (n <= 1) return;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] *= i / n;
  }
}

/**
 * Turn a buffer rendered `extra` seconds too long into one that loops without a
 * click, by equal-power crossfading the overhang back over the head. The result
 * is sample-continuous at the loop point *and* continuous in slope, which the
 * naive "just fade both ends" approach is not.
 */
export function makeSeamless(buf: AudioBuffer, extra: number): AudioBuffer {
  const sr = buf.sampleRate;
  const x = Math.min(Math.floor(extra * sr), Math.floor(buf.length / 2) - 1);
  if (x <= 1) return buf;
  const len = buf.length - x;
  const out = new AudioBuffer({
    numberOfChannels: buf.numberOfChannels,
    length: len,
    sampleRate: sr,
  });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c);
    const d = out.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = s[i];
    for (let i = 0; i < x; i++) {
      const t = i / x;
      // Equal-power: keeps perceived level flat through the overlap.
      const a = Math.cos(t * Math.PI * 0.5);
      const b = Math.sin(t * Math.PI * 0.5);
      d[i] = s[i] * b + s[len + i] * a;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Measurement — used by the self-test, and worth keeping in the build
// ---------------------------------------------------------------------------

export interface BufferMetrics {
  peak: number;
  rms: number;
  /** Milliseconds from the first non-silent sample to 90 % of peak. */
  attackMs: number;
  /** Absolute sample step across the loop point. */
  loopStep: number;
  /**
   * Mean absolute step between adjacent samples. A loop is seamless when
   * `loopStep` is of the same order as this — a *zero* step would actually be
   * the anomaly for a broadband signal. `loopStep / meanStep` is the number to
   * read: under ~3 is inaudible, over ~20 is a click.
   */
  meanStep: number;
  /** Change in slope across the loop point — a click you hear but a step test
   *  can miss. */
  loopSlope: number;
  dc: number;
  seconds: number;
}

export function measure(buf: AudioBuffer): BufferMetrics {
  const d = buf.getChannelData(0);
  const n = d.length;
  let peak = 0;
  let sum = 0;
  let dc = 0;
  for (let i = 0; i < n; i++) {
    const v = d[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
    dc += v;
  }
  const rms = Math.sqrt(sum / Math.max(1, n));

  let firstIdx = -1;
  const floor = Math.max(1e-4, peak * 0.02);
  for (let i = 0; i < n; i++) {
    if (Math.abs(d[i]) > floor) {
      firstIdx = i;
      break;
    }
  }
  let attackIdx = firstIdx;
  const target = peak * 0.9;
  for (let i = Math.max(0, firstIdx); i < n; i++) {
    if (Math.abs(d[i]) >= target) {
      attackIdx = i;
      break;
    }
  }
  const attackMs =
    firstIdx < 0 ? 0 : ((attackIdx - firstIdx) / buf.sampleRate) * 1000;

  let stepSum = 0;
  for (let i = 1; i < n; i++) stepSum += Math.abs(d[i] - d[i - 1]);
  const meanStep = stepSum / Math.max(1, n - 1);

  const loopStep = n > 2 ? Math.abs(d[n - 1] - d[0]) : 0;
  const slopeIn = n > 2 ? d[n - 1] - d[n - 2] : 0;
  const slopeOut = n > 2 ? d[1] - d[0] : 0;

  return {
    peak,
    rms,
    attackMs,
    loopStep,
    meanStep,
    loopSlope: Math.abs(slopeIn - slopeOut),
    dc: dc / Math.max(1, n),
    seconds: buf.duration,
  };
}

/** Musical helper: semitones → playback-rate multiplier. */
export const semis = (n: number): number => Math.pow(2, n / 12);
