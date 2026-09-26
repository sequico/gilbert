/**
 * The worker: the agent's own process (ADR 0003, v1 scope).
 *
 * Same codebase, second entrypoint. It authenticates as the one structure agent
 * the installation registered, claims the group accounts it will serve, and
 * holds the agent's event stream when it wins that claim. Nothing durable
 * lives in it: the claims, the jobs and the decisions are documents, so a
 * restart re-derives the session, re-claims what is free and carries on from
 * the state the last worker recorded. A second worker on the same installation
 * keeps the claims it can and polls for the rest — which is why the default
 * deployment is one.
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { type Ctx, filesAccountId, readAppJsonAt, writeAppFileAt } from "../appFolder.js";
import { config } from "../config.js";
import { JmapClient, serverNow } from "../jmap.js";
import { sleep } from "../shared/async.js";
import { basicAuth } from "../shared/basicAuth.js";
import {
  fetchUpstreamSession,
  UpstreamError,
  type UpstreamSession,
  upstreamFor,
} from "../upstream.js";
import { groupAccountsDetailed } from "./actions.js";
import { greetUnspoken, readChat } from "./chat.js";
import type { AgentClaim, AgentRecord, AgentStreamClaim } from "./documents.js";
import {
  AUDIT_RETENTION_MS,
  type ChangeType,
  DOCUMENT_RETENTION_MS,
  Executor,
  type GuardOutcome,
} from "./executor.js";
import {
  agentId as agentIdOf,
  type ClaimRefusal,
  claimAccount,
  claimStream,
  releaseClaim,
  releaseStreamClaim,
} from "./lease.js";
import { AgentStore } from "./store.js";
import { type AgentWithdrawal, WITHDRAWALS_PATH } from "./views.js";
import { openEventStream, pollLoop } from "./wake.js";

/** The JMAP change types one account's pass reconciles. */
const RECONCILED_TYPES: ReadonlyArray<ChangeType> = ["Email", "FileNode"];

export interface AgentDeps {
  /** The agent's own session context, derived from its app password. */
  ctx: Ctx;
  /** The agent's address: the identity of everything it writes. */
  address: string;
  /** Defaults to a `[gilbert]`-prefixed console line. */
  log?: (line: string) => void;
  /** Defaults to an id derived from the address and this process. */
  agentId?: string;
  now?: () => Date;
  pollMs?: number;
  heartbeatMs?: number;
  /**
   * False in a test: the handle then runs only what `pass()` drives, instead of
   * keeping the process alive with timers and a stream.
   */
  timers?: boolean;
}

export interface AgentHandle {
  /** One pass: claim, reconcile, retry, answer, prune. Returns the accounts served. */
  pass(): Promise<ReadonlyArray<string>>;
  /** The accounts this worker holds a claim on. */
  served(): ReadonlyArray<string>;
  /** What a health endpoint and an operator read: this worker, right now. */
  health(): AgentHealth;
  /** Release everything and stop: the stream claim first, so a peer can take it. */
  stop(): Promise<void>;
}

/**
 * What a running worker reports about itself.
 *
 * Deployment's restart policy needs one thing to ask: is this process serving
 * what it claimed (ADR 0003 resolution 8). What it does *not* report is
 * whether the agent's work is going well — a failed job is a document in the
 * group's account and belongs in the audit, not in a liveness probe that a
 * restart would answer by starting the work over.
 */
export interface AgentHealth {
  status: "ok";
  worker: string;
  address: string;
  /** The accounts the worker holds a claim on right now. */
  accounts: ReadonlyArray<string>;
  /** Whether this worker holds the agent's event stream. */
  streaming: boolean;
  startedAt: string;
  uptimeSeconds: number;
}

/**
 * The accounts a v1 agent may serve: the groups its session holds, through the
 * one classifier rather than a second spelling of it.
 *
 * v1 is group agents only (ADR resolution 4): a person's own mailbox is not
 * this worker's work, whatever the principal can reach, and neither is a share
 * that happens to carry an address. `groupAccounts` answers with the accounts
 * that answer as mail stores, which is what a group is.
 */
export async function candidateAccounts(ctx: Ctx): Promise<string[]> {
  // The account ids, not the group names: everything downstream — claims,
  // stores, the heartbeat's `serves` — addresses an account by its id, and
  // `groupNameOf` is what turns one back into the name it is served under.
  const reach = await groupAccountsDetailed(ctx);
  // A candidate the mail server did not answer about is not served: nothing is
  // written into an account nobody could prove is a mailbox, and the operator
  // reads which ones those were rather than watching a group quietly vanish.
  if (reach.unreadable.length)
    console.warn(
      "[gilbert] the mail server did not answer about these accounts, so they are not served:",
      reach.unreadable.join(", "),
    );
  return [...reach.groups.values()];
}

