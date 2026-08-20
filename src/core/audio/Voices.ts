/**
 * Voice allocation and spatialisation.
 *
 * Each playing sound is a `Voice`: a fresh `AudioBufferSourceNode` (they are
 * single-use by spec) feeding a pooled chain of occlusion filter → panner →
 * gain, with a parallel tap into the reverb send. The chain is pooled because
 * `PannerNode` construction with HRTF is not free and a firefight can start
 * forty voices a second.
 *
 * Three policies keep the mix intelligible:
 *
 *  - **Per-id voice limiting.** A machine gun firing at 900 rpm into a 1.2 s
 *    tail would otherwise stack 18 copies of itself and sum to +25 dB. Each id
 *    has a cap; over it, the oldest instance is stolen.
 *  - **HRTF budget.** HRTF convolution is the expensive part of a panner, so
 *    only the nearest N voices get it; the rest fall back to equal-power
 *    panning, which is inaudible at distance.
 *  - **Occlusion as a lowpass**, not a volume cut. Sound behind a rock loses its
 *    highs first; cutting level alone reads as "quieter", not as "behind".
 */
import * as THREE from 'three';
import { clamp, clamp01 } from '@/util/math';
import type { AudioHandle } from '@/types';

/** Speed of sound used for the doppler shift, m/s. */
const SOUND_SPEED = 343;

export interface VoiceRequest {
  id: string;
  buffer: AudioBuffer;
  bus: AudioNode;
  volume: number;
  pitch: number;
  loop: boolean;
  /** Null for a non-positional (2D) sound. */
  position: THREE.Vector3 | null;
  velocity: THREE.Vector3 | null;
  maxDistance: number;
  refDistance: number;
  /** 0..1 aux send into the convolution reverb. */
  reverb: number;
  /** Maximum simultaneous voices for this id. */
  limit: number;
  /** Priority for stealing; higher survives. */
  priority: number;
}

const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

interface Chain {
  lp: BiquadFilterNode;
  panner: PannerNode;
  gain: GainNode;
  send: GainNode;
  /** 2D path: bypasses the panner entirely. */
  stereo: StereoPannerNode;
}

export class Voice implements AudioHandle {
  id = '';
  source: AudioBufferSourceNode | null = null;
  chain: Chain | null = null;
  startedAt = 0;
  priority = 0;
  positional = false;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  baseRate = 1;
  baseVolume = 1;
  maxDistance = 90;
  occlusion = 0;
  active = false;
  loop = false;
  /** Set by the pool when the voice is released, so double-stop is harmless. */
  private pool: VoicePool | null = null;

  get playing(): boolean {
    return this.active;
  }

  bind(pool: VoicePool): void {
    this.pool = pool;
  }

  setVolume(v: number, fade = 0.05): void {
    if (!this.active || !this.chain) return;
    this.baseVolume = Math.max(0, v);
    const ctx = this.chain.gain.context;
    const t = ctx.currentTime;
    this.chain.gain.gain.cancelScheduledValues(t);
    if (fade <= 0) this.chain.gain.gain.setValueAtTime(this.baseVolume, t);
    else this.chain.gain.gain.setTargetAtTime(this.baseVolume, t, Math.max(0.005, fade / 3));
  }

  stop(fade = 0.02): void {
    if (!this.active) return;
    this.pool?.release(this, fade);
  }

  /** Move a looping positional voice (engine loops, burning enemies). */
  setPosition(p: THREE.Vector3, velocity?: THREE.Vector3): void {
    this.position.copy(p);
    if (velocity) this.velocity.copy(velocity);
  }
}

export interface ListenerState {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
}

export class VoicePool {
  private ctx: AudioContext;
  private free: Chain[] = [];
  private voices: Voice[] = [];
  private spare: Voice[] = [];
  private byId = new Map<string, Voice[]>();
  private reverbSend: AudioNode;
  /** Voices allowed to use HRTF at once. */
  hrtfBudget = 20;
  /** Called with a world position; returns 0 (clear) .. 1 (fully occluded). */
  occlusionProbe: ((position: THREE.Vector3) => number) | null = null;

