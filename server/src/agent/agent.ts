/**
 * The agent process (ADR 0031, 0034, 0036).
 *
 * `gilbertserver`'s second process: it boots on the deployment's own handshake
 * exactly as the server does, and where the server serves, it supervises the
 * loop (`supervisor.ts`). A deployment that names a Master runs it beside its
 * server — `npm run agent`, and `dev:mock:agent` for the mock stack — and a
 * deployment that names none stops at the boot, which is what every process
 * without the handshake does (ADR 0011).
 *
 * Nothing is served here and no route is added: this process has no port, and
 * what it keeps between passes is nothing. An installation that has chosen no
 * model has no agent (ADR 0031), so this exits saying so rather than inventing
 * one — the exit is clean, and the installation is complete without it.
 */

import { errorMessage } from "../shared/errors.js";
import { startAgent } from "./supervisor.js";

async function main(): Promise<void> {
  const agent = await startAgent();
  if (!agent) return;
  const stop = (signal: string): void => {
    console.log(`[gilbert] ${signal} received, the agent stops`);
    agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(`[gilbert] the agent did not start: ${errorMessage(err)}`);
  process.exit(1);
});
