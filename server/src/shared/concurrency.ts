/**
 * Bounded concurrency for the reads that walk a tree or a folder.
 *
 * The mail server answers one document per request, so a walk that waits for
 * each answer in turn pays one round trip after another: an article's history,
 * a knowledge tree or a workorder registry costs the same latency per item it
 * holds. The work is independent, and a small bound turns a serial walk into a
 * handful of parallel ones without opening a connection per article.
 *
 * The answers keep the order the items were given in, so a caller can still
 * sort or pair them by index.
 */

/**
 * How many reads run at once when a caller does not say.
 *
 * Two, not eight: Stalwart refuses an account past its own
 * `maxConcurrentRequests`, and that limit is **per account** — the agent's reads
 * and a person's webmail share it. Eight parallel reads bought a walk some
 * wall-clock time and cost the whole pass a `400` when the ceiling was reached,
 * which is a pass that works nothing (live, 2026-10-27, three times in an hour).
 */
export const READ_CONCURRENCY = 2;

/**
 * `fn` over every item, at most `limit` of them at a time, in input order.
 *
 * The first failure stops the walk and is thrown: a partial answer is not one
 * a caller should have to tell apart from a complete one.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const bound = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: bound }, worker));
  return out;
}