  readonly listener: ListenerState = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
  };

  constructor(ctx: AudioContext, reverbSend: AudioNode, capacity = 48) {
    this.ctx = ctx;
    this.reverbSend = reverbSend;
    for (let i = 0; i < capacity; i++) this.spare.push(new Voice());
  }

  get activeCount(): number {
    return this.voices.length;
  }

  /** What is sounding right now, for diagnostics. */
  snapshot(): { id: string; gain: number; loop: boolean }[] {
    return this.voices.map((v) => ({
      id: v.id,
      gain: Math.round((v.chain?.gain.gain.value ?? 0) * 1000) / 1000,
      loop: v.loop,
    }));
  }

  private acquireChain(): Chain {
    const c = this.free.pop();
    if (c) return c;
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 22000;
    lp.Q.value = 0.6;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 3;
    panner.rolloffFactor = 1.1;
    panner.maxDistance = 120;
    panner.coneInnerAngle = 360;
    const stereo = ctx.createStereoPanner();
    const gain = ctx.createGain();
    const send = ctx.createGain();
    send.gain.value = 0;
    send.connect(this.reverbSend);
    gain.connect(send);
    return { lp, panner, gain, send, stereo };
  }

  play(req: VoiceRequest): Voice | null {
    // -- per-id limiting ---------------------------------------------------
    let list = this.byId.get(req.id);
    if (!list) this.byId.set(req.id, (list = []));
    if (list.length >= req.limit) {
      // Steal the oldest at or below this priority.
      let victim: Voice | null = null;
      for (const v of list) {
        if (v.priority > req.priority) continue;
        if (!victim || v.startedAt < victim.startedAt) victim = v;
      }
      if (!victim) return null;
      this.release(victim, 0.012);
    }

    const voice = this.spare.pop() ?? (this.voices.length < 64 ? new Voice() : null);
    if (!voice) return null;

    const ctx = this.ctx;
    const chain = this.acquireChain();
    const src = ctx.createBufferSource();
    src.buffer = req.buffer;
    src.loop = req.loop;
    if (req.loop) {
      src.loopStart = 0;
      src.loopEnd = req.buffer.duration;
    }
    src.playbackRate.value = clamp(req.pitch, 0.06, 8);

    voice.bind(this);
    voice.id = req.id;
    voice.source = src;
    voice.chain = chain;
    voice.startedAt = ctx.currentTime;
    voice.priority = req.priority;
    voice.baseRate = src.playbackRate.value;
    voice.baseVolume = req.volume;
    voice.maxDistance = req.maxDistance;
    voice.loop = req.loop;
    voice.active = true;
    voice.occlusion = 0;
    voice.positional = req.position != null;
    if (req.position) voice.position.copy(req.position);
    if (req.velocity) voice.velocity.copy(req.velocity);
    else voice.velocity.set(0, 0, 0);

    chain.gain.gain.cancelScheduledValues(ctx.currentTime);
    chain.gain.gain.setValueAtTime(req.volume, ctx.currentTime);
    chain.send.gain.setValueAtTime(req.reverb, ctx.currentTime);
    chain.lp.frequency.cancelScheduledValues(ctx.currentTime);
    chain.lp.frequency.setValueAtTime(22000, ctx.currentTime);

    if (voice.positional) {
      chain.panner.maxDistance = req.maxDistance;
      chain.panner.refDistance = req.refDistance;
      chain.panner.panningModel =
        this.voices.length < this.hrtfBudget ? 'HRTF' : 'equalpower';
      this.writePanner(chain.panner, voice.position);
      src.connect(chain.lp);
      chain.lp.connect(chain.panner);
      chain.panner.connect(chain.gain);
    } else {
      chain.stereo.pan.value = 0;
      src.connect(chain.lp);
      chain.lp.connect(chain.stereo);
      chain.stereo.connect(chain.gain);
    }
    chain.gain.connect(req.bus);

    src.onended = () => {
      if (voice.active && voice.source === src) this.release(voice, 0);
    };
    try {
      src.start();
    } catch {
      this.release(voice, 0);
      return null;
    }

    this.voices.push(voice);
    list.push(voice);
    return voice;
  }

  release(voice: Voice, fade: number): void {
    if (!voice.active) return;
    voice.active = false;
    const chain = voice.chain;
    const src = voice.source;
    voice.chain = null;
    voice.source = null;

    const i = this.voices.indexOf(voice);
    if (i >= 0) this.voices.splice(i, 1);
    const list = this.byId.get(voice.id);
    if (list) {
      const j = list.indexOf(voice);
      if (j >= 0) list.splice(j, 1);
    }

    if (!chain || !src) {
      this.spare.push(voice);
      return;
    }
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const f = Math.max(0, fade);
    if (f > 0.001) {
      chain.gain.gain.cancelScheduledValues(t);
      chain.gain.gain.setValueAtTime(Math.max(1e-4, chain.gain.gain.value), t);
      chain.gain.gain.exponentialRampToValueAtTime(1e-4, t + f);
    }
    const stopAt = t + f + 0.005;
    try {
      src.onended = null;
      src.stop(stopAt);
    } catch {
      /* already stopped */
    }
    // Reclaim the chain after the fade has actually elapsed.
    const delayMs = (f + 0.03) * 1000;
    setTimeout(() => {
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
      chain.lp.disconnect();
      chain.panner.disconnect();
      chain.stereo.disconnect();
      chain.gain.disconnect();
      chain.gain.connect(chain.send);
      if (this.free.length < 64) this.free.push(chain);
      else chain.send.disconnect();
      this.spare.push(voice);
    }, delayMs);
  }

  stopAll(fade = 0.05): void {
    for (const v of this.voices.slice()) this.release(v, fade);
  }

  setListener(position: THREE.Vector3, quaternion: THREE.Quaternion, velocity: THREE.Vector3): void {
    this.listener.position.copy(position);
    this.listener.quaternion.copy(quaternion);
    this.listener.velocity.copy(velocity);

    const l = this.ctx.listener;
    _fwd.set(0, 0, -1).applyQuaternion(quaternion);
    _up.set(0, 1, 0).applyQuaternion(quaternion);
    const t = this.ctx.currentTime;
    // The AudioParam form is the modern API; the deprecated setters are kept as
    // a fallback because Safari still ships only those.
    if (l.positionX) {
      l.positionX.setTargetAtTime(position.x, t, 0.01);
      l.positionY.setTargetAtTime(position.y, t, 0.01);
      l.positionZ.setTargetAtTime(position.z, t, 0.01);
      l.forwardX.setTargetAtTime(_fwd.x, t, 0.01);
      l.forwardY.setTargetAtTime(_fwd.y, t, 0.01);
      l.forwardZ.setTargetAtTime(_fwd.z, t, 0.01);
      l.upX.setTargetAtTime(_up.x, t, 0.01);
      l.upY.setTargetAtTime(_up.y, t, 0.01);
      l.upZ.setTargetAtTime(_up.z, t, 0.01);
    } else {
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(position.x, position.y, position.z);
      legacy.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
  }

  private writePanner(p: PannerNode, pos: THREE.Vector3): void {
    const t = this.ctx.currentTime;
    if (p.positionX) {
      p.positionX.setTargetAtTime(pos.x, t, 0.008);
      p.positionY.setTargetAtTime(pos.y, t, 0.008);
      p.positionZ.setTargetAtTime(pos.z, t, 0.008);
    } else {
      (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(
        pos.x,
        pos.y,
        pos.z,
      );
    }
  }

  /**
   * Per-frame maintenance: doppler, occlusion and panner position for the
   * looping voices that move. Called from the render pass, not the sim step —
   * WebAudio is wall-clock and interpolating it on a fixed step gains nothing.
   */
  update(dt: number): void {
    const listenerPos = this.listener.position;
    const listenerVel = this.listener.velocity;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v.positional || !v.chain || !v.source) continue;

      this.writePanner(v.chain.panner, v.position);

      // -- doppler ---------------------------------------------------------
      _dir.subVectors(v.position, listenerPos);
      const dist = _dir.length();
      if (dist > 1e-4) {
        _dir.multiplyScalar(1 / dist);
        const vl = listenerVel.dot(_dir);
        const vs = v.velocity.dot(_dir);
        const rate = clamp(
          (SOUND_SPEED + vl) / (SOUND_SPEED + vs),
          0.86,
          1.16,
        );
        const want = v.baseRate * rate;
        if (Math.abs(want - v.source.playbackRate.value) > 0.002) {
          v.source.playbackRate.setTargetAtTime(want, this.ctx.currentTime, 0.03);
        }
      }

      // -- occlusion -------------------------------------------------------
      if (this.occlusionProbe) {
        const target = clamp01(this.occlusionProbe(v.position));
        v.occlusion += (target - v.occlusion) * clamp01(dt * 6);
        const cutoff = 22000 * Math.pow(0.028, v.occlusion);
        v.chain.lp.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.05);
        const atten = 1 - v.occlusion * 0.45;
        v.chain.gain.gain.setTargetAtTime(v.baseVolume * atten, this.ctx.currentTime, 0.06);
      }
    }
  }

  dispose(): void {
    this.stopAll(0);
    for (const c of this.free) {
      c.lp.disconnect();
      c.panner.disconnect();
      c.stereo.disconnect();
      c.gain.disconnect();
      c.send.disconnect();
    }
    this.free.length = 0;
    this.voices.length = 0;
    this.spare.length = 0;
    this.byId.clear();
  }
}
