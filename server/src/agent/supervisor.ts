/**
 * The process that asks the loop for a pass (ADR 0038, 0030, 0032).
 *
 * `agent/loop.ts` works a run — it claims the installation, re-arms the waits it
 * finds, reads each account's changes and answers each change the group's
 * instruction covers — and a
 * pass is the caller's to ask for. This module is that caller, and the **server's
 * own boot is what starts it** (`index.ts`): the agent is part of the product, so
 * launching Gilbert is what makes it exist. It runs on the installation the boot
 * just read — the model the installation has chosen, and the line of prose its
 * document carries into every call (ADR 0038) — and asks the loop for a pass on
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
 * installation's claim (one read, and no write while it is held — ADR 0032),
 * re-reads the session the Master's groups are resolved from (one read, and the
 * mail-store probe the one classifier for that question makes per candidate only
 * when the session names a different set of candidates — `groupAccess.ts`), and
 * reads each group's runs and its change log (a request per page apiece, and a
 * run document whose stamp has not moved is not downloaded again). It
 * asks the model **only** when the group's instruction covers a change (ADR 0038), so a quiet
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
 * the moment it is repeated. **A full upload allowance is the exception**: a
 * rejected upload spends the allowance too, so the ordinary retry would keep the
 * account at its ceiling; that pass pauses the schedule long enough for the
 * server's window to drain (`QUOTA_PAUSE_MS`), and the pause is one line rather
 * than a failure every interval.
 *
 * **A claim a peer holds is not an error.** The loop answers such a pass without
 * working anything (ADR 0032), which is one installation with one agent: this
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
 * gap a pass reported (an instruction this build cannot read, a change log that
 * skipped) — and never once per ten seconds. The line a person reads is one
 * they can act on.
 *
 * **Nothing is kept.** The loop, the roster the last pass resolved and its
 * alarms live in memory, which is disposable by law (`IMMUTABLE=1`, ADR 0038):
 * what outlives the process is the claim, the runs, the waits and each group's
 * reading cursor (`agent/cursors.ts`, ADR 0037), all documents in Stalwart.
 * There is no lock file, no pid file and no state of its own on disk.
 */

import { hostname } from "node:os";
import type { Ctx } from "../appFolder.js";
import type { BootConfiguration } from "../bootstrap.js";
import { groupAccountsDetailed } from "../groupAccess.js";
import { errorMessage } from "../shared/errors.js";
import { groupCandidates } from "../shared/sessionAccount.js";
import { fetchUpstreamSession, UpstreamError, upstreamFor } from "../upstream.js";
import { AgentLoop, type PassSummary } from "./loop.js";
import { modelAccess, setRunningModelAccess } from "./model.js";
import { agentWakeStatus } from "./wake.js";

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
 * The interval while the wake stream is connected.
 *
 * A pushed change is immediate, and a dated wait kicks a pass as it comes due,
 * so the beat is a safety net until the stream drops; without it the pass is
 * asked every ten seconds as before.
 */
export const AGENT_PASS_INTERVAL_WITH_WAKE_MS = 30_000;

/**
 * How long a pass may take before it is worth a line.
 *
 * A pass is not an event, and its own line is written **when it returns**: this
 * one says a pass finished late, with what it worked. A pass that does not return
 * is `PASS_WATCHDOG_MS`'s, which abandons it and says so. Thirty seconds is
 * several times an ordinary pass with a model call in it.
 */
export const SLOW_PASS_MS = 30_000;

/**
 * How long a pass may run before it is abandoned and the next one starts.
 *
 * Every call inside a pass has its own timeout — the mail server's
 * (`limits.upstreamTimeout`) and the provider's — so a pass that stops here is not
 * a call that never answered: it is the loop itself, stuck where no timeout
 * reaches. Left alone it holds `inFlight`, no further pass is asked, and nothing
 * is written: the agent is off and looks idle. Five minutes is several times a
 * pass with several accounts and model calls in it, so the abandonment costs
 * nothing on a healthy installation.
 */
export const PASS_WATCHDOG_MS = 5 * 60_000;

