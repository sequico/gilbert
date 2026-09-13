import { serve } from "@hono/node-server";
import { startAgentFleet } from "./agent/agent.js";
import { createApp, sessionDocumentIo, sessions, useDurableSessions } from "./app.js";
import { bootInstallation } from "./bootstrap.js";
import { config, useConfiguration } from "./config.js";

async function main() {
  /*
   * The boot, before anything is served: the handshake, the Master's sign-in,
   * and the installation's own document in that account. It is what makes the
   * session store durable — the sessions are records in that document, so a
   * redeploy signs nobody out — and it is the only step that can tell a
   * deployment its handshake is missing. A failure here ends the process with
   * one line and a non-zero code, which is the whole of what a process with no
   * port has to report with (see `bootstrap.ts`).
   */
  const boot = await bootInstallation();
  /*
   * From here the process runs on the installation's own configuration: what
   * the document decides overrides the environment, and the fields it does not
   * carry — the version, the source URL, the limits — stay as the deployment
   * stated them.
   */
  useConfiguration(boot.configuration);
  await useDurableSessions(
    sessionDocumentIo(
      {
        authorization: boot.master.authorization,
        session: boot.master.session,
        username: boot.master.address,
      },
      boot.accountId,
    ),
    {
      ttlSeconds: boot.configuration.sessionTtl,
      rememberTtlSeconds: boot.configuration.sessionRememberTtl,
    },
  );
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
   * The fleet, beside the web tier in this process (ADR 0003): an installation
   * whose deployment names an agent serves and works from one command, and this
   * server's shutdown is what stops it. An installation with no agent named
   * starts none — the admin surface says so — and one that wants the fleet back
   * in a process of its own says `GILBERT_AGENT_INPROCESS=0` and runs
   * `node server/dist/agent/agent.js`.
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
