/**
 * Coordination without a coordinator (ADR 0003).
 *
 * A agent serves the accounts it wins, and exactly one agent
 * holds the agent's event stream. There is no lock to take and no coordinator
 * to ask: a claim is a document, its owner and the instant it was taken are the
 * truth, and a claim taken before this process started is free to take over.
 * Every write passes the state it read as `ifInState`, so the two agents that
 * race for the same claim cannot both believe they won — the loser's write is
 * refused and retried against what the winner left behind.
 *
 * A claim is a **fence**, not a lease: it is written when it is taken and
 * removed when it is let go, and holding it costs nothing and writes nothing.
 * That is not only cheaper (Stalwart charges the account for every upload and
 * never gives the blob back) — it is truer: the server and the fleet it runs
 * share a fate, so a liveness fact renewed on a clock bought nothing.
 *
 * Losing a race is normal here, not an error: the caller simply serves nothing
 * for that unit and comes back next pass.
 */

import { isStateMismatch } from "../jmap.js";
import { type AgentClaim, type AgentStreamClaim, claimEpoch } from "./documents.js";
import type { AgentStore } from "./store.js";

export interface ClaimOpts {
  /**
   * The instant the claim is written for when it is taken; injected so a test
   * can decide what a claim's take time is.
   */
  now: Date;
  /**
   * When the process asking started, on the clock the claim's own instant is
   * written with (the mail server's, in production). It answers the one
   * question a takeover turns on: a claim taken **before** this instant was
   * taken by a process that cannot have been waiting for us to arrive, so the
   * unit is free to take over.
   */
  startedAt: Date;
  /**
   * Why the claim was refused, when it was: the caller logs the anomaly and
   * stays quiet about the ordinary answer. A bare `null` cannot tell "another
   * agent is serving this unit" — which is the design working — from "nobody
   * is serving it and my write kept losing", which is the fleet quietly
   * stopping.
   */
  onRefused?: (reason: ClaimRefusal) => void;
}

/** Why a claim came back empty. */
export type ClaimRefusal =
  /** A peer holds it, and that peer started after we did. */
  | "held"
  /** Nobody's, but the write lost every compare-and-set: contention, not ownership. */
  | "contended";

/**
 * How many times a read-modify-write retries after losing a compare-and-set.
 * Four attempts cover the ordinary race (another agent taking the same free
 * unit between the read and the write); a longer fight means somebody else owns
 * the unit now, and giving up is the correct answer.
 */
const CAS_ATTEMPTS = 4;

/**
 * Whether a claim this process just read is ours to take.
 *
 * Three answers, and the middle one is the whole design of a fence:
 *
 * - `mine`: this very agent holds it — the fence is held, and holding it is
 *   not an event, so nothing is written;
 * - `free`: nobody holds it, or the holder took it before this process started;
 * - `held`: another agent took it after this process started.
 *
 * The takeover rule is decided on the work's own facts, never on time passing.
 * A agent that reads a claim taken **before** it started knows the peer cannot
 * have been waiting for it to arrive — the peer was there first, so it either
 * died holding the fence or was replaced, and the unit is ours to serve. A
 * claim taken **after** we started is a peer that was already running when we
 * came up, which is exactly what a rolling restart looks like: the old process
 * is still alive and finishing what it holds while the new one starts, the new
 * one leaves those units alone, and the old one's next conditional write is
 * refused by the state the new ownership advanced. The overlap lasts as long as
 * the old process takes to notice, and whatever it loses it reads as `held` on
 * its next pass.
 */
function verdict(
  held: { agent: string; takenAt: string } | undefined,
  agent: string,
  startedAt: Date,
): "mine" | "free" | "held" {
  if (!held) return "free";
  if (held.agent === agent) return "mine";
  // An unreadable take time is unknown, and taking over on an unknown is how
  // two agents end up on one unit: it is read as held, which is safe (the
  // holder serves it) rather than greedy.
  const taken = Date.parse(held.takenAt);
  if (!Number.isFinite(taken)) return "held";
  return taken < startedAt.getTime() ? "free" : "held";
}

