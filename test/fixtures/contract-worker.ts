// Worker used by runtime-contract.ts. Speaks the protocol the contract expects: ready, pong, exit.
import { resolveRuntime } from "../../src/runtime";

const runtime = resolveRuntime();
runtime.sendToPrimary({ cmd: "ready" });
runtime.onPrimaryMessage((raw) => {
  // The contract's primary only sends the messages handled below.
  const message = raw as { cmd: string; n?: number };
  if (message.cmd === "ping") {
    runtime.sendToPrimary({
      cmd: "pong",
      n: message.n,
      value: process.env.CONTRACT_VALUE,
      pending: runtime.pendingRequests({ pendingRequests: 4 }),
    });
  }
  if (message.cmd === "exit") runtime.exit(3);
});
// Keeps the event loop alive until the primary says otherwise.
setInterval(() => {}, 1000);
