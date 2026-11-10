# Changelog

## 0.1.0

Initial release. Bun only; tested on Bun 1.4.x and Elysia 2.0.0-rc.4 on Linux.

- `autoscale(options)`: an Elysia plugin that runs one app across processes on one host, sharing a listening port
  through `SO_REUSEPORT` (`scaler.listenOptions`).
- Fixed mode (`processes: N`) and auto mode (`processes: "auto"`, with `min` and `max`).
- Auto mode scales up when a process is hot (CPU or event-loop lag) and retires the newest worker after a quiet period,
  with cooldowns; it drains workers before stopping them.
- Container limits: reads cgroup v2 and v1 CPU and memory limits and caps the process count to fit them (`respectLimits`).
- `cluster`: `isPrimary`, `isWorker`, `processCount()`, `broadcast(topic, data, { relay })`, `on(topic, handler)`.
- Crash-loop protection: a worker that dies right after start makes the primary exit so the platform restarts it.
- Workers exit when the primary goes away (no orphans), and drain on SIGTERM.
- `workerEnv`, `onDrain`, `log`, `runtime` (advanced; the seam for porting to another runtime).
