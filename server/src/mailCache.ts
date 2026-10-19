/**
 * An account's mailboxes, sending identities and calendars, remembered for a
 * moment.
 *
 * Each is read by several steps of one run, and none changes while the agent
 * works: a step that files, drafts and answers asked the same account for its
 * folder tree three times, and every calendar write resolved a name against
 * the same list. They are **not** kept in the tree's
 * memory (`requestMemory.ts`), because a run document write is a FileNode
 * write and would throw them away before every step — the one invalidation that
 * has nothing to do with mailboxes.
 *
 * A mailbox, identity or calendar write forgets them at once (`jmap.ts`), and
 * the TTL bounds a change made by a process that did not come through this one. The
 * cache is per unit of work (a request or the agent's pass), so two
 * credentials never read each other's answer.
 */

/** How long an answer is reused before the store is read again. */
const TTL_MS = 5_000;

let caches = new WeakMap<object, Map<string, { at: number; value: unknown }>>();

/** One read of `key`, reused for the unit while it is younger than the TTL. */
export async function cachedMail<T>(
  scope: object,
  accountId: string,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const id = `${accountId}\u0000${key}`;
  const mine = caches.get(scope) ?? new Map<string, { at: number; value: unknown }>();
  const held = mine.get(id);
  if (held && Date.now() - held.at < TTL_MS) return held.value as T;
  const value = await read();
  mine.set(id, { at: Date.now(), value });
  caches.set(scope, mine);
  return value;
}

/** For every unit: the mailbox tree or an identity was written. */
export function forgetMailCache(): void {
  caches = new WeakMap();
}
