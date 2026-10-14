import { groupSenderIdentity } from "@gilbert/shared/identityAssignment";
import { create } from "zustand";
import { CAP, chunk, client, JmapMethodError, setErrorMessage } from "@/jmap/client";
import type {
  ChangesResponse,
  Email,
  EmailFilter,
  GetResponse,
  Id,
  Identity,
  Invocation,
  Mailbox,
  QueryResponse,
  Quota,
  SetResponse,
  Thread,
  VacationResponse,
} from "@/jmap/types";
import { groupByArchivePath } from "@/lib/archiveDate";
import { filedFolderOf } from "@/lib/archiveTarget";
import { plural, t } from "@/lib/i18n";
import {
  countedKeywords,
  countsConversations,
  type KeywordCounts,
  keywordCountDelta,
  SEEN_KEYWORD,
} from "@/lib/keywordCounts";
import { placeOwnerFrom, rememberPlace } from "@/lib/lastPlace";
import { isOptionalSort, withoutOptionalSorts } from "@/lib/listSort";
import {
  isGroupMailboxAccount,
  type MailAccountInfo,
  mailAccountAddress,
  mailAccountCandidates,
  ownIdentityAccountId,
} from "@/lib/mailAccounts";
import { mailboxDisplayName } from "@/lib/mailboxName";
import {
  type DeleteContext,
  type DeleteFailure,
  deleteEffect,
  destroyRefusal,
  FINAL_FOLDER_ROLES,
  finalFoldersOf,
  folderDestroyTakesMail,
  mayDestroy,
} from "@/lib/mailDelete";
import { mailRouteAccount } from "@/lib/mailLink";
import type { FolderRef } from "@/lib/sieveFolders";
import { toast } from "@/ui/toast";
import { labelsForAccount } from "../groupLabels";
import { useSession } from "../session";
import { settings, useSettings } from "../settings";
import { useSieve } from "../sieve";
import { releaseBodies, releaseHeld, resetBodyOrder, touchBodies } from "./bodies";
import { ensureFolderPath, folderRefs, rememberedMailAccount } from "./folders";
import {
  EMPTY_IDENTITIES,
  identitiesLoading,
  identitiesReads,
  overtakeIdentities,
  sortIdentities,
} from "./identities";
import { countRows, listKey, mergeEmail, pick } from "./list";
import {
  adoptMailboxes,
  movedTo,
  moveToDestinations,
  moveUndo,
  threadMessagesFor,
} from "./mailboxes";
import {
  destroyEmails,
  moveMailboxPatch,
  patchMailboxIds,
  refusalSentence,
  removeFromList,
  setEmails,
} from "./mutations";
import { notifyGroupMail, notifyNewMail } from "./notify";
import {
  BODY_PROPS,
  FULL_PROPS,
  LIST_PROPS,
  type ListQuery,
  MAILBOX_PROPS,
  type MailState,
} from "./types";
import { sessionIsAdmin } from "@gilbert/shared/sessionAccount";

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
          await useMail.getState().ensureArchiveFolder();
          await retry();
        } catch (err) {
          toast.error(
            t("Could not set up an Archive folder: {error}", {
              error: (err as Error).message,
            }),
          );
        }
      },
    },
  });
}

