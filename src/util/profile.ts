import { yieldTimeMs } from './async';

/**
 * Coarse load-time profiler.
 *
 * Level entry is the one place the main thread can block long enough for the tab
 * to look crashed, and "terrain.build took 25 s" is not actionable on its own.
 * Every long phase stamps itself here so a capture can name the phase that
 * blocks — and, by correlating the recorded spans against a requestAnimationFrame
 * gap trace, say whether that phase actually froze the page or merely took a
 * while while still painting.
 *
 * Deliberately global and dependency-free: it has to be readable from a headless
 * browser probe with no access to engine internals.
 */
export interface PhaseSpan {
  name: string;
  start: number;
  end: number;
  /** Wall time minus time parked in a cooperative yield — the real CPU cost. */
  workMs: number;
}

const spans: PhaseSpan[] = [];

/** Start a phase. Call the returned function when the phase ends. */
export function phase(name: string): () => void {
  const start = performance.now();
  const y0 = yieldTimeMs();
  return () => {
    const end = performance.now();
    spans.push({ name, start, end, workMs: end - start - (yieldTimeMs() - y0) });
  };
}

/** Every phase recorded since the last `resetProfile()`, in completion order. */
export function profileSpans(): PhaseSpan[] {
  return spans.map((s) => ({
    name: s.name,
    start: Math.round(s.start),
    end: Math.round(s.end),
    workMs: Math.round(s.workMs),
  }));
}

export function resetProfile(): void {
  spans.length = 0;
}

(globalThis as Record<string, unknown>).GF_PROFILE = { spans: profileSpans, reset: resetProfile };
