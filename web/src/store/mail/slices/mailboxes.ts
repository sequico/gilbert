import { errorMessage } from "@gilbert/shared/errors";
import { client, setErrorMessage } from "@/jmap/client";
import type {
  EmailFilter,
  GetResponse,
  Id,
  Mailbox,
  QueryResponse,
  SetResponse,
} from "@/jmap/types";
import { plural, t } from "@/lib/i18n";
import { destroyRefusal, folderDestroyTakesMail, mayDestroy } from "@/lib/mailDelete";
import { mailRouteAccount } from "@/lib/mailLink";
import type { FolderRef } from "@/lib/sieveFolders";
import { toast } from "@/ui/toast";
import { useSieve } from "../../sieve";
import { deleteContext } from "../context";
import { folderRefs } from "../folders";
import { adoptMailboxes } from "../mailboxes";
import { refusalSentence } from "../mutations";
import type { MailGet, MailSet, MailState } from "../types";
import { MAILBOX_PROPS } from "../types";

/**
 * The folder tree and its folders: reading it, naming it, and the
 * actions that add, retitle or remove a folder.
 *
 * A slice of the mail store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function mailboxesSlice(
  set: MailSet,
  get: MailGet,
): Pick<
  MailState,
  | "loadMailboxes"
  | "roleId"
  | "accountOfMailbox"
  | "mayDestroyHere"
  | "mailboxPath"
  | "childrenOf"
  | "descendantMailboxIds"
  | "markMailboxRead"
  | "createMailbox"
  | "ensureArchiveFolder"
  | "updateMailbox"
  | "destroyMailbox"
> {
  /**
   * A failed folder-tree read already reported, until one lands.
   *
   * `loadMailboxes` is fired and forgotten from a dozen places, and a read that
   * keeps failing would otherwise report on every one of them.
   */
  let mailboxesReadReported = false;

  /**
   * Keeps the Sieve rules pointing at the folders they were aimed at.
   *
   * Called after the mailbox list has reloaded: anything in `before` that still
   * exists has its rules retargeted to the new path, and anything that has gone
   * takes its rules with it. Rules are server-side and invisible from here, so
   * both outcomes are reported rather than done quietly.
   *
   * Deliberately never throws. The folder operation has already succeeded by this
   * point, and failing to tidy the rules must not make it look otherwise.
   */
  async function followFolders(accountId: Id, before: FolderRef[]): Promise<void> {
    try {
      const sieve = useSieve.getState();
      if (!sieve.available) return;
      /*
       * The rules this keeps are the reader's own, in their own account. A folder
       * in somebody else's tree -- a group's, where a member may also move one --
       * cannot be named by any of them: retargeting on such a move would point the
       * reader's filters at a path that exists only in the group, and a folder
       * that had gone from a group is not a folder their rules ever filed into.
       */
      if (sieve.accountId !== accountId) return;
      if (!sieve.scripts.length) await sieve.load();
      // Only the script the rule editor manages can be rewritten safely; a
      // hand-written one is nobody's business but its author's.
      const { rules } = useSieve.getState().rules();
      if (!rules?.length) return;

      const state = get();
      const moves: Array<FolderRef & { newPath: string }> = [];
      const gone: FolderRef[] = [];
      for (const ref of before) {
        if (state.mailboxes[ref.id])
          moves.push({ ...ref, newPath: state.mailboxPath(ref.id) });
        else gone.push(ref);
      }

      const { retargetRules, detachFolders } = await import("@/lib/sieveFolders");
      const retargeted = retargetRules(rules, moves);
      const detached = detachFolders(retargeted.rules, gone);
      if (!retargeted.changed && !detached.edited.length && !detached.removed.length)
        return;

      await useSieve.getState().saveRules(detached.rules);
      const plural = (n: number) => (n === 1 ? "" : "s");
      const said: string[] = [];
      if (retargeted.changed)
        said.push(
          `${retargeted.changed} filter rule${plural(retargeted.changed)} updated`,
        );
      if (detached.edited.length)
        said.push(
          `${detached.edited.length} filter rule${plural(detached.edited.length)} no longer file${detached.edited.length === 1 ? "s" : ""} there`,
        );
      if (detached.removed.length)
        said.push(
          `${detached.removed.length} filter rule${plural(detached.removed.length)} removed, having nothing left to do: ${detached.removed.map((r) => `“${r.name}”`).join(", ")}`,
        );
      toast.show(said.join(" · "), { duration: 8000 });
    } catch (err) {
      toast.error(
        t("Folder changed, but its filter rules could not be updated: {error}", {
          error: errorMessage(err),
        }),
      );
    }
  }

  return {
    async loadMailboxes() {
      const accountId = get().accountId;
      if (!accountId) return;
      let res: GetResponse<Mailbox>;
      try {
        res = await client.call<GetResponse<Mailbox>>("Mailbox/get", {
          accountId,
          ids: null,
          properties: MAILBOX_PROPS,
        });
      } catch (err) {
        /*
         * A failed read is not an answer: the tree already on screen is kept
         * rather than the sidebar emptied. This method is fired and forgotten
         * from a dozen places, so the failure is reported here, once for the
         * outage, instead of leaving an unhandled rejection behind.
         */
        if (!mailboxesReadReported) {
          mailboxesReadReported = true;
          console.warn(
            `[gilbert] could not read the folder tree of ${accountId}: ${errorMessage(err)}`,
          );
        }
        return;
      }
      mailboxesReadReported = false;
      const mailboxes = adoptMailboxes(accountId, res.list);
      const accountTrees = { ...get().accountTrees, [accountId]: mailboxes };
      // The account may have changed while the request was in flight (a quick
      // second click in the sidebar). The tree cache still wants this account's
      // folders, but the live state must not be clobbered by a stale answer.
      if (get().accountId !== accountId) {
        set({ accountTrees });
        return;
      }
      // The sidebar shows every account's tree, so the active account's folders
      // are written through to the per-account cache as well as to `mailboxes`.
      set({
        mailboxes,
        mailboxState: res.state,
        mailboxesLoaded: true,
        accountTrees,
      });
      // Label counts move for the same reasons folder counts do -- something was
      // read, moved or deleted -- so they are refreshed on the same beat rather
      // than on a timer of their own. Not awaited: the folder tree should not
      // wait on decoration.
      void get().loadLabelCounts();
    },

    roleId(role, accountId) {
      const { accountId: active, mailboxes, accountTrees } = get();
      /*
       * The account asked for, not always the one on screen: a draft is saved
       * into the account it was written in, which a mailbox switch does not
       * change. The tree of an account switched away from is still cached.
       */
      const tree =
        accountId && accountId !== active ? accountTrees[accountId] : mailboxes;
      if (!tree) return null;
      for (const m of Object.values(tree)) if (m.role === role) return m.id;
      return null;
    },

    accountOfMailbox(mailboxId, hint) {
      const { accountId, accountTrees, mailboxes } = get();
      /*
       * A link that names its account means that account, whatever this device is
       * showing. Ids are short and belong to one account each, but a folder id
       * another account also holds resolves against the account on screen — which
       * is a conversation that account does not have. The hint comes from the
       * link a notification built (`lib/mailLink`), and a hint that names an
       * account this session does not have is ignored rather than obeyed.
       */
      if (hint)
        return mailRouteAccount({
          hint,
          active: accountId,
          accounts: get().mailAccounts,
        });
      // The account on screen wins, so a folder that exists in two trees is not
      // attributed to the other one and is never a reason to switch away.
      if (accountId && (mailboxes[mailboxId] || accountTrees[accountId]?.[mailboxId]))
        return accountId;
      for (const [owner, tree] of Object.entries(accountTrees)) {
        if (tree[mailboxId]) return owner;
      }
      return null;
    },

    mayDestroyHere() {
      return mayDestroy(deleteContext(get));
    },

    mailboxPath(id) {
      const mbs = get().mailboxes;
      const parts: string[] = [];
      let cur: Mailbox | undefined = mbs[id];
      let guard = 0;
      while (cur && guard++ < 20) {
        parts.unshift(cur.role === "inbox" ? "INBOX" : cur.name);
        cur = cur.parentId ? mbs[cur.parentId] : undefined;
      }
      return parts.join("/");
    },

    childrenOf(parentId) {
      return Object.values(get().mailboxes)
        .filter((m) => (m.parentId ?? null) === parentId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    },

    descendantMailboxIds(mailboxId) {
      const all = Object.values(get().mailboxes);
      const out: Id[] = [mailboxId];
      const walk = (parent: Id) => {
        for (const m of all) {
          if ((m.parentId ?? null) === parent) {
            out.push(m.id);
            walk(m.id);
          }
        }
      };
      walk(mailboxId);
      return out;
    },

    async markMailboxRead(mailboxId, includeChildren = false) {
      const accountId = get().accountId;
      if (!accountId) return;
      const boxes = includeChildren ? get().descendantMailboxIds(mailboxId) : [mailboxId];
      // The ids the query returns are all we need; asking Email/get to echo them
      // back only risks blowing past maxObjectsInGet on a very full folder.
      const page = client.maxObjectsInSet;
      const unreadIn = async (filter: EmailFilter): Promise<Id[]> => {
        const res = await client.call<QueryResponse>("Email/query", {
          accountId,
          filter,
          limit: page,
        });
        return res.ids;
      };
      const nextUnread = async (): Promise<Id[]> => {
        if (boxes.length === 1)
          return unreadIn({ inMailbox: boxes[0]!, notKeyword: "$seen" });
        try {
          return await unreadIn({
            operator: "AND",
            conditions: [
              { notKeyword: "$seen" },
              { operator: "OR", conditions: boxes.map((id) => ({ inMailbox: id })) },
            ],
          });
        } catch {
          // Server without filter-operator support: one query per folder.
          const per = await Promise.all(
            boxes.map((id) =>
              unreadIn({ inMailbox: id, notKeyword: "$seen" }).catch(() => [] as Id[]),
            ),
          );
          return [...new Set(per.flat())];
        }
      };
      try {
        // One page per pass; the ones just marked drop out of the filter, so a
        // repeated head id means the last pass changed nothing and we stop.
        let marked = 0;
        let lastHead: Id | null = null;
        for (;;) {
          const ids = await nextUnread();
          if (!ids.length || ids[0] === lastHead) break;
          lastHead = ids[0]!;
          await get().markRead(ids, true);
          marked += ids.length;
        }
        if (!marked) {
          toast.show(t("Nothing unread here"));
          return;
        }
        toast.success(
          plural(marked, {
            one: "Marked {n} message as read",
            other: "Marked {n} messages as read",
          }) +
            (includeChildren && boxes.length > 1
              ? " " +
                plural(boxes.length, { one: "in {n} folder", other: "in {n} folders" })
              : ""),
        );
        void get().loadMailboxes();
      } catch (err) {
        toast.error(t("Could not mark as read: {error}", { error: errorMessage(err) }));
      }
    },

    async createMailbox(name, parentId, role) {
      const accountId = get().accountId!;
      const n: Record<string, unknown> = { name, parentId, isSubscribed: true };
      // Only when asked. Sending `role: null` on every create would be harmless
      // and would still say something the caller did not.
      if (role) n.role = role;
      const res = await client.call<SetResponse<Mailbox>>("Mailbox/set", {
        accountId,
        create: { n },
      });
      const err = res.notCreated?.n;
      if (err) throw new Error(setErrorMessage(err));
      await get().loadMailboxes();
      return res.created!.n!.id;
    },

    /*
     * The Archive folder, made rather than described.
     *
     * `Mailbox/set` takes `role` -- confirmed live against 0.16.20 on 2026-09-02,
     * as an ordinary user through the proxy, no admin API -- so a missing Archive
     * is something Gilbert can fix instead of explaining a server-side concept
     * and leaving. Stalwart parses the role names in `SpecialUse::parse`, of
     * which "archive" is one, and enforces that a role is held by one folder.
     *
     * A folder already *named* Archive but carrying no role is adopted rather
     * than duplicated. That is exactly the state #217 was reported from -- a
     * folder with the right name and no role, which archiving could not see --
     * and creating a second Archive beside it would be its own confusion.
     *
     * The name is the server's, not a translated one, for the same reason
     * renaming writes back the server's own: a folder's name is data, and a
     * German session must not create "Archiv" that an English one cannot find.
     */
    async ensureArchiveFolder() {
      const existing = Object.values(get().mailboxes).find(
        (m) => !m.role && m.name.trim().toLowerCase() === "archive",
      );
      if (existing) {
        await get().updateMailbox(existing.id, { role: "archive" });
        return existing.id;
      }
      return get().createMailbox("Archive", null, "archive");
    },

    async updateMailbox(id, patch) {
      const accountId = get().accountId!;
      // Paths as the filter rules currently spell them, before the move.
      const before =
        patch.name !== undefined || patch.parentId !== undefined
          ? folderRefs(get(), id)
          : [];
      const res = await client.call<SetResponse>("Mailbox/set", {
        accountId,
        update: { [id]: patch },
      });
      const err = res.notUpdated?.[id];
      if (err) throw new Error(setErrorMessage(err));
      await get().loadMailboxes();
      // Awaited, not fired and forgotten: the folder operation is not really done
      // until the rules pointing at it agree, and a page that navigates away
      // mid-save would leave the script half-written.
      if (before.length) await followFolders(accountId, before);
    },

    async destroyMailbox(id, removeEmails = true) {
      const accountId = get().accountId!;
      /*
       * A folder that holds mail is destroyed **with** it, so this is the third of
       * the three entry points ADR 0015 closes in a group. The count is the one
       * the folder list already carries: an empty folder is not mail, and a
       * group's tree stays the group's to shape.
       */
      if (
        folderDestroyTakesMail(get().mailboxes[id], removeEmails) &&
        destroyRefusal(deleteContext(get), "folder")
      ) {
        toast.error(refusalSentence("group_mail_folder"));
        return { ok: false, code: "group_mail_folder" };
      }
      const before = folderRefs(get(), id);
      const res = await client.call<SetResponse>("Mailbox/set", {
        accountId,
        destroy: [id],
        onDestroyRemoveEmails: removeEmails,
      });
      const err = res.notDestroyed?.[id];
      if (err) throw new Error(setErrorMessage(err));
      await get().loadMailboxes();
      await followFolders(accountId, before);
      /*
       * A refusal from the server still throws, which is the existing contract
       * this method has with its callers; only the rule's own refusal is returned,
       * because that one is not a failure — it is the answer.
       */
      return { ok: true };
    },
  };
}
