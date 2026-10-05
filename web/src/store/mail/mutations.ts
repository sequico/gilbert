import { chunk, client } from "@/jmap/client";
import type { Id, SetError, SetResponse } from "@/jmap/types";
import { t } from "@/lib/i18n";
import type { DeleteRefusal } from "@/lib/mailDelete";
import type { MailState } from "./types";

/**
 * What a refused destroy says, in the reader's language.
 *
 * The rule answers a code and the sentence is composed where it shows, which is
 * here for the actions the store performs: a string held in a library is a
 * string no catalogue can translate. Each sentence says what still works rather
 * than only what does not, because the reader's next move is the point.
 */
export function refusalSentence(code: DeleteRefusal): string {
  switch (code) {
    case "group_mail_final":
      /*
       * Deliberately not "your delete filed it in Deleted Items": a selection
       * can hold messages that were already in Deleted Items or Junk Mail, and
       * those are not filed — they are the ones the rule refused. The sentence
       * states the rule and what still works, which is true of every case.
       */
      return t(
        "A group's mail is ended by an installation administrator. Filing a message in the group's Deleted Items still works, and so does moving it back out.",
      );
    case "group_mail_empty":
      return t(
        "Only an installation administrator can empty a group's Deleted Items or Junk Mail. Filing mail there still works, and so does moving it back out.",
      );
    case "group_mail_folder":
      return t(
        "A folder holding mail cannot be deleted in a group, because its mail would go with it. Move the mail out first, or ask an installation administrator.",
      );
  }
}

/**
 * Destroy emails in batches the server will accept.
 *
 * Handing Email/set more ids than `maxObjectsInSet` fails the whole call with
 * requestTooLarge — nothing is deleted — so split first and merge the results.
 * Every final delete the client makes funnels through here, which is why the
 * group rule's guard sits on the callers above rather than on this: a guard
 * here would refuse the batches a caller had already promised.
 */
export async function destroyEmails(
  accountId: Id,
  ids: Id[],
): Promise<{ destroyed: Id[]; notDestroyed: Record<Id, SetError> }> {
  const destroyed: Id[] = [];
  const notDestroyed: Record<Id, SetError> = {};
  for (const part of chunk(ids, client.maxObjectsInSet)) {
    const res = await client.call<SetResponse>("Email/set", { accountId, destroy: part });
    destroyed.push(...(res.destroyed ?? []));
    Object.assign(notDestroyed, res.notDestroyed ?? {});
  }
  return { destroyed, notDestroyed };
}

export async function setEmails(
  accountId: Id,
  update: Record<Id, Record<string, unknown>>,
) {
  const ids = Object.keys(update);
  for (const part of chunk(ids, client.maxObjectsInSet)) {
    const sub: Record<Id, Record<string, unknown>> = {};
    for (const id of part) sub[id] = update[id]!;
    const res = await client.call<SetResponse>("Email/set", { accountId, update: sub });
    const failed = Object.entries(res.notUpdated ?? {});
    if (failed.length) {
      const [, err] = failed[0]!;
      throw new Error(
        `${err.type}${err.description ? `: ${err.description}` : ""}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ""}`,
      );
    }
  }
}

/**
 * Folders a move takes a message out of and puts it into, as per-folder patch
 * paths (`mailboxIds/<id>`), never a replacement of the whole map.
 *
 * A message can genuinely sit in several folders at once — a server-side copy
 * rule, a filter set to “keep a copy” — and replacing the whole `mailboxIds`
 * map throws every folder but the target away. Patching one entry leaves the
 * rest alone; the mock's `applyPatch` applies these paths the same way a real
 * server does.
 *
 * `from` is the folder the action is moving out of: the list whose rows it is
 * acting on (or the explicit opt). Without one — a search result, a deep link
 * — every folder the message is known to sit in is the source, which is the
 * only reading “move” has without one.
 */
export function moveMailboxPatch(
  mb: Record<Id, boolean>,
  to: Id,
  from: Id | null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (from) {
    if (from !== to) patch[`mailboxIds/${from}`] = null;
  } else {
    for (const f of Object.keys(mb)) if (f !== to) patch[`mailboxIds/${f}`] = null;
  }
  patch[`mailboxIds/${to}`] = true;
  return patch;
}

/** Apply per-folder patch paths to the optimistic copy of an Email. */
export function patchMailboxIds(
  mb: Record<Id, boolean>,
  patch: Record<string, unknown>,
): Record<Id, boolean> {
  const next = { ...mb };
  for (const [k, v] of Object.entries(patch)) {
    if (!k.startsWith("mailboxIds/")) continue;
    const folder = k.slice("mailboxIds/".length);
    if (v === null) delete next[folder];
    else next[folder] = true;
  }
  return next;
}

/**
 * The per-folder patch that puts a message back in exactly the folders it had
 * before (`prev`), undoing a move's per-folder patch over whatever it sits in
 * now. Written as patch paths like every other writer, so the undo cannot
 * drop a folder the move never touched.
 */
export function restoreMailboxPatch(
  prev: Record<Id, boolean>,
  cur: Record<Id, boolean>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of new Set([...Object.keys(prev), ...Object.keys(cur)]))
    patch[`mailboxIds/${f}`] = prev[f] ? true : null;
  return patch;
}

/** Remove given email ids (and threads they represent) from the current list optimistically. */
export function removeFromList(
  ids: Id[],
  set: (fn: (s: MailState) => Partial<MailState>) => void,
  get: () => MailState,
  targetMailboxId: Id | null,
) {
  const l = get().list;
  if (!l) return;
  // If the list is showing the mailbox we're moving into, don't remove.
  if (targetMailboxId && l.mailboxId === targetMailboxId) return;
  const idSet = new Set(ids);
  const { emails, threads } = get();
  const removeRow = (rowId: Id): boolean => {
    if (idSet.has(rowId)) return true;
    if (!l.collapseThreads) return false;
    const e = emails[rowId];
    if (!e) return false;
    const t = threads[e.threadId];
    if (!t) return false;
    // Row goes away if no email of the thread remains in this mailbox after the move.
    if (l.mailboxId) {
      const remaining = t.emailIds.filter(
        (id) => !idSet.has(id) && emails[id]?.mailboxIds[l.mailboxId!],
      );
      return remaining.length === 0;
    }
    return t.emailIds.every((id) => idSet.has(id));
  };
  const nextIds = l.ids.filter((id) => !removeRow(id));
  if (nextIds.length !== l.ids.length) {
    set((s) => ({
      list: s.list
        ? {
            ...s.list,
            ids: nextIds,
            total: Math.max(0, s.list.total - (l.ids.length - nextIds.length)),
          }
        : s.list,
    }));
  }
}
