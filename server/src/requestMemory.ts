/**
 * What one unit of work remembers.
 *
 * The unit is a request or a pass, and both are an object: `accountCtx` builds a
 * fresh `Ctx` per HTTP call and it is gone with the answer, and the agent builds
 * one per run and empties it at each pass (`forgetRememberedFor`, `agent.ts`).
 * A memory hung on that object cannot be seen by another request and is keyed by
 * no user. The reader is `appFolder.ts`, which remembers the levels it lists: a
 * unit that resolves several documents walks the same folders over and over, and
 * every walk is a round trip the person waiting on the answer pays for.
 *
 * A memory is wrong the moment something is written, and every write this
 * process *sends* passes one place: `JmapClient` forgets them all whenever a
 * `FILENODE_SET` goes through it -- a helper's write, a route's, a fixture's,
 * another request's -- so no writer has to know that any memory exists, and a
 * reader is not served a listing from before a write it never made. The mock
 * writes its own arrays directly, the way the server it simulates would, and is
 * not a writer of this process: a suite that caches a level the mock's own
 * traffic then changes reads it as old until the next write or the unit ends.
 *
 * shortcut: a write from another process -- an agent started apart (the
 * deployment's `agent` profile), a second replica -- is not seen when it lands,
 * so a level it changed is served from the memory for the rest of the unit: one
 * request, or one pass of an agent, which is as long as the work it is doing. A
 * name-creating write (`freeChildFolderName`, `unusedVisibleName`) decides
 * against such a listing. Keying a memory on the account's FileNode state
 * instead would catch those too, at a read per lookup, if a deployment ever runs
 * the agent apart and reads the levels it writes in the same breath.
 */
let memories = new WeakMap<object, Map<string, unknown>>();

/**
 * What this unit remembered under `key`, reading it once when it is new.
 *
 * Two reads that overlap while the first is still running both run `read` --
 * this holds an answer, not a promise, which is what keeps a failing read from
 * being remembered as a failure.
 */
export async function recalled<T>(
  scope: object,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const mine = memories.get(scope);
  if (mine?.has(key)) return mine.get(key) as T;
  const generation = memories;
  const value = await read();
  /*
   * A write that landed while `read` ran wiped the memories, and this answer was
   * read before it: keeping it would revive a listing from before a write -- the
   * very thing this module exists to prevent, and the one race a sequential test
   * cannot see. The identity of the WeakMap is the generation: if it was
   * replaced under us, the value is dropped rather than stored.
   */
  if (memories !== generation) return value;
  const into = mine ?? new Map();
  into.set(key, value);
  memories.set(scope, into);
  return value;
}

/**
 * Forget what every unit remembered: the one thing a write owes them.
 *
 * Called on any write, and deliberately not scoped to the unit that wrote: a
 * reader cannot see who writes. Another request, a suite's own fixture, the
 * agent in this process -- all of them write through the same mail client, and a
 * memory only its own writer could drop would serve a listing from before a
 * write it never made. Dropping everything costs a read, and only a read.
 */
export function forgetRemembered(): void {
  memories = new WeakMap();
}

/**
 * Forget what one unit remembered, because the unit is over.
 *
 * A request needs nothing here -- its `Ctx` is garbage the moment the answer is
 * written, and the memory with it. A pass does: the agent's `Ctx` lives as long
 * as the process, so the pass that begins clears what the last one read, and the
 * work it is about to do is done on the tree as it is now.
 */
export function forgetRememberedFor(scope: object): void {
  memories.delete(scope);
}
