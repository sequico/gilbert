/**
 * Coordination without a coordinator (ADR 0003 §6).
 *
 * A worker serves the `account × area` units it wins, and exactly one worker
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
  type AgentArea,
  type AgentClaim,
  type AgentStreamClaim,
  leaseExpired,
} from "./documents.js";
import type { AgentStore } from "./store.js";

export interface ClaimOpts {
  /** The instant the claim is written for; injected so a test can age a lease. */
  now: Date;
  /** How long a claim may go un-renewed before another worker takes it over. */
  leaseMs: number;
}

/**
 * How many times a read-modify-write retries after losing a compare-and-set.
 * Four attempts cover the ordinary race (another worker's heartbeat landing
 * between the read and the write); a longer fight means somebody else owns the
 * unit now, and giving up is the correct answer.
 */
const CAS_ATTEMPTS = 4;

/**
 * Claim (or renew, or take over) one account's area.
 *
 * - nobody holds it → take it;
 * - I hold it → renew the heartbeat, keeping the instant the lease started;
 * - another worker holds it with a live lease → null, it is theirs;
 * - another worker holds it with a stale lease → take it over, **keeping the
 *   states it recorded**, so catch-up continues where the dead worker stopped
 *   instead of starting from nothing.
 */
export async function claimArea(
  store: AgentStore,
  area: AgentArea,
  worker: string,
  opts: ClaimOpts,
): Promise<AgentClaim | null> {
  const heartbeatAt = opts.now.toISOString();
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const found = await store.readClaim(area);
    const held = found?.doc;
    const mine = held?.worker === worker;
    if (
      held &&
      !mine &&
      !leaseExpired(held.heartbeatAt, opts.now.getTime(), opts.leaseMs)
    )
      return null;
    const claim: AgentClaim = held
      ? {
          ...held,
          worker,
          leasedAt: mine ? held.leasedAt : heartbeatAt,
          heartbeatAt,
        }
      : {
          v: 1,
          accountId: store.accountId,
          area,
          worker,
          leasedAt: heartbeatAt,
          heartbeatAt,
          states: {},
        };
    try {
      // The state read with the document is the compare-and-set token; a claim
      // that does not exist yet is guarded by the state read after it.
      await store.writeClaim(claim, { ifInState: found?.state ?? (await store.state()) });
      return claim;
    } catch (err) {
      if (!isStateMismatch(err)) throw err;
    }
  }
  return null;
}

/** Renew a claim I still hold. Null means it is somebody else's now. */
export async function renewClaim(
  store: AgentStore,
  claim: AgentClaim,
  opts: { now: Date },
): Promise<AgentClaim | null> {
  const heartbeatAt = opts.now.toISOString();
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const found = await store.readClaim(claim.area);
    if (!found || found.doc.worker !== claim.worker) return null;
    try {
      const renewed = { ...found.doc, heartbeatAt };
      await store.writeClaim(renewed, { ifInState: found.state });
      return renewed;
    } catch (err) {
      if (!isStateMismatch(err)) throw err;
    }
  }
  return null;
}

/** Give a claim back, if I am still the one holding it. */
export async function releaseClaim(
  store: AgentStore,
  area: AgentArea,
  worker: string,
): Promise<boolean> {
  const found = await store.readClaim(area);
  if (!found || found.doc.worker !== worker) return false;
  await store.destroyClaim(area);
  return true;
}

/**
 * Record what a claim has reconciled up to.
 *
 * The new state is written together with the claim so that a takeover can
 * catch up: a worker that dies mid-pass leaves the anchor at the last thing it
 * finished, and the next worker re-reads from there rather than from nothing.
 */
export async function saveClaimStates(
  store: AgentStore,
  claim: AgentClaim,
  states: Record<string, string>,
): Promise<AgentClaim | null> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const found = await store.readClaim(claim.area);
    if (found && found.doc.worker !== claim.worker) return null;
    const updated: AgentClaim = {
      ...(found?.doc ?? claim),
      states: { ...(found?.doc ?? claim).states, ...states },
    };
    try {
      await store.writeClaim(updated, {
        ifInState: found?.state ?? (await store.state()),
      });
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
 */
export async function claimStream(
  store: AgentStore,
  worker: string,
  opts: ClaimOpts,
): Promise<AgentStreamClaim | null> {
  const heartbeatAt = opts.now.toISOString();
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
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
      leasedAt: mine && held ? held.leasedAt : heartbeatAt,
      heartbeatAt,
    };
    try {
      await store.writeStreamClaim(claim, {
        ifInState: found?.state ?? (await store.state()),
      });
      return claim;
    } catch (err) {
      if (!isStateMismatch(err)) throw err;
    }
  }
  return null;
}

/** Renew the stream claim I still hold. Null means it is somebody else's now. */
export async function renewStreamClaim(
  store: AgentStore,
  claim: AgentStreamClaim,
  opts: { now: Date },
): Promise<AgentStreamClaim | null> {
  const heartbeatAt = opts.now.toISOString();
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const found = await store.readStreamClaim();
    if (!found || found.doc.worker !== claim.worker) return null;
    try {
      const renewed = { ...found.doc, heartbeatAt };
      await store.writeStreamClaim(renewed, { ifInState: found.state });
      return renewed;
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
): Promise<boolean> {
  const found = await store.readStreamClaim();
  if (!found || found.doc.worker !== worker) return false;
  await store.destroyStreamClaim();
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
