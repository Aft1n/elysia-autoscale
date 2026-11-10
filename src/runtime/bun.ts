import type { Runtime, SpawnOptions, WorkerHandle } from "./types";

export interface BunRuntimeOptions {
  /** Command that starts a worker. Default: this same entry (or the executable, for a compiled binary). */
  command?: readonly string[];
}

/** True when this process runs on Bun. */
export function isBun(): boolean {
  return typeof Bun !== "undefined";
}

// Inside `bun build --compile` the entry is embedded: Bun.main points into the virtual filesystem and the
// executable itself is the entry, so the worker is started with the executable alone.
function defaultCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs") || Bun.main.startsWith("B:");
  return compiled ? [process.execPath] : [process.execPath, ...process.execArgv, Bun.main];
}

export function createBunRuntime(options: BunRuntimeOptions = {}): Runtime {
  return {
    name: "bun",
    spawn({ env, onMessage, onExit }: SpawnOptions): WorkerHandle {
      let handle!: WorkerHandle;
      // The callbacks run on later ticks, after `handle` is assigned below, so `from` is the same object.
      const child = Bun.spawn(options.command ? [...options.command] : defaultCommand(), {
        env,
        stdout: "inherit",
        stderr: "inherit",
        ipc(message) {
          onMessage(message, handle);
        },
        onExit(_exited, code) {
          onExit(code);
        },
      });
      handle = {
        send: (message) => child.send(message),
        kill: (signal) => child.kill(signal),
        exited: child.exited,
      };
      return handle;
    },
    sendToPrimary(message) {
      process.send?.(message);
    },
    onPrimaryMessage(handler) {
      process.on("message", handler);
    },
    onPrimaryDisconnect(handler) {
      process.once("disconnect", handler);
    },
    exit(code) {
      process.exit(code);
    },
    sleep(ms) {
      return Bun.sleep(ms);
    },
    pendingRequests(server) {
      if (typeof server !== "object" || server === null || !("pendingRequests" in server)) return undefined;
      return typeof server.pendingRequests === "number" ? server.pendingRequests : undefined;
    },
  };
}
