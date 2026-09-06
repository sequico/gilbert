import { serve } from "@hono/node-server";
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
        `[ihasmail] ${config.appName} listening on http://${shown}:${info.port}`,
      );
      console.log(`[ihasmail] upstream Stalwart: ${config.stalwartUrl}`);
      console.log(`[ihasmail] static dir: ${config.staticDir}`);
    },
  );

  const shutdown = async (signal: string) => {
    console.log(`[ihasmail] ${signal} received, shutting down`);
    server.close();
    await sessions.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[ihasmail] fatal:", err);
  process.exit(1);
});