/* The Authorization header a plain principal authenticates with is
   `shared/basicAuth.ts`'s one implementation, re-exported here because this
   module's callers (and its tests) name it through the worker. */
export { basicAuth };

/**
 * The accounts the session listed and no longer does, with the names they had.
 *
 * A grant withdrawn in Stalwart's own administration removes the group from the
 * agent's session — that is what a grant *is* — so the accounts the worker was
 * serving and the accounts the session still lists are the whole of the
 * detection. The names travel with it because the session is exactly what stops
 * carrying them: after the withdrawal there is nowhere left to ask.
 *
 * Pure, and the reason it is: the pass does the reading and the reporting, and
 * this is the judgement, worth a test of its own.
 */
export function withdrawnAccounts(
  before: ReadonlyMap<string, string>,
  after: ReadonlyArray<string>,
): Array<{ account: string; name: string }> {
  const still = new Set(after);
  const gone: Array<{ account: string; name: string }> = [];
  for (const [account, name] of before) {
    if (!still.has(account)) gone.push({ account, name });
  }
  return gone;
}

/** The group name the session gives one account, or empty when it gives none. */
export function groupNameOf(session: UpstreamSession, accountId: string): string {
  const account = session.accounts?.[accountId] as { name?: unknown } | undefined;
  return typeof account?.name === "string" ? account.name.trim().toLowerCase() : "";
}

/**
 * The agents this process is running, in memory.
 *
 * Liveness is a process fact and it is kept where the process is. A deployment's
 * server and its agents share a fate (ADR 0003: the fleet runs beside the web
 * tier, and the server's shutdown stops it), so a worker that is alive is a
 * worker this process is running — while the record in the agent's own account
 * is written when the work changes, never on a clock. The status surface asks
 * the server that hosts the worker, and this is what it reads.
 *
 * Nothing here is durable and nothing here asks the store anything: a process
 * that dies takes its own liveness with it, which is the whole of what a restart
 * policy or an operator needs to know.
 */
export interface LiveAgent {
  id: string;
  address: string;
  version: string;
  /** When this process started serving as this worker. */
  since: string;
  /** The accounts it holds a claim on right now. */
  accounts: ReadonlyArray<string>;
  /** The groups those accounts are, by the names the session gave them. */
  groups: ReadonlyArray<string>;
  /** Whether it holds the agent's event stream. */
  streaming: boolean;
  /** When it last wrote its own record: a change in the work, never a clock. */
  updatedAt: string;
}

/**
 * The fleet this process runs, keyed by worker id.
 *
 * A handout rather than a service: `startAgent` registers what it is when it
 * starts and whenever the set of accounts it serves changes, and removes itself
 * when it stops, so "is this worker alive" is answered by whether it is here and
 * not by anything written to Stalwart.
 */
const live = new Map<string, LiveAgent>();

/** The agents this process is running right now. */
export function liveAgents(): LiveAgent[] {
  return [...live.values()];
}

/**
 * What a running worker is, as the fleet surface reads it.
 *
 * A worker that stopped is removed rather than left behind: in-memory liveness
 * is exactly "is this process running it", and a row that survived the stop
 * would be the durable lie this exists to remove.
 */
function remember(worker: LiveAgent): void {
  live.set(worker.id, worker);
}

function forget(id: string): void {
  live.delete(id);
}

/**
 * Start serving. The handle is the seam a test drives: `pass()` runs one full
 * round, `stop()` releases the claims and the stream.
 */