export const useMail = create<MailState>((set, get) => ({
  accountId: null,
  ownAccountId: null,
  mailAccounts: [],
  accountTrees: {},
  mailboxes: {},
  mailboxState: null,
  mailboxesLoaded: false,
  emails: {},
  fullIds: {},
  emailState: null,
  threads: {},
  identities: [],
  identitiesByAccount: {},
  assignmentByAccount: {},
  quotas: [],
  quotaAccountId: null,
  vacation: null,
  list: null,
  selected: {},
  labelCounts: {},
  selectedAll: false,
  anchorId: null,
  loadingThreads: {},
  lastSeenInboxEmailIds: null,
  lastThreadEmailIds: [],
  openThreadId: null,

  setOpenThread(id) {
    set({ openThreadId: id });
  },

  setAccount(accountId) {
    if (accountId === get().accountId) return;
    // Nothing held in full belongs to the account being left behind.
    resetBodyOrder();
    set({
      accountId,
      /* The per-account state below belongs to whichever account is active.
         The sidebar trees and the account list outlive a switch -- they are
         what let the reader come back -- and are dropped only on sign-out. */
      ...(accountId
        ? {
            ownAccountId: get().ownAccountId,
            mailAccounts: get().mailAccounts,
            accountTrees: get().accountTrees,
          }
        : { ownAccountId: null, mailAccounts: [], accountTrees: {} }),
      mailboxes: {},
      mailboxState: null,
      mailboxesLoaded: false,
      emails: {},
      fullIds: {},
      emailState: null,
      threads: {},
      identities: [],
      identitiesByAccount: {},
      assignmentByAccount: {},
      quotas: [],
      quotaAccountId: null,
      vacation: null,
      list: null,
      selected: {},
      selectedAll: false,
      anchorId: null,
      lastSeenInboxEmailIds: null,
      /* The rest names objects of the account that was on screen: ids of its
         own, a label count from its folders, a conversation, a thread. Kept,
         they would be read against the folders of the new account. */
      labelCounts: {},
      loadingThreads: {},
      lastThreadEmailIds: [],
      openThreadId: null,
    });
  },

  /*
   * Which accounts carry a mailbox: the reader's own, then the group mailboxes
   * whose folder trees `Mailbox/get` answers with. Each candidate is asked for
   * its folders; an account that shares only calendars, books or files answers
   * with none and is not listed (see lib/mailAccounts).
   *
   * A session refresh can land at any moment, so this must be cheap when
   * nothing changed: probing every account on every refresh would turn the
   * session's own change beat into a loop. Skip when the candidate list is
   * already the one on screen, and share the probe that is already on its
   * way, so overlapping callers get one round of Mailbox/get -- and its
   * answer -- rather than a second caller returning as if it had one.
   */
  async discoverMailAccounts() {
    if (discoverInFlight) return discoverInFlight;
    discoverInFlight = (async () => {
      try {
        const session = useSession.getState().session;
        const candidates = mailAccountCandidates(session);
        const current = get().mailAccounts;
        /*
         * Skip only when every account already known is still among the
         * candidates. Comparing the two lengths instead would never skip: a
         * candidate list holds every non-personal account, while `mailAccounts`
         * holds only the ones the probe found to be mailboxes, so a single
         * calendar/files/address-book share makes the lists different for ever
         * and the probe runs on every beat.
         */
        const byCandidate = new Map(candidates.map((c) => [c.accountId, c]));
        if (
          current.length > 0 &&
          current.every((a) => {
            const c = byCandidate.get(a.accountId);
            return c?.kind === a.kind && c.name === a.name;
          })
        )
          return;
        const ownInfo = candidates.find((c) => c.kind === "own") ?? null;
        const groups: MailAccountInfo[] = [];
        const trees: Record<Id, Record<Id, Mailbox>> = {};
        for (const c of candidates) {
          if (c.kind !== "group") continue;
          try {
            const res = await client.call<GetResponse<Mailbox>>("Mailbox/get", {
              accountId: c.accountId,
              ids: null,
              properties: MAILBOX_PROPS,
            });
            if (!res.list.length) continue;
            trees[c.accountId] = adoptMailboxes(c.accountId, res.list);
            groups.push(c);
          } catch {
            /*
             * A probe that failed is not an answer. `Mailbox/get` is what
             * proves an account carries a mailbox, but a request that never
             * answered proves nothing -- and dropping the account on it would
             * take the group off the screen, which is how its whole membership
             * ends up in the From list. The entry already known for that
             * account is kept instead; an answer with no folder tree still
             * drops it, just above.
             */
            const known = current.find((a) => a.accountId === c.accountId);
            if (known) groups.push(known);
          }
        }
        /*
         * The answer belongs to the session it was asked of. A sign-out, or a
         * fresh session, can land while the probe is in flight, and writing
         * this one then would put the previous reader's accounts back on
         * screen under the new session.
         */
        if (useSession.getState().session !== session) return;
        set((s) => ({
          ownAccountId: ownInfo?.accountId ?? null,
          mailAccounts: ownInfo ? [ownInfo, ...groups] : [],
          accountTrees: { ...s.accountTrees, ...trees },
        }));
        /*
         * The group mailboxes are known here, and with them that the reader
         * may need a group's From list narrowed to the identity assigned to
         * them there. Read now so the composer has it before a draft is
         * opened, and for the account on screen at that moment.
         */
        const active = get().accountId;
        if (active)
          void get()
            .loadAssignmentFor(active)
            .catch(() => undefined);
        /*
         * The account the reader was last on, if it is still one of theirs.
         * Discovery is where the group mailboxes become known, so this is the
         * first moment a remembered group account could be honoured at all --
         * the account switcher has nothing to offer before it.
         */
        const again = rememberedMailAccount(get().mailAccounts);
        if (again && again !== get().accountId) void get().openAccount(again);
      } finally {
        discoverInFlight = null;
      }
    })();
    return discoverInFlight;
  },

  async refreshAccountTree(accountId) {
    try {
      const res = await client.call<GetResponse<Mailbox>>("Mailbox/get", {
        accountId,
        ids: null,
        properties: MAILBOX_PROPS,
      });
      const tree = adoptMailboxes(accountId, res.list);
      set((s) => ({ accountTrees: { ...s.accountTrees, [accountId]: tree } }));
    } catch {
      /* keep the last tree we could read */
    }
  },

  async openAccount(accountId) {
    if (!accountId) return;
    /*
     * Where the reader is, for the next session on this device. Recorded here
     * rather than in `setAccount`, because the boot sequence and the sign-in
     * path call that too: a place is somewhere somebody went, and the account a
     * session opens on by itself is not one they chose.
     */
    rememberPlace(placeOwnerFrom(useSession.getState()), { mailAccountId: accountId });
    if (accountId === get().accountId) {
      if (!get().mailboxesLoaded) await get().loadMailboxes();
      return;
    }
    get().setAccount(accountId);
    await Promise.all([get().loadMailboxes(), get().loadIdentities()]);
    void get().loadQuota();
  },

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
          `[gilbert] could not read the folder tree of ${accountId}: ${(err as Error).message}`,
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

  roleId(role) {
    for (const m of Object.values(get().mailboxes)) if (m.role === role) return m.id;
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
    return mayDestroy(deleteContext());
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

  async query(q, opts = {}) {
    const accountId = get().accountId;
    if (!accountId) return;
    const key = listKey(q);
    const cur = get().list;
    const reuse = cur && cur.key === key && !opts.reset;
    if (reuse && cur.ids.length && !cur.error) {
      // Already showing; just refresh in background.
      void get().refreshList();
      return;
    }
    // A fresh window replaces whatever was on screen, so a page still on its
    // way for the old one is told to drop its answer.
    listEpoch++;
    const epoch = listEpoch;
    set({
      list: {
        ...q,
        key,
        ids: reuse ? cur.ids : [],
        total: reuse ? cur.total : 0,
        queryState: null,
        loading: true,
        loadingMore: false,
        error: null,
        exhausted: false,
      },
      selected: {},
      selectedAll: false,
      anchorId: null,
    });
    try {
      const { ids, total, queryState } = await runQuery(
        accountId,
        q,
        0,
        settings().pageSize,
      );
      if (get().list?.key !== key) return;
      /*
       * A delete or a move landed while this window was being read: the answer
       * was computed before it, so it is read again rather than shown. The
       * re-read may itself be superseded and return without touching the flag,
       * so `loading` comes down here: the re-read only refreshes what the list
       * already holds, and a spinner left up over it is one nobody takes down.
       */
      if (epoch !== listEpoch) {
        set((s) => ({
          list: s.list ? { ...s.list, loading: false } : s.list,
        }));
        void get().refreshList();
        return;
      }
      set((s) => ({
        list: s.list
          ? {
              ...s.list,
              ids,
              total,
              queryState,
              loading: false,
              exhausted: ids.length >= total,
            }
          : s.list,
      }));
    } catch (err) {
      if (get().list?.key !== key) return;
      set((s) => ({
        list: s.list
          ? { ...s.list, loading: false, error: (err as Error).message }
          : s.list,
      }));
    }
  },

  async loadMore() {
    const accountId = get().accountId;
    const l = get().list;
    if (!accountId || !l || l.loading || l.loadingMore || l.exhausted) return;
    // The window this page belongs to. A full read that starts while the page
    // is on its way owns the list when it lands, and this page must not append
    // over it.
    const epoch = listEpoch;
    set({ list: { ...l, loadingMore: true } });
    try {
      const { ids, total, queryState } = await runQuery(
        accountId,
        l,
        l.ids.length,
        settings().pageSize,
      );
      const cur = get().list;
      if (!cur || cur.key !== l.key) return;
      /*
       * A full read, a delete or a move landed while this page was on its way:
       * the page is dropped rather than joined to a window it does not belong
       * to, and the flag it set comes down with it -- the window it was paging
       * is still on screen and waits on `loadingMore` to ask for the next one,
       * so a flag left up is a window that pages no further.
       */
      if (epoch !== listEpoch) {
        if (cur.loadingMore) set({ list: { ...cur, loadingMore: false } });
        return;
      }
      /*
       * A page asked for at a bare position is the next page only of the window
       * the first one read. If the server's query state moved meanwhile -- a
       * message arrived, was filed or was read -- that position no longer
       * continues what is on screen, and appending would skip whatever moved
       * into the gap. The stored `queryState` is what says so, so the window is
       * read again rather than joined.
       */
      if (queryState && l.queryState && queryState !== l.queryState) {
        /*
         * The re-read owns the list now, and one that is itself superseded
         * returns without touching this flag -- so it comes down here, where the
         * page is dropped either way.
         */
        if (cur.loadingMore) set({ list: { ...cur, loadingMore: false } });
        await get().refreshList();
        return;
      }
      const merged = [...cur.ids];
      const seen = new Set(merged);
      for (const id of ids) if (!seen.has(id)) merged.push(id);
      set({
        list: {
          ...cur,
          ids: merged,
          total,
          queryState,
          loadingMore: false,
          exhausted: ids.length === 0 || merged.length >= total,
        },
      });
    } catch (err) {
      const cur = get().list;
      if (cur && cur.key === l.key)
        set({ list: { ...cur, loadingMore: false, error: (err as Error).message } });
    }
  },

  async refreshList() {
    const accountId = get().accountId;
    const l = get().list;
    if (!accountId || !l) return;
    // A full read supersedes any page still on its way: the generation moves so
    // that page drops its answer instead of appending over this one.
    listEpoch++;
    const epoch = listEpoch;
    try {
      const limit = Math.max(settings().pageSize, l.ids.length);
      const { ids, total, queryState } = await runQuery(accountId, l, 0, limit);
      const cur = get().list;
      if (!cur || cur.key !== l.key) return;
      /*
       * A delete or a move landed while this read was on its way: `destroy` or
       * `move` moved the generation, and the ids it came back with name a row
       * the reader just removed. The list on screen is left as that change left
       * it.
       */
      if (epoch !== listEpoch) return;
      set({
        list: {
          ...cur,
          ids,
          total,
          queryState,
          loading: false,
          loadingMore: false,
          error: null,
          exhausted: ids.length >= total,
        },
      });
    } catch {
      // The window is kept as it was; a page that was in flight is not allowed
      // to leave the list looking like it is still loading more.
      const cur = get().list;
      if (cur?.loadingMore) set({ list: { ...cur, loadingMore: false } });
    }
  },

  async getEmails(ids, full = false) {
    const accountId = get().accountId;
    if (!accountId || !ids.length) return [];
    const { emails, fullIds } = get();
    const missing = ids.filter((id) => !emails[id] || (full && !fullIds[id]));
    if (missing.length) {
      const results = await Promise.all(
        chunk(missing, client.maxObjectsInGet).map((part) =>
          client.call<GetResponse<Email>>("Email/get", {
            accountId,
            ids: part,
            properties: full ? FULL_PROPS : LIST_PROPS,
            ...(full
              ? {
                  fetchHTMLBodyValues: true,
                  fetchTextBodyValues: true,
                  maxBodyValueBytes: 2 * 1024 * 1024,
                  bodyProperties: BODY_PROPS,
                }
              : {}),
          }),
        ),
      );
      set((s) => {
        const next = { ...s.emails };
        const nextFull = { ...s.fullIds };
        let state = s.emailState;
        for (const r of results) {
          state = r.state;
          for (const e of r.list) {
            next[e.id] = mergeEmail(next[e.id], e);
            if (full) nextFull[e.id] = true;
          }
        }
        return { emails: next, fullIds: nextFull, emailState: s.emailState ?? state };
      });
    }
    if (full) {
      // What was just asked for is the most recently wanted, and the oldest
      // bodies are let go of to pay for it.
      touchBodies(ids);
      set((s) => releaseBodies(s));
    }
    const now = get().emails;
    return ids.map((id) => now[id]).filter((e): e is Email => Boolean(e));
  },

  async loadThread(threadId) {
    const accountId = get().accountId;
    if (!accountId) return [];
    set((s) => ({ loadingThreads: { ...s.loadingThreads, [threadId]: true } }));
    try {
      const res = await client.chain([
        ["Thread/get", { accountId, ids: [threadId] }, "t"],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
            properties: FULL_PROPS,
            fetchHTMLBodyValues: true,
            fetchTextBodyValues: true,
            maxBodyValueBytes: 2 * 1024 * 1024,
            bodyProperties: BODY_PROPS,
          },
          "e",
        ],
      ]);
      const [threadRes] = res.get("t") ?? [];
      const thread = (threadRes as unknown as GetResponse<Thread>).list[0];
      const emailsRes = res.get("e")?.[0] as unknown as GetResponse<Email>;
      if (!thread) {
        /*
         * Thread/get answered list: [] — the thread is gone (destroyed on
         * another device, or a stale deep link). The loading flag has to come
         * down here or ThreadView's spinner never stops, and this is an error
         * rather than an empty thread, so it is thrown for the caller's catch
         * to say so.
         */
        set((s) => {
          const { [threadId]: _drop, ...rest } = s.loadingThreads;
          return { loadingThreads: rest };
        });
        throw new Error(t("This conversation no longer exists."));
      }
      set((s) => {
        const next = { ...s.emails };
        const nextFull = { ...s.fullIds };
        for (const e of emailsRes.list) {
          next[e.id] = mergeEmail(next[e.id], e);
          nextFull[e.id] = true;
        }
        const { [threadId]: _drop, ...rest } = s.loadingThreads;
        return {
          emails: next,
          fullIds: nextFull,
          threads: { ...s.threads, [threadId]: thread },
          loadingThreads: rest,
          // The ids of the last conversation that finished loading: the pane
          // keeps showing them while a newly opened one is still loading.
          lastThreadEmailIds: thread.emailIds,
        };
      });
      /*
       * The bodies this read inserted are the most recently wanted, and the
       * cache's oldest bodies are let go of to pay for them — exactly as a full
       * `getEmails` does. Without this the conversation's bodies sit outside
       * `bodyOrder` and are never counted against `BODIES_KEPT`, so a session
       * that opens conversations holds every one of their bodies.
       */
      touchBodies(thread.emailIds);
      set((s) => releaseBodies(s));
      return get().threadEmails(threadId);
    } catch (err) {
      set((s) => {
        const { [threadId]: _drop, ...rest } = s.loadingThreads;
        return { loadingThreads: rest };
      });
      throw err;
    }
  },

  threadEmails(threadId) {
    const { threads, emails } = get();
    const t = threads[threadId];
    if (!t) return [];
    return t.emailIds.map((id) => emails[id]).filter((e): e is Email => Boolean(e));
  },

  threadIdsIn(threadId, mailboxId) {
    const t = get().threads[threadId];
    if (!t) return [];
    if (!mailboxId) return [...t.emailIds];
    const { emails } = get();
    return t.emailIds.filter((id) => emails[id]?.mailboxIds[mailboxId]);
  },

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
      toast.error(t("Could not update: {error}", { error: (err as Error).message }));
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
     * rather than putting them back (see `listEpoch`). Only a move that took a
     * row with it moves the generation -- filing a message the window is not
     * showing leaves the list exactly as it was.
     */
    if (rowsBefore !== get().list?.ids.length) listEpoch++;
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
      toast.error(t("Move failed: {error}", { error: (err as Error).message }));
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
    for (const id of ids) update[id] = { [`mailboxIds/${mailboxId}`]: add ? true : null };
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
      toast.error(
        t("Could not update labels: {error}", { error: (err as Error).message }),
      );
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
    const refused = destroyRefusal(deleteContext(), "final");
    if (refused) {
      toast.error(refusalSentence(refused));
      return { ok: false, code: refused };
    }
    /*
     * The window moves here too: a list read already on its way was computed
     * before this delete reached the server, so its answer names a message that
     * is gone and must be dropped rather than written back over the removal
     * below (see `listEpoch`).
     */
    listEpoch++;
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
      toast.error(t("Delete failed: {error}", { error: (err as Error).message }));
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
      const filed = threadId ? filedFolderOf(byThread[threadId] ?? [], mailboxes) : null;
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
      toast.error(t("Archive failed: {error}", { error: (err as Error).message }));
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
      toast.error(t("Could not update: {error}", { error: (err as Error).message }));
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
     * Then the group rule (ADR 0015), asked after the folder's own: a folder
     * that may not be emptied at all is the more specific answer, and it says
     * nothing about who is asking. A group's Deleted Items and Junk Mail are
     * real folders members fill and cannot empty.
     */
    const refused = destroyRefusal(deleteContext(), "empty");
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
        t("Could not empty folder: {error}", { error: (err as Error).message }) +
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
      toast.error(
        t("Could not mark as read: {error}", { error: (err as Error).message }),
      );
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
      destroyRefusal(deleteContext(), "folder")
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

  async loadIdentitiesFor(accountId) {
    if (!accountId) return [];
    const running = identitiesLoading.get(accountId);
    if (running) return running;
    /*
     * The number this read is started under. A write that lands while it is on
     * its way spends it (`overtakeIdentities`), and what it got is then kept
     * between the reader and this promise rather than written under the
     * account -- the list it holds is the one from before the write.
     */
    const read = identitiesReads.get(accountId) ?? 0;
    const spent = () => (identitiesReads.get(accountId) ?? 0) !== read;
    const run = (async () => {
      const res = await client.call<GetResponse<Identity>>("Identity/get", {
        accountId,
        ids: null,
      });
      /*
       * Cached under the account id, whatever is on screen. The account the
       * reader's own identities live in is rarely the one they are browsing --
       * somebody reading a group's mail is looking at the group's account --
       * and Settings lists the two one under the other, so each answer is kept
       * rather than thrown away with the account that asked for it.
       */
      let list = sortIdentities(res.list, accountId);
      if (spent()) return list;
      set((s) => ({
        identitiesByAccount: { ...s.identitiesByAccount, [accountId]: list },
      }));
      identitiesChanged(accountId);
      // Long signatures live in Files; swap the stored marker for the full HTML.
      const { markerOf } = await import("@/lib/signatureHtml");
      const pending = list.filter((i) => markerOf(i.htmlSignature));
      if (!pending.length) return list;
      const { loadStoredSignature } = await import("@/lib/signatureImages");
      const full = await Promise.all(
        pending.map(async (i) => {
          const m = markerOf(i.htmlSignature)!;
          try {
            return [i.id, await loadStoredSignature(m.blobId, m.type)] as const;
          } catch {
            return [i.id, null] as const;
          }
        }),
      );
      // The same account again: its signatures are as much part of its list as
      // of the list of the account that happens to be on screen.
      list = list.map((i) => {
        const f = full.find(([id]) => id === i.id)?.[1];
        return f ? { ...i, htmlSignature: f } : i;
      });
      if (spent()) return list;
      set((s) => ({
        identitiesByAccount: { ...s.identitiesByAccount, [accountId]: list },
      }));
      identitiesChanged(accountId);
      return list;
    })();
    identitiesLoading.set(accountId, run);
    try {
      return await run;
    } finally {
      // Only this read's own entry: a read started after it took the place,
      // and dropping that one would have a third caller fetch in parallel.
      if (identitiesLoading.get(accountId) === run) identitiesLoading.delete(accountId);
    }
  },

  async loadIdentities() {
    const accountId = get().accountId;
    if (!accountId) return [];
    await get().loadIdentitiesFor(accountId);
    /*
     * A group mailbox has one more thing to know before its view is right: the
     * identity the administration assigned the reader (ADR 0007). Read beside
     * the list rather than after it, and a failure is not fatal -- the view
     * falls back to the group's own identity, which is what an unassigned
     * member sends as anyway.
     */
    if (isGroupMailboxAccount(accountId, get().mailAccounts))
      await get()
        .loadAssignmentFor(accountId)
        .catch(() => undefined);
    // The account's *view*, which is what every caller of this has always had:
    // in a group mailbox the sender is the assigned identity, else the group's.
    return get().identities;
  },

  /**
   * Which identity this group mailbox has assigned to the reader (ADR 0007).
   *
   * `null` is an answer -- nothing is assigned, so the view sends as the
   * group's own identity -- and a failed read leaves the entry absent, which is
   * "not known", so an unreadable document is never shown as "nothing
   * assigned" outside the window where the group's own identity is what both
   * would offer anyway.
   */
  async loadAssignmentFor(accountId, opts) {
    const state = get();
    if (!isGroupMailboxAccount(accountId, state.mailAccounts)) return;
    if (!opts?.force && state.assignmentByAccount[accountId] !== undefined) return;
    const address = mailAccountAddress(state.mailAccounts, accountId);
    if (!address) return;
    const { fetchMemberAssignment } = await import("@/lib/identities");
    const view = await fetchMemberAssignment(address);
    set((s) => ({
      assignmentByAccount: {
        ...s.assignmentByAccount,
        [accountId]: { assignedId: view.assignedId },
      },
    }));
    identitiesChanged(accountId);
  },

  defaultIdentity() {
    const { identities, accountId } = get();
    /*
     * Through the one reader of the preference: the account a draft is written
     * in first, the reader's own behind it. `setDefaultIdentity` writes under
     * the account that sends for the reader, which is not always the account on
     * screen -- and a group mailbox has narrowed to the reader's own identity
     * by then, so the fallback there is the identity already being offered.
     */
    return (
      get().defaultIdentityFor(accountId) ??
      get().defaultIdentityFor(ownIdentityAccountId(useSession.getState().session)) ??
      identities[0]
    );
  },

  defaultIdentityFor(accountId) {
    if (!accountId) return undefined;
    /*
     * The account on screen is read from its view: in a group mailbox that
     * view is the reader's own identity, while the group account's own
     * preference may name a different member. Everything else comes from the
     * cache, which is where the reader's own list lives.
     */
    const list =
      accountId === get().accountId
        ? get().identities
        : (get().identitiesByAccount[accountId] ?? []);
    const pref = settings().defaultIdentityByAccount[accountId];
    return list.find((i) => i.id === pref) ?? list[0];
  },

  ownIdentities() {
    const own = ownIdentityAccountId(useSession.getState().session);
    if (!own) return EMPTY_IDENTITIES;
    return get().identitiesByAccount[own] ?? EMPTY_IDENTITIES;
  },

  setDefaultIdentity(id) {
    // ADR 0007: the default a person sets is the one their own account sends
    // with, not the preference of the mailbox they happened to be reading.
    const accountId = ownIdentityAccountId(useSession.getState().session);
    if (!accountId) return;
    useSettings.getState().update({
      defaultIdentityByAccount: {
        ...settings().defaultIdentityByAccount,
        [accountId]: id,
      },
    });
    const cached = get().identitiesByAccount[accountId] ?? [];
    if (cached.length)
      set((s) => ({
        identitiesByAccount: {
          ...s.identitiesByAccount,
          [accountId]: sortIdentities(cached, accountId),
        },
      }));
    const active = get().accountId;
    if (active) applyIdentities(active);
  },

  async saveIdentity(id, patch) {
    const accountId = ownIdentityAccountId(useSession.getState().session);
    if (!accountId) throw new Error(t("Not signed in"));
    const res = id
      ? await client.call<SetResponse<Identity>>("Identity/set", {
          accountId,
          update: { [id]: patch },
        })
      : await client.call<SetResponse<Identity>>("Identity/set", {
          accountId,
          create: { n: patch },
        });
    const err = id ? res.notUpdated?.[id] : res.notCreated?.n;
    if (err) throw new Error(setErrorMessage(err));
    // A read already on its way was asked before this write and answers with
    // the list from before it, so it is spent rather than joined.
    overtakeIdentities(accountId);
    await get().loadIdentitiesFor(accountId);
  },

  async destroyIdentity(id) {
    const accountId = ownIdentityAccountId(useSession.getState().session);
    if (!accountId) throw new Error(t("Not signed in"));
    const res = await client.call<SetResponse>("Identity/set", {
      accountId,
      destroy: [id],
    });
    const err = res.notDestroyed?.[id];
    if (err) throw new Error(setErrorMessage(err));
    // Same as saveIdentity: the list has to be read after the write.
    overtakeIdentities(accountId);
    await get().loadIdentitiesFor(accountId);
  },

  async refreshIdentities() {
    /*
     * Every list this session is holding, plus the two that are always worth
     * having: the reader's own, which Settings lists and a group mailbox
     * narrows against, and the account on screen.
     */
    const state = get();
    const own = ownIdentityAccountId(useSession.getState().session);
    const wanted = new Set<Id>(Object.keys(state.identitiesByAccount));
    if (own) wanted.add(own);
    if (state.accountId) wanted.add(state.accountId);
    /*
     * The assignments too, and dropped rather than kept: the administration
     * writes them through its own routes (ADR 0007), so the session that asked
     * for the write is the one thing that never hears of it — and a stale
     * assignment is a draft that goes out as the group instead of as the person
     * the administrator just assigned.
     */
    set({ assignmentByAccount: {} });
    for (const id of wanted) overtakeIdentities(id);
    await Promise.all(
      [...wanted].map((id) =>
        get()
          .loadIdentitiesFor(id)
          .catch(() => undefined),
      ),
    );
    if (state.accountId)
      await get()
        .loadAssignmentFor(state.accountId)
        .catch(() => undefined);
  },

  async loadVacation() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const res = await client.call<GetResponse<VacationResponse>>(
        "VacationResponse/get",
        { accountId, ids: null },
      );
      set({ vacation: res.list[0] ?? null });
    } catch {
      set({ vacation: null });
    }
  },

  async saveVacation(patch) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("VacationResponse/set", {
      accountId,
      update: { singleton: patch },
    });
    const err = res.notUpdated?.singleton;
    if (err) throw new Error(setErrorMessage(err));
    await get().loadVacation();
  },

  async loadQuota() {
    const accountId = get().accountId;
    if (!accountId || !client.hasCapability(CAP.quota)) return;
    // Claimed before the read, so a second ask from the bar's effect answers
    // itself instead of sending a second request for the account already on its
    // way. A quick switch back is caught by the guard after the await.
    set({ quotaAccountId: accountId });
    try {
      const res = await client.call<GetResponse<Quota>>("Quota/get", {
        accountId,
        ids: null,
      });
      if (get().accountId !== accountId) return;
      set({ quotas: res.list });
    } catch {
      if (get().accountId !== accountId) return;
      set({ quotas: [] });
    }
  },

  select(ids, on) {
    set((s) => {
      const next = { ...s.selected };
      for (const id of ids) {
        if (on) next[id] = true;
        else delete next[id];
      }
      return { selected: next };
    });
  },
  async loadLabelCounts() {
    const accountId = get().accountId;
    const labels = labelsForAccount(accountId, settings().labels);
    /*
     * Starred is counted too, and it is not a label: it is the keyword a star
     * writes, drawn as the first row of the same list. An account with no
     * labels still has stars, so the empty case is the counted set being
     * empty and never the label array.
     */
    const keywords = countedKeywords(labels);
    if (!accountId) {
      if (Object.keys(get().labelCounts).length) set({ labelCounts: {} });
      return;
    }
    /*
     * Two queries per keyword -- the total, and the unread half -- carried in
     * slices of the server's batch ceiling. The count is the whole answer, so
     * `limit: 0` keeps the server from sending ids that would only be thrown
     * away: what is wanted is `total`.
     *
     * Both are asked at once rather than derived, because one cannot be
     * derived from the other and the sidebar needs both: the row shows the
     * total, and a label set to "while unread" is drawn or dropped by the
     * unread half.
     *
     * **`collapseThreads` is the setting the list itself uses**, so the number
     * counts the unit the reader is about to see: conversations when
     * conversation view is on, messages when it is off. Without it a
     * conversation of three messages carrying a label counted three while the
     * list it opened showed one row -- a number that contradicts the list it
     * describes is worse than no number.
     */
    const collapseThreads = countsConversations();
    const calls: Invocation[] = keywords.flatMap((keyword, i) => [
      [
        "Email/query",
        {
          accountId,
          filter: { hasKeyword: keyword },
          collapseThreads,
          limit: 0,
          calculateTotal: true,
        },
        `t${i}`,
      ],
      [
        "Email/query",
        {
          accountId,
          filter: {
            operator: "AND",
            conditions: [{ hasKeyword: keyword }, { notKeyword: SEEN_KEYWORD }],
          },
          collapseThreads,
          limit: 0,
          calculateTotal: true,
        },
        `u${i}`,
      ],
    ]) as Invocation[];
    const counts: Record<string, KeywordCounts> = {};
    for (const keyword of keywords) counts[keyword] = { total: 0, unread: 0 };
    try {
      /*
       * Sliced to the server's batch ceiling (`maxCallsInRequest`, advertised
       * as 16 and honoured by `call`/`flush`): two queries per keyword means a
       * reader with nine labels sends eighteen calls, and a real server refuses
       * the whole request, with nothing landing here. The low-level `request`
       * does not chunk on its own, so the bound is applied here.
       */
      const max = client.maxCallsInRequest;
      for (let at = 0; at < calls.length; at += max) {
        const res = await client.request(calls.slice(at, at + max));
        for (const [, result, id] of res.methodResponses) {
          const which = String(id).slice(0, 1);
          const keyword = keywords[Number(String(id).slice(1))];
          if (!keyword) continue;
          const total = (result as { total?: number }).total ?? 0;
          if (which === "t") counts[keyword]!.total = total;
          else counts[keyword]!.unread = total;
        }
      }
      set({ labelCounts: counts });
    } catch {
      // A count is decoration. Failing to get one is not worth a toast, and
      // the sidebar falls back to drawing the label without a number.
    }
  },

  clearSelection() {
    set({ selected: {}, selectedAll: false });
  },
  selectAll() {
    const l = get().list;
    if (!l) return;
    const next: Record<Id, true> = {};
    for (const id of l.ids) next[id] = true;
    // Ticking the box is the loaded rows. Going wider is a separate,
    // deliberate press, because "select all" meaning ten thousand messages
    // when the screen shows fifty is not something to infer from a checkbox.
    set({ selected: next, selectedAll: false });
  },

  selectAllMatching() {
    if (!get().list) return;
    set({ selectedAll: true });
  },

  async queryAllIds() {
    const { accountId, list } = get();
    if (!accountId || !list) return [];
    const page = client.maxObjectsInSet;
    const out: Id[] = [];
    let progress: number | null = null;
    try {
      for (let position = 0; ; position += page) {
        const q = await client.call<QueryResponse>("Email/query", {
          accountId,
          filter: list.filter,
          sort: list.sort,
          /*
           * Uncollapsed, unlike the list itself. "Everything in this folder"
           * means every message; the list shows one row per thread only so it
           * reads well. Expanding threads the way a click does is not possible
           * here anyway -- that walks loaded Email objects, and the whole point
           * is the ones that were never loaded.
           */
          collapseThreads: false,
          position,
          limit: page,
        });
        if (!q.ids.length) break;
        out.push(...q.ids);
        if (progress === null && q.ids.length === page) {
          progress = toast.show(t("Working out what is selected…"), { duration: 0 });
        }
        // A short page is the last page. Asking again would cost a round trip
        // to be told the same thing.
        if (q.ids.length < page) break;
      }
    } finally {
      if (progress !== null) toast.dismiss(progress);
    }
    return out;
  },
  setAnchor(id) {
    set({ anchorId: id });
  },

  async applyChanges(types, signal) {
    const accountId = get().accountId;
    if (!accountId) return;
    // A pass aborted at the start is not worth a single request; one aborted
    // mid-way stops before each further call, because `client.call` rejects an
    // aborted signal without sending anything.
    if (signal?.aborted) return;
    if (types.has("Mailbox")) void get().loadMailboxes();
    if (types.has("Email")) {
      const state = get().emailState;
      if (state) {
        try {
          let since = state;
          let guard = 0;
          const updated = new Set<Id>();
          const created = new Set<Id>();
          const destroyed = new Set<Id>();
          // Page through Email/changes.
          while (guard++ < 10) {
            const ch = await client.call<ChangesResponse>(
              "Email/changes",
              {
                accountId,
                sinceState: since,
                maxChanges: 500,
              },
              [],
              signal,
            );
            ch.created.forEach((id) => created.add(id));
            ch.updated.forEach((id) => updated.add(id));
            ch.destroyed.forEach((id) => destroyed.add(id));
            since = ch.newState;
            if (!ch.hasMoreChanges) break;
          }
          // The changes were read: whatever was reported while the server was
          // failing has been answered, so a later failure is news again.
          changesReported = false;
          set((s) => {
            const next = { ...s.emails };
            const nextFull = { ...s.fullIds };
            for (const id of destroyed) {
              delete next[id];
              delete nextFull[id];
            }
            /*
             * The full copy of an updated email is deliberately kept.
             *
             * Dropping it would make the next read fetch it again, but the
             * reading pane renders only the emails it holds in full: dropping
             * one takes the message out of the open thread until the refetch
             * at the end of this function puts it back. The pane empties and
             * refills -- on an HTML message, a flash to the app's own
             * background and out again, which is what is left of #100.
             *
             * Marking as read causes exactly this: the server echoes our own
             * change back as an update.
             *
             * Nothing is lost by keeping it. RFC 8621 makes every property of
             * an Email immutable except `keywords` and `mailboxIds` -- the id
             * is derived from the content, so a body cannot change beneath one
             * -- and both are in LIST_PROPS, which the refresh immediately
             * below merges over the cached copy. Dropping it only ever costs
             * the message its place in the thread.
             */
            return { emails: next, fullIds: nextFull };
          });
          // Refresh the list-level props of updated/cached emails.
          const cached = [...updated].filter((id) => get().emails[id]);
          if (cached.length) {
            const results = await Promise.all(
              chunk(cached, client.maxObjectsInGet).map((part) =>
                client.call<GetResponse<Email>>(
                  "Email/get",
                  {
                    accountId,
                    ids: part,
                    properties: LIST_PROPS,
                  },
                  [],
                  signal,
                ),
              ),
            );
            set((s) => {
              const next = { ...s.emails };
              for (const r of results)
                for (const e of r.list) next[e.id] = mergeEmail(next[e.id], e);
              return { emails: next };
            });
          }
          /*
           * The token moves only once every read the new state promised has
           * landed. An aborted pass (or a failed `Email/get`) leaves
           * `emailState` where it was, so the next pass asks for the same
           * window again rather than dropping the updated emails whose list
           * props were never fetched -- `refreshList` below re-reads ids only,
           * not those props.
           */
          set({ emailState: since });
          if (created.size) await notifyNewMail([...created], get);
        } catch (err) {
          if (err instanceof JmapMethodError && err.type === "cannotCalculateChanges") {
            /*
             * The token is older than the server's window: dropping it makes
             * the next pass start from the server's own state rather than
             * asking for a range that no longer exists.
             */
            set({ emailState: null });
          } else if (!signal?.aborted) {
            /*
             * Every other failure leaves the token where it was, so the same
             * window is asked for again -- a transient outage heals itself. A
             * pass that keeps failing is reported once, so an account whose
             * mail has stopped updating does not do so silently.
             */
            if (!changesReported) {
              changesReported = true;
              console.warn(
                `[gilbert] could not read mail changes: ${(err as Error).message}`,
              );
            }
          }
        }
      }
      // The list and the tree are next; an aborted pass leaves them to the
      // pass that follows the reconnection rather than firing requests now.
      if (signal?.aborted) return;
      void get().refreshList();
      void get().loadMailboxes();
    }
    if (signal?.aborted) return;
    if (types.has("Thread") || types.has("Email")) {
      const open = get().openThreadId;
      if (open)
        void get()
          .loadThread(open)
          .catch(() => undefined);
    }
    if (types.has("Identity")) {
      /*
       * Both lists are "on screen" in the ADR 0012 sense while Settings is
       * open: the account being browsed, and the reader's own, which is every
       * group block under it. A change to either is a change to what is shown.
       */
      const own = ownIdentityAccountId(useSession.getState().session);
      void get()
        .loadIdentitiesFor(accountId)
        .catch(() => undefined);
      if (own && own !== accountId)
        void get()
          .loadIdentitiesFor(own)
          .catch(() => undefined);
    }
    if (types.has("VacationResponse")) void get().loadVacation();
    if (types.has("Quota")) void get().loadQuota();
  },

  async applyAccountChanges(accountId, types, signal) {
    if (signal?.aborted) return;
    if (accountId === get().accountId) return get().applyChanges(types, signal);
    if (!get().mailAccounts.some((a) => a.accountId === accountId)) return;
    /*
     * A mailbox changed while the reader is elsewhere -- a group box under
     * their own, or their own while they are inside a group. Refresh its folder
     * tree so the sidebar's counts stay honest, and announce what it received
     * so a visible Gilbert is not the quiet one (ADR 0016).
     */
    void get().refreshAccountTree(accountId);
    // `notifyGroupMail` reads the message to announce; an aborted pass leaves
    // the announcement to the next one rather than fetching against nothing.
    if (signal?.aborted) return;
    if (types.has("Email")) await notifyGroupMail(accountId, get).catch(() => undefined);
  },

  async importEml(blobId, mailboxId, keywords = {}) {
    const accountId = get().accountId;
    if (!accountId) return null;
    const res = await client.call<{
      created?: Record<string, Email>;
      notCreated?: Record<string, { type: string; description?: string }>;
    }>("Email/import", {
      accountId,
      emails: { i: { blobId, mailboxIds: { [mailboxId]: true }, keywords } },
    });
    if (res.notCreated?.i) throw new Error(setErrorMessage(res.notCreated.i));
    void get().refreshList();
    void get().loadMailboxes();
    return res.created?.i?.id ?? null;
  },
}));

