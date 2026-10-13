import { chunk, client } from "@/jmap/client";
import type { Email, GetResponse, Id, Mailbox, SetResponse, Thread } from "@/jmap/types";
import type { ConversedMessage } from "@/lib/archiveTarget";
import { unsubscribedFolders } from "@/lib/groupSubscriptions";
import { plural, t } from "@/lib/i18n";
import { isOwnMailAccount } from "@/lib/mailAccounts";
import type { DeleteOutcome } from "@/lib/mailDelete";
import { toast } from "@/ui/toast";
import { useSession } from "../session";
import { patchMailboxIds, restoreMailboxPatch, setEmails } from "./mutations";
import type { MailState } from "./types";

/**
 * A `Mailbox/get` answer as the map every reader of the tree uses.
 *
 * One builder, because three read paths answer this question -- the probe, an
 * account's tree on its own beat, and the active account's -- and a tree that
 * was assembled slightly differently in each is a difference nothing notices
 * until two of them disagree on screen.
 */
export function mailboxMap(list: Mailbox[]): Record<Id, Mailbox> {
  const tree: Record<Id, Mailbox> = {};
  for (const m of list) tree[m.id] = m;
  return tree;
}

/**
 * A `Mailbox/get` answer adopted: the tree, and -- on an account that is not
 * the reader's own -- the subscriptions membership owes on it.
 *
 * Which account is the reader's own is asked of the session, never of the
 * group classifier: that one answers nothing until the probe has listed the
 * account, and a folder the reader is owed a subscription to is not something
 * to decide on an answer that is still on its way.
 */
/**
 * The sentence a move says: how many conversations went to which folder.
 *
 * Two paths build it -- a move that names one destination folder and one that
 * names several -- so it is built once here, and `plural()` is what lets a
 * language with more than two forms pick the right one (ru, uk).
 */
export function movedTo(count: number, where: string): string {
  return plural(
    count,
    {
      one: "Conversation moved to {folder}",
      other: "{n} conversations moved to {folder}",
    },
    { folder: where },
  );
}

export function adoptMailboxes(accountId: Id, list: Mailbox[]): Record<Id, Mailbox> {
  const tree = mailboxMap(list);
  if (!isOwnMailAccount(useSession.getState().session, accountId))
    ensureSubscribed(accountId, tree);
  return tree;
}

/** Reconciles in flight, one per account, so overlapping reads share one write. */
export const subscribing = new Map<Id, Promise<void>>();

/**
 * Accounts whose failed subscription write has already been reported.
 *
 * A member may write `isSubscribed` on a folder of their group (ADR 0021,
 * confirmed live on 0.16.23, 2026-09-24), but Stalwart is of two minds about the
 * field elsewhere -- it accepts the write on a calendar shared read-only and
 * refuses it on an address book -- so a refusal is possible even where the
 * folder is the member's to read. It is asked again on every read of the tree,
 * because a member whose folders are unsubscribed is a member whose group reads
 * as empty in every other client: one transient refusal must not leave it so
 * for the session. Only the *report* is held back, in the shape `loadMailboxes`
 * uses for a failed tree read, so a server that refuses persistently warns once
 * per outage rather than on every read; a write that lands clears the entry, so
 * a later refusal is news again.
 */
export const subscriptionsReported = new Set<Id>();

/**
 * The folders of a group the member is owed a subscription to, written once.
 *
 * Stalwart hands a freshly added member every folder unsubscribed and keeps
 * doing it for folders created since, so the reader's own record has to be
 * brought up to what membership means -- otherwise the group is unreadable
 * from every client that honours subscriptions, which is every client but
 * this one. Nothing is sent when nothing is missing, and one reconciliation
 * is in flight per account: this sits on every read of a group's folder list,
 * which is also what makes it cover a folder that appeared a moment ago.
 */
export function ensureSubscribed(accountId: Id, tree: Record<Id, Mailbox>): void {
  if (subscribing.has(accountId)) return;
  const missing = unsubscribedFolders(tree);
  if (!missing.length) return;
  const run = (async () => {
    try {
      for (const part of chunk(missing, client.maxObjectsInSet)) {
        const update: Record<Id, { isSubscribed: true }> = {};
        for (const id of part) update[id] = { isSubscribed: true };
        await client.call<SetResponse>("Mailbox/set", { accountId, update });
      }
      subscriptionsReported.delete(accountId);
    } catch (err) {
      if (!subscriptionsReported.has(accountId)) {
        subscriptionsReported.add(accountId);
        console.warn(
          `[gilbert] could not subscribe the folders of ${accountId}: ${(err as Error).message}`,
        );
      }
    } finally {
      subscribing.delete(accountId);
    }
  })();
  subscribing.set(accountId, run);
}

/**
 * Every message of these threads, read from the server when the client does not
 * hold them.
 *
 * The ones that matter are exactly the ones the list is not showing: a
 * conversation that has come back to the Inbox has its older messages in the
 * folder it was filed under, and those are not in the page on screen. Threads
 * are the account's own -- two accounts may each hold a copy of one
 * conversation, and each copy is filed on its own -- so this reads only the
 * account the action is aimed at, and a copy elsewhere is never consulted.
 */