/**
 * How long a pass waits after the mail server's upload allowance is full.
 *
 * Stalwart counts a rejected upload towards the allowance too, so asking again
 * on the ordinary interval keeps the account at its ceiling instead of letting
 * the window drain. Fifteen minutes is short enough to notice the allowance
 * return and long enough that a full window is not spent again.
 */
export const QUOTA_PAUSE_MS = 15 * 60_000;

/** How long pushes are gathered before one pass is asked for. */
const KICK_COALESCE_MS = 500;

/**
 * The half of the loop this module uses.
 *
 * Declared rather than taking an `AgentLoop`, so a test can hand it a stand-in
 * and pin what the supervisor itself does — how often it asks, what it does with
 * a failure, what it says about a claim it does not hold — without a model, a
 * mail server or a run.
 */
export interface PassableLoop {
  /**
   * One pass: what the loop works. `claimed` false means a peer holds the
   * installation. The signal is the pass's own abort: a loop that obeys it stops
   * asking the mail server and unwinds, which is how a pass is given up on.
   */
  pass(now?: Date, signal?: AbortSignal): Promise<PassSummary>;
  /** Give up the loop's alarms and its claim. */
  stop(): void | Promise<void>;
  /** Set by the supervisor: a wait that came due asks for a pass now. */
  onDue?: () => void;
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
  /** Give up the schedule, the loop's alarms and the claim it holds. */
  stop(): Promise<void>;
  /**
   * Ask for a pass now — the agent's wake stream (`wake.ts`) calls this when
   * Stalwart says mail or the app folder changed; the state types it asks for
   * are `WAKE_STATE_TYPES`. Bursts coalesce into one pass, and a kick that lands
   * while a pass is running asks for one more, never two at once.
   */
  kick(): void;
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
  let stopped = false;
  /** The pass in flight, so stop can wait for it before releasing the claim. */
  let inFlight: Promise<void> | null = null;
  /** A push that arrived while a pass was running asks for one more. */
  let queued = false;
  /** Pushes within this window are one reason to work. */
  let kickTimer: NodeJS.Timeout | null = null;
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
   * every beat: an unreadable instruction or a change log that skipped says the
   * same sentence ten seconds later, and a fault that has gone stops being said.
   */
  let saidGaps = new Set<string>();
  /**
   * The failure this process last reported, so a reason that repeats is silent
   * and a pass that works again is news. A broken mail server fails the same way
   * every ten seconds; a line per beat is not an event, it is noise, and the
   * module's own rule is that what is said is what **changes**.
   */
  let saidFailure: string | null = null;
  /**
   * A full upload allowance pauses the schedule until this instant: a rejected
   * upload spends the allowance too, so the ordinary retry would keep the
   * account at the ceiling rather than let the window drain.
   */
  let pausedUntil = 0;

