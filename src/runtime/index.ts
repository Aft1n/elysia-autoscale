import { createBunRuntime, isBun } from "./bun";
import type { Runtime } from "./types";

export type { Runtime, SpawnOptions, WorkerHandle } from "./types";

/**
 * The runtime that starts extra processes. Called only when a process is actually started, so importing the package
 * or running a single process never needs one.
 */
export function resolveRuntime(): Runtime {
  if (isBun()) return createBunRuntime();
  throw new Error("elysia-autoscale runs on Bun only for now; see 'Runtimes' in the README");
}
