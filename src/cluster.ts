import { initialScaleState, startLoadMeter, stepScale, type LoadSample, type ScaleConfig, type ScaleState } from "./autoscale";
import { memoryLimit, memoryUsed } from "./cgroup";
import { resolveRuntime, type Runtime, type WorkerHandle } from "./runtime";

interface Child {
  worker: WorkerHandle;
  retiring: boolean;
  load: LoadSample | null;
  loadAt: number;
}

/** What the plugin resolved from its options, plus this primary's own worker state. */
export interface Plan {
  elastic: boolean;
  fixedCount: number;
  respectLimits: boolean;
  memoryPerProcessBytes: number;
  workerEnv: Record<string, string>;
  onDrain: () => unknown;
  log: ((line: string) => void) | false;
  config: ScaleConfig;
  /** From `AutoscaleOptions.runtime`; undefined means the platform default. */
  runtime: Runtime | undefined;
  /** Workers this primary started. Per plan, so a second autoscale() in one process does not share them. */
  children: Set<Child>;
  stopping: boolean;
}

/** The slice of the Elysia app the runtime reads; `server` is set after publish, so it is read lazily. */
export interface Host {
  readonly server?: unknown;
  stop(): unknown;
}

interface Envelope {
  topic: string;
  data?: unknown;
  relay?: boolean;
}

type Handler = (data?: unknown) => void;

export const isWorker = process.env.ELYSIA_AUTOSCALE_WORKER === "1";
const elasticWorker = process.env.ELYSIA_AUTOSCALE_ELASTIC === "1";

// Topics under this prefix belong to the plugin; user topics must not start with it.
const PREFIX = "__autoscale:";
const LOAD = `${PREFIX}load`;
const DRAIN = `${PREFIX}drain`;

const LOAD_FRESH_MS = 5_000;
const CRASH_LOOP_MS = 5_000;
const DRAIN_WAIT_MS = 10_000;
const STOP_WAIT_MS = 25_000;

const handlers = new Map<string, Set<Handler>>();
// The primary that `cluster.broadcast` and `cluster.processCount` describe: the last one started in this process.
let primary: Plan | undefined;
let workerDrain: (() => void) | undefined;
let fallbackRuntime: Runtime | undefined;

const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === "object" && value !== null && typeof (value as Envelope).topic === "string";

const say = (plan: Plan, line: string) => {
  if (plan.log) plan.log(line);
};

/** The runtime this process uses when none was given: resolved on first use, never at import. */
function defaultRuntime(): Runtime {
  fallbackRuntime ??= resolveRuntime();
  return fallbackRuntime;
}

function runtimeOf(plan: Plan): Runtime {
  return plan.runtime ?? defaultRuntime();
}

function emit(topic: string, data: unknown): void {
  for (const handler of handlers.get(topic) ?? []) handler(data);
}

function spawnWorker(plan: Plan, startedAt = Date.now()): void {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  // Assigned right after spawn; the callbacks below only run later, on the event loop.
  let child!: Child;
  child = {
    worker: runtimeOf(plan).spawn({
      env: {
        ...env,
        ...plan.workerEnv,
        ELYSIA_AUTOSCALE_WORKER: "1",
        ...(plan.elastic ? { ELYSIA_AUTOSCALE_ELASTIC: "1" } : {}),
      },
      onMessage(message, from) {
        if (!isEnvelope(message)) return;
        if (message.topic === LOAD) {
          child.load = message.data as LoadSample;
          child.loadAt = Date.now();
          return;
        }
        if (message.topic.startsWith(PREFIX)) return;
        emit(message.topic, message.data);
        if (message.relay) {
          for (const other of plan.children) if (other.worker !== from && !other.retiring) other.worker.send(message);
        }
      },
      onExit(code) {
        plan.children.delete(child);
        if (plan.stopping || child.retiring) return;
        console.error(`worker exited with code ${code}`);
        // A process that dies right after start is a crash loop: let the platform restart the container.
        if (Date.now() - startedAt < CRASH_LOOP_MS) {
          runtimeOf(plan).exit(1);
          return;
        }
        spawnWorker(plan);
      },
    }),
    retiring: false,
    load: null,
    loadAt: 0,
  };
  plan.children.add(child);
}

function memoryHasRoom(plan: Plan): boolean {
  if (!plan.respectLimits) return true;
  const limit = memoryLimit();
  const used = memoryUsed();
  return limit === null || used === null || used + plan.memoryPerProcessBytes <= limit * 0.92;
}

function describeLoad(samples: readonly LoadSample[]): string {
  const worst = samples.reduce((a, b) => (b.cpu > a.cpu ? b : a));
  return `${Math.round(worst.cpu * 100)}% of a core, loop delay ${Math.round(worst.lagMs)} ms, ${worst.pending} in flight`;
}

