# elysia-autoscale

An [Elysia](https://elysiajs.com) plugin that runs one app across several processes on one host. A Bun process runs
JavaScript on a single thread, so one process can use at most one core. This plugin starts copies of your app that
share one port, adds a copy when a process is saturated, and retires copies when traffic goes quiet. In `auto` mode it
reads the CPU and memory limit of the container (Docker, Coolify) and never starts more processes than fit.

It is for people who run one Bun + Elysia container on a multi-core host and want to use the cores without writing a
cluster launcher, and without paying for idle processes. It is **not** for serverless or edge runtimes, and it does not
scale across containers or hosts.

> **Status:** version 0.1.0. Bun only. Measured on Bun 1.4.x, Elysia 2.0.0-rc.4 and Linux. See
> [Compatibility](#compatibility) and [Limitations](#limitations).

## Features

- **Fixed or automatic process count.** `processes: 4` keeps four. `processes: "auto"` starts with one and follows load,
  between `min` (default 1) and `max` (default 4). `min: 2` keeps a warm second process so there is no ramp.
- **Scales on CPU, not on queue length.** A process is "hot" at 85% of a core or an event loop that is 40 ms late. Requests
  waiting for a slow database deliberately do not count, so a database stall does not add processes (and database connections).
- **Respects container limits.** Reads cgroup v2 and v1 CPU and memory limits (what Docker `--cpus` and `--memory` set,
  and so what platforms such as Coolify apply) and caps the process count to fit.
- **One shared port.** Extra processes bind the same port with `SO_REUSEPORT`; the kernel spreads new connections.
- **A message channel between processes.** `cluster.broadcast` and `cluster.on`, with optional relay, so per-process
  state (caches) can be invalidated everywhere.
- **Graceful retirement.** A retired process stops accepting connections, lets in-flight requests finish (up to 10 s),
  runs your `onDrain` cleanup, then exits.
- **Crash handling.** A worker that crashes is replaced. A worker that dies within 5 s of starting makes the primary
  exit so your platform restarts the whole container instead of looping.
- **No orphans.** Workers drain and exit if the primary goes away.
- **Inert by default.** With `processes: 1` (the default) the plugin does nothing at runtime.
- **No dependencies** besides the `elysia` peer.
- **A runtime seam** so a Node implementation can be added later ([Runtimes](#runtimes)).

## Install

```bash
bun add elysia-autoscale
```

The package ships its TypeScript source and is meant to be used from Bun (or a bundler that resolves extensionless
TypeScript imports). It has no build step.

## Quick start

```ts
import { Elysia } from "elysia";
import { autoscale } from "elysia-autoscale";

const scaler = autoscale({ processes: "auto", max: 4 });

new Elysia()
  .use(scaler)
  .get("/", () => "hello")
  .listen({ port: 3000, ...scaler.listenOptions });
```

Spreading `scaler.listenOptions` into `listen()` is required. A plugin cannot change how you listen, and on Linux a
second process can only bind the same port with `reusePort: true`. Without it, extra processes fail with `EADDRINUSE`.
`listenOptions` is `{ reusePort: true }` when more than one process can exist and `{ reusePort: false }` otherwise.

## How it works

### Primary and workers

The first process you start is the **primary**. It starts **workers**: copies of the same entry (`Bun.spawn` of the
same script, or of the compiled binary itself) with an IPC channel and `ELYSIA_AUTOSCALE_WORKER=1` in their environment.
All processes run your whole app and listen on the same port.

```
                 ┌────────────────────────── one host / one container ──────────────────────────┐
  connections    │                                                                                │
  ────────────►  │   kernel (SO_REUSEPORT)  ──►  primary (pid 1)   ◄── IPC ──►  worker 2          │
  :3000          │        spreads NEW             runs the controller             worker 3        │
                 │        connections             runs cron / migrations          worker N        │
                 └────────────────────────────────────────────────────────────────────────────────┘
```

Start-up order matters: workers are started from the plugin's `onStart`, after the primary is listening.

### What belongs on the primary only

Anything that must run once, such as cron jobs, schedulers and boot-time migrations, would run in every copy. Gate it
with `cluster.isWorker`:

```ts
import { cluster } from "elysia-autoscale";

if (cluster.isPrimary) {
  startCronJobs();
}
```

The primary is never retired.

### The controller (auto mode)

Once a second the primary looks at itself and at the load each worker reports (workers report once a second, only in
auto mode).

| Signal | Value |
|---|---|
| CPU of a process | `process.cpuUsage()` delta over wall time, as a fraction of one core |
| Event-loop delay | the late-timer delay of a 250 ms timer, worst in the window |
| In-flight requests | measured and shown in log lines, **not** a trigger |

- **Hot:** any process at or above `hotCpu` (default 0.85) or `hotLagMs` (default 40).
- **Add a process** after `upAfterSeconds` (default 3) of continuous heat, if the budget allows it, if memory has room
  (the new process must fit under 92% of the memory limit), and at least `upCooldownSeconds` (default 10) after the last addition.
- **Quiet:** every process under 5% CPU and with at most 2 requests in flight.
- **Retire the newest worker** after `idleSeconds` (default 120) of continuous quiet, never below `min`, at least `downCooldownSeconds`
  (default 60) after the last retirement, never below one process. Going from four to one therefore takes about
  `idleSeconds` plus two cooldowns.
- A hot or non-quiet second resets the quiet streak, and the other way around. A short burst never retires anything.

Why in-flight requests are not a signal: they pile up just as well when the database is slow. More processes would not help
and would each open their own database pool. CPU does tell you that the one JavaScript thread is the limit, which is
exactly what another process fixes.

Log lines (to `console.log`, or your `log` function):

```
workers: 1 -> 2 (busy: 142% of a core, loop delay 1 ms, 59 in flight)
workers: 4 -> 3 (quiet for 120s)
```

### Limits from the container

With `respectLimits: true` (default) the plugin reads, once at start:

| Limit | cgroup v2 | cgroup v1 |
|---|---|---|
| CPU | `/sys/fs/cgroup/cpu.max` (`quota period`, or `max`) | `cpu/cpu.cfs_quota_us` and `cpu.cfs_period_us` (`-1` = none) |
| Memory | `/sys/fs/cgroup/memory.max` (`max` or bytes) | `memory/memory.limit_in_bytes` (a huge number = none) |
| Memory in use (checked before each addition) | `memory.current` | `memory/memory.usage_in_bytes` |

The most processes `auto` may run is the smallest of:

- the CPU limit rounded up (a limit of 1.5 CPUs allows 2; a limit of 0.5 allows 1),
- `floor(memory limit / memoryPerProcessMB)` (default 160 MB per process),
- `max` (default 4),

and at least 1. With no limits, the machine's core count replaces the CPU limit. `processes: N` (fixed) does not look at
limits: you asked for N.

Docker's `--cpus` and `--memory` write these files, and Coolify's per-application CPU and memory limits are applied
through Docker, so they should show up here. That path (a limit set, then read inside the container) has not been run end
to end: set a limit, start with `processes: "auto"`, and check that the process count stays within it. The plugin reads
the files from inside the container and does not talk to Docker.

### Messages between processes

```ts
import { cluster } from "elysia-autoscale";

// Every process holds its own cache. When one sign-out clears it, tell the others.
cluster.on("sessions:clear", () => cache.clear());

function onSignOut() {
  cache.clear();                                            // local effect: yours to do
  cluster.broadcast("sessions:clear", undefined, { relay: true });
}
```

- On the **primary**, `broadcast` sends to every live worker.
- On a **worker**, `broadcast` sends to the primary only. With `{ relay: true }` the primary also passes it on to the other workers.
- A process never receives its own message.
- Messages must be structured-cloneable. Topics starting with `__autoscale:` are reserved.
- `cluster` can be imported at module load, before the plugin is applied.

### Shutdown, retirement, crashes

- **Retire (auto):** the primary sends a drain message to the newest worker. It calls `app.stop()` (no new connections),
  waits up to 10 s for in-flight requests, runs `onDrain`, and exits 0. The primary does not respawn it.
- **Stop:** when the primary stops, it sends `SIGTERM` to every worker and waits up to 25 s.
- **Worker `SIGTERM` or lost primary:** the same drain path as a retirement.
- **Unexpected worker exit:** the worker is respawned, unless it died within 5 s of starting. Then the primary exits with
  code 1 so the platform restarts the container.

## Configuration

```ts
autoscale({
  processes: "auto",
  min: 1,
  max: 4,
  idleSeconds: 120,
  workerEnv: { MIGRATE_ON_BOOT: "false" },
  onDrain: async () => { await pool.close(); },
});
```

| Option | Default | Meaning |
|---|---|---|
| `processes` | `1` | `1`: the plugin is inert. A number `N`: start `N` processes at boot and keep them. `"auto"`: follow load. |
| `max` | `4` | Upper bound for `auto`. The container's CPU and memory limits can lower it. |
| `min` | `1` | `auto` only: processes kept running at all times. They start at boot and are never retired, so there is no ramp up to that count. It costs the memory of the idle processes. Capped by `max` and the container limits. |
| `idleSeconds` | `120` | Quiet time before `auto` retires a process. |
| `hotCpu` | `0.85` | Fraction of one core at which a process counts as hot. |
| `hotLagMs` | `40` | Event-loop delay at which a process counts as hot. |
| `upAfterSeconds` | `3` | Heat that must last this long before a process is added. |
| `upCooldownSeconds` | `10` | Minimum time between additions. |
| `downCooldownSeconds` | `60` | Minimum time between retirements. |
| `memoryPerProcessMB` | `160` | Memory a new process is assumed to need. Used for the memory budget. |
| `respectLimits` | `true` | Read the container's CPU and memory limits. |
| `workerEnv` | `{}` | Extra environment variables for spawned processes. |
| `onDrain` | none | Cleanup run in a retired worker after it stops serving and before it exits (close pools, flush). |
| `log` | `console.log` | Receives scaling log lines. `false` silences them. |
| `runtime` | Bun | Advanced and experimental. See [Runtimes](#runtimes). |

Mapping environment variables is up to you. For example:

```ts
const raw = process.env.WEB_CONCURRENCY;
autoscale({
  processes: raw === "auto" ? "auto" : Number(raw ?? 1) || 1,
  min: Number(process.env.WEB_CONCURRENCY_MIN ?? 1),
  max: Number(process.env.WEB_CONCURRENCY_MAX ?? 4),
  idleSeconds: Number(process.env.WEB_CONCURRENCY_IDLE_S ?? 120),
});
```

## API

```ts
import { autoscale, cluster, type AutoscaleOptions, type Runtime } from "elysia-autoscale";
```

- **`autoscale(options?)`** returns an Elysia plugin (`.use()` it) that also has `listenOptions: { reusePort: boolean }`.
- **`cluster.isPrimary`**, **`cluster.isWorker`**: which kind of process this is. Workers are detected by the
  `ELYSIA_AUTOSCALE_WORKER=1` environment variable, which the plugin sets.
- **`cluster.processCount()`**: live processes known to the primary (itself plus workers that are not retiring). On a worker it returns 1.
- **`cluster.broadcast(topic, data?, { relay? })`**, **`cluster.on(topic, handler)`**: described above.

## Recipes

- **Database connections.** Every process has its own pool. The database sees `processes x pool size`. Keep that under
  the database's connection limit. With `auto`, use `max x pool size`.
- **Per-process state.** Caches, in-memory rate limiters and counters live in each process. A client spread over `N`
  processes can use up to `N` times a per-process rate limit. Use `cluster.broadcast` to invalidate caches.
- **Migrations and cron on the primary.** Gate them with `cluster.isPrimary`, and pass `workerEnv: { MIGRATE_ON_BOOT: "false" }`
  (or your own flag) so workers skip them.
- **Docker / Coolify.** Nothing special is needed in the image. Set the CPU and memory limits on the container, leave
  `respectLimits` on, and confirm the cap with the check above. Keep `max` at or under the CPU limit you set.
- **Compiled binaries.** Workers are started from `process.execPath` when the app is a compiled Bun binary, so the same
  binary serves as primary and worker.
- **Logging.** Workers inherit stdout and stderr, so their logs appear in the same stream. Add `process.pid` to log lines if you need to tell them apart.

## Measurements

These come from one app (an Elysia + Postgres API) on one shared Linux host (a Hetzner server running Docker and about
25 other containers), with the load generator in the same Docker network. They show what happened there, not what you will get.

3,000 simulated users, each making one request every 1 to 3 seconds:

| | One process | `processes: "auto"`, `max: 4` |
|---|---|---|
| Answered requests | about 710 per second | 1,010 per second |
| Latency p95 | 3.5 s | 1.7 s |
| Container CPU | about 0.9 core | 0.63 core at the start, 1.9 to 2.4 cores once workers joined |
| Container memory | not measured | about 96 MB with one process, about 550 MB with four under load |

Scale-down was observed: `workers: 4 -> 3 (quiet for 120s)` about two minutes after the load stopped, with memory
falling from 372 MB to 291 MB. A recheck after this code moved into the package gave 907 requests per second answered
and p95 1.9 s at the same load. Not every step down was observed in every run.

## Limitations

- **A new process only receives new connections.** Connections that are already open stay with the process that
  accepted them. A client with a long-lived keep-alive connection is not rebalanced.
  Measured once, one run each: straight to the container the busiest process stayed near the hot threshold while the
  third ran at about a quarter of a core; behind a reverse proxy (Traefik) the load spread evenly over four processes.
  Why the proxy spread it better was not investigated.
- **Linux is where balancing was tested.** On macOS the process lifecycle works, but the kernel does not spread
  connections, so one process takes them all and there is no gain.
- **Windows is untested.** There are no cgroups there, and port sharing behaviour was not checked.
- **Not for serverless or edge platforms** (Cloudflare Workers, Lambda and the like). There is no process spawning, no
  shared port and no cgroup files there.
- **One host only.** This does not add containers or machines.
- **Bun only today.** On Node, `listen()` itself needs an Elysia Node adapter (Elysia 2.0.0-rc.4 throws
  "requires an adapter on this runtime"), and this package has no Node runtime yet.
- **The package ships TypeScript source** with extensionless imports. Bun and bundlers handle that; running it directly
  with Node does not work.
- **Scaling is not instant.** In one local run of a compiled binary (this API, one Mac), with the defaults, the first
  extra process was requested 3.2 s after load started and was serving 0.25 s after that; with `upAfterSeconds: 2` and `1`
  the request came at 2.2 s and 1.2 s. The next process waits `upCooldownSeconds` (10 s) after the previous one, so going
  from one to four processes takes about 25 s with the defaults. Boot is a small part of it: most of the delay is the
  controller waiting to be sure the heat is sustained. Retiring takes minutes by design. Lower `upAfterSeconds` and
  `upCooldownSeconds` to react faster, at the price of reacting to shorter bursts. Requests that arrive before the extra
  processes exist are served by the processes that do, so a very sharp spike can still queue.
- **In-flight requests are not a scaling signal.** A workload that is slow because it waits on something else (a database
  or an upstream API) will not scale up, on purpose.

## Compatibility

| | Tested | Untested |
|---|---|---|
| Runtime | Bun 1.4.x | Node, Deno, older Bun |
| Elysia | 2.0.0-rc.4, including a build made with Elysia's AOT plugin (the compiled binary ran on a Linux server) | 1.x and other 2.x versions |
| Eden | `@elysia/eden` 2.0.0-rc.1: the client types are identical with and without the plugin, and a call through a running two-process app worked (a valid body returned 200, an invalid one 422). The plugin adds no routes. | `@elysiajs/eden` 1.4.9 (its `treaty` types the responses of any Elysia 2.0.0-rc.4 app as `{}`, with or without this plugin) |
| OS | Linux (a Docker container), macOS (process lifecycle only) | Windows |
| cgroup limits | The parsers for v2 and v1 files are unit-tested with sample file contents. In a real container only the "no limit" case ran (every file said unlimited). | Reading an actual CPU or memory limit inside a container with a limit set, and cgroup v1 hosts |

## Runtimes

The process logic talks to the platform only through a small `Runtime` interface (`spawn`, IPC, `exit`, `sleep`, and a
way to count in-flight requests). Bun is the only implementation. A contract test (`test/runtime-contract.ts` in the
source repository, not in the npm package) describes what a port has to satisfy, and
[docs/ADDING-A-RUNTIME.md](docs/ADDING-A-RUNTIME.md) lists the steps and what is not yet known for Node.
You can pass your own implementation as the `runtime` option; treat that as experimental.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `EADDRINUSE` from the second process | `scaler.listenOptions` was not spread into `listen()`. |
| Stays at one process in `auto` | One CPU or a CPU limit of 1 or less, a memory limit under two processes' worth, or `max: 1`. A log line says so at start. |
| More processes, no speedup on macOS | Expected: macOS does not spread connections. Test on Linux. |
| Never scales up under load | The load is not CPU-bound (waiting on a database or network), or the threshold is too high for it. Check CPU per process. |
| Workers never scale down | Something keeps a process above 5% CPU or holds more than 2 requests in flight (a health check loop, a busy timer). |
| Cron job runs several times | It is not gated with `cluster.isPrimary`. |
| Error mentioning "runs on Bun only" | You started extra processes on a runtime without an implementation. |

## License

MIT. See [LICENSE](LICENSE).