export async function startAgent(deps: AgentDeps): Promise<AgentHandle> {
  const log = deps.log ?? ((line: string) => console.log(`[gilbert] ${line}`));
  // The clock the fleet agrees on: the mail server's own, as its responses
  // report it (`serverNow`). A lease is about whether another process is still
  // alive, and two processes comparing their own clocks is how one of them
  // concludes the other is dead. A test injects its own.
  const now = deps.now ?? serverNow;
  const pollMs = deps.pollMs ?? config.agent.pollMs;
  const heartbeatMs = deps.heartbeatMs ?? config.agent.heartbeatMs;
  const id = deps.agentId ?? agentIdOf(deps.address);
  const timers = deps.timers !== false;

  const client = new JmapClient(deps.ctx);
  const executor = new Executor({
    ctx: deps.ctx,
    client,
    address: deps.address,
    agentId: id,
    now,
    log,
  });
  const agentStore = new AgentStore(deps.ctx, filesAccountId(deps.ctx));
  const started = now();
  const startedAt = started.toISOString();

  const servedAccounts = new Set<string>();
  /** The accounts the session listed when the pass last looked, by name. */
  let knownAccounts = new Map<string, string>();
  /** When the session was last re-read: never more often than the poll interval. */
  let refreshedAt = 0;
  const scheduleDisposers = new Map<string, () => void>();
  const disposers: Array<() => void> = [];
  let streamClaim: AgentStreamClaim | null = null;
  let closeStream: (() => void) | null = null;
  let stopped = false;
  let lastPrune = 0;
  const dirty = new Set<string>();
  const reconciling = new Set<string>();

  /** The types this worker has to reconcile for one account. */
  const typesOf = (accountId: string): ChangeType[] =>
    servedAccounts.has(accountId) ? [...RECONCILED_TYPES] : [];

  const reconcileAccount = async (accountId: string): Promise<void> => {
    const store = new AgentStore(deps.ctx, accountId);
    const types = typesOf(accountId);
    for (const type of types) {
      const claim = (await store.readClaim())?.doc;
      if (!claim) continue;
      try {
        await executor.reconcile(accountId, type, claim);
      } catch (err) {
        // A lost reconcile is not a lost worker: the state stays where it was,
        // so the next pass re-reads the same range.
        log(
          `${accountId}: ${type} reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Nothing wakes the worker for a time trigger — it is not a change — so the
    // pass asks. This is the catch-up for the runs a worker was away for, and
    // it reads the due entries back out of the document on every round.
    const due = await executor.runDueSchedules(accountId);
    if (due) log(`${accountId}: ${due} scheduled run(s) due`);
    const retried = await executor.runPending(accountId);
    if (retried) log(`${accountId}: retried ${retried} job(s)`);
    // An audit entry a contended document pushed out of its retries is held in
    // memory: the pass writes it, so a group that has gone quiet does not carry
    // it until it happens to write something else.
    const carried = await store.flushPendingAudits();
    if (carried) log(`${accountId}: wrote ${carried} held audit entry(ies)`);
    const decisions = (await store.listDecisions())
      .map((entry) => entry.doc)
      .filter((decision) => decision.state === "pending");
    if (decisions.length) {
      // The draft that left Drafts is settled **before** the chat is read: a
      // member who sent the draft and then wrote "sì" has approved once by
      // sending it, and the document that wins is the one a person acted on.
      // Resolving the reply first would settle the decision on the
      // conversational answer and leave the sent draft unexplained.
      await executor.sweepDrafts(
        accountId,
        decisions.filter((decision) => decision.draft).map((decision) => decision.id),
      );
      const messages = await readChat(deps.ctx, accountId, client);
      const answered = await executor.answerDecisions(accountId, messages);
      if (answered.length)
        log(`${accountId}: ${answered.length} decision(s) answered in the chat`);
    }
    if (!scheduleDisposers.has(accountId)) {
      // A far-future entry is re-checked each poll rather than trusted to one
      // long timer; the same cap keeps a paused container's clock jump honest.
      scheduleDisposers.set(
        accountId,
        await executor.armSchedule(accountId, {
          maxDelayMs: pollMs,
          // The timer fires on its own clock, outside any poll or push: without
          // this it is a fourth, unguarded way into `runJob` for this account.
          // Routing it through the same lock as `pass`/`drain` means a fire that
          // lands mid-reconcile is deferred to that reconcile's own schedule
          // catch-up instead of running the same due entry a second time — and
          // the deferral is a state the armer reads: it arms no timer for a
          // fire that did not run, so the catch-up is what runs the entry.
          guard: (work) => withAccountLock(accountId, work),
        }),
      );
    }
  };

  /**
   * Run one unit of work for an account with at most one in flight at a time.
   *
   * `reconcileAccount` is reached from three independent triggers — the poll
   * timer (`pass`), a push wake (`drain`), and a rule's own schedule timer
   * (`armSchedule`'s callback, wired through `withAccountLock` below) — and
   * before this, only `drain` checked `reconciling` at all. A push wake
   * arriving mid-poll, or a scheduled rule firing mid-reconcile, could start a
   * second `reconcileAccount` (or a second `runJob`, by the same path) for the
   * same account while the first was still running, which is exactly the
   * duplicate execution the job document's own deduplication assumes cannot
   * happen (ADR 0003). Every caller now goes through here instead of
   * touching `reconciling` itself, so at most one unit of work per account is
   * ever in flight, whichever trigger started it. A caller that finds the
   * account already busy does not wait for it — it marks the account dirty so
   * a plain reconcile follows once the busy one is done, which is enough: a
   * scheduled fire that is skipped this way is simply picked up by that
   * reconcile's own `runDueSchedules` catch-up instead of running twice.
   *
   * The answer says which of the two happened, because a caller can need the
   * difference: the schedule armer's fire must not be read as one that ran, and
   * that deferral is what keeps its entry from being armed again against a busy
   * account.
   */
  const withAccountLock = async (
    accountId: string,
    work: () => Promise<void>,
  ): Promise<GuardOutcome> => {
    if (reconciling.has(accountId)) {
      dirty.add(accountId);
      return "deferred";
    }
    reconciling.add(accountId);
    try {
      await work();
    } finally {
      reconciling.delete(accountId);
    }
    return "ran";
  };

  /** Reconcile the accounts the stream just woke, one at a time. */
  const drain = async (): Promise<void> => {
    for (const accountId of [...dirty]) {
      if (stopped || reconciling.has(accountId)) continue;
      dirty.delete(accountId);
      await withAccountLock(accountId, () => reconcileAccount(accountId));
    }
  };

  const wake = (accountId: string, type: string): void => {
    if (!servedAccounts.has(accountId)) return;
    if (type !== "Email" && type !== "FileNode") return;
    dirty.add(accountId);
    void drain().catch((err: unknown) =>
      log(`reconcile failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  const openStreamIfHeld = (): void => {
    // The stream is a process-level concern: a test drives `pass()` alone and
    // holds the claim document without opening a live connection.
    if (!timers || closeStream || !streamClaim) return;
    const types = new Set<string>();
    for (const accountId of servedAccounts)
      for (const type of typesOf(accountId)) types.add(type);
    closeStream = openEventStream(
      deps.ctx.session,
      deps.ctx.authorization,
      [...types],
      wake,
      (err) => log(`the event stream failed: ${err.message}`),
    );
    log(`holding the agent's event stream (${[...types].join(", ")})`);
  };

  /**
   * What this worker is holding, by the names the session gave those accounts.
   *
   * The claims are per account and the group's own surface reads a worker's
   * groups off this, so it is derived in one place and read by both the record
   * and the in-memory registry.
   */
  const servesNow = (): string[] =>
    [...servedAccounts]
      .map((accountId) => knownAccounts.get(accountId) ?? "")
      .filter(Boolean)
      .sort();

  /** What the last written record says this worker serves, and when it was written. */
  let publishedServes: string | null = null;
  let publishedAt: string | null = null;

  /**
   * Say what this worker is, in memory and — when it has changed — on disk.
   *
   * The record is written on **change**, never on a clock: when the worker
   * starts, when the set of accounts it serves changes, and (in `stop`) when it
   * goes away. The three are the same three things that are true of it, and
   * nothing else about a worker is a fact worth an upload — Stalwart charges
   * the account for every one, and never gives the blob back. Liveness is not
   * one of them: that is a fact of this process and lives in `live`.
   */
  const publish = async (): Promise<void> => {
    const serves = servesNow();
    const asWritten = JSON.stringify(serves);
    if (asWritten !== publishedServes) {
      const record: AgentRecord = {
        v: 1,
        id,
        address: deps.address,
        version: config.version,
        startedAt,
        updatedAt: now().toISOString(),
        serves,
      };
      await agentStore.writeAgent(record);
      publishedServes = asWritten;
      publishedAt = record.updatedAt;
    }
    remember({
      id,
      address: deps.address,
      version: config.version,
      since: startedAt,
      accounts: [...servedAccounts],
      groups: serves,
      streaming: streamClaim !== null,
      updatedAt: publishedAt ?? startedAt,
    });
  };

  /**
   * Retention, on the one timer left in the worker's own machinery.
   *
   * A sweep is a read until it finds something past its retention, and what it
   * removes is work that has finished — a change in the work, not a clock. The
   * interval is the heartbeat's for the same reason it always was: pruning
   * wants to be unhurried, and a knob nobody has to set twice is one less way a
   * deployment can be wrong.
   */
  const prune = async (): Promise<void> => {
    if (now().getTime() - lastPrune < heartbeatMs) return;
    lastPrune = now().getTime();
    const cutoff = new Date(now().getTime() - DOCUMENT_RETENTION_MS);
    const auditCutoff = new Date(now().getTime() - AUDIT_RETENTION_MS);
    for (const accountId of [...servedAccounts]) {
      const removed = await executor.prune(accountId, cutoff);
      if (removed) log(`${accountId}: pruned ${removed} finished document(s)`);
      const months = await executor.pruneAudit(accountId, auditCutoff);
      if (months) log(`${accountId}: pruned ${months} audit month(s)`);
    }
  };

  /**
   * What a refused claim says: contention out loud, ownership not.
   *
   * Losing a claim to a peer is the design working, and saying it every pass
   * would be noise. Losing every write to a unit nobody holds is the fleet
   * quietly stopping, and nothing else in the process would ever say so.
   */
  const refused = (accountId: string) => (reason: ClaimRefusal) => {
    if (reason === "contended")
      log(`${accountId}: nobody holds it and the claim kept losing`);
  };

  /**
   * Whether the units this worker believes it holds are still its own.
   *
   * A fence that is never renewed is a fence a peer can take over without this
   * worker noticing, so the pass asks — with a **read**, which costs the account
   * nothing, and never with a write. What the answer changes is what this worker
   * serves: an account whose claim has moved on is dropped, and the drop is a
   * change in the work, so the record is written once for it (`publish`).
   */
  const stillMine = async (): Promise<void> => {
    for (const accountId of [...servedAccounts]) {
      const store = new AgentStore(deps.ctx, accountId);
      const held = await claimAccount(store, id, {
        now: now(),
        startedAt: started,
        onRefused: refused(accountId),
      });
      if (!held) {
        // Somebody else holds it: stop serving rather than work an account
        // that belongs to a peer's run now. Its next write is refused by the
        // epoch, which is the fence doing its job.
        servedAccounts.delete(accountId);
        dirty.delete(accountId);
        log(`lost ${accountId}`);
      }
    }
    if (streamClaim) {
      const held = await claimStream(agentStore, id, { now: now(), startedAt: started });
      if (!held && closeStream) {
        // Somebody else holds the stream now: stop reading, keep polling.
        closeStream();
        closeStream = null;
        streamClaim = null;
        log("the event stream claim moved to another worker; polling");
      }
    }
  };

  // One account's fault is that account's: an unreadable claim document ends the
  // round for that account alone, instead of ending it for every account behind
  // it in the list, and the pass says what it caught (resolution 18). What the
  // work answers with is not read here — a caller with something to say about
  // its own outcome says it itself — so any answer is taken.
  const guarded = async (accountId: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (err) {
      log(
        `${accountId}: the pass could not finish this account: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Re-read the agent's session, at most once per poll interval.
   *
   * A grant withdrawn in Stalwart's own administration removes the group from
   * the agent's session — that is what a grant is — and nothing announces it:
   * the account simply stops being listed. Re-reading on a timer is what turns
   * that into a fact the pass can act on, and the interval is the poll interval
   * the worker already runs on, a third of a lease, so no new knob arrives with
   * it. A refresh that fails is not a withdrawal: the session in force stays in
   * force and the next pass tries again.
   *
   * It replaces the context's session, which is what everything downstream
   * reads: the pass's accounts and the installation's narrowing, the executor,
   * and the client itself — each holds the context, not a copy of the session,
   * so nothing carries the withdrawn account forward.
   */
  const refreshSession = async (): Promise<void> => {
    const at = now().getTime();
    if (at - refreshedAt < pollMs) return;
    refreshedAt = at;
    try {
      deps.ctx.session = await openSession(
        deps.ctx.authorization,
        upstreamFor(deps.address),
      );
    } catch (err) {
      log(
        `could not re-read the agent's session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Write down a grant the agent has lost.
   *
   * In the agent's **own** account, because it is the only place it can still
   * write: the moment the grant is gone, the group's own documents are refused
   * to it. So the report is the group and when the worker noticed — the work a
   * withdrawal leaves behind is in the group's audit, unreadable from here, and
   * saying more than this would be inventing it.
   */
  const reportWithdrawal = async (account: string, group: string): Promise<void> => {
    const self = filesAccountId(deps.ctx);
    const seen = await readAppJsonAt(deps.ctx, self, WITHDRAWALS_PATH);
    const entries = Array.isArray(seen) ? (seen as AgentWithdrawal[]) : [];
    const entry: AgentWithdrawal = {
      account,
      group,
      at: now().toISOString(),
    };
    await writeAppFileAt(
      deps.ctx,
      self,
      WITHDRAWALS_PATH,
      [...entries, entry].slice(-20),
    );
    log(`${group || account}: the agent's grant on this group is gone`);
  };

  const pass = async (): Promise<ReadonlyArray<string>> => {
    if (stopped) return [...servedAccounts];
    await refreshSession();
    const accounts = await candidateAccounts(deps.ctx);
    // An account the worker was serving and the session no longer lists is a
    // grant that has been withdrawn. It stops being served here and is reported
    // once, rather than failing against it on every pass for as long as the
    // worker runs — and nothing here writes or touches a claim: the claim it
    // held is left where it is, un-renewed and un-released, which is how a
    // withdrawal is meant to end (ADR 0003).
    const gone = withdrawnAccounts(knownAccounts, accounts);
    knownAccounts = new Map(
      accounts.map((accountId) => [accountId, groupNameOf(deps.ctx.session, accountId)]),
    );
    for (const { account, name } of gone) {
      servedAccounts.delete(account);
      await guarded(account, () => reportWithdrawal(account, name));
    }
    for (const accountId of accounts) {
      await guarded(accountId, async () => {
        const store = new AgentStore(deps.ctx, accountId);
        if (servedAccounts.has(accountId)) return;
        const claim: AgentClaim | null = await claimAccount(store, id, {
          now: now(),
          startedAt: started,
          onRefused: refused(accountId),
        });
        if (!claim) return;
        servedAccounts.add(accountId);
        log(`claimed ${accountId}`);
        // A group hears from the agent once, without anyone having to ask. The
        // transcript is the record, so this is safe on every claim; a failure
        // is logged and retried on the next claim, never fatal to the pass.
        try {
          const greeted = await greetUnspoken(deps.ctx, accountId, deps.address, client);
          if (greeted) log(`${accountId}: greeted the group`);
        } catch (err) {
          log(
            `${accountId}: could not greet the group: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      });
    }
    // What this worker holds is asked, not renewed: holding a fence is not an
    // event, so the pass reads (which costs nothing) and writes only if the
    // answer changed. Nothing here is on a clock — the record goes to disk when
    // this list changes, and never because a pass came round again.
    await stillMine();
    if (!servedAccounts.size) {
      await publish();
      return [];
    }
    if (!streamClaim) {
      const won = await claimStream(agentStore, id, { now: now(), startedAt: started });
      if (won) {
        streamClaim = won;
        openStreamIfHeld();
      }
    } else {
      openStreamIfHeld();
    }
    // After the stream claim, so what the surface reads is what this pass
    // actually ended up holding.
    await publish();
    for (const accountId of servedAccounts)
      await guarded(accountId, () =>
        withAccountLock(accountId, () => reconcileAccount(accountId)),
      );
    return [...servedAccounts];
  };

  /*
   * The work in flight, so a stop can wait for it.
   *
   * A pass may claim a unit and write the record, and either recreates what the
   * release has just removed: a `stop()` that raced one would hand the account
   * back and have it taken again by the same worker, held with nobody to release
   * it. So the writers are tracked, and `stop()` waits for them before it
   * releases anything.
   */
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    void work.catch(() => {}).finally(() => inFlight.delete(work));
    return work;
  };

  if (timers) {
    disposers.push(
      pollLoop(
        pollMs,
        async () => {
          await track(pass());
        },
        {
          onError: (err) =>
            log(`the pass threw: ${err instanceof Error ? err.message : String(err)}`),
        },
      ),
    );
    disposers.push(
      pollLoop(heartbeatMs, async () => {
        await track(prune());
      }),
    );
  }

  // What this process is, before it has asked anybody anything: a worker that
  // is up and serving nothing is a state the records make visible, and the
  // registry is what the status surface reads liveness from.
  await publish();

  return {
    pass,
    served: () => [...servedAccounts],
    health: () => ({
      status: "ok",
      worker: id,
      address: deps.address,
      accounts: [...servedAccounts],
      streaming: streamClaim !== null,
      startedAt,
      uptimeSeconds: Math.max(
        0,
        Math.round((now().getTime() - Date.parse(startedAt)) / 1000),
      ),
    }),
    stop: async () => {
      stopped = true;
      for (const dispose of disposers) dispose();
      for (const dispose of scheduleDisposers.values()) dispose();
      scheduleDisposers.clear();
      // Whatever was already running finishes first: a pass claims the units it
      // finds free, so a release that raced one would be undone by it.
      await Promise.allSettled([...inFlight]);
      if (closeStream) {
        closeStream();
        closeStream = null;
      }
      if (streamClaim) {
        await releaseStreamClaim(agentStore, id);
        streamClaim = null;
      }
      // The accounts too: the claim is released rather than left to anything
      // lapsing, because nothing lapses it — a fence that is never renewed is
      // also a fence that never goes away on its own, and a successor must not
      // have to wait for this process's start time to be beaten.
      for (const accountId of servedAccounts) {
        const store = new AgentStore(deps.ctx, accountId);
        await releaseClaim(store, id);
      }
      servedAccounts.clear();
      // And the record goes, so the agent's own account carries what this
      // worker is **doing** and not a claim about it being up: the process this
      // answer came from is the only thing that could say that, and it is on its
      // way out.
      await agentStore.destroyAgent(id);
      forget(id);
    },
  };
}

/** How long a worker waits for an upstream that has not opened its door yet. */
const BOOT_ATTEMPTS = 6;
const BOOT_DELAY_MS = 1000;

/**
 * Open the agent's session, waiting out an upstream that is not there yet.
 *
 * A missing configuration never reaches here — `main` warns and waits — so
 * what is left is the server side: a container orchestrator replaces a worker
 * that cannot reach Stalwart, but a development stack starts the mock and the
 * worker together and a worker that dies in that first second is a papercut,
 * not a diagnosis. A refused credential is not a race either: the attempt
 * fails once, `main` says why and keeps the worker up and idle, and the fleet
 * is retried when the deployment names an agent it can sign in as.
 */
async function openSession(
  authorization: string,
  base: string,
): Promise<UpstreamSession> {
  let last: unknown;
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
    try {
      return await fetchUpstreamSession(authorization, base);
    } catch (err) {
      last = err;
      if (err instanceof UpstreamError && err.status === 401) break;
      if (attempt < BOOT_ATTEMPTS) await sleep(BOOT_DELAY_MS * attempt);
    }
  }
  throw last instanceof Error ? last : new Error("the agent session could not be opened");
}

/**
 * The worker's health endpoint (ADR 0003 resolution 8).
 *
 * A restart policy can only act on an answer, and a worker that is up but
 * holds no claim is not serving anything: the endpoint reports which accounts
 * this process is actually working, so a deployment can tell "running" from
 * "running and useless". It is started only when the deployment names a port
 * (`GILBERT_AGENT_HEALTH_PORT`) — a worker otherwise needs no inbound surface
 * at all, and a port nobody asked for is surface for nothing.
 */
export function startHealthServer(opts: {
  port: number;
  health: () => AgentHealth;
}): () => void {
  const server = createServer((req, res) => {
    if ((req.url ?? "/").split("?")[0] !== "/health") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(opts.health()));
  });
  server.listen(opts.port, "0.0.0.0");
  return () => server.close();
}

/**
 * The agent the deployment names, as the worker needs it.
 *
 * `config.agent` is bootstrap configuration, resolved when the module loaded:
 * the environment cannot change under a running process, so this is the word
 * the deployment started with.
 */
export interface AgentIdentity {
  address: string;
  password: string;
}

/**
 * How often the running fleet asks whether the deployment renamed the agent.
 *
 * This is not the session's own poll: a session is re-read every poll interval
 * because a grant changes inside the mail server, while this asks whether the
 * *deployment* changed the identity. Both are cheap reads of a file that is
 * re-read on its own stamp, so this only decides how long a hand-edited file
 * takes to matter.
 */
const AGENT_IDENTITY_RECHECK_MS = 2_000;

/** The agent the deployment names right now. */
export function currentIdentity(): AgentIdentity {
  const { address, password } = config.agent;
  return { address, password };
}

/** Whether two identities would start the same fleet. */
export function sameIdentity(a: AgentIdentity, b: AgentIdentity): boolean {
  return a.address === b.address && a.password === b.password;
}

/** Sign in as an identity, the way the worker does at boot. */
async function signInAs(
  identity: AgentIdentity,
): Promise<{ authorization: string; session: UpstreamSession }> {
  const authorization = basicAuth(identity.address, identity.password);
  return {
    authorization,
    session: await openSession(authorization, upstreamFor(identity.address)),
  };
}

/**
 * The identity the running fleet should follow, or null to stay as it is.
 *
 * A deployment that renames the agent is followed by signing in as the new one
 * **before** anything is stopped: a sign-in that fails leaves the fleet that is
 * serving alone, so a deployment mid-edit never takes a working agent down.
 * Null is therefore three things — nothing changed, nothing usable is named any
 * more, or what is named cannot sign in — and each of them means the groups
 * being served keep being served.
 */
export async function identityToFollow(
  running: AgentIdentity,
  deps: {
    current?: () => AgentIdentity;
    signIn?: (
      identity: AgentIdentity,
    ) => Promise<{ authorization: string; session: UpstreamSession }>;
    log?: (line: string) => void;
  } = {},
): Promise<{ identity: AgentIdentity; ctx: Ctx } | null> {
  const log = deps.log ?? ((line: string) => console.log(`[gilbert] ${line}`));
  const wanted = (deps.current ?? currentIdentity)();
  if (sameIdentity(running, wanted)) return null;
  if (!wanted.address || !wanted.password) {
    log("the deployment no longer names a usable agent: the fleet keeps serving");
    return null;
  }
  try {
    const { authorization, session } = await (deps.signIn ?? signInAs)(wanted);
    return {
      identity: wanted,
      ctx: { authorization, session, username: wanted.address },
    };
  } catch (err) {
    log(
      `${wanted.address} could not sign in, so the fleet keeps serving ${running.address}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

/** Start serving one identity: sign in as it, then start a fleet on that. */
async function startAgents(identity: AgentIdentity): Promise<AgentHandle> {
  const { authorization, session } = await signInAs(identity);
  const ctx: Ctx = { authorization, session, username: identity.address };
  return startAgent({ ctx, address: identity.address });
}

/** The health an idle worker reports: up, answering, serving nothing. */
function idleHealth(identity: AgentIdentity, startedAt: number): AgentHealth {
  return {
    status: "ok",
    worker: "idle",
    address: identity.address,
    accounts: [],
    streaming: false,
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

/**
 * A running fleet, and the only way to stop it.
 *
 * The seam the two entrypoints share — the worker's own process, and the server
 * that runs one beside itself (ADR 0003) — so the boot retry, the identity
 * watch and the stop are written once. Nothing here owns the process: the
 * caller wires the signals it cares about, and `stop()` is what releases the
 * claims.
 */
export interface AgentFleet {
  /** Stop serving, release the claims, and stop following the identity. */
  stop(): Promise<void>;
}

/**
 * Start serving as the agent the deployment names, and keep doing it.
 *
 * A deployment that names no agent, or names one Stalwart refuses, is not a
 * failed start: the admin surface is where that is read
 * (`agent_not_configured`, `agent_credentials_rejected`), and a fleet that
 * exited would take down the health endpoint a restart policy reads. So this
 * warns, keeps running, serves nothing, and keeps asking — a deployment that
 * starts naming an agent finds a fleet already waiting. The notice is not
 * repeated while nothing changes; the newest one is what an operator reads.
 */
export async function startAgentFleet(): Promise<AgentFleet> {
  const startedAt = Date.now();
  let identity = currentIdentity();
  let lastNotice = "";
  const notice = (line: string): void => {
    if (line === lastNotice) return;
    lastNotice = line;
    console.warn(line);
  };

  const start = async (): Promise<AgentHandle | null> => {
    if (!identity.address || !identity.password) {
      notice(
        "[gilbert] the agent worker is not configured: set GILBERT_AGENT_ADDRESS and " +
          "GILBERT_AGENT_PASSWORD in the environment that starts this process; " +
          "the worker keeps running and serves nothing until both are there",
      );
      return null;
    }
    try {
      const fleet = await startAgents(identity);
      lastNotice = "";
      console.log(`[gilbert] agent worker for ${identity.address}`);
      return fleet;
    } catch (err) {
      notice(
        `[gilbert] ${identity.address} could not sign in, so nothing is served: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }
  };

  let worker = await start();
  const closeHealth =
    config.agent.healthPort > 0
      ? startHealthServer({
          port: config.agent.healthPort,
          health: () => worker?.health() ?? idleHealth(identity, startedAt),
        })
      : null;
  if (closeHealth)
    console.log(
      `[gilbert] agent health: http://0.0.0.0:${config.agent.healthPort}/health`,
    );

  // A fleet that was never started is retried here, and a fleet that is serving
  // is replaced only by one that can already serve: `identityToFollow` signs in
  // as the agent the installation now names before anything is stopped.
  const watch = setInterval(() => {
    void (async () => {
      if (!worker) {
        identity = currentIdentity();
        worker = await start();
        return;
      }
      const current = worker;
      const next = await identityToFollow(identity);
      if (!next) return;
      await current.stop();
      worker = await startAgents(next.identity);
      identity = next.identity;
      console.log(`[gilbert] the agent is now ${identity.address}`);
    })();
  }, AGENT_IDENTITY_RECHECK_MS);

  return {
    stop: async () => {
      clearInterval(watch);
      closeHealth?.();
      await worker?.stop();
    },
  };
}

/**
 * The worker's own entrypoint: a fleet, and the signals that end it.
 *
 * The server starts the same fleet beside itself and stops it in its own
 * shutdown instead (ADR 0003); this is the process a deployment runs on its own
 * when it wants the two apart.
 */
export async function main(): Promise<void> {
  const fleet = await startAgentFleet();
  const shutdown = async (signal: string) => {
    console.log(`[gilbert] ${signal} received, stopping the agent worker`);
    await fleet.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Only when this file is the process's entrypoint: the module is imported by
// the tests and by anything that wants the seam, and neither should start a
// fleet by importing it.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry && import.meta.url === entry) {
  main().catch((err) => {
    console.error("[gilbert] fatal:", err);
    process.exit(1);
  });
}
