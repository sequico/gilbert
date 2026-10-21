import { errorMessage } from "@gilbert/shared/errors";
import { ref } from "@gilbert/shared/jmapQuery";
import { chunk, client } from "@/jmap/client";
import type { Email, GetResponse, Id, QueryResponse, Thread } from "@/jmap/types";
import { t } from "@/lib/i18n";
import { isOptionalSort, withoutOptionalSorts } from "@/lib/listSort";
import { settings } from "../../settings";
import { releaseBodies, releaseHeld, touchBodies } from "../bodies";
import { currentEpoch, moveEpoch } from "../epoch";
import { listKey, mergeEmail } from "../list";
import type { MailGet, MailSet, MailState } from "../types";
import { BODY_PROPS, FULL_PROPS, LIST_PROPS, type ListQuery } from "../types";

/**
 * The message list: its window, its pages, and the bodies a row
 * needs.
 *
 * A slice of the mail store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function listingSlice(
  set: MailSet,
  get: MailGet,
): Pick<
  MailState,
  | "query"
  | "loadMore"
  | "refreshList"
  | "getEmails"
  | "loadThread"
  | "threadEmails"
  | "threadIdsIn"
> {
  /**
   * Sort properties a server has already refused, so it is asked once and not
   * once per folder for the rest of the session.
   *
   * Keyed by nothing: a refusal is about the server, and there is only one.
   */
  let sortRefused = false;

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
    const message = errorMessage(err);
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
     * happened, so they are not written back (see `currentEpoch()`).
     */
    const epoch = currentEpoch();
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
          "#ids": ref("q", "Email/query", "/ids"),
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
          "#ids": ref("e", "Email/get", "/list/*/threadId"),
        },
        "t",
      ]);
      calls.push([
        "Email/get",
        {
          accountId,
          "#ids": ref("t", "Thread/get", "/list/*/emailIds"),
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
     * is not written back (see `currentEpoch()`).
     */
    if (epoch !== currentEpoch()) return answer;
    set((s) => {
      const emails = { ...s.emails };
      /*
       * `mergeEmail`, not a spread: a row is memoised on its message object, so a
       * re-read that changed nothing must hand back the object already held, or
       * every push, delete, move and folder open re-renders the whole list.
       */
      for (const e of emailsRes.list) emails[e.id] = mergeEmail(emails[e.id], e);
      for (const e of threadEmails?.list ?? [])
        emails[e.id] = mergeEmail(emails[e.id], e);
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

  return {
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
      moveEpoch();
      const epoch = currentEpoch();
      set({
        list: {
          ...q,
          key,
          ids: reuse ? cur.ids : [],
          /*
           * What the rows showed until this read: drawn by the list while the
           * answer is in flight (`MessageList`), so a folder switch never
           * empties the pane. Actions cannot reach it — the selection is
           * cleared below and the rows are made inert while the window is
           * being replaced.
           */
          previousIds: reuse ? [] : (cur?.ids ?? []),
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
        if (epoch !== currentEpoch()) {
          set((s) => ({
            list: s.list ? { ...s.list, loading: false } : s.list,
          }));
          void get().refreshList();
          return;
        }
        set((s) => {
          if (!s.list) return {};
          /*
           * The answer replaces the window. The rows the query carried are on
           * screen no longer, so the messages behind them are let go with them:
           * the carried window is a place to look while waiting, never a second
           * list kept afterwards.
           */
          const list = {
            ...s.list,
            ids,
            previousIds: [],
            total,
            queryState,
            loading: false,
            exhausted: ids.length >= total,
          };
          return { ...releaseHeld({ ...s, list }, ids), list };
        });
      } catch (err) {
        if (get().list?.key !== key) return;
        set((s) => ({
          list: s.list ? { ...s.list, loading: false, error: errorMessage(err) } : s.list,
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
      const epoch = currentEpoch();
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
        if (epoch !== currentEpoch()) {
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
          set({ list: { ...cur, loadingMore: false, error: errorMessage(err) } });
      }
    },

    async refreshList() {
      const accountId = get().accountId;
      const l = get().list;
      if (!accountId || !l) return;
      // A full read supersedes any page still on its way: the generation moves so
      // that page drops its answer instead of appending over this one.
      moveEpoch();
      const epoch = currentEpoch();
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
        if (epoch !== currentEpoch()) return;
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
              "#ids": ref("t", "Thread/get", "/list/*/emailIds"),
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
  };
}
