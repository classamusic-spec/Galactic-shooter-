/**
 * Procedural blue-noise tile (void-and-cluster, Ulichney 1993).
 *
 * Every stochastic pass in this chain — GTAO slice rotation, volumetric march
 * offset, film grain — needs a low-discrepancy dither. White noise makes those
 * passes look like sandpaper; a Bayer matrix makes them look like a screen door.
 * Blue noise is the only option that both hides banding *and* averages away
 * cleanly under TAA, because its energy sits at high spatial frequencies where
 * the temporal filter is most effective.
 *
 * Shipping a 64×64 blue-noise PNG is the normal solution. There are no asset
 * files here, so the tile is synthesised: ~30 ms of one-time CPU work at boot
 * for three independent 32×32 channels, which is cheaper than the first frame
 * of the game.
 */
import * as THREE from 'three';
import { Rng } from '@/util/math';

const TILE = 32;
const TILE2 = TILE * TILE;
/** Gaussian sigma from the paper; 1.5–2.0 all behave well at this tile size. */
const SIGMA = 1.9;
const RADIUS = 5;

/** Precomputed wrap-around Gaussian kernel, indexed [dy + R][dx + R]. */
const KERNEL = (() => {
  const k = new Float32Array((RADIUS * 2 + 1) * (RADIUS * 2 + 1));
  const inv = 1 / (2 * SIGMA * SIGMA);
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      k[(dy + RADIUS) * (RADIUS * 2 + 1) + (dx + RADIUS)] = Math.exp(-(dx * dx + dy * dy) * inv);
    }
  }
  return k;
})();

/**
 * Splat one point's Gaussian into the energy field (sign = +1 add, -1 remove).
 * The field is maintained incrementally: recomputing it from scratch per rank
 * would turn a 30 ms build into a 4 s one.
 */
function splat(energy: Float32Array, x: number, y: number, sign: number): void {
  const span = RADIUS * 2 + 1;
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    const yy = (y + dy + TILE) & (TILE - 1);
    const row = yy * TILE;
    const krow = (dy + RADIUS) * span;
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      const xx = (x + dx + TILE) & (TILE - 1);
      energy[row + xx] += sign * KERNEL[krow + (dx + RADIUS)];
    }
  }
}

/** Index of the highest-energy set pixel: the centre of the tightest cluster. */
function tightestCluster(energy: Float32Array, on: Uint8Array, skip: number): number {
  let best = -1;
  let bestE = -Infinity;
  for (let i = 0; i < TILE2; i++) {
    if (on[i] === 0 || i === skip) continue;
    if (energy[i] > bestE) {
      bestE = energy[i];
      best = i;
    }
  }
  return best;
}

/** Index of the lowest-energy clear pixel: the centre of the largest void. */
function largestVoid(energy: Float32Array, on: Uint8Array, skip: number): number {
  let best = -1;
  let bestE = Infinity;
  for (let i = 0; i < TILE2; i++) {
    if (on[i] !== 0 || i === skip) continue;
    if (energy[i] < bestE) {
      bestE = energy[i];
      best = i;
    }
  }
  return best;
}

/** One 32×32 channel of ranked blue noise, returned as bytes in [0,255]. */
function buildChannel(seed: number): Uint8Array {
  const rng = new Rng(seed);
  const on = new Uint8Array(TILE2);
  const energy = new Float32Array(TILE2);

  // -- initial binary pattern, then relax it until it is its own fixed point --
  const initial = Math.max(8, Math.round(TILE2 * 0.1));
  let placed = 0;
  while (placed < initial) {
    const i = Math.floor(rng.next() * TILE2) % TILE2;
    if (on[i]) continue;
    on[i] = 1;
    splat(energy, i & (TILE - 1), i >> 5, 1);
    placed++;
  }
  for (let iter = 0; iter < 4096; iter++) {
    const c = tightestCluster(energy, on, -1);
    if (c < 0) break;
    on[c] = 0;
    splat(energy, c & (TILE - 1), c >> 5, -1);
    const v = largestVoid(energy, on, c);
    if (v < 0 || v === c) {
      // Removing the cluster created the largest void in the same place: the
      // pattern is stable, which is the paper's termination condition.
      on[c] = 1;
      splat(energy, c & (TILE - 1), c >> 5, 1);
      break;
    }
    on[v] = 1;
    splat(energy, v & (TILE - 1), v >> 5, 1);
  }

  const rank = new Int32Array(TILE2).fill(-1);
  const initialOn = Uint8Array.from(on);
  const initialEnergy = Float32Array.from(energy);

  // -- phase 1: strip the pattern down, ranking downward from initial-1 -------
  let r = placed - 1;
  while (r >= 0) {
    const c = tightestCluster(energy, on, -1);
    if (c < 0) break;
    on[c] = 0;
    splat(energy, c & (TILE - 1), c >> 5, -1);
    rank[c] = r--;
  }

  // -- phases 2+3: refill largest voids, ranking upward ----------------------
  // Filling the largest void and "removing the tightest cluster of zeros" are
  // the same operation once you expand the energy identity, so the paper's two
  // remaining phases collapse into one loop.
  on.set(initialOn);
  energy.set(initialEnergy);
  for (let k = placed; k < TILE2; k++) {
    const v = largestVoid(energy, on, -1);
    if (v < 0) break;
    on[v] = 1;
    splat(energy, v & (TILE - 1), v >> 5, 1);
    rank[v] = k;
  }

  const out = new Uint8Array(TILE2);
  for (let i = 0; i < TILE2; i++) {
    const q = rank[i] < 0 ? 0 : rank[i];
    out[i] = Math.min(255, Math.round(((q + 0.5) / TILE2) * 255));
  }
  return out;
}

let cached: THREE.DataTexture | null = null;

/**
 * The shared blue-noise tile. Three independent ranked channels in RGB so a
 * pass that needs two or three decorrelated dithers gets them from one fetch.
 * Cached process-wide: the build is deterministic, so every pass and every
 * PostFX instance can share one texture.
 */
export function blueNoiseTexture(): THREE.DataTexture {
  if (cached) return cached;
  const data = new Uint8Array(TILE2 * 4);
  const ch = [buildChannel(0x5eed01), buildChannel(0x1337c0de), buildChannel(0x2a17b3)];
  for (let i = 0; i < TILE2; i++) {
    data[i * 4 + 0] = ch[0][i];
    data[i * 4 + 1] = ch[1][i];
    data[i * 4 + 2] = ch[2][i];
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, TILE, TILE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Nearest is mandatory: interpolating ranks destroys the spectrum that makes
  // this useful in the first place.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}

/** Tile edge length, so shaders can convert pixel coords to tile uv. */
export const BLUE_NOISE_TILE = TILE;
