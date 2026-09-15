/**
 * How many messages carry a keyword — one shape and one place for the
 * arithmetic that keeps it true.
 *
 * The numbers come from the server: one `Email/query` per keyword with
 * `calculateTotal`, which is what `loadLabelCounts` asks. Two numbers come out
 * of the same question and they are used differently, so both are kept:
 *
 *  - **the total**, which is what the sidebar shows beside a label — how much
 *    mail is filed under it, read or not;
 *  - **the unread half**, which is what decides whether a label set to
 *    "while unread" is drawn at all (`visibleLabels`), and nothing else.
 *
 * The `G-` state the agent writes (ADR 0003 resolution 9) is deliberately not
 * among the counted keywords: it is per-message processing state, never a row
 * in the sidebar.
 */
import type { Label } from "@/store/settings";

/** The keyword a starred message carries. One definition, both tiers' readers. */
export const STARRED_KEYWORD = "$flagged";

/** The keyword that marks a message read. */
export const SEEN_KEYWORD = "$seen";

/** One keyword's numbers. */
export interface KeywordCounts {
  /** Messages carrying the keyword, read and unread. */
  total: number;
  /** Of those, the ones not marked `$seen`. */
  unread: number;
}

/**
 * Nothing known about a keyword.
 *
 * One shared object rather than a fresh one per miss: a selector built on
 * `countOf` hands back a referentially stable value, which is what keeps a
 * store subscription from re-rendering on every read.
 */
const NONE: KeywordCounts = { total: 0, unread: 0 };

/** One keyword's numbers, or none when it was never counted. */
export function countOf(
  counts: Record<string, KeywordCounts>,
  keyword: string,
): KeywordCounts {
  return counts[keyword] ?? NONE;
}

/**
 * The keywords a sidebar counts, in the order it draws them: **Starred**
 * first — a row of its own, which is not a label — then the account's labels.
 *
 * One definition, so what is counted and what is drawn cannot drift apart.
 */
export function countedKeywords(labels: Label[]): string[] {
  return [STARRED_KEYWORD, ...labels.map((l) => l.keyword)];
}

/**
 * The counts after one message gained or lost one keyword.
 *
 * A count is a server total, and a write the reader just made has to move it at
 * once: unstarring a message and watching the Starred number stay where it was
 * is the kind of lag that makes a reader distrust every number on the screen.
 * The move is exact rather than a guess, because everything it needs is known
 * — which keywords the message carried before the write, and whether it was
 * read.
 *
 * Two cases, and they are different shapes:
 *
 *  - **a label or the starred keyword**: that keyword's total moves by one,
 *    and its unread half moves with it only if the message was unread;
 *  - **`$seen`**: no total moves anywhere — reading a message files it nowhere
 *    else — and the unread half of every keyword the message carries moves in
 *    the direction of the change.
 *
 * A keyword nobody is counting is left alone. A number that was never read has
 * none to move, and inventing one from a single message would be a worse answer
 * than its absence.
 */
export function keywordCountDelta(args: {
  counts: Record<string, KeywordCounts>;
  /** The message's keywords *before* the write. */
  keywords: Record<string, boolean>;
  /** The keyword being written. */
  keyword: string;
  /** Whether it is being added or removed. */
  on: boolean;
}): Record<string, KeywordCounts> {
  const { counts, keywords, keyword, on } = args;
  // A write that changes nothing moves nothing: re-starring a starred message
  // is not two messages.
  if (Boolean(keywords[keyword]) === on) return counts;

  const next = { ...counts };

  if (keyword === SEEN_KEYWORD) {
    const step = on ? -1 : 1;
    for (const carried of Object.keys(keywords)) {
      const c = next[carried];
      if (c) next[carried] = { ...c, unread: Math.max(0, c.unread + step) };
    }
    return next;
  }

  const c = next[keyword];
  if (!c) return counts;
  const wasUnread = !keywords[SEEN_KEYWORD];
  const unreadStep = wasUnread ? (on ? 1 : -1) : 0;
  next[keyword] = {
    total: Math.max(0, c.total + (on ? 1 : -1)),
    unread: Math.max(0, c.unread + unreadStep),
  };
  return next;
}
