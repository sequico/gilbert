/**
 * A pasted list, read into rows (ADR 0040).
 *
 * The import is the surface the feature lives or dies by, so it is a pure
 * decision over the text: what each line gave, what it lost, and how many of each
 * the caller is about to be told. Nothing is written here — the caller writes what
 * this plans, which is what makes the counts testable against a hundred real
 * lines instead of against a database.
 *
 * Four things a line can be, and a person is told each of them: a row, a
 * duplicate of another line in the same paste, a number the installation
 * promised never to call, or a line this build cannot read.
 */

import type { RowDoc } from "../shared/outbound.js";
import { lineEntry, type NumberRefusal, normaliseNumber } from "./phone.js";

/** Why a line became no row. `no_number` is the line that carried none at all. */
export type ImportRefusalReason = NumberRefusal | "no_number";

export interface ImportRefusal {
  line: string;
  reason: ImportRefusalReason;
}

export interface ImportPlan {
  /** The rows to write, in the order the list gave them. */
  rows: RowDoc[];
  /** The lines that became no row, with the reason a person reads. */
  refused: ImportRefusal[];
  /** Lines that repeated a number an earlier line of this paste already gave. */
  duplicate: number;
  /** Lines whose number the group's do-not-call list already holds. */
  blocked: number;
  /** Rows whose number a card of the group already carries. */
  matched: number;
}

export interface ImportInput {
  campaignUid: string;
  /** The pasted text, one entry per line. */
  text: string;
  /** The group's do-not-call numbers, canonical. */
  doNotCall: readonly string[];
  /** The group's cards by the number each carries: canonical number → card uid. */
  cards: Readonly<Record<string, string>>;
  now: Date;
  /** Where a new row's uid comes from; injected so a test names its own. */
  newUid: () => string;
}

/** Read a pasted list into the rows a campaign is about to hold. */
export function planImport({
  campaignUid,
  text,
  doNotCall,
  cards,
  now,
  newUid,
}: ImportInput): ImportPlan {
  const rows: RowDoc[] = [];
  const refused: ImportRefusal[] = [];
  const seen = new Set<string>();
  const blocked = new Set(doNotCall);
  let duplicate = 0;
  let blockedCount = 0;
  let matched = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const { entry, context } = lineEntry(line);
    if (!entry) {
      refused.push({ line, reason: "no_number" });
      continue;
    }
    const number = normaliseNumber(entry);
    if (!number.ok) {
      refused.push({ line, reason: number.reason });
      continue;
    }
    if (seen.has(number.e164)) {
      duplicate += 1;
      continue;
    }
    seen.add(number.e164);
    if (blocked.has(number.e164)) {
      blockedCount += 1;
      continue;
    }

    // A number the group already knows becomes a row pointed at its card, so the
    // caller reads who they are about to speak to before the call, not after it.
    const cardUid = cards[number.e164] ?? null;
    if (cardUid) matched += 1;

    rows.push({
      version: 1,
      uid: newUid(),
      campaignUid,
      e164: number.e164,
      extension: number.extension,
      context,
      cardUid,
      state: "open",
      claim: null,
      nextCallAt: null,
      calls: [],
      trimmed: 0,
      createdAt: now.toISOString(),
    });
  }

  return { rows, refused, duplicate, blocked: blockedCount, matched };
}
