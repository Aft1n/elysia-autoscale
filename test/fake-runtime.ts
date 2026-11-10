import type { Runtime, SpawnOptions, WorkerHandle } from "../src/runtime";

/** One spawned worker of the fake: what the primary sent it, and how the test makes it talk or exit. */
export interface FakeWorker {
  readonly env: Record<string, string>;
  readonly sent: unknown[];
  readonly killed: string[];
  readonly handle: WorkerHandle;
  /** The worker sends `message` to the primary. */
  deliver(message: unknown): void;
  /** The worker process exits with `code`; runs the exit callback once. */
  finish(code: number | null): void;
}

export interface FakeRuntime extends Runtime {
  readonly workers: FakeWorker[];
  /** Codes passed to `exit()`, i.e. the primary exiting itself. */
  readonly exits: number[];
  /** What `pendingRequests` reports for every server. */
  pending: number | undefined;
}

const workerSideUnused = () => {
  throw new Error("fake runtime: worker-side API is not used by primary tests");
};

/** In-memory runtime: no processes. Worker-side methods throw if called. */
export function createFakeRuntime(): FakeRuntime {
  const workers: FakeWorker[] = [];
  const exits: number[] = [];
  const runtime: FakeRuntime = {
    name: "fake",
    workers,
    exits,
    pending: undefined,
    spawn({ env, onMessage, onExit }: SpawnOptions): WorkerHandle {
      const { promise: exited, resolve: settle } = Promise.withResolvers<number | null>();
      const sent: unknown[] = [];
      const killed: string[] = [];
      let done = false;
      let handle!: WorkerHandle;
      const finish = (code: number | null) => {
        if (done) return;
        done = true;
        settle(code);
        onExit(code);
      };
      handle = {
        send: (message) => {
          sent.push(message);
        },
        kill: (signal) => {
          killed.push(signal);
          queueMicrotask(() => finish(null));
        },
        exited,
      };
      workers.push({ env, sent, killed, handle, deliver: (message) => onMessage(message, handle), finish });
      return handle;
    },
    sendToPrimary: workerSideUnused,
    onPrimaryMessage: workerSideUnused,
    onPrimaryDisconnect: workerSideUnused,
    exit(code) {
      exits.push(code);
    },
    sleep: (ms) => Bun.sleep(ms),
    pendingRequests: () => runtime.pending,
  };
  return runtime;
}
