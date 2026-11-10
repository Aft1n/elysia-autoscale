import { availableParallelism } from "node:os";

/**
 * The decisions behind `processes: "auto"` (see src/cluster.ts), kept pure so they can be tested with numbers.
 *
 * A process is "hot" when it is using nearly a whole core (its one JavaScript thread is the limit, which is exactly
 * what a second process helps with) or its event loop is badly late. Requests in flight are deliberately NOT a hot
 * signal: they pile up just as well when the database is slow, and more processes would only add database connections.
 * The controller adds a process after the load stays hot for a few seconds and removes one only after everything has
 * been quiet for minutes, so a bursty minute does not make processes come and go.
 */

export interface LoadSample {
  /** Requests in flight in that process. */
  pending: number;
  /** Worst event-loop delay in the last second, in ms. */
  lagMs: number;
  /** CPU used in the last second as a fraction of one core (1 = a whole core). */
  cpu: number;
}

export interface ScaleConfig {
  maxProcesses: number;
  /** Never retire below this many processes (1 = only the primary is permanent). */
  minProcesses: number;
  /** Event-loop delay that counts as hot. */
  hotLagMs: number;
  /** Fraction of a core that counts as hot. */
  hotCpu: number;
  /** Seconds of continuous heat before adding a process. */
  upAfterS: number;
  /** Seconds of continuous quiet before removing one. */
  downAfterS: number;
  /** Minimum seconds between two additions, and between two removals. */
  upCooldownS: number;
  downCooldownS: number;
}

export interface ScaleState {
  hotS: number;
  quietS: number;
  lastUpAt: number;
  lastDownAt: number;
}

export type ScaleAction = "up" | "down" | "hold";

export const initialScaleState: ScaleState = { hotS: 0, quietS: 0, lastUpAt: -Infinity, lastDownAt: -Infinity };

/** Quiet means every process is nearly idle: well under the hot thresholds, not merely below them. */
const QUIET_CPU = 0.05;
const QUIET_PENDING = 2;

/** One second of observation. `nowS` is a monotonic clock in seconds; `memoryOk` says a new process would fit. */
export function stepScale(
  state: ScaleState,
  samples: readonly LoadSample[],
  processes: number,
  nowS: number,
  memoryOk: boolean,
  config: ScaleConfig,
): { state: ScaleState; action: ScaleAction } {
  const hot = samples.some((s) => s.cpu >= config.hotCpu || s.lagMs >= config.hotLagMs);
  const quiet = samples.every((s) => s.cpu < QUIET_CPU && s.pending <= QUIET_PENDING);
  const next: ScaleState = { ...state, hotS: hot ? state.hotS + 1 : 0, quietS: quiet ? state.quietS + 1 : 0 };

  if (next.hotS >= config.upAfterS && processes < config.maxProcesses && memoryOk && nowS - state.lastUpAt >= config.upCooldownS) {
    return { state: { ...next, hotS: 0, quietS: 0, lastUpAt: nowS }, action: "up" };
  }
  if (next.quietS >= config.downAfterS && processes > config.minProcesses && nowS - state.lastDownAt >= config.downCooldownS) {
    return { state: { ...next, quietS: 0, lastDownAt: nowS }, action: "down" };
  }
  return { state: next, action: "hold" };
}

/** A new process's budget: about this much resident memory under load (measured: 4 processes peaked near 600 MB). */
export const PROCESS_MEMORY_BYTES = 160 * 1024 * 1024;

/**
 * How many processes the container may run: the smallest of the CPU limit (rounded up), the configured `max`
 * (default 4), and what the memory limit holds. Without a limit the machine's cores count. Always at least 1.
 */
export function processBudget(opts: {
  cpuLimit: number | null;
  memoryLimitBytes: number | null;
  configuredMax?: number;
  cores?: number;
  memoryPerProcessBytes?: number;
}): number {
  const cores = opts.cores ?? availableParallelism();
  const byCpu = opts.cpuLimit === null ? cores : Math.ceil(opts.cpuLimit);
  const perProcess = opts.memoryPerProcessBytes ?? PROCESS_MEMORY_BYTES;
  const byMemory = opts.memoryLimitBytes === null ? Infinity : Math.floor(opts.memoryLimitBytes / perProcess);
  const configured = opts.configuredMax ?? 4;
  return Math.max(1, Math.min(byCpu, byMemory, configured));
}

/**
 * Measures this process: the worst event-loop delay (a timer that fires late means the thread was busy) and the CPU
 * used, both since the previous read. Two timers a second at most, so an idle process stays idle.
 */
export function startLoadMeter(intervalMs = 250): () => { lagMs: number; cpu: number } {
  let last = performance.now();
  let worst = 0;
  setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - intervalMs);
    last = now;
  }, intervalMs).unref();
  let readAt = performance.now();
  let used = process.cpuUsage();
  return () => {
    const now = performance.now();
    const usage = process.cpuUsage();
    const cpuMs = (usage.user - used.user + (usage.system - used.system)) / 1000;
    const cpu = now > readAt ? cpuMs / (now - readAt) : 0;
    readAt = now;
    used = usage;
    const lagMs = worst;
    worst = 0;
    return { lagMs, cpu };
  };
}
