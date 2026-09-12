/**
 * Coordination without a coordinator (ADR 0003 §6).
 *
 * A worker serves the accounts it wins, and exactly one worker
 * holds the agent's event stream. There is no lock to take and no coordinator
 * to ask: a claim is a document, its owner and heartbeat are the truth, and a
 * heartbeat older than the tolerance is free for anyone to take over. Every
 * write passes the state it read as `ifInState`, so the two workers that race
 * for the same claim cannot both believe they won — the loser's write is
 * refused and retried against what the winner left behind.
 *
 * Losing a race is normal here, not an error: the caller simply serves nothing
 * for that unit and comes back next pass.
 */

import { isStateMismatch } from "../jmap.js";
import {
  type AgentClaim,
  type AgentStreamClaim,
  claimEpoch,
  leaseExpired,
} from "./documents.js";
import type { AgentStore } from "./store.js";

export interface ClaimOpts {
  /** The instant the claim is written for; injected so a test can age a lease. */
  now: Date;
  /** How long a claim may go un-renewed before another worker takes it over. */
  leaseMs: number;
  /**
   * Why the claim was refused, when it was: the caller logs the anomaly and
   * stays quiet about the ordinary answer. A bare `null` cannot tell "another
   * worker is serving this unit" — which is the design working — from "nobody
   * is serving it and my write kept losing", which is the fleet quietly
   * stopping.
   */
  onRefused?: (reason: ClaimRefusal) => void;
}

/** Why a claim came back empty. */
export type ClaimRefusal =
  /** A peer holds it with a live lease. */
  | "held"
  /** Nobody's, but the write lost every compare-and-set: contention, not ownership. */
  | "contended";

/**
 * How many times a read-modify-write retries after losing a compare-and-set.
 * Four attempts cover the ordinary race (another worker's heartbeat landing
 * between the read and the write); a longer fight means somebody else owns the
 * unit now, and giving up is the correct answer.
 */
const CAS_ATTEMPTS = 4;

/**
 * Claim (or renew, or take over) one account.
 *
 * - nobody holds it → take it;
 * - I hold it → renew the heartbeat, keeping the instant the lease started and
 *   keeping the epoch, because a renewal is the same ownership and a fence
 *   taken before it still holds;
 * - another worker holds it with a live lease → null, it is theirs;
 * - another worker holds it with a stale lease → take it over, **keeping the
 *   states it recorded**, so catch-up continues where the dead worker stopped
 *   instead of starting from nothing.
 *
 * This is the one renewal path: a holder keeps its claim live by asking for it
 * again under its own worker id, so the epoch, the lease instant and the
 * ownership are decided in a single place. A renewal written beside it would
 * have to restate all three, and the one that read the worker alone would renew
 * a claim that had moved to a new epoch under the same id.
 */
export async function claimAccount(
  store: AgentStore,
  worker: string,
  opts: ClaimOpts,
): Promise<AgentClaim | null> {
  const heartbeatAt = opts.now.toISOString();
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    // The token is read **before** the document, and that order is the whole
    // guard: read the other way round, a claim written by another worker in
    // between is invisible to the comparison — the token already reflects it,
    // the write is an ordinary update, and both workers walk away believing
    // they hold the unit. Read this way, any write in that window advances the
    // state past the token, so the conditional write is refused and the loser
    // comes back next pass.
    const token = await store.state();
    const found = await store.readClaim();
    const held = found?.doc;
    const mine = held?.worker === worker;
    if (
      held &&
      !mine &&
      !leaseExpired(held.heartbeatAt, opts.now.getTime(), opts.leaseMs)
    ) {
      opts.onRefused?.("held");
      return null;
    }
    const claim: AgentClaim = held
      ? {
          ...held,
          worker,
          epoch: claimEpoch(held) + (mine ? 0 : 1),
          leasedAt: mine ? held.leasedAt : heartbeatAt,
          heartbeatAt,
        }
      : {
          v: 1,
          accountId: store.accountId,
          worker,
          epoch: 0,
          leasedAt: heartbeatAt,
          heartbeatAt,
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
 * over — destroying then would delete the **live** claim of the worker that
 * replaced me, and a third one would find the unit free while two are running
 * it. The removal therefore carries the state it was read against, and a
 * mismatch means the answer is "not mine any more", not "try again".
 */
export async function releaseClaim(
  store: AgentStore,
  worker: string,
  epoch?: number,
): Promise<boolean> {
  const found = await store.readClaim();
  if (!found || found.doc.worker !== worker) return false;
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
 * Whether this worker still holds the account, in the epoch it was granted.
 *
 * What the executor asks before each effect that leaves the process — sending
 * mail, posting to a chat, writing a file — so a run whose lease lapsed and was
 * taken over stops instead of writing results the new owner will write again.
 */
export async function claimStillMine(
  store: AgentStore,
  worker: string,
  epoch: number,
): Promise<boolean> {
  const found = await store.readClaim();
  return Boolean(found && found.doc.worker === worker && claimEpoch(found.doc) === epoch);
}

/**
 * Record what a claim has reconciled up to, and when it was observed.
 *
 * The new state is written together with the claim so that a takeover can
 * catch up: a worker that dies mid-pass leaves the anchor at the last thing it
 * finished, and the next worker re-reads from there rather than from nothing.
 *
 * `statesAt` carries the instant each state was read, so a later pass can tell
 * the write it is reporting from a write to the same record that came earlier.
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
    // recreating it here would put the unit back under a worker that has already
    // given it away — busy for a whole lease, with nobody serving it. The next
    // pass claims the unit again through `claimAccount`, which is the one place a
    // claim is born.
    if (!found) return null;
    if (found.doc.worker !== claim.worker) return null;
    // A claim that has moved to a new epoch is somebody else's run: the anchor
    // this worker is saving belongs to an ownership that is over.
    if (claimEpoch(found.doc) !== claimEpoch(claim)) return null;
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
 * worker holds it (ADR §6): the others poll, which is why the default
 * deployment is one worker and a second one is a deliberate choice.
 *
 * Claiming with the same worker id is also the stream's renewal: the holder
 * keeps its claim live through this function, so the epoch and the lease
 * instant are decided in the one place that answers who holds the stream.
 */
export async function claimStream(
  store: AgentStore,
  worker: string,
  opts: ClaimOpts,
): Promise<AgentStreamClaim | null> {
  const heartbeatAt = opts.now.toISOString();
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const token = await store.state();
    const found = await store.readStreamClaim();
    const held = found?.doc;
    const mine = held?.worker === worker;
    if (
      held &&
      !mine &&
      !leaseExpired(held.heartbeatAt, opts.now.getTime(), opts.leaseMs)
    )
      return null;
    const claim: AgentStreamClaim = {
      v: 1,
      worker,
      epoch: held ? claimEpoch(held) + (mine ? 0 : 1) : 0,
      leasedAt: mine && held ? held.leasedAt : heartbeatAt,
      heartbeatAt,
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

/** Give the stream back, so a replacement worker opens it at once. */
export async function releaseStreamClaim(
  store: AgentStore,
  worker: string,
  epoch?: number,
): Promise<boolean> {
  const found = await store.readStreamClaim();
  if (!found || found.doc.worker !== worker) return false;
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
 * How someone is the same worker again: stable for the process, different for
 * every run. A restarted worker therefore waits out the lease of the process it
 * replaced instead of mistaking that process's claims for its own.
 */
export function workerId(address: string): string {
  return `${address}#${process.pid}-${PROCESS_STARTED}`;
}