/**
 * The active account's From list, as `identities`.
 *
 * `identities` is one *view* of `identitiesByAccount`, and this is what makes
 * it one: the account on screen, narrowed where the account on screen is a
 * group mailbox. ADR 0007 gives a group's account one identity per member,
 * and a member sends as the identity the administration **assigned** them —
 * else as the group's own, which is what the agent sends as too, so nobody is
 * left without a sender and no member ever sends under another's name.
 * Everywhere but a group the view is the account's list, whole.
 *
 * Rebuilt from the cache rather than patched, so a stale entry -- an identity
 * destroyed in another client, a list that landed after the reader switched --
 * cannot survive in the view.
 */
function applyIdentities(accountId: Id): void {
  const state = useMail.getState();
  if (state.accountId !== accountId) return;
  const all = state.identitiesByAccount[accountId] ?? [];
  if (!isGroupMailboxAccount(accountId, state.mailAccounts)) {
    useMail.setState({ identities: all });
    return;
  }
  /*
   * The cascade lives once, in `@gilbert/shared/identityAssignment`, and is
   * imported rather than restated: the identity assigned to the reader, else
   * the group's own, matched by the address the session calls this account.
   *
   * An assignment that has not been read is no assignment — `held?.assignedId`
   * — so one call answers both before and after the read, and what stands in
   * while it is on its way is step 2 of the cascade: what the answer will be
   * for a member nothing is assigned to anyway. The alternative is an empty
   * From, which the composer reports as a group that holds no identity, a
   * claim that is false for as long as the read takes.
   */
  const held = state.assignmentByAccount[accountId];
  const sender = groupSenderIdentity(
    all,
    held?.assignedId,
    mailAccountAddress(state.mailAccounts, accountId),
  );
  useMail.setState({ identities: sender ? [sender] : [] });
}

