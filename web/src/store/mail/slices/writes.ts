import { errorMessage } from "@gilbert/shared/errors";
import { client, setErrorMessage } from "@/jmap/client";
import type { Id, QueryResponse } from "@/jmap/types";
import { groupByArchivePath } from "@/lib/archiveDate";
import { filedFolderOf } from "@/lib/archiveTarget";
import { plural, t } from "@/lib/i18n";
import { keywordCountDelta } from "@/lib/keywordCounts";
import { mailboxDisplayName } from "@/lib/mailboxName";
import {
  type DeleteFailure,
  deleteEffect,
  destroyRefusal,
  FINAL_FOLDER_ROLES,
  finalFoldersOf,
} from "@/lib/mailDelete";
import { toast } from "@/ui/toast";
import { deleteContext } from "../context";
import { moveEpoch } from "../epoch";
import { ensureFolderPath } from "../folders";
import { countRows, pick } from "../list";
import { movedTo, moveToDestinations, moveUndo, threadMessagesFor } from "../mailboxes";
import {
  destroyEmails,
  moveMailboxPatch,
  patchMailboxIds,
  refusalSentence,
  removeFromList,
  setEmails,
} from "../mutations";
import type { MailGet, MailSet, MailState } from "../types";

/**
 * What a person does to messages: a keyword, a move, the deleted
 * items, the archive.
 *
 * A slice of the mail store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function writesSlice(
  set: MailSet,
  get: MailGet,
): Pick<
  MailState,
  | "setKeyword"
  | "markRead"
  | "star"
  | "move"
  | "addToMailbox"
  | "trash"
  | "destroy"
  | "archive"
  | "archiveByDate"
  | "spam"
  | "emptyMailbox"
> {
  /**
   * Nothing carries the Archive role, so offer to fix it rather than explain it.
   *
   * The message this replaces described the problem accurately and left the
   * reader with nothing to do inside Gilbert -- roles were only ever shown, not
   * set. `Mailbox/set` takes `role`, so the offer is real: one click makes the
   * folder and files the messages that were being archived when it was missing.
   *
   * `retry` is the archiving that could not happen, handed back so the click
   * finishes the job rather than leaving someone to select the same messages
   * again.
   */
  function offerArchiveFolder(retry: () => Promise<void>): void {
    toast.error(t("No Archive folder is set yet."), {
      action: {
        label: t("Create one"),
        onClick: async () => {
          try {
            await get().ensureArchiveFolder();
            await retry();
          } catch (err) {
            toast.error(
              t("Could not set up an Archive folder: {error}", {
                error: errorMessage(err),
              }),
            );
          }
        },
      },
    });
  }

  return {
    async setKeyword(ids, keyword, value) {
      const accountId = get().accountId;
      if (!accountId || !ids.length) return;
      // optimistic
      set((s) => {
        const next = { ...s.emails };
        for (const id of ids) {
          const e = next[id];
          if (!e) continue;
          const kw = { ...e.keywords };
          if (value) kw[keyword] = true;
          else delete kw[keyword];
          next[id] = { ...e, keywords: kw };
        }
        /*
         * The sidebar's numbers are server totals, and this write moves them
         * here rather than on the next read: unstarring a message and watching
         * the Starred count stay put reads as a broken app. The arithmetic is
         * `keywordCountDelta`'s, once, and it is handed **one row at a time** —
         * the whole conversation when the sidebar counts conversations — as it
         * was and as it is, so the number moves once for a conversation however
         * many of its messages this write names.
         */
        let labelCounts = s.labelCounts;
        for (const row of countRows(ids, s.emails, s.threads)) {
          labelCounts = keywordCountDelta({
            counts: labelCounts,
            before: pick(s.emails, row),
            after: pick(next, row),
          });
        }
        return { emails: next, labelCounts };
      });
      const update: Record<Id, Record<string, unknown>> = {};
      for (const id of ids) update[id] = { [`keywords/${keyword}`]: value ? true : null };
      try {
        await setEmails(accountId, update);
      } catch (err) {
        toast.error(t("Could not update: {error}", { error: errorMessage(err) }));
        /*
         * `getEmails` answers from what is already held, so it would leave the
         * optimistic keywords exactly where the refused write put them. The list
         * is read again instead, which re-fetches the rows on screen.
         */
        await get().refreshList();
        // The messages were put back; the counts moved with the optimistic write
        // and have to come back the same way. Re-read rather than reverse the
        // arithmetic: a second failure mid-reverse would leave a number nobody
        // could reconstruct.
        void get().loadLabelCounts();
      }
    },

    markRead(ids, read) {
      return get().setKeyword(ids, "$seen", read);
    },

    star(ids, on) {
      return get().setKeyword(ids, "$flagged", on);
    },

    async move(ids, toMailboxId, opts = {}) {
      const accountId = get().accountId;
      if (!accountId || !ids.length) return { ok: true };
      const { emails, mailboxes } = get();
      const prev: Record<Id, Record<Id, boolean>> = {};
      // The folder this move puts each message into: the one folder its Undo may
      // take it back out of (see `restoreMailboxPatch`).
      const added: Record<Id, Id> = {};
      const update: Record<Id, Record<string, unknown>> = {};
      /*
       * Undo restores the folders each message was in, which can only be offered
       * for messages we actually hold. Selecting a whole folder reaches messages
       * that were never loaded, and an Undo built from those would write an empty
       * mailboxIds -- putting the message in no folder at all, which is worse
       * than the move it was undoing. So the offer is withheld rather than
       * quietly restoring something wrong.
       */
      let undoable = true;
      // The folder the action is moving out of: the list whose rows it is acting
      // on (or the explicit opt). Without one -- a search result, a deep link --
      // "move" means out of every folder the message is known to sit in; see
      // moveMailboxPatch.
      const from = opts.fromMailboxId ?? get().list?.mailboxId ?? null;
      for (const id of ids) {
        const e = emails[id];
        if (!e) undoable = false;
        prev[id] = e?.mailboxIds ?? {};
        added[id] = toMailboxId;
        update[id] = moveMailboxPatch(prev[id]!, toMailboxId, from);
      }
      // optimistic
      set((s) => {
        const next = { ...s.emails };
        for (const id of ids) {
          const e = next[id];
          if (!e) continue;
          next[id] = { ...e, mailboxIds: patchMailboxIds(e.mailboxIds, update[id]!) };
        }
        return { emails: next, selected: {}, selectedAll: false };
      });
      const rowsBefore = get().list?.ids.length;
      removeFromList(ids, set, get, toMailboxId);
      /*
       * The rows the move takes off the screen are gone now, and a list read
       * already on its way was computed before the move reached the server: its
       * answer names the rows this list no longer holds, so it must be dropped
       * rather than putting them back (see `currentEpoch()`). Only a move that took a
       * row with it moves the generation -- filing a message the window is not
       * showing leaves the list exactly as it was.
       */
      if (rowsBefore !== get().list?.ids.length) moveEpoch();
      try {
        await setEmails(accountId, update);
        if (!opts.silent) {
          // The folder's own name, because that is what the user is looking at
          // in the sidebar. A hardcoded word here told people their mail had
          // moved to "Trash" or "Spam" on a server whose folders are called
          // "Deleted Items" and "Junk Mail" -- naming somewhere that does not
          // exist, in the one message whose job is saying where it went.
          // Through the display name, so the message names the folder the reader
          // is looking at in the sidebar rather than the server's own word for it.
          const name =
            mailboxDisplayName(mailboxes[toMailboxId]) || opts.label || t("folder");
          toast.show(movedTo(ids.length, name), {
            action: !undoable
              ? undefined
              : {
                  label: "Undo",
                  onClick: moveUndo(ids, prev, added, accountId, set, get),
                },
          });
        }
        void get().loadMailboxes();
        return { ok: true };
      } catch (err) {
        toast.error(t("Move failed: {error}", { error: errorMessage(err) }));
        void get().refreshList();
        /*
         * The server refused, so nothing moved: the refresh re-reads the list's
         * window and the optimistic patch goes with it. A second change landing
         * while that read is in flight moves the generation and the read is
         * dropped, so the rows come back with the next one rather than instantly —
         * which is why a caller is told the move did not happen instead of being
         * shown a repair.
         */
        return { ok: false, code: "server_refused" };
      }
    },

    async addToMailbox(ids, mailboxId, add) {
      const accountId = get().accountId;
      if (!accountId || !ids.length) return;
      const update: Record<Id, Record<string, unknown>> = {};
      for (const id of ids)
        update[id] = { [`mailboxIds/${mailboxId}`]: add ? true : null };
      set((s) => {
        const next = { ...s.emails };
        for (const id of ids) {
          const e = next[id];
          if (!e) continue;
          const mb = { ...e.mailboxIds };
          if (add) mb[mailboxId] = true;
          else delete mb[mailboxId];
          next[id] = { ...e, mailboxIds: mb };
        }
        return { emails: next };
      });
      try {
        await setEmails(accountId, update);
        void get().loadMailboxes();
      } catch (err) {
        toast.error(t("Could not update labels: {error}", { error: errorMessage(err) }));
        // `getEmails` would answer from what is already held and leave the
        // optimistic folder membership in place; the list is read again instead.
        void get().refreshList();
      }
    },

    async trash(ids) {
      const { mailboxes, emails } = get();
      // Which messages a delete ends is the one rule in `lib/mailDelete`, not a
      // re-derivation from the roles here: a third final folder is one edit
      // there, and this decides from the same list the list menu and the swipe do.
      const folders = finalFoldersOf(mailboxes);
      const trashId = folders.trash;
      const inTrash = ids.filter((id) => deleteEffect(emails[id], folders) === "final");
      const toMove = ids.filter((id) => !inTrash.includes(id));
      /*
       * A delete does two different things, and in a group only one of them is
       * refused: the messages already in Deleted Items or Junk Mail would be
       * ended, and the rest are filed. So the answer is "did anything happen",
       * not "was anything refused" — a mixed selection still moves what it can,
       * and a caller must not read that as nothing having happened. The refused
       * half is announced by `destroy` below either way.
       */
      let refused: DeleteFailure | null = null;
      let acted = false;
      if (inTrash.length) {
        const outcome = await get().destroy(inTrash);
        if (outcome.ok) acted = true;
        else refused = outcome.code;
      }
      if (toMove.length) {
        if (trashId) {
          const outcome = await get().move(toMove, trashId, { label: "Deleted Items" });
          if (outcome.ok) acted = true;
          else refused ??= outcome.code;
        } else {
          // No Deleted Items to file into, so the rest is destroyed outright —
          // and that half's outcome is the caller's business too.
          const outcome = await get().destroy(toMove);
          if (outcome.ok) acted = true;
          else refused ??= outcome.code;
        }
      }
      if (!acted && refused) return { ok: false, code: refused };
      return { ok: true };
    },

    async destroy(ids) {
      const accountId = get().accountId;
      if (!accountId || !ids.length) return { ok: true };
      const refused = destroyRefusal(deleteContext(get), "final");
      if (refused) {
        toast.error(refusalSentence(refused));
        return { ok: false, code: refused };
      }
      /*
       * The window moves here too: a list read already on its way was computed
       * before this delete reached the server, so its answer names a message that
       * is gone and must be dropped rather than written back over the removal
       * below (see `currentEpoch()`).
       */
      moveEpoch();
      removeFromList(ids, set, get, null);
      set((s) => {
        const next = { ...s.emails };
        for (const id of ids) delete next[id];
        return { emails: next, selected: {}, selectedAll: false };
      });
      try {
        const { notDestroyed } = await destroyEmails(accountId, ids);
        const failed = Object.keys(notDestroyed);
        if (failed.length) {
          toast.error(
            plural(failed.length, {
              one: "{n} message could not be deleted",
              other: "{n} messages could not be deleted",
            }),
          );
          // The optimistic removal above assumed every id would go; a message
          // the server refused (ACL, quota, a lock) is still there, so the list
          // and the lookup map must say so too, instead of leaving it "deleted"
          // on screen while it still exists on the server.
          void get().refreshList();
        } else
          toast.show(
            plural(ids.length, {
              one: "Message deleted forever",
              other: "{n} messages deleted forever",
            }),
          );
        void get().loadMailboxes();
        /*
         * Part of the selection went and part did not: the action happened, and
         * the toast above already named the mail that stayed. Only the total
         * refusal is the answer a caller has to read — nothing moved, so nothing
         * may be reported as done.
         */
        if (failed.length && failed.length === ids.length)
          return { ok: false, code: "server_refused" };
      } catch (err) {
        toast.error(t("Delete failed: {error}", { error: errorMessage(err) }));
        void get().refreshList();
        /*
         * The server refused, so the messages are still there — and the optimistic
         * removal above has to be undone by the refresh. That is why this is the
         * answer rather than silence: a caller that read it as success would move
         * its focus off a row that is still in the list.
         */
        return { ok: false, code: "server_refused" };
      }
      return { ok: true };
    },

    async archive(ids) {
      const accountId = get().accountId;
      const archiveId = get().roleId("archive") ?? get().roleId("all");
      if (!archiveId) {
        offerArchiveFolder(async () => {
          await get().archive(ids);
        });
        /*
         * Nothing was filed -- there is no folder to file into yet -- so this is
         * the same answer as a refused move. The toast above offers the folder
         * and retries this call itself once it exists.
         */
        return { ok: false, code: "server_refused" };
      }
      if (!accountId || !ids.length) return { ok: true };
      const { emails, mailboxes } = get();
      const threadIds = [
        ...new Set(
          ids.map((id) => emails[id]?.threadId).filter((t): t is Id => Boolean(t)),
        ),
      ];
      const byThread = await threadMessagesFor(accountId, threadIds, get);
      /*
       * A conversation that has come back to the Inbox goes back to where it was
       * filed; one that was never filed anywhere goes to Archive. A message
       * already sitting in that folder -- the reader archiving out of the case
       * folder itself -- is filed away as it always was, so the action still does
       * what its name says wherever it is pressed.
       *
       * The ids are this account's and so are the threads read above: a copy of
       * the same conversation in another account is that account's own mail, and
       * is archived from there.
       */
      const targets = new Map<Id, Id[]>();
      for (const id of ids) {
        const threadId = emails[id]?.threadId;
        const filed = threadId
          ? filedFolderOf(byThread[threadId] ?? [], mailboxes)
          : null;
        const already = filed ? Boolean(emails[id]?.mailboxIds?.[filed]) : false;
        const destination = filed && !already ? filed : archiveId;
        targets.set(destination, [...(targets.get(destination) ?? []), id]);
      }
      return moveToDestinations(ids, targets, set, get, (mailboxId) =>
        mailboxDisplayName(mailboxes[mailboxId]),
      );
    },

    async archiveByDate(ids, granularity) {
      const accountId = get().accountId;
      const archiveId = get().roleId("archive") ?? get().roleId("all");
      if (!accountId || !ids.length) return;
      if (!archiveId) {
        offerArchiveFolder(() => get().archiveByDate(ids, granularity));
        return;
      }
      const { emails } = get();
      const groups = groupByArchivePath(
        ids.map((id) => ({ id, receivedAt: emails[id]?.receivedAt })),
        granularity,
      );

      /*
       * The dated entries say what they do and are taken at their word: a reader
       * who picks *Archive to 2026/09* is asking for that date, not for where the
       * conversation used to be. The plain Archive button is the one that returns
       * a conversation to its folder (see `lib/archiveTarget`).
       */
      const targets = new Map<Id, Id[]>();
      try {
        for (const group of groups) {
          const target = await ensureFolderPath(get, archiveId, group.segments);
          targets.set(target, [...(targets.get(target) ?? []), ...group.ids]);
        }
      } catch (err) {
        toast.error(t("Archive failed: {error}", { error: errorMessage(err) }));
        void get().refreshList();
        return;
      }

      await moveToDestinations(ids, targets, set, get, (mailboxId) =>
        get().mailboxPath(mailboxId),
      );
    },

    async spam(ids, isSpam) {
      const { roleId } = get();
      const target = isSpam ? roleId("junk") : roleId("inbox");
      /*
       * No Junk Mail or Inbox to move to: nothing happens, which is the same
       * answer as a refused move and not a success a caller may report.
       */
      if (!target) return { ok: false, code: "server_refused" };
      const accountId = get().accountId;
      if (!accountId || !ids.length) return { ok: true };
      const kw: Record<Id, Record<string, unknown>> = {};
      for (const id of ids)
        kw[id] = {
          "keywords/$junk": isSpam ? true : null,
          "keywords/$notjunk": isSpam ? null : true,
        };
      try {
        await setEmails(accountId, kw);
      } catch (err) {
        /*
         * A server that refuses `$junk` still takes the move, so the message is
         * filed either way -- but the keyword is what makes it spam, and a report
         * of the move alone would say the action succeeded when half of it did
         * not. Said the way this store says a refused keyword write everywhere
         * else.
         */
        toast.error(t("Could not update: {error}", { error: errorMessage(err) }));
      }
      return get().move(ids, target, { label: isSpam ? "Junk Mail" : "Inbox" });
    },

    async emptyMailbox(mailboxId) {
      const accountId = get().accountId;
      if (!accountId) return { ok: true };
      // Emptying is permanent and covers the whole folder at once, so it is
      // offered only for the two folders whose whole purpose is holding what you
      // did not want. The menus hide it elsewhere; this is the guard that makes
      // that true of the action itself, whatever calls it.
      //
      // Junk Mail is destroyed outright rather than moved to Deleted Items —
      // there is no point routing spam through the bin on its way out, and it is
      // what "delete all spam" means everywhere else. The dialogs say so.
      // The two folders are the rule's (`FINAL_FOLDER_ROLES`), asked as ids so
      // the question is the one the action actually names.
      const finalIds = FINAL_FOLDER_ROLES.map((role) => get().roleId(role));
      if (!finalIds.includes(mailboxId)) {
        toast.error(t("Only Deleted Items and Junk Mail can be emptied."));
        return { ok: false, code: "not_final_folder" };
      }
      /*
       * Then the group rule (ADR 0013), asked after the folder's own: a folder
       * that may not be emptied at all is the more specific answer, and it says
       * nothing about who is asking. A group's Deleted Items and Junk Mail are
       * real folders members fill and cannot empty.
       */
      const refused = destroyRefusal(deleteContext(get), "empty");
      if (refused) {
        toast.error(refusalSentence(refused));
        return { ok: false, code: refused };
      }
      // A folder can hold far more messages than the server will destroy in one
      // call, so walk it a page at a time instead of back-referencing one huge
      // query into one Email/set. Each pass re-runs the filter, so the next page
      // is simply whatever is still in the folder.
      const page = client.maxObjectsInSet;
      let deleted = 0;
      let progress: number | null = null;
      try {
        for (;;) {
          const q = await client.call<QueryResponse>("Email/query", {
            accountId,
            filter: { inMailbox: mailboxId },
            limit: page,
          });
          if (!q.ids.length) break;
          if (progress === null && (q.total ?? q.ids.length) > page) {
            progress = toast.show(t("Emptying folder…"), { duration: 0 });
          }
          const { destroyed, notDestroyed } = await destroyEmails(accountId, q.ids);
          deleted += destroyed.length;
          // Nothing went through: the rest is undeletable, and looping again
          // would ask for the same ids forever.
          if (!destroyed.length) {
            const [, err] = Object.entries(notDestroyed)[0] ?? [];
            throw new Error(
              err ? setErrorMessage(err) : "the server refused to delete these messages",
            );
          }
        }
        toast.show(
          plural(deleted, { one: "Deleted {n} message", other: "Deleted {n} messages" }),
        );
        set({
          list: get().list
            ? {
                ...get().list!,
                ids: get().list!.mailboxId === mailboxId ? [] : get().list!.ids,
                // The total follows the ids: a reader who switched folders while
                // the empty was in flight keeps the count that belongs to the
                // folder now on screen.
                total: get().list!.mailboxId === mailboxId ? 0 : get().list!.total,
              }
            : null,
        });
      } catch (err) {
        toast.error(
          t("Could not empty folder: {error}", { error: errorMessage(err) }) +
            (deleted
              ? " " +
                plural(deleted, {
                  one: "({n} deleted first)",
                  other: "({n} deleted first)",
                })
              : ""),
        );
        /*
         * Nothing was destroyed before the failure — the folder is as it was — so
         * a caller may not read this as an emptied folder. The housekeeping below
         * runs either way: this branch only has to answer.
         */
        if (!deleted) return { ok: false, code: "server_refused" };
      } finally {
        if (progress !== null) toast.dismiss(progress);
        void get().loadMailboxes();
        void get().refreshList();
      }
      /*
       * The server's own refusal part-way through is a failure the reader is
       * already told about, not the group rule declining to act — and mail did go,
       * so the emptying happened and the answer says so.
       */
      return { ok: true };
    },
  };
}