/**
 * Claim one account: take the fence, or find it somebody else's.
 *
 * - nobody holds it → take it (a fresh claim, epoch 0);
 * - I hold it → **no write at all**: the fence is held, the take time and the
 *   catch-up states are already the truth, and a renewal would be a durable
 *   write caused by nothing but the clock;
 * - another agent holds it, and started after us → null, it is theirs;
 * - another agent holds it, and took it before we started → take it over with
 *   `epoch + 1`, **keeping the states it recorded**, so catch-up continues where
 *   the process that was here before us stopped instead of starting from
 *   nothing.
 *
 * The compare-and-set is unchanged and it is what makes this safe: a stale
 * holder whose fence has moved on has its next write refused, so a rolling
 * restart is a brief overlap in reads and never two agents writing one unit.
 * The epoch is what a run is fenced on (`claimStillMine`), so a holder that
 * lost the unit mid-run stops before it writes what its successor will write
 * again.
 */
export async function claimAccount(
  store: AgentStore,
  agent: string,
  opts: ClaimOpts,
): Promise<AgentClaim | null> {
  // The cheap answer first, without a token read and without a write: the unit
  // is mine already, or it is a peer's that is still running. A pass that holds
  // its claim therefore costs one read of the claim document and no upload at
  // all — and the pass that knows from memory which units it holds does not
  // even ask (see `pass` in agent.ts).
  const opened = await store.readClaim();
  const answer = verdict(opened?.doc, agent, opts.startedAt);
  if (answer === "mine" && opened) return opened.doc;
  if (answer === "held") {
    opts.onRefused?.("held");
    return null;
  }
  const takenAt = opts.now.toISOString();
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    // The token is read **before** the document, and that order is the whole
    // guard: read the other way round, a claim written by another agent in
    // between is invisible to the comparison — the token already reflects it,
    // the write is an ordinary update, and both agents walk away believing
    // they hold the unit. Read this way, any write in that window advances the
    // state past the token, so the conditional write is refused and the loser
    // comes back next pass.
    const token = await store.state();
    const found = await store.readClaim();
    const held = found?.doc;
    const answer = verdict(held, agent, opts.startedAt);
    if (answer === "mine") return held ?? null;
    if (answer === "held") {
      opts.onRefused?.("held");
      return null;
    }
    const claim: AgentClaim = held
      ? {
          ...held,
          agent,
          epoch: claimEpoch(held) + 1,
          takenAt,
        }
      : {
          v: 1,
          accountId: store.accountId,
          agent,
          epoch: 0,
          takenAt,
          states: {},
        };
    try {
      await store.writeClaim(claim, { ifInState: token });
      return claim;
    } catch (err) {
      if (!isStateMismatch(err)) throw err;
    }
  }
  opts.onRefused?.("contended");
  return null;
}

/**
 * Give a claim back, if I am still the one holding it.
 *
 * Both halves matter. The owner check alone is not enough: between reading the
 * claim and removing it, the lease can lapse and a successor can take the unit
 * over — destroying then would delete the **live** claim of the agent that
 * replaced me, and a third one would find the unit free while two are running
 * it. The removal therefore carries the state it was read against, and a
 * mismatch means the answer is "not mine any more", not "try again".
 */
export async function releaseClaim(
  store: AgentStore,
  agent: string,
  epoch?: number,
): Promise<boolean> {
  const found = await store.readClaim();
  if (!found || found.doc.agent !== agent) return false;
  if (epoch !== undefined && claimEpoch(found.doc) !== epoch) return false;
  try {
    await store.destroyClaim({ ifInState: found.state });
  } catch (err) {
    if (isStateMismatch(err)) return false;
    throw err;
  }
  return true;
}

/**
 * Whether this agent still holds the account, in the epoch it was granted.
 *
 * What the executor asks before each effect that leaves the process — sending
 * mail, posting to a chat, writing a file — so a run whose lease lapsed and was
 * taken over stops instead of writing results the new owner will write again.
 */
export async function claimStillMine(
  store: AgentStore,
  agent: string,
  epoch: number,
): Promise<boolean> {
  const found = await store.readClaim();
  return Boolean(found && found.doc.agent === agent && claimEpoch(found.doc) === epoch);
}