  function pass(): Promise<void> {
    if (stopped || now().getTime() < pausedUntil) return Promise.resolve();
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    /** Set by the watchdog when it gives up on this pass. */
    let abandoned = false;
    const control = new AbortController();
    const work = (async () => {
      try {
        const summary = await options.loop.pass(now(), control.signal);
        // The watchdog gave up on this pass: what it found is not news.
        if (abandoned) return;
        if (saidFailure) {
          saidFailure = null;
          log("[gilbert] agent: the pass is working again");
        }
        if (summary.claimed) {
          if (summary.ms > SLOW_PASS_MS)
            log(
              `[gilbert] agent: a pass took ${Math.round(summary.ms / 1000)} s — ${summary.changes} change(s), ${summary.runs} run(s), ${summary.due} due; what came after it waited`,
            );
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
        // An abandoned pass's failure is not this installation's news: the pass
        // that replaced it is the one whose outcome is read.
        if (abandoned) return;
        if (err instanceof UpstreamError && err.status === 429) {
          pausedUntil = now().getTime() + QUOTA_PAUSE_MS;
          log(
            `[gilbert] agent: the mail server's upload allowance is full, so the agent pauses for ${Math.round(QUOTA_PAUSE_MS / 60_000)} minutes`,
          );
        } else {
          /*
           * One line per **reason**, not per pass: a mail server that is down
           * fails the same way every ten seconds, and the next pass is the retry
           * — the line says what a person can act on, and says it once.
           */
          const why = errorMessage(err);
          if (why !== saidFailure) {
            saidFailure = why;
            log(
              `[gilbert] agent: the pass failed and the next one will try again: ${why}`,
            );
          }
        }
      } finally {
        if (queued && !stopped) {
          queued = false;
          kick();
        }
      }
    })();
    let current: Promise<void>;
    /*
     * The watchdog: every request inside a pass has its own ceiling, so a pass
     * still running after `PASS_WATCHDOG_MS` is stuck where no ceiling reaches —
     * and a pass given no word of it holds the schedule for ever, which reads as an
     * idle agent. It is **aborted**, which is the one thing it listens to
     * (`Ctx.signal`): its requests stop, it unwinds, and the next pass starts when
     * it is really gone — never beside it, so two passes can never write one cursor.
     */
    const watchdog = setTimeout(() => {
      if (inFlight !== current) return;
      abandoned = true;
      control.abort();
      log(
        `[gilbert] agent: a pass had not returned in ${Math.round(PASS_WATCHDOG_MS / 60_000)} minutes and was given up on; the next one starts when it is gone`,
      );
    }, PASS_WATCHDOG_MS);
    current = work.finally(() => {
      clearTimeout(watchdog);
      inFlight = null;
      if (abandoned) {
        log("[gilbert] agent: the pass given up on has ended");
        kick();
      }
    });
    inFlight = current;
    return current;
  }

  /**
   * A push asks for a pass, debounced: a burst of `StateChange` frames -- one
   * per write, and the agent's own writes are among them -- is one pass, not
   * one per frame.
   */
  function kick(): void {
    if (stopped || kickTimer) return;
    kickTimer = setTimeout(() => {
      kickTimer = null;
      void pass();
    }, KICK_COALESCE_MS);
  }

  // A dated wait that comes due is a reason to work now; the interval is the
  // floor for the rest, not the only clock a wait can keep.
  options.loop.onDue = kick;
  let intervalTimer: NodeJS.Timeout | null = null;
  function scheduleInterval(): void {
    if (stopped) return;
    const delay =
      agentWakeStatus().state === "connected"
        ? AGENT_PASS_INTERVAL_WITH_WAKE_MS
        : intervalMs;
    intervalTimer = setTimeout(() => {
      if (stopped) return;
      void pass();
      scheduleInterval();
    }, delay);
  }
  void pass();
  scheduleInterval();
  log(
    `[gilbert] agent: asking for a pass every ${Math.round(intervalMs / 1000)} s, or ${Math.round(AGENT_PASS_INTERVAL_WITH_WAKE_MS / 1000)} s while the wake stream is connected`,
  );

  return {
    kick,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (intervalTimer) clearTimeout(intervalTimer);
      if (kickTimer) clearTimeout(kickTimer);
      // The claim is released only after the pass in flight has finished: a
      // release beside a working pass hands the installation to a peer while
      // this one is still writing the runs it holds.
      await inFlight;
      await options.loop.stop();
      log("[gilbert] agent: stopping, and the claim is released");
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
 *   document (ADR 0009, ADR 0038), together with the operator's statement about
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
    if (!access)
      log(
        "[gilbert] agent: this installation has chosen no model, so the agent stays idle until one is chosen (ADR 0038)",
      );
    /*
     * The loop starts even with no model: the pass re-reads the document, so a
     * model published from Administration brings the agent to work on the next
     * pass -- ten seconds -- rather than at the next restart. Until then every
     * pass ends with the reason in its gaps, said once.
     */
    const loop = new AgentLoop(ctx, {
      holder: options.holder ?? holderName(),
      accounts: () => resolveGroupAccounts(ctx),
      ...(access ? { access } : {}),
      allowPrivateProvider: boot.configuration.agent.allowPrivateProvider,
      ...(boot.installation.agent.instruction
        ? { installation: boot.installation.agent.instruction }
        : {}),
      log,
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
 * disposable process needs to know here (ADR 0032).
 */
const rosters = new WeakMap<Ctx, { candidates: string; roster: readonly string[] }>();

/** Who holds the claim, as a name the claim's own document can be read with. */
function holderName(): string {
  return `${hostname()}#${process.pid}`;
}
