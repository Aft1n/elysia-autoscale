# Adding a runtime

Status: **Bun only.** Node is planned, not implemented. Nothing below has been run on Node.

The primary/worker logic (`src/cluster.ts`, `src/plugin.ts`, `src/autoscale.ts`, `src/cgroup.ts`) talks to the
platform only through the `Runtime` interface in `src/runtime/types.ts`. A new runtime is one file that implements
that interface, plus one branch in `resolveRuntime()` (`src/runtime/index.ts`).

## The interface

| Member | Meaning | Bun (`src/runtime/bun.ts`) |
|---|---|---|
| `name` | Label for logs and errors | `"bun"` |
| `spawn({ env, onMessage, onExit })` | Start a worker copy of the current entry with `env` and an IPC channel. Returns a `WorkerHandle`. | `Bun.spawn` with `ipc`, `onExit`, stdout/stderr inherited |
| `WorkerHandle.send(message)` | Primary to worker message | `subprocess.send` |
| `WorkerHandle.kill(signal)` | `SIGTERM` or `SIGKILL` | `subprocess.kill` |
| `WorkerHandle.exited` | Resolves with the exit code (`null` on a signal) | `subprocess.exited` |
| `onMessage(message, from)` | Worker to primary message. `from` is the handle of the sender; the primary uses it for relay. | IPC `message` event |
| `onExit(code)` | Called once when a worker exits | `onExit` callback |
| `sendToPrimary(message)` | Worker to primary (in a worker) | `process.send` |
| `onPrimaryMessage(handler)` | Primary to worker messages (in a worker) | `process.on("message")` |
| `onPrimaryDisconnect(handler)` | Primary went away (in a worker). The worker then exits so it cannot be orphaned. | `process.on("disconnect")` |
| `exit(code)` | Exit this process (in a worker, and for the crash-loop exit of the primary) | `process.exit` |
| `sleep(ms)` | Promise that resolves after `ms` | `Bun.sleep` |
| `pendingRequests(server)` | In-flight request count of the server object Elysia gives `onStart`, or `undefined` if the runtime cannot tell | `server.pendingRequests` |

Environment reads use `process.env` and must keep doing so. `Bun` is not referenced outside `src/runtime/bun.ts`
(the one exception is a comment and an error string in `src/plugin.ts` and `src/runtime/index.ts`).

## Steps to add Node on `node:cluster`

1. **Create `src/runtime/node.ts`** exporting `createNodeRuntime()` that returns a `Runtime`. Mapping:
   - `spawn`: `cluster.fork(env)`. Attach `worker.on("message", m => onMessage(m, handle))` and
     `worker.on("exit", code => onExit(code))`. Build the `WorkerHandle` around the `Worker`:
     `send` = `worker.send`, `kill` = `worker.process.kill`, `exited` = a promise resolved in the `exit` event.
   - Worker side: `sendToPrimary` = `process.send`, `onPrimaryMessage` = `process.on("message")`,
     `onPrimaryDisconnect` = `process.on("disconnect")`, `exit` = `process.exit`.
   - `sleep`: `new Promise` with `setTimeout` (use `Promise.withResolvers()`, the package's style rule).
   - `pendingRequests`: return `undefined` (see the in-flight note below), or a count you keep yourself.
   - `name`: `"node"`.
   - Retirement: the primary sends the existing `DRAIN` message, and the worker calls `worker.disconnect()` or
     `process.disconnect()` after its in-flight requests finish. Do not add `disconnect` to `WorkerHandle`
     unless the primary needs it.
2. **`resolveRuntime()`**: return `createNodeRuntime()` when `typeof Bun === "undefined"` and
   `process.versions.node` is set. Remove the Bun-only throw. Keep the lazy resolution: it runs on first spawn, not at import.
3. **Listening.** `scaler.listenOptions` returns `{ reusePort: true }` today. Node has no `reusePort` option in
   `listen()`: the cluster primary owns the listening socket and hands connections to workers (round-robin on Linux).
   On Node, `listenOptions` should be `{}`. Make `plugin.ts` choose it from the runtime instead of hard-coding `reusePort`.
   With round-robin, a new worker only gets new connections, as on Bun.
4. **In-flight requests.** Node has no `server.pendingRequests`. Either keep a counter in the plugin
   (`onRequest` increments, `onAfterResponse` and `onError` decrement) and return it from `pendingRequests`, or
   return `undefined` and let the drain wait for `DRAIN_WAIT_MS`. The counter is per process, so it is cheap.
5. **Elysia adapter.** Elysia 2.0.0-rc.4 ships only the `bun` and `web-standard` adapters. Calling `.listen()` on Node
   with it throws `listen() requires an adapter on this runtime` (checked: `new Elysia().use(autoscale({processes: 2}))`
   on Node 26 reached that error). A Node port needs an Elysia release that ships a Node adapter. Its `onStart`
   server object is what `pendingRequests` reads, so check that the object is the one the adapter passes to `onStart`.
   Do not assume it until you have run it.
6. **Entry and env.** `cluster.fork` runs the same script with the same argv, and the worker sets
   `ELYSIA_AUTOSCALE_WORKER=1`. Confirm that `isWorker` reads it, not `cluster.isWorker`, so the logic is unchanged.
7. **Docs.** Move Node from "planned" to a row in the README compatibility table, state the Elysia and Node versions
   tested, and update the README "Runtimes" section.

## Checklist

- [ ] `src/runtime/node.ts` implements every member of `Runtime`; `Bun` is not referenced in it.
- [ ] `resolveRuntime()` picks it on Node; importing the package on Node still does not throw.
- [ ] `listenOptions` is correct for Node (no `reusePort`).
- [ ] `pendingRequests` returns a count, or `undefined` with a documented drain fallback.
- [ ] Elysia version with a Node adapter pinned in `peerDependencies` and tested.
- [ ] Contract test passes on Node (below).
- [ ] Integration test (`test/integration.test.ts`) passes on Node with `processes: 2`, relay, and auto scaling.
- [ ] README compatibility table and "Runtimes" section updated; CHANGELOG entry added.

## Running the contract test on Node

`test/runtime-contract.ts` exports `runtimeContract(name, makeRuntime)`. `test/bun-runtime.test.ts` runs it against the Bun
runtime. Add `test/node-runtime.test.ts` that calls it with `createNodeRuntime`. The contract cases are:

- `name` is set.
- `pendingRequests` returns a number or `undefined`.
- `sleep` waits at least the requested time.
- A spawned worker gets its env, messages the primary, receives a message back, and `exited` resolves with its exit code.
- `kill("SIGKILL")` stops the worker and `onExit` runs once.

The contract file imports `bun:test`. Running it on Node needs one of: port the file to `node:test`, or run it under Bun
with the Node runtime loaded. Whether Bun's `node:cluster` support is enough for the second option is **not known**;
test it before relying on it.

## Not known or not tested on Node

- Whether `cluster` workers on Node restart and drain correctly under the crash-loop and orphan rules. The logic is
  shared, but nothing has run on Node.
- Connection balancing on Node (round-robin, not `SO_REUSEPORT`) under load.
- Memory and CPU accounting: `src/cgroup.ts` reads the same cgroup files on any runtime, so it should carry over, but it is not measured on Node.
- Signals: `SIGTERM` drain on Node, and what the parent sees when a worker is killed by a signal.