/**
 * Record what a claim has reconciled up to, and when it was observed.
 *
 * The new state is written together with the claim so that a takeover can
 * catch up: a agent that dies mid-pass leaves the anchor at the last thing it
 * finished, and the next agent re-reads from there rather than from nothing.
 *
 * `statesAt` carries the instant each state was read, so a later pass can tell
 * the write it is reporting from a write to the same record that came earlier.
 *
 * A state that has not moved is not written at all. A pass that has read no
 * change reports the state the claim already records — and writing that anyway
 * would cost a blob the account never gets back, *and* move the account on:
 * the claim is a file in the very account the state describes, so its own write
 * is the next change the next pass reads, which is a pass writing a record of
 * its own writing, once a minute, for as long as nothing happens.
 */
export async function saveClaimStates(
  store: AgentStore,
  claim: AgentClaim,
  states: Record<string, string>,
  statesAt: Record<string, string> = {},
): Promise<AgentClaim | null> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const token = await store.state();
    const found = await store.readClaim();
    // A claim that is not there is not mine to write into: it was released, and
    // recreating it here would put the unit back under a agent that has already
    // given it away — held by nobody, for as long as it takes to notice. The next
    // pass claims the unit again through `claimAccount`, which is the one place a
    // claim is born.
    if (!found) return null;
    if (found.doc.agent !== claim.agent) return null;
    // A claim that has moved to a new epoch is somebody else's run: the anchor
    // this agent is saving belongs to an ownership that is over.
    if (claimEpoch(found.doc) !== claimEpoch(claim)) return null;
    const moved = Object.entries(states).some(
      ([type, state]) => found.doc.states[type] !== state,
    );
    if (!moved) return found.doc;
    const updated: AgentClaim = {
      ...found.doc,
      states: { ...found.doc.states, ...states },
      statesAt: { ...found.doc.statesAt, ...statesAt },
    };
    try {
      await store.writeClaim(updated, { ifInState: token });
      return updated;
    } catch (err) {
      if (!isStateMismatch(err)) throw err;
    }
  }
  return null;
}

/**
 * Claim the agent's event stream, in the agent's own account. Exactly one
 * agent holds it (ADR 0003): the others poll, which is why the default
 * deployment is one agent and a second one is a deliberate choice.
 *
 * The rule is the accounts' rule (`verdict`): held by another agent that
 * started after us means theirs, and a stream taken before this process started
 * is free to take over — one write, at the moment it is taken, and none while it
 * is held.
 */
export async function claimStream(
  store: AgentStore,
  agent: string,
  opts: ClaimOpts,
): Promise<AgentStreamClaim | null> {
  // Mine already: no write, and no token read either. The stream is a fence
  // like an account's claim, and holding it is not an event.
  const opened = await store.readStreamClaim();
  const answer = verdict(opened?.doc, agent, opts.startedAt);
  if (answer === "mine" && opened) return opened.doc;
  if (answer === "held") return null;
  const takenAt = opts.now.toISOString();
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    // The token before the document, for the same reason as in `claimAccount`.
    const token = await store.state();
    const found = await store.readStreamClaim();
    const held = found?.doc;
    const current = verdict(held, agent, opts.startedAt);
    if (current === "mine") return held ?? null;
    if (current === "held") return null;
    const claim: AgentStreamClaim = {
      v: 1,
      agent,
      epoch: held ? claimEpoch(held) + 1 : 0,
      takenAt,
    };
    try {
      await store.writeStreamClaim(claim, { ifInState: token });
      return claim;
    } catch (err) {
      if (!isStateMismatch(err)) throw err;
    }
  }
  return null;
}

/** Give the stream back, so a replacement agent opens it at once. */
export async function releaseStreamClaim(
  store: AgentStore,
  agent: string,
  epoch?: number,
): Promise<boolean> {
  const found = await store.readStreamClaim();
  if (!found || found.doc.agent !== agent) return false;
  if (epoch !== undefined && claimEpoch(found.doc) !== epoch) return false;
  try {
    await store.destroyStreamClaim({ ifInState: found.state });
  } catch (err) {
    if (isStateMismatch(err)) return false;
    throw err;
  }
  return true;
}

/** When this process started: one run's id never equals the next one's. */
const PROCESS_STARTED = Date.now().toString(36);

/**
 * How someone is the same agent again: stable for the process, different for
 * every run. A restarted agent therefore never mistakes the process it
 * replaced for itself, and — with takeover decided against this process's own
 * start — it takes that process's claims over at once rather than waiting
 * anything out.
 */
export function agentId(address: string): string {
  return `${address}#${process.pid}-${PROCESS_STARTED}`;
}
