/**
 * The process that asks the loop for a pass (ADR 0031, 0034, 0036).
 *
 * `agent/loop.ts` works a run — it claims the installation, re-arms the waits it
 * finds, reads each account's changes and answers each one a rule covers — and a
 * pass is the caller's to ask for. This module is that caller, and the **server's
 * own boot is what starts it** (`index.ts`): the agent is part of the product, so
 * launching Gilbert is what makes it exist. It runs on the installation the boot
 * just read — the model the installation has chosen and the groups its principal
 * works — and asks the loop for a pass on an interval.
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
import type { BootConfiguration } from "../bootstrap.js";
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

/** Where the agent's lines go, and the two things a test may shorten. */
export interface AgentStartOptions {
  /** One line per event worth reading. */
  log?: (line: string) => void;
  /** `AGENT_PASS_INTERVAL_MS` unless a test needs the question asked sooner. */
  intervalMs?: number;
  /** Who holds the installation's claim. This process, unless a test names it. */
  holder?: string;
}

/**
 * Start the installation's agent on this process, or answer null because it has
 * nothing to run on.
 *
 * **The server's boot is where this is called** (`server/src/index.ts`), with the
 * installation that boot just read: the agent is part of the product rather than
 * a second thing an operator has to remember, so launching Gilbert is what makes
 * it exist. The installation's configuration is the one this process already
 * runs on (`config.ts`'s `useConfiguration`, called by that boot), which is what
 * makes the model, the groups and the waits the same ones a served request sees.
 *
 * **A condition that is missing leaves the agent idle, never the process down.**
 * Everything the agent needs is resolved here, and each absence is one line on
 * the log and `null` — the server goes on serving exactly as it would without an
 * agent, and `exit` stays the server's own fatal boot's business:
 *
 * - **A model** `boot.installation.agent.provider`, the installation's own
 *   document (ADR 0011, ADR 0031), together with the operator's statement about
 *   where it may sit (`boot.configuration.agent.allowPrivateProvider`,
 *   `GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER` in the environment). An installation
 *   with no model has no agent: a default provider nobody chose is the one thing
 *   the record forbids. Which document a booted process runs on is fixed at the
 *   boot, so a model chosen afterwards is in force at the next one.
 * - **A group to work**, from the one classifier for that question
 *   (`groupAccess.ts`'s `groupAccountsDetailed`): the accounts this principal
 *   works are its groups' own. A Master in no group has nothing to work, and
 *   that is one line rather than a loop that asks every thirty seconds for
 *   nothing.
 *
 * **A model it may not reach is not one of those.** Whether the provider's
 * address may be used is asked on every call (`model.ts`'s `assertUsableProvider`)
 * because that is where the installation's key would leave, so a provider that
 * is unreachable or refused is a **pass** that fails loudly and the next pass
 * tries again (`supervise` below).
 *
 * **And anything else that goes wrong here is a line too.** The conditions are
 * resolved inside a guard, so an unexpected failure — a session that is not what
 * it was, a document whose shape has moved — leaves the installation without an
 * agent rather than with a boot that fell over: the server is what a deployment
 * needs, and no agent is a degraded feature of it.
 */
export async function startAgent(
  boot: BootConfiguration,
  options: AgentStartOptions = {},
): Promise<AgentProcess | null> {
  const log = options.log ?? ((line: string) => console.log(line));
  const ctx: Ctx = {
    authorization: boot.master.authorization,
    session: boot.master.session,
    username: boot.master.address,
  };
  try {
    const access = modelAccess(
      boot.installation,
      boot.configuration.agent.allowPrivateProvider,
    );
    if (!access) {
      log(
        "[gilbert] agent: this installation has chosen no model, so the agent stays idle until one is chosen (ADR 0031)",
      );
      return null;
    }
    const accounts = [...(await groupAccountsDetailed(ctx)).groups.values()];
    if (!accounts.length) {
      log(
        "[gilbert] agent: the Master works no group, so the agent stays idle until it holds one",
      );
      return null;
    }
    const loop = new AgentLoop(ctx, {
      holder: options.holder ?? holderName(),
      accounts,
      access,
    });
    return supervise({ loop, intervalMs: options.intervalMs, log });
  } catch (err) {
    log(
      `[gilbert] agent: it could not be started, so this installation runs without one: ${errorMessage(err)}`,
    );
    return null;
  }
}

/** Who holds the claim, as a name the claim's own document can be read with. */
function holderName(): string {
  return `${hostname()}#${process.pid}`;
}