export async function threadMessagesFor(
  accountId: Id,
  threadIds: Id[],
  get: () => MailState,
): Promise<Record<Id, ConversedMessage[]>> {
  const idsByThread: Record<Id, Id[]> = {};
  const unheld: Id[] = [];
  for (const threadId of threadIds) {
    const held = get().threads[threadId];
    if (held?.emailIds?.length) idsByThread[threadId] = held.emailIds;
    else unheld.push(threadId);
  }
  if (unheld.length) {
    const res = await client.call<GetResponse<Thread>>("Thread/get", {
      accountId,
      ids: unheld,
    });
    for (const thread of res.list) idsByThread[thread.id] = thread.emailIds;
  }
  const missing = [
    ...new Set(
      Object.values(idsByThread)
        .flat()
        .filter((id) => !get().emails[id]),
    ),
  ];
  const read: Record<Id, ConversedMessage> = {};
  if (missing.length) {
    const res = await client.call<GetResponse<Email>>("Email/get", {
      accountId,
      ids: missing,
      properties: ["id", "mailboxIds", "receivedAt"],
    });
    for (const email of res.list) read[email.id] = email;
  }
  const out: Record<Id, ConversedMessage[]> = {};
  for (const [threadId, ids] of Object.entries(idsByThread))
    out[threadId] = ids.map((id) => get().emails[id] ?? read[id] ?? {});
  return out;
}

/**
 * Move a selection to one folder or to several, saying so once.
 *
 * A selection can split across destinations -- by date, and by the folder each
 * conversation already lives in -- and a toast per destination would be a queue
 * of messages about one action, each with an Undo that puts back a third of it.
 * So every move is silent and the report is one sentence, with one Undo built
 * from where each message was before any of them moved.
 *
 * A failure is not reported here, because it is already reported where it
 * happens: `move` says what the server refused, and the caller that has to
 * create folders first says that in its own words. What it does answer is
 * whether any move went through, so a caller can tell a report of work done
 * from a refusal -- `ok: false` only when nothing moved at all.
 */
export async function moveToDestinations(
  ids: Id[],
  targets: Map<Id, Id[]>,
  set: (fn: (s: MailState) => Partial<MailState>) => void,
  get: () => MailState,
  nameOf: (mailboxId: Id) => string,
): Promise<DeleteOutcome> {
  const accountId = get().accountId;
  if (!accountId || !ids.length || !targets.size) return { ok: true };
  /*
   * Where everything came from, captured before anything moves, so one Undo can
   * put back a selection that went to several folders. See the note in `move`:
   * an Undo for a message we never loaded would write an empty `mailboxIds`, so
   * it is not offered at all.
   */
  const prev: Record<Id, Record<Id, boolean>> = {};
  let undoable = true;
  for (const id of ids) {
    if (!get().emails[id]) undoable = false;
    prev[id] = get().emails[id]?.mailboxIds ?? {};
  }

  /*
   * Where each message was moved into, so the Undo can write away exactly that
   * folder and leave alone any other the message sits in (see
   * `restoreMailboxPatch`).
   */
  const added: Record<Id, Id> = {};
  const names: string[] = [];
  for (const [target, group] of targets) {
    const outcome = await get().move(group, target, { silent: true });
    if (outcome.ok) {
      names.push(nameOf(target));
      for (const id of group) added[id] = target;
    }
  }
  /*
   * Nothing went: every move was refused, and what refused them is already
   * said. There is no move to report and no Undo to offer, and a caller must
   * not read this as work done.
   */
  if (!names.length) return { ok: false, code: "server_refused" };

  const where =
    names.length === 1
      ? names[0]!
      : t("{count} folders", { count: String(names.length) });
  toast.show(movedTo(ids.length, where), {
    action: !undoable
      ? undefined
      : { label: "Undo", onClick: moveUndo(ids, prev, added, accountId, set, get) },
  });
  void get().loadMailboxes();
  return { ok: true };
}

/**
 * The Undo a move offers, once.
 *
 * `move` and `moveToDestinations` each end by putting every message back in the
 * folders it was in and refreshing what the list and the sidebar show; a change
 * to the Undo has to reach both, so it is one function rather than two copies
 * that agree today. `added` is the folder each message was moved into, which is
 * the one folder the restore may take it out of.
 */
export function moveUndo(
  ids: Id[],
  prev: Record<Id, Record<Id, boolean>>,
  added: Record<Id, Id>,
  accountId: Id,
  set: (fn: (s: MailState) => Partial<MailState>) => void,
  get: () => MailState,
): () => Promise<void> {
  return async () => {
    const undo: Record<Id, Record<string, unknown>> = {};
    for (const id of ids)
      undo[id] = restoreMailboxPatch(
        prev[id]!,
        get().emails[id]?.mailboxIds ?? {},
        added[id] ? [added[id]!] : [],
      );
    await setEmails(accountId, undo);
    set((s) => {
      const next = { ...s.emails };
      for (const id of ids) {
        const e = next[id];
        if (!e) continue;
        next[id] = { ...e, mailboxIds: patchMailboxIds(e.mailboxIds, undo[id]!) };
      }
      return { emails: next };
    });
    void get().refreshList();
    void get().loadMailboxes();
  };
}
