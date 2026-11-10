import { describe, expect, test } from "bun:test";
import type { Runtime, WorkerHandle } from "../src/runtime";
import { until } from "./helpers";

/**
 * Behaviour every runtime must provide. A port (for example node:cluster) runs this file against its own
 * `makeRuntime`; the worker it spawns must answer the protocol of `fixtures/contract-worker.ts`.
 * `makeRuntime` must return a runtime whose `spawn` starts that worker.
 */
export function runtimeContract(name: string, makeRuntime: () => Runtime): void {
  describe(`runtime contract: ${name}`, () => {
    test("has a name", () => {
      expect(makeRuntime().name.length).toBeGreaterThan(0);
    });

    test("pendingRequests reads the server's counter, or undefined when there is none", () => {
      const runtime = makeRuntime();
      expect(runtime.pendingRequests({ pendingRequests: 2 })).toBe(2);
      expect(runtime.pendingRequests({})).toBeUndefined();
      expect(runtime.pendingRequests(undefined)).toBeUndefined();
    });

    // Real wall-clock on purpose: this checks that sleep actually waits.
    test("sleep waits at least the requested time", async () => {
      const started = performance.now();
      await makeRuntime().sleep(50);
      expect(performance.now() - started).toBeGreaterThanOrEqual(45);
    });

    test("worker gets its env, messages the primary, receives messages, and exits with its code", async () => {
      const runtime = makeRuntime();
      const messages: Record<string, unknown>[] = [];
      const exits: (number | null)[] = [];
      let sender: WorkerHandle | undefined;
      const worker = runtime.spawn({
        env: { PATH: process.env.PATH ?? "", CONTRACT_VALUE: "hello" },
        onMessage(message, from) {
          messages.push(message as Record<string, unknown>);
          sender = from;
        },
        onExit: (code) => exits.push(code),
      });

      await until(() => messages.some((m) => m.cmd === "ready"));
      worker.send({ cmd: "ping", n: 1 });
      await until(() => messages.some((m) => m.cmd === "pong"));

      expect(messages.find((m) => m.cmd === "pong")).toEqual({ cmd: "pong", n: 1, value: "hello", pending: 4 });
      expect(sender).toBe(worker);

      worker.send({ cmd: "exit" });
      expect(await worker.exited).toBe(3);
      await until(() => exits.length > 0);
      expect(exits).toEqual([3]);
    });

    test("kill stops a worker and the exit callback runs once", async () => {
      const runtime = makeRuntime();
      const exits: (number | null)[] = [];
      const worker = runtime.spawn({
        env: { PATH: process.env.PATH ?? "" },
        onMessage() {},
        onExit: (code) => exits.push(code),
      });

      worker.kill("SIGKILL");
      await worker.exited;
      await until(() => exits.length > 0);
      expect(exits).toHaveLength(1);
    });
  });
}
