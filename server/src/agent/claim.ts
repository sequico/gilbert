/**
 * The installation's single claim (ADR 0032).
 *
 * One agent acts for an installation, and a second copy of the process must not
 * work the same runs. There is no per-group lease and no coordinator to ask:
 * the claim is **one document** in the app folder of the account the agent
 * signs in as — the Master's, the installation's own principal — and it is
 * taken by the conditional write JMAP does offer (`ifInState`, `appFolder.ts`).
 * A claim that is taken carries who holds it and when it stops being believed.
 *
 * A holder **renews** it while it works, and a claim that lapses is free: a
 * process that dies without releasing leaves a claim that expires, and the next
 * start takes it over. A holder this host can see to be gone is taken at once;
 * one on another host waits the lease. Either way a restart never leaves a
 * document to delete by hand.
 *
 * Holding the claim costs one read per pass; a renew or a take costs one write
 * (one upload). Nothing here is on a clock of its own: the caller says when.
 *
 * The claim's **document** — its path, its TTL, its shape and the predicate
 * that reads one — is `shared/agent.ts`, in the same position a run and a fact
 * are in: a stored contract both tiers read, so the Administration surface
 * reads the very shape this file writes.
 */

import { hostname } from "node:os";
import {
  appFolderState,
  type Ctx,
  destroyAppNode,
  filesAccountId,
  readAppFileAt,
  writeAppFile,
} from "../appFolder.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import { CLAIM_FILE, CLAIM_TTL_MS, type ClaimDoc, isClaimDoc } from "../shared/agent.js";

export type { ClaimDoc };
export { CLAIM_FILE, CLAIM_TTL_MS };

/** The account the claim lives in: the one the agent signs in as. */
function claimAccountId(ctx: Ctx): string {
  const accountId = filesAccountId(ctx);
  if (!accountId)
    throw new Error(
      "The session has no Files account, so the installation's claim has nowhere to live.",
    );
  return accountId;
}

/**
 * The stored claim and the node it sits on, or null.
 *
 * A document that is not this shape reads as no claim, and so does one whose
 * bytes do not come back: an installation whose claim document was damaged has
 * no agent at all if a bad read is an exception, which is the worst outcome
 * this file has. The takeover is safe because it is conditional either way: two
 * processes that both read a broken claim write against the same state, one
 * wins, and the loser re-reads what the winner stored.
 */
async function readClaimAt(
  ctx: Ctx,
  accountId: string,
): Promise<{ doc: ClaimDoc; nodeId: string } | null> {
  let found: Awaited<ReturnType<typeof readAppFileAt>>;
  try {
    found = await readAppFileAt(ctx, accountId, CLAIM_FILE);
  } catch {
    // A node that is there with bytes that do not come back is unreadable, not
    // absent — and a claim nobody can read is a claim this process may take.
    return null;
  }
  if (!found) return null;
  let whole: unknown;
  try {
    whole = JSON.parse(found.text);
  } catch {
    return null;
  }
  if (!isClaimDoc(whole)) return null;
  const nodeId = found.file.id;
  return typeof nodeId === "string" ? { doc: whole, nodeId } : null;
}

/** Who holds the installation's claim, or null when nobody does. */
export async function readClaim(ctx: Ctx): Promise<ClaimDoc | null> {
  const accountId = claimAccountId(ctx);
  return (await readClaimAt(ctx, accountId))?.doc ?? null;
}

/** The claim's expiry, `CLAIM_TTL_MS` after `now`. */
function expiryOf(now: Date): string {
  return new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
}

/**
 * Whether the process a claim names may still be running.
 *
 * A holder is `hostname#pid` (`supervisor.ts`). A process this host can see is
 * checked: one that was killed — an update restarts the service, and a claim
 * left behind by a dead process is not going to be renewed — must not make the
 * next start wait a whole TTL. The live run of 2026-10-20 lost a chat message
 * in the four and a half minutes a restarted process waited for a dead claim's
 * lease. A holder on another host cannot be checked from here and keeps the TTL.
 *
 * A PID the machine has reused by another process reads as alive; the TTL is
 * the answer then, exactly as it was before.
 */
function holderMaybeAlive(holder: string): boolean {
  const at = holder.lastIndexOf("#");
  if (at <= 0) return true;
  if (holder.slice(0, at) !== hostname()) return true;
  const pid = Number.parseInt(holder.slice(at + 1), 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH is "no such process"; EPERM is a live process this user may not signal.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Take the claim for `holder`, or answer null because a live peer holds it.
 *
 * A claim this `holder` already holds is answered as itself with no write:
 * holding it is not an event. One held by another process is left alone until
 * it lapses — or, on this host, until the process it names is gone. The write
 * is conditional on the state read before the claim was, so two processes
 * racing for a free claim cannot both believe they won — the loser is refused
 * and comes back to a claim that is now readable.
 */
export async function takeClaim(
  ctx: Ctx,
  holder: string,
  now: Date,
): Promise<ClaimDoc | null> {
  const accountId = claimAccountId(ctx);
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = await appFolderState(ctx, accountId);
    const held = (await readClaimAt(ctx, accountId))?.doc;
    if (held?.holder === holder) return held;
    if (held && Date.parse(held.expires) > now.getTime() && holderMaybeAlive(held.holder))
      return null;
    const doc: ClaimDoc = {
      v: 1,
      holder,
      takenAt: now.toISOString(),
      expires: expiryOf(now),
    };
    try {
      await writeAppFile(ctx, accountId, CLAIM_FILE, doc, { ifInState: token });
      return doc;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  return null;
}

/**
 * Push the claim's expiry out, if `holder` still holds it.
 *
 * False is one answer with two causes — a peer took the claim over, or this
 * holder's write kept losing — and the caller's act in both is the same: it
 * stops working the runs it claimed.
 */
export async function renewClaim(ctx: Ctx, holder: string, now: Date): Promise<boolean> {
  const accountId = claimAccountId(ctx);
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = await appFolderState(ctx, accountId);
    const found = await readClaimAt(ctx, accountId);
    if (found?.doc.holder !== holder) return false;
    try {
      await writeAppFile(
        ctx,
        accountId,
        CLAIM_FILE,
        { ...found.doc, expires: expiryOf(now) },
        { ifInState: token },
      );
      return true;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  return false;
}

/** Give the claim back, if `holder` still holds it; false when it does not. */
export async function releaseClaim(ctx: Ctx, holder: string): Promise<boolean> {
  const accountId = claimAccountId(ctx);
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const token = await appFolderState(ctx, accountId);
    const found = await readClaimAt(ctx, accountId);
    if (found?.doc.holder !== holder) return false;
    try {
      // Conditional on the state the claim was read at, so a release cannot
      // remove a claim a peer has just taken over.
      await destroyAppNode(ctx, accountId, found.nodeId, { ifInState: token });
      return true;
    } catch (err) {
      if (retryStateMismatch(err, attempt)) break;
    }
  }
  return false;
}
