import { Elysia } from "elysia";
import { processBudget } from "./autoscale";
import { cpuLimit, memoryLimit } from "./cgroup";
import { isWorker, startPrimary, startWorker, stopChildren, type Host, type Plan } from "./cluster";
import type { Runtime } from "./runtime";

export interface AutoscaleOptions {
  /** 1 (default: the plugin is inert), a fixed number of processes, or "auto". */
  processes?: number | "auto";
  /** Upper bound for "auto"; the cgroup CPU and memory limits can lower it. Default 4. */
  max?: number;
  /**
   * "auto" only: processes kept running at all times. They start at boot and are never retired, so the first
   * requests are spread over `min` processes and there is no ramp up to that count. The cgroup limits can lower it
   * (it never exceeds the process budget). Costs the memory of the extra idle processes. Default 1.
   */
  min?: number;
  /** Quiet time before "auto" retires a process. Default 120. */
  idleSeconds?: number;
  /** A process at or above this fraction of one core counts as hot. Default 0.85. */
  hotCpu?: number;
  /** Event-loop delay at or above this many ms counts as hot. Default 40. */
  hotLagMs?: number;
  /** How long a hot signal must last before adding a process. Default 3. */
  upAfterSeconds?: number;
  /** Minimum time between two additions. Default 10. */
  upCooldownSeconds?: number;
  /** Minimum time between two retirements. Default 60. */
  downCooldownSeconds?: number;
  /** Resident memory a new process is assumed to need. Default 160. */
  memoryPerProcessMB?: number;
  /** Read the Docker/Coolify cgroup CPU and memory limits. Default true. */
  respectLimits?: boolean;
  /** Extra environment for spawned processes. */
  workerEnv?: Record<string, string>;
  /** Cleanup a retired worker runs after it stops serving and before it exits. */
  onDrain?: () => unknown;
  /** Log sink for scaling decisions; `false` silences them. Default `console.log`. */
  log?: ((line: string) => void) | false;
  /**
   * Advanced, experimental: the process runtime to use instead of the platform default. Mainly for tests and for
   * porting to another runtime; see docs/ADDING-A-RUNTIME.md. Unset on Bun.
   */
  runtime?: Runtime;
}

const MB = 1024 * 1024;

/**
 * Scales the app across processes on one host. Apply with `.use(scaler)` and spread `scaler.listenOptions`
 * into `.listen()`: the second process can only bind the same port with `reusePort`.
 */
export function autoscale(options: AutoscaleOptions = {}) {
  const requested = options.processes ?? 1;
  const elastic = requested === "auto" && !isWorker;
  const fixedCount = isWorker || requested === "auto" ? 1 : Math.max(1, Math.floor(requested) || 1);
  const respectLimits = options.respectLimits ?? true;
  const memoryPerProcessBytes = (options.memoryPerProcessMB ?? 160) * MB;
  const maxProcesses = elastic
    ? processBudget({
        cpuLimit: respectLimits ? cpuLimit() : null,
        memoryLimitBytes: respectLimits ? memoryLimit() : null,
        configuredMax: options.max ?? 4,
        memoryPerProcessBytes,
      })
    : fixedCount;
  const minProcesses = elastic ? Math.max(1, Math.min(Math.floor(options.min ?? 1) || 1, maxProcesses)) : 1;

  const plan: Plan = {
    elastic,
    fixedCount,
    respectLimits,
    memoryPerProcessBytes,
    workerEnv: options.workerEnv ?? {},
    onDrain: options.onDrain ?? (() => {}),
    log: options.log === undefined ? console.log : options.log,
    config: {
      maxProcesses,
      minProcesses,
      hotLagMs: options.hotLagMs ?? 40,
      hotCpu: options.hotCpu ?? 0.85,
      upAfterS: options.upAfterSeconds ?? 3,
      downAfterS: options.idleSeconds ?? 120,
      upCooldownS: options.upCooldownSeconds ?? 10,
      downCooldownS: options.downCooldownSeconds ?? 60,
    },
    runtime: options.runtime,
    children: new Set(),
    stopping: false,
  };

  const plugin = new Elysia({ name: "elysia-autoscale" })
    .onStart((app) => {
      // Read lazily: `server` is only set once the app has published its listener.
      const host: Host = {
        get server() {
          return app.server;
        },
        stop: () => app.stop(),
      };
      if (isWorker) startWorker(host, plan);
      else startPrimary(host, plan);
    })
    .onStop(() => (isWorker ? undefined : stopChildren(plan)));

  return Object.assign(plugin, { listenOptions: { reusePort: isWorker || maxProcesses > 1 } });
}