/**
 * A cache entry moved: recompute what is on screen from it.
 *
 * Two entries can move the view -- the account being browsed, and the reader's
 * own list, which is what tells a group mailbox which of its identities is
 * theirs -- so a change to either recomputes the active view.
 */
function identitiesChanged(accountId: Id): void {
  applyIdentities(accountId);
  const active = useMail.getState().accountId;
  if (!active || active === accountId) return;
  if (accountId === ownIdentityAccountId(useSession.getState().session))
    applyIdentities(active);
}

/**
 * Sort properties a server has already refused, so it is asked once and not
 * once per folder for the rest of the session.
 *
 * Keyed by nothing: a refusal is about the server, and there is only one.
 */
let sortRefused = false;

/**
 * A failed folder-tree read already reported, until one lands.
 *
 * `loadMailboxes` is fired and forgotten from a dozen places, and a read that
 * keeps failing would otherwise report on every one of them.
 */
let mailboxesReadReported = false;

/**
 * A failed `Email/changes` pass already reported, until one lands.
 *
 * A transient failure is left to heal on the next pass; a persistent one is
 * said once rather than on every push beat.
 */
let changesReported = false;

/**
 * The current list window's generation.
 *
 * A full read (`refreshList`, or a fresh `query`) moves it, and so does any
 * change that takes rows off the screen -- `destroy`, or a `move` that removes
 * a row from the window (`moveToDestinations` reaches this through `move`): a
 * page that was already on its way drops its answer instead of appending over
 * the new window, and a list read computed before the change drops its answer
 * instead of putting the removed rows back on screen.
 */
