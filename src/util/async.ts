/**
 * Cooperative time-slicing for long build jobs.
 *
 * Generating a planet is tens of seconds of pure CPU work. Doing it in one
 * synchronous run freezes the tab: the loading bar stops animating, the browser
 * stops painting, and the page is indistinguishable from a crash. Yielding once
 * per *item* is the other failure mode — a scatter definition that places 40k
 * instances is a single item, so one yield still leaves a 17 s block.
 *
 * The fix is to yield on a *time* budget rather than an item count: run until
 * the slice is spent, hand the thread back so the browser can paint a frame,
 * then resume. The cost is one macrotask hop per slice.
 */

/**
 * `setTimeout(0)` is clamped to ~4 ms once nested a few deep, which would triple
 * the cost of a fine-grained slice. A MessageChannel round-trip is a real
 * macrotask with no clamp, so the yield costs microseconds instead.
 */
const scheduleMacrotask: (fn: () => void) => void =
  typeof MessageChannel === 'function'
    ? (fn) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          ch.port1.close();
          fn();
        };
        ch.port2.postMessage(0);
      }
    : (fn) => {
        setTimeout(fn, 0);
      };

/**
 * Total wall-clock time spent parked in `nextTask()`.
 *
 * Wall-clock phase timings become meaningless once a phase yields: under a
 * software rasteriser a single yielded frame costs a second, so a 400 ms job
 * reports as 9 s. Subtracting this counter recovers the real CPU cost, which is
 * the number that predicts behaviour on a real GPU.
 */
let yieldedMs = 0;
let yieldCount = 0;

export function yieldTimeMs(): number {
  return yieldedMs;
}

(globalThis as Record<string, unknown>).GF_YIELD = {
  ms: () => yieldedMs,
  count: () => yieldCount,
};

/** Hand the thread back to the browser for exactly one macrotask. */
export function nextTask(): Promise<void> {
  const t0 = performance.now();
  return new Promise<void>((resolve) => scheduleMacrotask(resolve)).then(() => {
    yieldedMs += performance.now() - t0;
    yieldCount++;
  });
}

export interface FrameBudget {
  /** Await inside a loop. Yields only once the current slice is spent. */
  (): Promise<void>;
  /** Longest uninterrupted run so far, ms — for verifying the slice holds. */
  readonly worstMs: number;
  /** Number of yields taken. */
  readonly yields: number;
}

/**
 * Build a budget that yields whenever `sliceMs` of work has accumulated.
 *
 * 8 ms is chosen to sit inside a 16.7 ms frame with room for the browser's own
 * work, so a loading screen keeps animating at roughly 60 fps while the build
 * runs at close to full speed.
 */
export function createFrameBudget(sliceMs = 8): FrameBudget {
  let last = performance.now();
  let worst = 0;
  let count = 0;

  const budget = (async (): Promise<void> => {
    const now = performance.now();
    const spent = now - last;
    if (spent < sliceMs) return;
    if (spent > worst) worst = spent;
    count++;
    await nextTask();
    last = performance.now();
  }) as FrameBudget & { worstMs: number; yields: number };

  Object.defineProperty(budget, 'worstMs', { get: () => Math.round(worst) });
  Object.defineProperty(budget, 'yields', { get: () => count });
  return budget;
}