function startController(host: Host, plan: Plan): void {
  // Resolved here, not in the interval, so a missing runtime fails the start instead of a later tick.
  const runtime = runtimeOf(plan);
  const read = startLoadMeter();
  let state: ScaleState = initialScaleState;
  setInterval(() => {
    if (plan.stopping) return;
    const now = Date.now();
    const live = [...plan.children].filter((child) => !child.retiring);
    const samples: LoadSample[] = [{ ...read(), pending: runtime.pendingRequests(host.server) ?? 0 }];
    for (const child of live) if (child.load && now - child.loadAt < LOAD_FRESH_MS) samples.push(child.load);

    const step = stepScale(state, samples, 1 + live.length, now / 1000, memoryHasRoom(plan), plan.config);
    state = step.state;
    if (step.action === "up") {
      say(plan, `workers: ${1 + live.length} -> ${2 + live.length} (busy: ${describeLoad(samples)})`);
      spawnWorker(plan);
    } else if (step.action === "down" && live.length > 0) {
      const newest = live[live.length - 1];
      say(plan, `workers: ${1 + live.length} -> ${live.length} (quiet for ${plan.config.downAfterS}s)`);
      newest.retiring = true;
      newest.worker.send({ topic: DRAIN });
    }
  }, 1000).unref();
}

function startLoadReporting(host: Host, runtime: Runtime): void {
  const read = startLoadMeter();
  setInterval(() => {
    runtime.sendToPrimary({ topic: LOAD, data: { ...read(), pending: runtime.pendingRequests(host.server) ?? 0 } });
  }, 1000).unref();
}

/** Primary: spawn the fixed workers, or start the controller in auto mode. Called from onStart. */
export function startPrimary(host: Host, plan: Plan): void {
  primary = plan;
  if (plan.elastic) {
    if (plan.config.maxProcesses > 1) {
      for (let i = 1; i < plan.config.minProcesses; i++) spawnWorker(plan);
      if (plan.config.minProcesses > 1) say(plan, `workers: keeping at least ${plan.config.minProcesses} processes (min)`);
      startController(host, plan);
    } else say(plan, "workers: auto mode needs more than one CPU or enough memory for a second process; staying at one");
    return;
  }
  for (let i = 1; i < plan.fixedCount; i++) spawnWorker(plan);
}

/** Worker: report load under auto, and drain on SIGTERM, on the primary's drain message, or when the primary goes away. */
export function startWorker(host: Host, plan: Plan): void {
  const runtime = runtimeOf(plan);
  if (elasticWorker) startLoadReporting(host, runtime);
  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    // Stop taking connections; in-flight requests finish, bounded below.
    void Promise.resolve()
      .then(() => host.stop())
      .catch((error) => console.error("autoscale: app.stop failed", error));
    const deadline = Date.now() + DRAIN_WAIT_MS;
    while ((runtime.pendingRequests(host.server) ?? 0) > 0 && Date.now() < deadline) await runtime.sleep(100);
    try {
      await plan.onDrain();
    } catch (error) {
      console.error("autoscale: onDrain failed", error);
    }
    runtime.exit(0);
  };
  workerDrain = () => void drain();
  process.once("SIGTERM", () => void drain());
  defaultRuntime().onPrimaryDisconnect(() => void drain());
}

/** Primary: SIGTERM every worker and wait for them to exit. Called from onStop. */
export async function stopChildren(plan: Plan): Promise<void> {
  plan.stopping = true;
  if (plan.children.size === 0) return;
  const exits = [...plan.children].map((child) => child.worker.exited);
  for (const child of plan.children) child.worker.kill("SIGTERM");
  await Promise.race([Promise.allSettled(exits), runtimeOf(plan).sleep(STOP_WAIT_MS)]);
}

if (isWorker) {
  defaultRuntime().onPrimaryMessage((message) => {
    if (!isEnvelope(message)) return;
    if (message.topic === DRAIN) return workerDrain?.();
    if (message.topic.startsWith(PREFIX)) return;
    emit(message.topic, message.data);
  });
}

/** The singleton: usable before the plugin is applied, since modules import it at load time. */
export const cluster = {
  isPrimary: !isWorker,
  isWorker,
  /** Live processes: the primary plus its non-retiring workers. A worker only knows it is one process. */
  processCount(): number {
    return isWorker ? 1 : 1 + [...(primary?.children ?? [])].filter((child) => !child.retiring).length;
  },
  /**
   * Primary -> every worker; worker -> primary. `relay: true` makes the primary pass the message on to the other
   * workers. The sender never receives its own message; local effects are the caller's job.
   */
  broadcast(topic: string, data?: unknown, options: { relay?: boolean } = {}): void {
    const envelope: Envelope = { topic, data, relay: options.relay ?? false };
    if (isWorker) {
      defaultRuntime().sendToPrimary(envelope);
      return;
    }
    for (const child of primary?.children ?? []) if (!child.retiring) child.worker.send(envelope);
  },
  on(topic: string, handler: Handler): void {
    let set = handlers.get(topic);
    if (!set) handlers.set(topic, (set = new Set()));
    set.add(handler);
  },
};
