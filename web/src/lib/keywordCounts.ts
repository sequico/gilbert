/**
 * How much mail carries a keyword — one shape and one place for the arithmetic
 * that keeps it true.
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
 *
 * **A count is taken over the row, not the message.** A conversation counted
 * once while its messages each counted once is not a detail: the number would
 * contradict the list it opens. Which of the two it is, is decided once
 * (`countsConversations`) and read by both sides — the read that answers the
 * number and the write that moves it — so they cannot be counted differently.
 */
import { anyCarries, type CarriesKeywords } from "@/lib/rowScope";
import { type Label, settings } from "@/store/settings";

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
 * Whether the sidebar counts conversations rather than messages.
 *
 * One setting decides the unit of every number in the sidebar — the same one
 * the list itself collapses by — and both readers of a count go through here:
 * `loadLabelCounts` asks the server with it, and a write moves the number with
 * it. Answered in one place because it has to be answered the same way in both:
 * a write counted per message against a total counted per conversation raised
 * the number by the size of the conversation and left the next read to take it
 * back down.
 */
export function countsConversations(): boolean {
  return settings().conversationMode;
}

/** Every keyword these messages carry, in any of them. */
function carriedKeywords(messages: ReadonlyArray<CarriesKeywords>): Set<string> {
  const keys = new Set<string>();
  for (const m of messages) for (const k of Object.keys(m.keywords ?? {})) keys.add(k);
  return keys;
}

/** How much a boolean that was one thing and is now another moves a count. */
const step = (was: boolean, is: boolean): number => (is ? 1 : 0) - (was ? 1 : 0);

/**
 * Whether the row carries the keyword *and* is counted as unread for it.
 *
 * The unread half is asked as `hasKeyword K AND notKeyword $seen`, collapsed
 * with the total, so a row counts when **one** message carries the keyword and
 * is not marked read — not when one message carries it and another is unread.
 * Marking a conversation read is where the two readings part company, which is
 * why this is not `anyCarries(messages, K) && anyLacks(messages, SEEN_KEYWORD)`.
 */
function carriesUnread(
  messages: ReadonlyArray<CarriesKeywords>,
  keyword: string,
): boolean {
  return anyCarries(
    messages.filter((m) => !m.keywords?.[SEEN_KEYWORD]),
    keyword,
  );
}

/**
 * The counts after one row changed.
 *
 * A count is a server total, and a write the reader just made has to move it at
 * once: unstarring a message and watching the Starred number stay where it was
 * is the kind of lag that makes a reader distrust every number on the screen.
 * The move is exact rather than a guess, because everything it needs is known —
 * the row's messages as they were and as they are.
 *
 * **The row is the unit, because the row is what a number counts**
 * (`countsConversations`): one message when the sidebar counts messages, a
 * conversation's messages when it counts conversations. `before` and `after`
 * are that row whole, which is what keeps this exact however much of it a write
 * reached: naming one message inside an open conversation moves the number no
 * more than unstarring the conversation does while another of its messages
 * still carries the keyword. Moving the number once per *message named* is what
 * raised it by the size of the conversation and left the next read to take it
 * back down.
 *
 * Both halves of every counted keyword move by what the row's contribution to
 * them changed:
 *
 *  - **the total**: the row counts for a keyword when any of its messages
 *    carries it, so the total moves by one when that changes;
 *  - **the unread half**: the row counts when **one** message carries the
 *    keyword *and* is not marked read — the question the server is asked — so
 *    reading a conversation moves the unread halves and no total, and starring
 *    one can move the unread half where the total does not.
 *
 * A row that changed nothing moves nothing, and every keyword is decided apart
 * from the others: the keyword being written is not a case here, which is what
 * lets one function answer for a label, for a star and for a read.
 *
 * A keyword nobody is counting is left alone — a number that was never read has
 * none to move, and inventing one from a single message would be a worse answer
 * than its absence — and so is a keyword nobody in the row carries.
 */
export function keywordCountDelta(args: {
  counts: Record<string, KeywordCounts>;
  /** The row's messages as they were *before* the write. */
  before: ReadonlyArray<CarriesKeywords>;
  /** The same row as it is *after* it. */
  after: ReadonlyArray<CarriesKeywords>;
}): Record<string, KeywordCounts> {
  const { counts, before, after } = args;
  let next: Record<string, KeywordCounts> | null = null;
  /*
   * Only the keywords the row carries, either side of the write: a keyword
   * nobody in it carries cannot have moved. Asking the counted set instead
   * would walk every label in the account for every row of a whole folder.
   */
  const candidates = carriedKeywords([...before, ...after]);
  for (const keyword of candidates) {
    const c = counts[keyword];
    if (!c) continue;
    const totalStep = step(anyCarries(before, keyword), anyCarries(after, keyword));
    const unreadStep = step(
      carriesUnread(before, keyword),
      carriesUnread(after, keyword),
    );
    if (!totalStep && !unreadStep) continue;
    next ??= { ...counts };
    next[keyword] = {
      total: Math.max(0, c.total + totalStep),
      unread: Math.max(0, c.unread + unreadStep),
    };
  }
  return next ?? counts;
}
