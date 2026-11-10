import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// Real multi-process runs of test/fixtures/app.ts. Each test owns its processes and stops them at the end.
// The controller and load meter run on the real clock, so the tests poll the child's output instead of faking time.
const FIXTURE = join(import.meta.dir, "fixtures/app.ts");

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("Bun.serve did not report a port");
  return port;
}

async function launch(options: Record<string, unknown>) {
  const port = await freePort();
  const proc = Bun.spawn([process.execPath, FIXTURE], {
    env: { ...process.env, PORT: String(port), AUTOSCALE_OPTS: JSON.stringify(options) },
    stdout: "pipe",
    stderr: "inherit",
  });
  let text = "";
  void (async () => {
    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) text += chunk;
  })();

  const waitUntil = async (check: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out; output so far:\n${text}`);
      await Bun.sleep(50);
    }
  };
  return {
    port,
    pid: proc.pid,
    text: () => text,
    waitFor: (pattern: RegExp, ms?: number) => waitUntil(() => pattern.test(text), ms),
    waitUntil,
    async stop() {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

describe("fixed processes", () => {
  test("two processes both start, and broadcasts reach the primary and the worker", async () => {
    const run = await launch({ processes: 2, log: false });
    try {
      await run.waitFor(/ready primary:\d+/);
      await run.waitFor(/ready worker:\d+/);
      await run.waitFor(/got up \{"pid":\d+\} primary:\d+/); // worker -> primary
      await run.waitFor(/got hello \{"from":"primary"\} worker:\d+/); // primary -> worker
      expect(run.text()).not.toContain("worker exited");
    } finally {
      await run.stop();
    }
  }, 30_000);

  test("relay: a worker's message reaches the other worker through the primary", async () => {
    const run = await launch({ processes: 3, log: false });
    try {
      // A message from one worker that lands in a different worker proves the forward; the primary does not echo to the sender.
      const crossed = () =>
        [...run.text().matchAll(/got relay \{"pid":(\d+)\} worker:(\d+)/g)].filter((m) => m[1] !== m[2]);
      await run.waitUntil(() => crossed().length >= 2);
    } finally {
      await run.stop();
    }
  }, 30_000);
});

describe("auto processes", () => {
  test("adds a process under CPU load and retires it when quiet", async () => {
    // Thresholds are lowered so a burn triggers scaling within seconds.
    const run = await launch({
      processes: "auto",
      max: 2,
      respectLimits: false,
      hotCpu: 0.5,
      upAfterSeconds: 1,
      upCooldownSeconds: 1,
      downCooldownSeconds: 1,
      idleSeconds: 2,
    });
    try {
      await run.waitFor(/ready primary:\d+/);
      const burns = Array.from({ length: 4 }, () =>
        fetch(`http://127.0.0.1:${run.port}/burn?ms=4000`).then((r) => r.text()),
      );
      await run.waitFor(/workers: 1 -> 2 \(busy: \d+% of a core, loop delay \d+ ms, \d+ in flight\)/);
      await Promise.all(burns);
      await run.waitFor(/workers: 2 -> 1 \(quiet for 2s\)/);
      expect(run.text()).not.toContain("worker exited with code");
    } finally {
      await run.stop();
    }
  }, 30_000);
});

describe("orphans", () => {
  test("a worker exits when the primary is SIGKILLed", async () => {
    const run = await launch({ processes: 2, log: false });
    try {
      await run.waitFor(/ready worker:\d+/);
      const worker = /ready worker:(\d+)/.exec(run.text())?.[1];
      if (!worker) throw new Error("no worker pid in output");
      process.kill(run.pid, "SIGKILL");
      // Real clock on purpose: the claim is that the OS process goes away, which no fake runtime can show.
      await run.waitUntil(() => !alive(Number(worker)));
    } finally {
      await run.stop();
    }
  }, 30_000);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