let listEpoch = 0;

/** The discovery run already on its way, shared by every caller that joins it. */
let discoverInFlight: Promise<void> | null = null;

async function runQuery(accountId: Id, q: ListQuery, position: number, limit: number) {
  /*
   * `hasKeyword` is an optional sort in RFC 8621, and a server that will not
   * do it fails the whole query rather than degrading it -- so "unread first"
   * on such a server means a folder that does not open at all, which is a
   * worse outcome than one in the wrong order.
   *
   * The refusal is caught once, the optional levels dropped, and the query
   * retried. Nothing is said the first time: the reader asked for an order and
   * got the closest the server can give, and a toast on every folder change
   * would be the app complaining about its own request.
   */
  const query = sortRefused ? { ...q, sort: withoutOptionalSorts(q.sort) } : q;
  try {
    return await runQueryOnce(accountId, query, position, limit);
  } catch (err) {
    const optional = query.sort.some(isOptionalSort);
    if (!optional || !isUnsupportedSort(err)) throw err;
    sortRefused = true;
    return await runQueryOnce(
      accountId,
      { ...q, sort: withoutOptionalSorts(q.sort) },
      position,
      limit,
    );
  }
}

/** The error a server raises for a sort property it does not implement. */
function isUnsupportedSort(err: unknown): boolean {
  const type = (err as { type?: string } | null)?.type;
  const message = String((err as Error | null)?.message ?? "");
  return type === "unsupportedSort" || /unsupportedSort/i.test(message);
}

