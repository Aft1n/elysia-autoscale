// Fixture for the integration tests: a real multi-process app, configured through AUTOSCALE_OPTS, listening on PORT.
import { Elysia } from "elysia";
import { autoscale, cluster } from "../../src/index";

const role = cluster.isWorker ? "worker" : "primary";
const who = `${role}:${process.pid}`;
const scaler = autoscale(JSON.parse(Bun.env.AUTOSCALE_OPTS ?? "{}"));

for (const topic of ["hello", "up", "relay"]) {
  cluster.on(topic, (data) => console.log(`got ${topic} ${JSON.stringify(data)} ${who}`));
}
// The primary answers each worker's announcement, so the workers' handlers are known to be registered.
if (!cluster.isWorker) cluster.on("up", () => cluster.broadcast("hello", { from: "primary" }));

const app = new Elysia()
  .use(scaler)
  .get("/ping", () => "pong")
  // Busy for `ms`, but yields every few ms so the event loop (and the controller) keeps running.
  .get("/burn", async ({ query }) => {
    const end = Date.now() + Number(query.ms ?? 1000);
    while (Date.now() < end) {
      const slice = performance.now() + 5;
      while (performance.now() < slice) {}
      await Bun.sleep(0);
    }
    return "done";
  })
  .onStart(() => {
    console.log(`ready ${who}`);
    if (cluster.isWorker) {
      cluster.broadcast("up", { pid: process.pid });
      setTimeout(() => cluster.broadcast("relay", { pid: process.pid }, { relay: true }), 1000);
    }
  })
  .listen({ port: Number(Bun.env.PORT), ...scaler.listenOptions });
if (!cluster.isWorker) process.once("SIGTERM", async () => { await app.stop(); process.exit(0); });
