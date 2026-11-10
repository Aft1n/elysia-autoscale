/**
 * The platform seam. Everything the primary and worker logic needs from the JavaScript runtime is here, and
 * nothing else. `src/runtime/bun.ts` is the only implementation today; docs/ADDING-A-RUNTIME.md describes a port.
 */

/** A spawned worker, as seen from the primary. */
export interface WorkerHandle {
  /** Primary -> this worker, over the IPC channel. */
  send(message: unknown): void;
  /** Ask the worker process to stop with `signal`. Use `exited` to learn when it has. */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  /** Resolves with the exit code, or null when the process ended by a signal. */
  readonly exited: Promise<number | null>;
}

export interface SpawnOptions {
  /** The worker's whole environment. */
  env: Record<string, string>;
  /** A message from the worker. `from` is the handle `spawn` returned for that worker, for identity checks. */
  onMessage(message: unknown, from: WorkerHandle): void;
  /** The worker process ended, with its exit code (null when it ended by signal). Called once. */
  onExit(code: number | null): void;
}

export interface Runtime {
  /** Shown in logs and errors, e.g. "bun". */
  readonly name: string;
  /** Primary: start another process running the same entry as this one, with `env` and an IPC channel to it. */
  spawn(options: SpawnOptions): WorkerHandle;
  /** Worker: send a message to the primary. A no-op when there is no channel. */
  sendToPrimary(message: unknown): void;
  /** Worker: call `handler` for every message from the primary. */
  onPrimaryMessage(handler: (message: unknown) => void): void;
  /** Worker: call `handler` when the channel to the primary closes (the primary exited or disconnected). */
  onPrimaryDisconnect(handler: () => void): void;
  /** Terminate this process with `code`. */
  exit(code: number): void;
  /** Resolve after `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
  /**
   * In-flight requests of the app's server (`host.server`, opaque to the caller), or undefined when the runtime
   * cannot tell. The controller treats undefined as zero.
   */
  pendingRequests(server: unknown): number | undefined;
}
