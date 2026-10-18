import { errorMessage } from "@gilbert/shared/errors";
import { client, setErrorMessage } from "@/jmap/client";
import type { Email, Id, SetResponse } from "@/jmap/types";
import { useMail } from "../mail";
import { hasContent, sameDraftContent } from "./draft";
import { buildEmailObject } from "./outgoing";
import type { ComposeState, Draft } from "./types";

const AUTOSAVE_MS = 20_000;
export const autosaveTimers = new Map<string, number>();

/*
 * Draft saves, one at a time per draft.
 *
 * Saving a draft is Email/set create + destroy of the draft it replaces, so
 * two saves that overlap each destroy only the id they captured and the one
 * that finishes last leaves its create behind: an autosave that lands after
 * Send or Discard leaves an orphan $draft of a message that is gone, and two
 * overlapping saves leave two drafts. A save that finishes last would also
 * clear `dirty` over content typed while it was in flight, so a close that
 * follows skips its own save and drops that content.
 *
 * Every save for a key therefore runs on one chain (`enqueueSave`), and send
 * and discard wait for the chain to drain and destroy the draft the last save
 * actually created (`lastId`), not the id they captured earlier. Completion
 * clears `dirty` only when the draft still holds what was saved.
 */
export const saveChains = new Map<
  string,
  { tail: Promise<unknown>; lastId: Id | null }
>();

/** Run `job` after every save already queued for this draft has settled. */
export function enqueueSave<T>(key: string, job: () => Promise<T>): Promise<T> {
  let q = saveChains.get(key);
  if (!q) {
    q = { tail: Promise.resolve(), lastId: null };
    saveChains.set(key, q);
  }
  const p = q.tail.then(job, job);
  q.tail = p.catch(() => undefined);
  return p;
}

/** Wait until every save queued for this draft has settled. */
export async function drainSaves(key: string): Promise<void> {
  const q = saveChains.get(key);
  if (!q) return;
  try {
    await q.tail;
  } catch {
    /* each job reports its own failure to whoever queued it */
  }
}
export function scheduleAutosave(key: string, get: () => ComposeState) {
  const t = autosaveTimers.get(key);
  if (t) window.clearTimeout(t);
  autosaveTimers.set(
    key,
    window.setTimeout(() => {
      autosaveTimers.delete(key);
      const d = get().drafts.find((x) => x.key === key);
      if (d?.dirty && (d.to.length || d.subject || hasContent(d)))
        void get().saveDraft(key, { silent: true });
    }, AUTOSAVE_MS),
  );
}
export async function saveDraftInternal(
  d: Draft,
  _get: () => ComposeState,
  set: (fn: (s: ComposeState) => Partial<ComposeState>) => void,
  opts: { silent: boolean; final?: boolean },
): Promise<Id | null> {
  const mail = useMail.getState();
  const accountId = d.accountId;
  if (!opts.final)
    set((s) => ({
      drafts: s.drafts.map((x) => (x.key === d.key ? { ...x, saving: true } : x)),
    }));
  try {
    const email = await buildEmailObject(d, { forSend: false });
    /*
     * Destroy the draft the previous save produced, not necessarily the id
     * this snapshot carries: when this save was queued behind one already in
     * flight, that save has since replaced the draft, and destroying the old
     * id would orphan its create.
     */
    const q = saveChains.get(d.key);
    const destroyId = q?.lastId ?? d.draftId;
    const args: Record<string, unknown> = { accountId, create: { draft: email } };
    if (destroyId) args.destroy = [destroyId];
    const res = await client.call<SetResponse<Email>>("Email/set", args);
    const err = res.notCreated?.draft;
    if (err) throw new Error(setErrorMessage(err));
    const newId = res.created?.draft?.id ?? null;
    const chain = saveChains.get(d.key);
    if (chain && newId) chain.lastId = newId;
    if (!opts.final)
      set((s) => ({
        drafts: s.drafts.map((x) =>
          x.key === d.key
            ? {
                ...x,
                draftId: newId,
                saving: false,
                /*
                 * `dirty` is cleared only when nothing was typed while the
                 * save was in flight. A save finishing over newer content
                 * must not claim to have saved it: the dirty flag is what a
                 * later close consults before its own final save, and a save
                 * wrongly cleared there drops the newest content.
                 */
                dirty: sameDraftContent(x, d) ? false : x.dirty,
                savedAt: Date.now(),
                error: null,
              }
            : x,
        ),
      }));
    void mail.loadMailboxes();
    if (mail.list?.mailboxId && mail.list.mailboxId === mail.roleId("drafts", accountId))
      void mail.refreshList();
    return newId;
  } catch (err) {
    if (!opts.final)
      set((s) => ({
        drafts: s.drafts.map((x) =>
          x.key === d.key ? { ...x, saving: false, error: errorMessage(err) } : x,
        ),
      }));
    throw err;
  }
}
