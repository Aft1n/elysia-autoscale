import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { autoscale, cluster, type AutoscaleOptions } from "../src/index";
import { createFakeRuntime } from "./fake-runtime";
import { until } from "./helpers";

// The plugin keeps process-wide state (live workers, the stop flag, topic handlers), so the tests share one
// process and run in file order. The stop test stays last: after app.stop() the plugin never respawns again.

async function start(options: AutoscaleOptions = {}) {
  const runtime = createFakeRuntime();
  const log: string[] = [];
  const scaler = autoscale({ runtime, log: (line) => log.push(line), ...options });
  const app = new Elysia().use(scaler).listen({ port: 0, ...scaler.listenOptions });
  return { runtime, log, app };
}

describe("primary/worker logic on a fake runtime", () => {
  test("fixed N spawns N-1 workers with the worker env and workerEnv", async () => {
    const { runtime } = await start({ processes: 3, workerEnv: { MIGRATE_ON_BOOT: "false" } });
    await until(() => runtime.workers.length === 2);

    expect(runtime.workers.map((worker) => worker.env.ELYSIA_AUTOSCALE_WORKER)).toEqual(["1", "1"]);
    expect(runtime.workers[0].env.MIGRATE_ON_BOOT).toBe("false");
    expect(runtime.workers[0].env.ELYSIA_AUTOSCALE_ELASTIC).toBeUndefined();
  });

  test("processes: 1 is inert and never touches a runtime", () => {
    const scaler = autoscale({ processes: 1 });
    expect(() => new Elysia().use(scaler).listen({ port: 0, ...scaler.listenOptions })).not.toThrow();
  });

  test("a worker message reaches cluster.on handlers, and relay reaches the other workers only", async () => {
    const { runtime } = await start({ processes: 3 });
    await until(() => runtime.workers.length === 2);
    const [sender, other] = runtime.workers;
    const seen: unknown[] = [];
    cluster.on("relay-test", (data) => seen.push(data));

    sender.deliver({ topic: "relay-test", data: { n: 1 }, relay: true });

    expect(seen).toEqual([{ n: 1 }]);
    expect(other.sent).toContainEqual({ topic: "relay-test", data: { n: 1 }, relay: true });
    expect(sender.sent).not.toContainEqual(expect.objectContaining({ topic: "relay-test" }));
  });

  test("cluster.broadcast reaches every live worker", async () => {
    const { runtime } = await start({ processes: 3 });
    await until(() => runtime.workers.length === 2);

    cluster.broadcast("wake", { at: 1 });

    for (const worker of runtime.workers) {
      expect(worker.sent).toContainEqual({ topic: "wake", data: { at: 1 }, relay: false });
    }
  });

  test("a worker that dies right after start exits the primary with code 1, without respawn", async () => {
    const { runtime } = await start({ processes: 2 });
    await until(() => runtime.workers.length === 1);

    runtime.workers[0].finish(1);

    expect(runtime.exits).toEqual([1]);
    expect(runtime.workers).toHaveLength(1);
  });

  test("a worker that dies after the crash-loop window is respawned", async () => {
    const { runtime } = await start({ processes: 2 });
    await until(() => runtime.workers.length === 1);
    const errors = spyOn(console, "error").mockImplementation(() => {});

    setSystemTime(new Date(Date.now() + 6_000));
    try {
      runtime.workers[0].finish(1);
    } finally {
      setSystemTime();
      errors.mockRestore();
    }

    expect(runtime.exits).toEqual([]);
    expect(runtime.workers).toHaveLength(2);
  });

  test("auto: adds a process under load, then drains the newest one when quiet", async () => {
    // Needs more than one CPU for the budget to allow a second process.
    let busy = true;
    let spent = 0;
    const cpu = spyOn(process, "cpuUsage").mockImplementation(() => {
      if (busy) spent += 1_000_000; // one second of CPU per read: a saturated core
      return { user: spent, system: 0 };
    });
    try {
      const { runtime, log } = await start({
        processes: "auto",
        max: 2,
        respectLimits: false,
        hotLagMs: 1e9,
        upAfterSeconds: 1,
        upCooldownSeconds: 0,
        idleSeconds: 1,
        downCooldownSeconds: 0,
      });
      await until(() => runtime.workers.length === 1);
      expect(log.some((line) => line.startsWith("workers: 1 -> 2 (busy:"))).toBe(true);

      busy = false;
      await until(() => log.includes("workers: 2 -> 1 (quiet for 1s)"));
      expect(runtime.workers[0].sent).toContainEqual({ topic: "__autoscale:drain" });

      // The retiring worker exiting must not respawn it.
      runtime.workers[0].finish(0);
      expect(runtime.workers).toHaveLength(1);
      expect(log.some((line) => line.includes("2 -> 3"))).toBe(false);
    } finally {
      cpu.mockRestore();
    }
  }, 20_000);

  test("auto with min: min processes exist at boot, growth continues above min, and it settles back to min", async () => {
    let busy = false;
    let spent = 0;
    const cpu = spyOn(process, "cpuUsage").mockImplementation(() => {
      if (busy) spent += 1_000_000; // one second of CPU per read: a saturated core
      return { user: spent, system: 0 };
    });
    try {
      const { runtime, log } = await start({
        processes: "auto",
        max: 3,
        min: 2,
        respectLimits: false,
        hotLagMs: 1e9,
        upAfterSeconds: 1,
        upCooldownSeconds: 0,
        idleSeconds: 1,
        downCooldownSeconds: 0,
      });
      // The second process is there before any load.
      await until(() => runtime.workers.length === 1);
      expect(runtime.workers[0].env.ELYSIA_AUTOSCALE_ELASTIC).toBe("1");
      expect(log).toContain("workers: keeping at least 2 processes (min)");

      busy = true;
      await until(() => runtime.workers.length === 2);
      expect(log.some((line) => line.startsWith("workers: 2 -> 3 (busy:"))).toBe(true);

      busy = false;
      await until(() => log.includes("workers: 3 -> 2 (quiet for 1s)"));
      expect(runtime.workers[1].sent).toContainEqual({ topic: "__autoscale:drain" });
      // The first process is never the one retired.
      expect(runtime.workers[0].sent).not.toContainEqual({ topic: "__autoscale:drain" });
    } finally {
      cpu.mockRestore();
    }
  }, 20_000);

  test("min is capped by the process budget: with max 1 nothing is started", async () => {
    const { runtime, log } = await start({ processes: "auto", max: 1, min: 3, respectLimits: false });
    await until(() => log.some((line) => line.includes("staying at one")));
    expect(runtime.workers).toHaveLength(0);
  });

  // Must stay last: stopping is one-way for the process.
  test("app.stop() SIGTERMs every worker and waits for them to exit", async () => {
    const { runtime, app } = await start({ processes: 3 });
    await until(() => runtime.workers.length === 2);
    const [first, second] = runtime.workers;

    await app.stop();

    expect(first.killed).toEqual(["SIGTERM"]);
    expect(second.killed).toEqual(["SIGTERM"]);
    expect(runtime.workers).toHaveLength(2);
  });
});