async function runQueryOnce(
  accountId: Id,
  q: ListQuery,
  position: number,
  limit: number,
) {
  /*
   * The window this answer belongs to, read when the request is issued. A
   * delete -- or a read that started later -- moves the generation while it is
   * on its way, and the ids this answer carries were computed before that
   * happened, so they are not written back (see `listEpoch`).
   */
  const epoch = listEpoch;
  const calls: Array<[string, Record<string, unknown>, string]> = [
    [
      "Email/query",
      {
        accountId,
        filter: q.filter,
        sort: q.sort,
        collapseThreads: q.collapseThreads,
        position,
        limit,
        calculateTotal: true,
      },
      "q",
    ],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: LIST_PROPS,
      },
      "e",
    ],
  ];
  if (q.collapseThreads) {
    calls.push([
      "Thread/get",
      {
        accountId,
        "#ids": { resultOf: "e", name: "Email/get", path: "/list/*/threadId" },
      },
      "t",
    ]);
    calls.push([
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
        properties: LIST_PROPS,
      },
      "te",
    ]);
  }
  const res = await client.chain(calls);
  const query = res.get("q")?.[0] as unknown as QueryResponse;
  const emailsRes = res.get("e")?.[0] as unknown as GetResponse<Email>;
  const threadsRes = res.get("t")?.[0] as unknown as GetResponse<Thread> | undefined;
  const threadEmails = res.get("te")?.[0] as unknown as GetResponse<Email> | undefined;
  const answer = {
    ids: query.ids,
    total: query.total ?? query.ids.length,
    queryState: query.queryState,
  };
  /*
   * A delete -- or a read that started later -- moved the generation while this
   * request was on its way, so the ids above were computed before it: the answer
   * is not written back (see `listEpoch`).
   */
  if (epoch !== listEpoch) return answer;
  useMail.setState((s) => {
    const emails = { ...s.emails };
    /*
     * `mergeEmail`, not a spread: a row is memoised on its message object, so a
     * re-read that changed nothing must hand back the object already held, or
     * every push, delete, move and folder open re-renders the whole list.
     */
    for (const e of emailsRes.list) emails[e.id] = mergeEmail(emails[e.id], e);
    for (const e of threadEmails?.list ?? []) emails[e.id] = mergeEmail(emails[e.id], e);
    const threads = { ...s.threads };
    for (const t of threadsRes?.list ?? []) threads[t.id] = t;
    /*
     * The window the caller is about to put on screen is what is kept, since
     * `s.list` is still the one being replaced: its ids are the rows, and the
     * conversation messages fetched beside them are what a collapsed row draws.
     */
    return {
      ...releaseHeld({ ...s, emails, threads }, [
        ...(query.ids ?? []),
        ...(threadEmails?.list ?? []).map((e) => e.id),
      ]),
      emailState: s.emailState ?? emailsRes.state,
    };
  });
  return answer;
}

