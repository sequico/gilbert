import { serve } from "@hono/node-server";
import { startAgentFleet } from "./agent/worker.js";
import { createApp, sessions } from "./app.js";
import { config } from "./config.js";

async function main() {
  await sessions.init();
  const app = createApp();
  const server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    (info) => {
      /* The browser will not trust 0.0.0.0: it is not a potentially
         trustworthy origin, so security headers such as COOP are ignored and
         cross-origin work misbehaves there. The machine the console speaks to
         is the one the user opens, so when the server is bound to every
         interface (the container default) the printed address is localhost. */
      const shown =
        info.address === "0.0.0.0" || info.address === "::" ? "localhost" : info.address;
      console.log(
        `[gilbert] ${config.appName} listening on http://${shown}:${info.port}`,
      );
      console.log(`[gilbert] upstream Stalwart: ${config.stalwartUrl}`);
      console.log(`[gilbert] static dir: ${config.staticDir}`);
    },
  );

  /*
   * The fleet, beside the web tier in this process (ADR 0012): an installation
   * whose deployment names an agent serves and works from one command, and this
   * server's shutdown is what stops it. An installation with no agent named
   * starts none — the admin surface says so — and one that wants the fleet back
   * in a process of its own says `GILBERT_AGENT_INPROCESS=0` and runs
   * `node server/dist/agent/worker.js`.
   */
  const fleet =
    config.agent.inprocess && config.agent.address ? await startAgentFleet() : null;

  const shutdown = async (signal: string) => {
    console.log(`[gilbert] ${signal} received, shutting down`);
    server.close();
    await fleet?.stop();
    await sessions.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[gilbert] fatal:", err);
  process.exit(1);
});
