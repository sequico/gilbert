/**
 * The process that asks the loop for a pass (ADR 0031, 0034, 0036).
 *
 * `agent/loop.ts` works a run — it claims the installation, re-arms the waits it
 * finds, reads each account's changes and answers each one a rule covers — and a
 * pass is the caller's to ask for. This module is that caller: the **agent
 * process** boots with the deployment's own handshake exactly as the server does
 * (`agent.ts`), resolves the installation's model and the groups the Master
 * works, and puts one question to the loop on an interval.
 *
 * **The interval is the whole of its policy.** The loop already knows what is
 * due — the dated waits and each account's change log — so there is no schedule
 * here, no queue and no backlog: a pass is asked, and the loop decides what that
 * pass works. Thirty seconds is sized to the waiting: a run parked on a date is
 * picked up within half a minute of it, a person's answer is not left for
 * minutes, and a pass costs one claim read and one change read per account,
 * which is nothing to repeat at that rate. It is far below the claim's own
 * `CLAIM_TTL_MS` (ten minutes), so a working process's renewals are ordinary
 * rather than a race with its own expiry.
 *
 * **One pass at a time.** A pass slower than the interval is not overtaken:
 * overlapping passes of one process would work the same run twice, which is the
 * thing the claim exists to prevent between processes.
 *
 * **A failure is loud, and it is not fatal.** A pass that throws — a mail server
 * that did not answer, a document that could not be written — is logged with its
 * reason and the schedule goes on: the next pass is the retry, and a run is a
 * document precisely so a failed pass loses nothing. Nothing is retried in a
 * tight loop, because a pass that failed against a broken Stalwart fails again
 * the moment it is repeated.
 *
 * **A claim a peer holds is not an error.** The loop answers such a pass without
 * working anything (ADR 0036), which is one installation with one agent: this
 * process waits its turn rather than fighting for the claim or reporting a
 * refusal. That is also the whole of what a dead peer costs — its claim lapses
 * at `CLAIM_TTL_MS` and the next pass takes the installation over, with no
 * document deleted by hand and nothing here to recover.
 *
 * **Nothing is kept.** The loop, its reading cursors and its alarms live in
 * memory, which is disposable by law (`IMMUTABLE=1`, ADR 0031): what outlives
 * the process is the claim, the runs and the waits, all documents in Stalwart.
 * There is no lock file, no pid file and no state of its own on disk.
 */

import { hostname } from "node:os";
import type { Ctx } from "../appFolder.js";
import { type BootConfiguration, type BootDeps, bootInstallation } from "../bootstrap.js";
import { useConfiguration } from "../config.js";
import type { InstallationEnvironment } from "../configuration.js";
import { groupAccountsDetailed } from "../groupAccess.js";
import { errorMessage } from "../shared/errors.js";
import { AgentLoop, type PassSummary } from "./loop.js";
import { modelAccess } from "./model.js";

/**
 * How often the supervisor puts its one question to the loop.
 *
 * A constant rather than a setting: an installation has one model and one
 * agent, and how often the agent asks is not a question the administration is
 * asked. It is short enough that a person's answer is not left waiting minutes
 * and that a dated wait is picked up close to its instant, and long enough that
 * a pass — one claim read and one change read per group — is nothing to repeat
 * (`supervisor.ts` above says what the pass costs).
 */
export const AGENT_PASS_INTERVAL_MS = 30_000;

/**
 * The half of the loop this module uses.
 *
 * Declared rather than taking an `AgentLoop`, so a test can hand it a stand-in
 * and pin what the supervisor itself does — how often it asks, what it does with
 * a failure, what it says about a claim it does not hold — without a model, a
 * mail server or a run.
 */
export interface PassableLoop {
  /** One pass: what the loop works. `claimed` false means a peer holds the installation. */
  pass(now?: Date): Promise<PassSummary>;
  /** Give up the loop's alarms; the claim lapses on its own. */
  stop(): void;
}

/** What one supervised process needs. */
export interface SupervisorOptions {
  /** The loop each pass is asked of. */
  loop: PassableLoop;
  /** `AGENT_PASS_INTERVAL_MS` unless a test needs the question asked sooner. */
  intervalMs?: number;
  /** One line per event worth reading. */
  log?: (line: string) => void;
  /** The clock a pass is stamped with. The wall clock unless a test says otherwise. */
  now?: () => Date;
}

/** A running supervisor: the schedule, and the one way to give it up. */
export interface AgentProcess {
  /** Give up the schedule and the loop's alarms. The claim lapses on its own (ADR 0036). */
  stop(): void;
}

