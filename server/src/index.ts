import { serve } from "@hono/node-server";
import { startAgent } from "./agent/supervisor.js";
import { startAgentWake } from "./agent/wake.js";
import { createApp, sessionDocumentIo, sessions, useDurableSessions } from "./app.js";
import { bootInstallation } from "./bootstrap.js";
import { assertServable, config, useConfiguration } from "./config.js";
import { ensureGlobalContacts } from "./globalContactsAdmin.js";
import { ensureKnowledge } from "./knowledgeAdmin.js";
import { releaseOnShutdown } from "./push.js";
import { errorMessage } from "./shared/errors.js";
import { ensureWorkorders } from "./workorderAdmin.js";

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
   * carry — the version, the source URL, the admin marker, and the operator's
   * own provider switch — stay as the deployment stated them.
   */
  useConfiguration(boot.configuration);
  /*
   * The boot has run, so the deployment is known and a secret nothing stated is
   * a fact rather than a guess: this is where a production process that would
   * serve on an ephemeral one is refused. Making it here, rather than at the
   * import of `config.ts`, is what lets a deployment state its secret in the
   * installation's own document — and the refusal is logged with every other
   * failure that stops this process, which is the only channel a process with
   * no port has.
   */
  assertServable(config);
  /*
   * Global contacts (ADR 0019): the installation's directory exists because the
   * installation needs it, not because an administrator made it. Created once,
   * as the Master, before anything is served, so the section is there for every
   * reader on the first load (read through the route, not a share). A failure is
   * logged and does not stop the process: a directory that could not be reached
   * is a degraded feature, not a boot that cannot serve.
   */
  await ensureGlobalContacts(
    {
      authorization: boot.master.authorization,
      session: boot.master.session,
      username: boot.master.address,
    },
    boot.accountId,
  ).catch((err) => {
    console.warn("[gilbert] Global contacts could not be prepared:", errorMessage(err));
  });
  /*
   * The company knowledge base (ADR 0020): the Master-owned folder exists
   * because the installation needs it, not because somebody created it, and is
   * read through the route (a `shareWith` cannot reach every account). Created
   * once, as the Master, before anything is served. A failure is logged and
   * does not stop the process: a knowledge base that could not be reached is a
   * degraded feature, not a boot that cannot serve.
   */
  await ensureKnowledge(
    {
      authorization: boot.master.authorization,
      session: boot.master.session,
      username: boot.master.address,
    },
    boot.accountId,
  ).catch((err) => {
    console.warn(
      "[gilbert] The knowledge base could not be prepared:",
      errorMessage(err),
    );
  });
  /*
   * The workorder registry (ADR 0024): the Master's `workorders/` folder and
   * its `closed/` child exist because the installation needs them, not because
   * somebody created them. Created once, as the Master, before anything is
   * served. A failure is logged and does not stop the process: a registry that
   * could not be reached is a degraded feature, not a boot that cannot serve.
   */
  await ensureWorkorders(
    {
      authorization: boot.master.authorization,
      session: boot.master.session,
      username: boot.master.address,
    },
    boot.accountId,
  ).catch((err) => {
    console.warn("[gilbert] Workorders could not be prepared:", errorMessage(err));
  });
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
  /*
   * The installation's agent (ADR 0038): part of this process, started here with
   * the installation this boot just read, so launching Gilbert is what makes it
   * exist — nothing for an operator to start or remember. It asks the loop for a
   * pass every `AGENT_PASS_INTERVAL_MS` (ten seconds) and claims the
   * installation, which is what keeps a second copy of this process (a rolling
   * restart, an operator's mistake) out of the same runs (ADR 0032).
   *
   * Nothing about the Master's groups is decided here: each pass asks which
   * accounts it works (`supervisor.ts`'s `resolveGroupAccounts`), so a group the
   * Master is added to in Stalwart's directory is worked by the next pass, with
   * no restart of this process.
   *
   * It never takes the process down: an installation with no model, one whose
   * principal works no group, and anything else it cannot resolve is one line on
   * the log and an idle agent (`supervisor.ts`), never a boot that fails.
   */
  const agent = await startAgent(boot, {
    log: (line: string) => console.log(line),
  });
  /*
   * The agent's own event stream, with the Master's credential: one upstream
   * connection, open with every tab closed. Stalwart's StateChange is the
   * reason for a pass and the interval is the floor; a stream that drops is
   * re-opened with a growing pause, and the interval covers the gap.
   */
  const stopWake = agent
    ? startAgentWake(
        {
          eventSourceUrl: boot.master.session.eventSourceUrl,
          baseUrl: boot.master.session.baseUrl ?? config.stalwartUrl,
          authorization: boot.master.authorization,
        },
        () => agent.kick(),
      )
    : () => {};
  const app = createApp();
  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
    },
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
   * The server's shutdown stops what it started: the agent's schedule, the
   * sessions, and the push subscriptions a live credential is needed to release.
   */
  const shutdown = async (signal: string) => {
    console.log(`[gilbert] ${signal} received, shutting down`);
    server.close();
    stopWake();
    await agent?.stop();
    /* Before the sessions go: releasing a subscription needs a live credential,
       and what is left behind otherwise holds one of the account's fifteen
       slots for as long as it lives. A deploy is a shutdown. */
    await releaseOnShutdown();
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
