/**
 * Today — the queue a caller works (ADR 0040).
 *
 * Today is not stored: it is the view of the rows that are mine or due, ordered
 * so the work that is already late comes first, and so a caller who has started a
 * row can finish it before taking another. A row another caller holds is not
 * offered, and a claim that has lapsed is free again — which is what makes a
 * caller leaving the desk cost nothing.
 *
 * The counts come back with the queue because a list that is being worked must
 * say how much is left, and "due today" is not the same number as "in Today".
 */

import { claimIsLive, heldByOther, type RowDoc } from "../shared/outbound.js";

export interface TodayInput {
  /** Who is looking. */
  caller: string;
  /** Now, as the caller's own clock says. */
  now: Date;
  /** The most rows to offer; the counts still count every row. */
  limit?: number;
}

export interface TodayResult {
  /** The rows to work, in the order to work them. */
  queue: RowDoc[];
  /** Open rows due now and not another caller's. */
  due: number;
  /** Open rows whose next call is still ahead. */
  upcoming: number;
  /** Open rows another caller holds right now. */
  heldByOthers: number;
}

/** Where a row falls in the order, lowest first. */
function bandOf(row: RowDoc, caller: string, now: Date): number {
  if (claimIsLive(row.claim, now) && row.claim.by === caller) return 0; // started, finish it
  if (row.nextCallAt !== null && Date.parse(row.nextCallAt) <= now.getTime()) return 1; // due
  return 2; // free, no date
}

export function todayQueue(rows: readonly RowDoc[], { caller, now, limit = 20 }: TodayInput): TodayResult {
  let due = 0;
  let upcoming = 0;
  let heldByOthers = 0;
  const offered: { row: RowDoc; band: number }[] = [];

  for (const row of rows) {
    if (row.state !== "open") continue;
    if (heldByOther(row, caller, now)) {
      heldByOthers += 1;
      continue;
    }
    const band = bandOf(row, caller, now);
    if (band === 2 && row.nextCallAt !== null) {
      upcoming += 1;
      continue;
    }
    if (band === 1) due += 1;
    offered.push({ row, band });
  }

  offered.sort((a, b) => {
    if (a.band !== b.band) return a.band - b.band;
    if (a.band === 0) return (a.row.claim?.at ?? "").localeCompare(b.row.claim?.at ?? "");
    if (a.band === 1) return (a.row.nextCallAt ?? "").localeCompare(b.row.nextCallAt ?? "");
    return a.row.createdAt.localeCompare(b.row.createdAt);
  });

  return { queue: offered.slice(0, Math.max(0, limit)).map((entry) => entry.row), due, upcoming, heldByOthers };
}
