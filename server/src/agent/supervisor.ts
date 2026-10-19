/**
 * The process that asks the loop for a pass (ADR 0031, 0034, 0036).
 *
 * `agent/loop.ts` works a run — it claims the installation, re-arms the waits it
 * finds, reads each account's changes and answers each one a rule covers — and a
 * pass is the caller's to ask for. This module is that caller, and the **server's
 * own boot is what starts it** (`index.ts`): the agent is part of the product, so
 * launching Gilbert is what makes it exist. It runs on the installation the boot
 * just read — the model the installation has chosen, and the line of prose its
 * document carries into every call (ADR 0035) — and asks the loop for a pass on
 * an interval. The groups it works are **not** settled at the boot:
 * every pass reads them from the mail server (`resolveGroupAccounts` below), so
 * a grant added or withdrawn in Stalwart's own directory needs no restart.
 *
 * **The interval is the whole of its policy.** The loop already knows what is
 * due — the dated waits and each account's change log — so there is no schedule
 * here, no queue and no backlog: a pass is asked, and the loop decides what that
 * pass works. Ten seconds is sized to the waiting: a run parked on a date is
 * picked up within ten seconds of it, a person's answer is not left for minutes,
 * and a group the Master is taken into in Stalwart's own directory is worked by
 * the very next pass, because nothing about the installation's groups is decided
 * at the boot (`loop.ts` asks for the accounts on every pass). A pass with
 * nothing to do is cheap enough to repeat at that rate: it reads the
 * installation's claim (one read, and no write while it is held — ADR 0036),
 * re-reads the session the Master's groups are resolved from (one read, and the
 * mail-store probe the one classifier for that question makes per candidate only
 * when the session names a different set of candidates — `groupAccess.ts`), and
 * reads each group's runs and its change log (a request per page apiece, and a
 * run document whose stamp has not moved is not downloaded again). It
 * asks the model **only** when a rule covers a change (ADR 0035), so a quiet
 * installation costs reads and nothing else. Ten seconds is far below the
 * claim's own `CLAIM_TTL_MS` (ten
 * minutes), so a working process's renewals are ordinary rather than a race with
 * its own expiry.
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
 * **A normal pass is not an event.** It writes no line: what a pass worked is
 * the runs and the change logs, and the record of it is the run document, not a
 * log. What is said is said **when it changes** — a pass that failed and its
 * reason, an installation whose Master works no group and the one that picks a
 * group up again, a claim a peer holds and this process taking it back, and a
 * gap a pass reported (a rule sheet this build cannot read, a change log that
 * skipped) — and never once per ten seconds. The line a person reads is one
 * they can act on.
 *
 * **Nothing is kept.** The loop, its reading cursors, the roster the last pass
 * resolved and its alarms live in memory, which is disposable by law
 * (`IMMUTABLE=1`, ADR 0031): what outlives the process is the claim, the runs
 * and the waits, all documents in Stalwart. There is no lock file, no pid file
 * and no state of its own on disk.
 */

import { hostname } from "node:os";
import type { Ctx } from "../appFolder.js";
import type { BootConfiguration } from "../bootstrap.js";
import { groupAccountsDetailed } from "../groupAccess.js";
import { errorMessage } from "../shared/errors.js";
import { groupCandidates } from "../shared/sessionAccount.js";
import { fetchUpstreamSession, upstreamFor } from "../upstream.js";
import { AgentLoop, type PassSummary } from "./loop.js";
import { modelAccess, setRunningModelAccess } from "./model.js";

/**
 * How often the supervisor puts its one question to the loop.
 *
 * A constant rather than a setting: an installation has one model and one
 * agent, and how often the agent asks is not a question the administration is
 * asked. Ten seconds: short enough that a group the Master is added to is worked
 * by the next pass, that a dated wait is picked up close to its instant and that
 * a person's answer is not left waiting minutes, and long enough that a pass
 * with nothing to do — the claim, the groups, and each group's runs and change
 * log — is nothing to repeat at that rate (`supervisor.ts` above says what the
 * pass costs). It is well inside `CLAIM_TTL_MS` (ten minutes), so a working
 * process's renewals are ordinary and not a race with its own expiry.
 */
