/**
 * What a row does when a caller touches it (ADR 0040), as pure rules.
 *
 * The two acts are "take this row" and "settle it". Taking is a lease: a caller
 * holds one row at a time and the claim lapses on its own, so leaving the desk
 * costs nothing and a row abandoned mid-call comes back. Settling records the
 * call and decides what the row does next: **a date means it stays open until
 * that date, no date means the row is done.** Which is why an outcome's label is
 * the campaign's business and never a switch in the code.
 */

import { claimIsLive, heldByOther, type RowDoc, withCall } from "../shared/outbound.js";

/** How long a taken row is believed to be in a caller's hands. */
export const CLAIM_LEASE_MS = 15 * 60 * 1000;

export type TakeResult =
  | { ok: true; row: RowDoc }
  | { ok: false; reason: "settled" | "held_by_other" };

/** Take a row: the caller holds it until the lease lapses. */
export function takeRow(
  row: RowDoc,
  { by, now, leaseMs = CLAIM_LEASE_MS }: { by: string; now: Date; leaseMs?: number },
): TakeResult {
  if (row.state !== "open") return { ok: false, reason: "settled" };
  if (heldByOther(row, by, now)) return { ok: false, reason: "held_by_other" };
  return {
    ok: true,
    row: {
      ...row,
      claim: {
        by,
        at: now.toISOString(),
        until: new Date(now.getTime() + leaseMs).toISOString(),
      },
    },
  };
}

export interface SettleInput {
  /** The campaign's outcome id. */
  outcome: string;
  note: string | null;
  by: string;
  at: Date;
  /** The card spoken to, when the call named somebody. */
  cardUid?: string | null;
  /** When this row is due again; null settles it. */
  nextCallAt?: string | null;
}

export type SettleResult =
  | { ok: true; row: RowDoc }
  | { ok: false; reason: "settled" | "held_by_other" | "unknown_outcome" };

/**
 * Give a taken row back before its call.
 *
 * A caller holds one row at a time, so a row taken by mistake would keep them from
 * the list for the length of the lease: the release is what makes that mistake cost
 * nothing. Only the caller holding it may give it back.
 */
export function releaseRow(
  row: RowDoc,
  { by, now }: { by: string; now: Date },
): { ok: true; row: RowDoc } | { ok: false; reason: "settled" | "not_mine" } {
  if (row.state !== "open") return { ok: false, reason: "settled" };
  if (!claimIsLive(row.claim, now) || row.claim.by !== by)
    return { ok: false, reason: "not_mine" };
  return { ok: true, row: { ...row, claim: null } };
}

/** Settle a row with the call it just took. */
export function settleRow(
  row: RowDoc,
  { outcome, note, by, at, cardUid = null, nextCallAt = null }: SettleInput,
  outcomes: readonly string[],
): SettleResult {
  if (row.state !== "open") return { ok: false, reason: "settled" };
  if (heldByOther(row, by, at)) return { ok: false, reason: "held_by_other" };
  // An outcome the campaign never named is a caller writing into a vocabulary
  // that does not exist, and the row would carry a word no screen can label.
  if (!outcomes.includes(outcome)) return { ok: false, reason: "unknown_outcome" };

  const called = withCall(row, { at: at.toISOString(), by, outcome, note, cardUid });
  return {
    ok: true,
    row: {
      ...called,
      state: nextCallAt ? "open" : "done",
      nextCallAt,
      claim: null,
      cardUid: cardUid ?? row.cardUid,
    },
  };
}
