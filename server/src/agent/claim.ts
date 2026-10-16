/**
 * The installation's single claim (ADR 0036).
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
 * start takes it over. The window after a holder's last renew is the one
 * question this answers, and it is why a restart needs no attention — a stale
 * claim costs one TTL of waiting, never a document to delete by hand.
 *
 * Holding the claim costs one read per pass; a renew or a take costs one write
 * (one upload). Nothing here is on a clock of its own: the caller says when.
 */

import {
  appFolderState,
  type Ctx,
  destroyAppNode,
  filesAccountId,
  readAppFileAt,
  writeAppFile,
} from "../appFolder.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import { isRecord } from "../shared/json.js";
import { isInstant } from "../shared/run.js";

/** The claim's document, in the app folder's own top level. */
export const CLAIM_FILE = "agent-claim.json";

/**
 * How long a claim that is not renewed is believed.
 *
 * The one number that says both when a live holder must renew and how long a
 * dead one's claim blocks the next start. Ten minutes is long enough that a
 * working agent's renewals are ordinary and short enough that a crash is
 * noticed by a restart rather than by a person.
 */
export const CLAIM_TTL_MS = 10 * 60_000;

/** The claim as it is stored. */
export interface ClaimDoc {
  v: 1;
  /** Who holds it. */
  holder: string;
  /** When it was taken, or last renewed. */
  takenAt: string;
  /** The instant it stops being believed, ISO 8601. */
  expires: string;
}

function isClaimDoc(x: unknown): x is ClaimDoc {
  return (
    isRecord(x) &&
    x.v === 1 &&
    typeof x.holder === "string" &&
    !!x.holder &&
    isInstant(x.takenAt) &&
    isInstant(x.expires)
  );
}

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
 * Take the claim for `holder`, or answer null because a live peer holds it.
 *
 * A claim this `holder` already holds is answered as itself with no write:
 * holding it is not an event. One held by another process is left alone until
 * it lapses. The write is conditional on the state read before the claim was,
 * so two processes racing for a free claim cannot both believe they won — the
 * loser is refused and comes back to a claim that is now readable.
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
    if (held && Date.parse(held.expires) > now.getTime()) return null;
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