/**
 * The delete rule's inputs, read at the moment an action is taken (ADR 0015).
 *
 * Read here rather than handed in because the store is where the action
 * happens and the account on screen is the store's own; the session is asked
 * for the copy it holds, which is ADR 0001's flag plus the question
 * `isOwnMailAccount` answers. Both move when the session state changes, which
 * the app re-reads on its own.
 */
function deleteContext(): DeleteContext {
  const session = useSession.getState().session;
  return {
    accountId: useMail.getState().accountId,
    session,
    isAdmin: sessionIsAdmin(session),
  };
}

/**
 * The store's account is its own. Group mailboxes open without moving the
 * session's selected account, which the other stores read to stay on the
 * reader's own data (settings, Sieve) -- the mistake a whole-app account
 * switcher makes. So this binds to the sign-in *state*, not to the session's
 * account id: a session refresh must not yank the reader out of a group
 * mailbox they are looking at.
 */
useSession.subscribe((s, prev) => {
  if (s.status === prev.status) return;
  const mail = useMail.getState();
  if (s.status !== "authenticated") {
    mail.setAccount(null);
    return;
  }
  const own = mailAccountCandidates(s.session).find((c) => c.kind === "own");
  mail.setAccount(own?.accountId ?? null);
  void mail.discoverMailAccounts();
});

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

    const state = useMail.getState();
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
      said.push(`${retargeted.changed} filter rule${plural(retargeted.changed)} updated`);
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
        error: (err as Error).message,
      }),
    );
  }
}

export { BODIES_KEPT, releaseBodies, resetBodyOrder } from "./bodies";
export { mailboxIcon, ROLE_ORDER, rememberedMailAccount } from "./folders";
export { DEFAULT_SORT } from "./list";
export { notifyGroupMail } from "./notify";
export type { ListQuery, ListState, MailState } from "./types";
export { BODY_PROPS, FULL_PROPS, LIST_PROPS, MAILBOX_PROPS } from "./types";
