/**
 * Today — the queue a caller works (ADR 0040).
 *
 * Today is not stored: it is the view of the rows that are mine or due, ordered
 * so a row already in my hands is finished first, then what is late, then what
 * carried no date. A row another caller holds is not offered, and a claim that has
 * lapsed is free again — which is what makes a caller leaving the desk cost
 * nothing.
 *
 * The counts come back with the queue because a list being worked must say how
 * much is left, and "due today" is not the same number as "in Today".
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
  /** Open rows due now and not another caller's, dated or not. */
  due: number;
  /** Open rows whose next call is still ahead. */
  upcoming: number;
  /** Open rows another caller holds right now. */
  heldByOthers: number;
}

/** Where a row stands for this caller, and so the band it sorts in. */
type Band = "mine" | "due" | "free" | "later";

const ORDER: Record<Band, number> = { mine: 0, due: 1, free: 2, later: 3 };

function bandOf(row: RowDoc, caller: string, now: Date): Band {
  if (claimIsLive(row.claim, now) && row.claim.by === caller) return "mine";
  if (row.nextCallAt === null) return "free";
  return Date.parse(row.nextCallAt) <= now.getTime() ? "due" : "later";
}

/** The key within a band: the oldest claim, the earliest date, the oldest row. */
function keyOf(row: RowDoc, band: Band): string {
  if (band === "mine") return row.claim?.at ?? "";
  if (band === "due") return row.nextCallAt ?? "";
  return row.createdAt;
}

export function todayQueue(
  rows: readonly RowDoc[],
  { caller, now, limit = 20 }: TodayInput,
): TodayResult {
  let due = 0;
  let upcoming = 0;
  let heldByOthers = 0;
  const offered: { row: RowDoc; band: Band }[] = [];

  for (const row of rows) {
    if (row.state !== "open") continue;
    if (heldByOther(row, caller, now)) {
      heldByOthers += 1;
      continue;
    }
    const band = bandOf(row, caller, now);
    if (band === "later") {
      upcoming += 1;
      continue;
    }
    // A row with no date is due now — "as soon as there is time" — so the count is
    // every row in hand, not only the ones a date made late.
    due += 1;
    offered.push({ row, band });
  }

  offered.sort(
    (a, b) =>
      ORDER[a.band] - ORDER[b.band] ||
      keyOf(a.row, a.band).localeCompare(keyOf(b.row, b.band)),
  );

  return {
    queue: offered.slice(0, Math.max(0, limit)).map((entry) => entry.row),
    due,
    upcoming,
    heldByOthers,
  };
}