export const AGENT_PASS_INTERVAL_MS = 10_000;

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
interface SupervisorOptions {
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
interface AgentProcess {
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
   * ten seconds.
   */
  let heldByPeer = false;
  /**
   * Whether the Master works no group, said the same way — once when the agent
   * goes idle and once when it has something to work again. A Master in no group
   * is a state of the installation, not an event: the line says the agent is
   * idle *now*, and the passes after it say nothing.
   */
  let idle = false;
  /**
   * The gaps the last pass reported, so one is said when it appears and not on
   * every beat: an unreadable rule sheet or a change log that skipped says the
   * same sentence ten seconds later, and a fault that has gone stops being said.
   */
  let saidGaps = new Set<string>();

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
        if (summary.accounts === 0) {
          if (!idle) {
            idle = true;
            log(
              "[gilbert] agent: the Master works no group, so the agent stays idle until it holds one",
            );
          }
        } else if (idle) {
          idle = false;
          log(
            "[gilbert] agent: the Master works a group again, so the agent is working it",
          );
        }
        for (const gap of summary.gaps)
          if (!saidGaps.has(gap)) log(`[gilbert] agent: ${gap}`);
        saidGaps = new Set(summary.gaps);
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
      log("[gilbert] agent: stopping, and the claim lapses on its own (ADR 0036)");
    },
  };
}

/** Where the agent's lines go, and the two things a test may shorten. */
interface AgentStartOptions {
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
 *
 * **The groups are not one of those, and are deliberately not resolved here.**
 * What the Master works is asked afresh on every pass (`resolveGroupAccounts`)
 * rather than once at the start, which is what makes a group added in Stalwart's
 * directory be worked by the next pass — and a Master who works no group at this
 * moment is an agent that is idle, said once (`supervise` below), never one that
 * does not exist.
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
    setRunningModelAccess(access);
    if (!access) {
      log(
        "[gilbert] agent: this installation has chosen no model, so the agent stays idle until one is chosen (ADR 0031)",
      );
      return null;
    }
    const loop = new AgentLoop(ctx, {
      holder: options.holder ?? holderName(),
      accounts: () => resolveGroupAccounts(ctx),
      access,
      ...(boot.installation.agent.instruction
        ? { installation: boot.installation.agent.instruction }
        : {}),
    });
    return supervise({ loop, intervalMs: options.intervalMs, log });
  } catch (err) {
    log(
      `[gilbert] agent: it could not be started, so this installation runs without one: ${errorMessage(err)}`,
    );
    return null;
  }
}

/**
 * The accounts one pass works: the Master's groups, read from the server.
 *
 * The session a boot signed in with lists the groups the Master held **then**, so
 * resolving the accounts from it would make a group added in Stalwart's own
 * directory visible only after a restart. This re-reads the session the boot
 * signed in with — the same `.well-known/jmap` read (`upstream.ts`) — and puts it
 * where every later call goes: a `Ctx` carries the session rather than a copy of
 * it, so the refreshed one is the one the claim, the runs and the change logs are
 * read through (`jmap.ts`'s `SessionSource`).
 *
 * **The session is read on every pass; the probe is not.** What follows the
 * session is the **one** classifier for what a group is (`groupAccess.ts`), and
 * that classifier asks every candidate for a mail store — a round trip per
 * candidate, ten times a minute, to learn something the last pass learned. So the
 * roster is held against the list it was resolved from and reused while that list
 * is the same: the candidates are the pairs the fresh session names (`groupCandidates`,
 * the walk the classifier itself makes), compared as one string, in the order the
 * session lists them. A grant added or withdrawn, a group renamed, a candidate
 * gone: a different list, so the classifier answers again and the roster held is
 * the new one — which is what keeps "a Master that gains a group is worked by the
 * next pass" exactly as true as it was. The first pass probes, because it holds
 * no roster to reuse.
 *
 * shortcut: an account that answers the mail-store probe **differently** while
 * the session still names the same candidates — a share that became a mailbox, an
 * account that became readable after a failure — is not re-probed, so the roster
 * follows the session's own list and not the probe's answer. Upgrade by asking
 * the classifier again on a slow tick (a pass every few minutes), which costs one
 * probe per candidate and bounds how long an answer can go on being stale.
 */
export async function resolveGroupAccounts(ctx: Ctx): Promise<readonly string[]> {
  ctx.session = await fetchUpstreamSession(ctx.authorization, upstreamFor(ctx.username));
  const candidates = JSON.stringify(groupCandidates(ctx.session.accounts));
  const held = rosters.get(ctx);
  if (held?.candidates === candidates) return held.roster;
  const { groups } = await groupAccountsDetailed(ctx);
  const roster = [...groups.values()];
  rosters.set(ctx, { candidates, roster });
  return roster;
}

/**
 * The roster the last pass resolved, and the candidates it resolved it from.
 *
 * Per `Ctx`, which is the agent's own and lives as long as the process: a
 * restart has no roster and probes for its first one, which is the whole of what a
 * disposable process needs to know here (ADR 0036).
 */
const rosters = new WeakMap<Ctx, { candidates: string; roster: readonly string[] }>();

/** Who holds the claim, as a name the claim's own document can be read with. */
function holderName(): string {
  return `${hostname()}#${process.pid}`;
}