/**
 * Ask the loop for a pass on an interval, and only one at a time.
 *
 * The first pass is immediate — a process that has just started works what the
 * installation left, so a wait that came due while it was down is due now,
 * rather than waiting out one interval first — and the interval carries it on.
 */
export function supervise(options: SupervisorOptions): AgentProcess {
  const log = options.log ?? ((line: string) => console.log(line));
  const intervalMs = options.intervalMs ?? AGENT_PASS_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  let running = false;
  let stopped = false;
  /**
   * Whether the last pass found the claim held by a peer, so the line about it
   * is written once per change of state rather than once per pass: a held claim
   * is an installation with its one agent already, not an event to report every
   * thirty seconds.
   */
  let heldByPeer = false;

  async function pass(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const summary = await options.loop.pass(now());
      if (summary.claimed) {
        if (heldByPeer) {
          heldByPeer = false;
          log("[gilbert] agent: the installation's claim is this process's again");
        }
      } else if (!heldByPeer) {
        heldByPeer = true;
        log(
          "[gilbert] agent: another process holds the installation's claim, so this one waits its turn",
        );
      }
    } catch (err) {
      log(
        `[gilbert] agent: the pass failed and the next one will try again: ${errorMessage(err)}`,
      );
    } finally {
      running = false;
    }
  }

  void pass();
  const timer = setInterval(() => void pass(), intervalMs);
  log(`[gilbert] agent: asking for a pass every ${Math.round(intervalMs / 1000)} s`);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      options.loop.stop();
    },
  };
}

/** What the agent process reads: the environment a boot reads, and where its lines go. */
export interface AgentDeps {
  /** The environment a boot reads; this process's own unless a test hands over one. */
  env?: InstallationEnvironment;
  /** One line per event worth reading. */
  log?: (line: string) => void;
  /** How a failed boot ends the process. `process.exit` unless a test says otherwise. */
  exit?: (code: number) => never;
  /** The boot, `bootInstallation` unless a test hands over its own. */
  boot?: (deps: BootDeps) => Promise<BootConfiguration>;
  /** `AGENT_PASS_INTERVAL_MS` unless a test needs the question asked sooner. */
  intervalMs?: number;
  /** Who holds the installation's claim. This process, unless a test names it. */
  holder?: string;
}

/**
 * Boot as the Master, and supervise the loop for the installation, or answer
 * null because this installation has no agent.
 *
 * The boot is the server's own, unchanged: the handshake, the Master's sign-in,
 * the installation's document, the configuration (`bootstrap.ts`). A process
 * whose handshake is missing stops there, exactly as every process does today —
 * nothing is added before it, so a deployment that has switched nothing on sees
 * no line, no error and no route from this module.
 *
 * **An installation with no model has no agent** (ADR 0031). The model is the
 * administration's choice and lives in the installation's own document, so a
 * document that states none is answered with one line and no process: the
 * installation is complete without an agent, and the alternative — a default
 * provider nobody chose — is the one thing the record forbids. The model a
 * process runs on is the one the document stated at this boot, because that is
 * when the installation's configuration is in force (ADR 0011).
 *
 * The accounts a pass works are the installation's **groups** — the accounts the
 * one classifier for that question names (`groupAccess.ts`) — resolved once,
 * here: a grant withdrawn in Stalwart is read at the next boot, which is when
 * every other installation decision moves too. A group nobody could ask about is
 * not worked, and `groupAccountsDetailed` says so to whoever shows a person a
 * list; a pass over the accounts it named carries on.
 */
export async function startAgent(deps: AgentDeps = {}): Promise<AgentProcess | null> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const boot = await (deps.boot ?? bootInstallation)({
    env: deps.env,
    log,
    exit: deps.exit,
  });
  useConfiguration(boot.configuration);
  const ctx: Ctx = {
    authorization: boot.master.authorization,
    session: boot.master.session,
    username: boot.master.address,
  };
  const access = modelAccess(
    boot.installation,
    boot.configuration.agent.allowPrivateProvider,
  );
  if (!access) {
    log("[gilbert] agent: this installation has chosen no model, so it has no agent");
    return null;
  }
  const accounts = [...(await groupAccountsDetailed(ctx)).groups.values()];
  const loop = new AgentLoop(ctx, {
    holder: deps.holder ?? holderName(),
    accounts,
    access,
  });
  return supervise({ loop, intervalMs: deps.intervalMs, log });
}

/** Who holds the claim, as a name the claim's own document can be read with. */
function holderName(): string {
  return `${hostname()}#${process.pid}`;
}
