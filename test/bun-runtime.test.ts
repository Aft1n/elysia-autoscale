import { join } from "node:path";
import { createBunRuntime } from "../src/runtime/bun";
import { runtimeContract } from "./runtime-contract";

runtimeContract("bun", () =>
  createBunRuntime({ command: [process.execPath, join(import.meta.dir, "fixtures/contract-worker.ts")] }),
);
