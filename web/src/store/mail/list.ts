import type { Comparator, Email, EmailFilter, Id, Thread } from "@/jmap/types";
import { countsConversations } from "@/lib/keywordCounts";

export function listKey(q: {
  filter: EmailFilter;
  sort: Comparator[];
  collapseThreads: boolean;
}): string {
  return JSON.stringify([q.filter, q.sort, q.collapseThreads]);
}

export const DEFAULT_SORT: Comparator[] = [
  { property: "receivedAt", isAscending: false },
];

/**
 * Fold freshly fetched properties into the copy already held.
 *
 * Returns the held object itself when nothing in `next` differs from it, which
 * is the whole point: a refresh fetches every listed message again, and handing
 * the store a new object for each one -- same data, new identity -- defeats the
 * memo on every row of the list. One message changing would then re-render the
 * whole visible list, and so would any store write that refreshed it.
 *
 * Compared property by property, because identity is compared per property and
 * a shallow compare on the message alone cannot see that `keywords` is a new
 * object holding the same flags. The comparison is shallow on each property
 * with a serialized fallback, which is enough for every field a refresh brings
 * back -- and a field that cannot be serialized simply reads as changed.
 */
export function mergeEmail(prev: Email | undefined, next: Email): Email {
  if (!prev) return next;
  for (const key of Object.keys(next) as (keyof Email)[]) {
    const a = prev[key];
    const b = next[key];
    if (a === b) continue;
    if (a && b && typeof a === "object" && sameJson(a, b)) continue;
    return { ...prev, ...next };
  }
  return prev;
}

/**
 * Whether two values serialize to the same JSON whatever order their keys are
 * in.
 *
 * `JSON.stringify` alone is not enough here, and the case is the common one:
 * `keywords` and `mailboxIds` are maps of arbitrary names, and the server is
 * free to answer them in any order -- so a shallow `JSON.stringify` comparison
 * reports a change whenever the order moves, which is exactly the wasted render
 * this is here to prevent.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) =>
      x < y ? -1 : x > y ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** The messages of these ids that the map holds. */
export function pick(emails: Record<Id, Email>, ids: Id[]): Email[] {
  return ids.map((id) => emails[id]).filter((e): e is Email => Boolean(e));
}

/**
 * The rows a keyword write is counted over: what the sidebar counts, for the
 * messages the write names.
 *
 * The unit is the row's and not the message's (`countsConversations`, which the
 * count itself is read with), so with conversation view on a conversation is
 * one number however many of its messages are being written, and with it off
 * every message counts for itself. Grouping is what makes the optimistic move
 * exact: moving the number once per message raised it by the size of the
 * conversation and left the next read to take it back down.
 *
 * A conversation is taken whole — every message of its thread the client holds
 * — because that is what the count asks about. The server's total is over the
 * account and not over the folder on screen, so a reply filed elsewhere belongs
 * to the same number, and a message of the row still carrying the keyword is
 * what keeps the number where it is when one message loses it. The thread comes
 * with the list (the collapsed query fetches its messages) and with
 * `loadThread`; the messages the write names are kept in the row even so, for a
 * thread the client has not read or has read before the newest reply landed.
 */
export function countRows(
  ids: Id[],
  emails: Record<Id, Email>,
  threads: Record<Id, Thread>,
): Id[][] {
  const perConversation = countsConversations();
  const rows = new Map<string, Id[]>();
  for (const id of ids) {
    const e = emails[id];
    if (!e) continue;
    // With conversations counted, the thread is the row; without it, each
    // message is its own row.
    const key = perConversation ? e.threadId : id;
    const row = rows.get(key);
    if (row) row.push(id);
    else rows.set(key, [id]);
  }
  return [...rows].map(([key, row]) => {
    const thread = perConversation ? threads[key] : undefined;
    if (!thread) return row;
    const members = thread.emailIds.filter((id) => emails[id]);
    for (const id of row) if (!members.includes(id)) members.push(id);
    return members;
  });
}
