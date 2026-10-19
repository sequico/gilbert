/**
 * The workorder panel's store (ADR 0028).
 *
 * The surface is route-only: the store holds the list the route served and
 * every mutation asks the route and writes its answer back. There is no direct
 * FileNode read and no push **payload**: a change on the
 * FileNode rail says which account moved and nothing else, so the answer to one
 * is a read through the route — which is also what keeps visibility the route's
 * decision, since the store never composes a document itself. `load()` is that
 * read: an open performs it at once, a FileNode change on an account this
 * surface follows — a group whose part it holds, or the installation's own
 * account, where the global checklist and the registry live — opens a short
 * window that collapses a burst into one read when it closes, and the launcher
 * exposes it for a manual refresh besides. The
 * Master is the only writer, so a failed mutation leaves the last state served
 * in place — it degrades to read-only rather than writing locally, and the panel
 * shows the error until the next attempt.
 *
 * The list holds a card per workorder — its name, its state and each part's
 * progress (`WorkorderListEntry`) — and opening one reads it in full by uid
 * (`show` → `loadDetail`). A mutation's answer therefore refreshes the card it
 * replaces, and the open panel when it is the one on screen.
 */

import { errorMessage } from "@gilbert/shared/errors";
import { create } from "zustand";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import {
  checkWorkorderStep,
  closeWorkorder,
  createWorkorder,
  editWorkorderRefs,
  listEntryOf,
  listWorkorders,
  readWorkorder as fetchWorkorder,
  replaceWorkorder,
  type WorkorderCreateInput,
  type WorkorderListEntry,
  type WorkorderRef,
  type WorkorderScope,
  type WorkorderState,
  type WorkorderStepState,
  type WorkorderSummary,
} from "@/lib/workorder";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";

/**
 * How long a burst of FileNode changes is collapsed over before the one read it
 * causes. Long enough to swallow a busy group's chat and knowledge storm, short
 * enough that a person watching the panel does not see a check sit stale.
 */
export const WORKORDER_CHANGE_WINDOW_MS = 1500;

/**
 * The installation's own account, as the session states it.
 *
 * The global checklist and the registry live there — the Master's own account,
 * which a member's session holds as none of its accounts — so the id is a fact
 * the server puts on the session for exactly this: a change on the FileNode
 * rail names only the account, and recognising the installation's own is what
 * turns the frame into the read. Read structurally, and `null` when the session
 * does not carry it: a session that predates the fact follows no installation
 * account rather than guessing one.
 */
function installationAccountId(): string | null {
  return useSession.getState().session?.gilbert?.installationAccount ?? null;
}

interface WorkorderStore {
  /** The list's page: a card's fields, never a checklist (see `WorkorderListEntry`). */
  workorders: WorkorderListEntry[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The open workorder's uid, or null when the panel shows the list. */
  openUid: string | null;
  /** The open workorder in full, read when it is opened. */
  detail: WorkorderSummary | null;
  detailLoading: boolean;
  /** Whether the launcher's panel is open. */
  panelOpen: boolean;
  openPanel(): void;
  closePanel(): void;
  load(): Promise<void>;
  /**
   * A FileNode change arrived for one account (the push rail's own frame, which
   * names the account and never the document): open the coalescing window when
   * it is an account this surface follows, so a check somebody else made
   * appears in the one read the window's close performs.
   *
   * It **arms** that window and returns: it answers no promise, because there is
   * no read to await — the read happens when the window closes. A caller that
   * awaits it as if the panel were fresh is awaiting nothing of the sort, which
   * is why the shape says so.
   */
  applyChanges(accountId: string): void;
  show(uid: string | null): void;
  create(input: WorkorderCreateInput): Promise<boolean>;
  /** Set one step's state, and the reason a skipped / not-applicable one carries. */
  check(
    uid: string,
    scope: WorkorderScope,
    group: string | null,
    path: string,
    state: WorkorderStepState,
    note?: string,
  ): Promise<boolean>;
  close(uid: string, state: WorkorderState): Promise<boolean>;
  /**
   * Replace a workorder with the successor the input describes, and open it.
   *
   * The successor is what the surface shows afterwards: the reader asked for the
   * work to continue as a new workorder, and landing back on the one that was
   * just retired would read as nothing having happened.
   */
  replace(uid: string, input: WorkorderCreateInput): Promise<boolean>;
  addRef(uid: string, ref: WorkorderRef): Promise<boolean>;
  removeRef(uid: string, ref: WorkorderRef): Promise<boolean>;
  reset(): void;
}

export const useWorkorders = create<WorkorderStore>((set, get) => {
  /*
   * How new the local list is, per workorder. A read that began before a
   * mutation the route has since accepted answers with the older value for
   * that uid, so the merge below keeps the local summary for anything mutated
   * after the read started.
   */
  let mutationSeq = 0;
  const mutatedAt = new Map<string, number>();
  /*
   * Names the detail read in progress. Opening another workorder takes the
   * next number, so an answer from the one before is discarded rather than
   * shown over the one the reader is actually on.
   */
  let detailToken = 0;
  /** A refresh asked for while one is running, run again when it ends. */
  let pendingReload = false;
  /**
   * The coalescing window a FileNode change opens, and its timer. A panel a
   * person is reading wants to be current to the eye, not to the message: the
   * rail carries every change of an account, and a group's chat, knowledge base
   * and settings writes ride it beside the workorder parts, so answering each
   * one with a full recomposition re-reads the whole registry once per message.
   * The window opens on the first change of a burst rather than being pushed
   * back by every later one — a group that stays busy would otherwise defer the
   * read forever — so the panel is at most one window behind the rail.
   */
  let changeWindow: ReturnType<typeof setTimeout> | undefined;
  /*
   * Bumped when the store is emptied, so a read that started under the session
   * that has since signed out drops its answer instead of repopulating the store
   * behind the sign-out. The rail makes a read arrive more often, which is why
   * the guard is here rather than left to how rarely a read used to be asked for.
   */
  let loadEpoch = 0;

  /**
   * Put a summary the route echoed back into the list, replacing by uid.
   *
   * A write answers with the whole workorder, so the card beside it is
   * refreshed from the same answer (`listEntryOf`), and the detail pane when it
   * is the one on screen.
   */
  function put(summary: WorkorderSummary): void {
    mutatedAt.set(summary.uid, (mutationSeq += 1));
    const entry = listEntryOf(summary);
    set((s) => {
      const at = s.workorders.findIndex((w) => w.uid === summary.uid);
      const workorders = s.workorders.slice();
      if (at < 0) workorders.push(entry);
      else workorders[at] = entry;
      return {
        workorders,
        ...(s.openUid === summary.uid ? { detail: summary, detailLoading: false } : {}),
      };
    });
  }

  /**
   * The open workorder's checklist, read when it is opened.
   *
   * The list carries what a card shows, so the steps and items are asked for
   * by uid — one read per open, not one per row.
   */
  async function loadDetail(uid: string): Promise<void> {
    const token = ++detailToken;
    set({ detailLoading: true });
    try {
      const detail = await fetchWorkorder(uid);
      if (token !== detailToken) return;
      if (!detail) {
        set({ detail: null, detailLoading: false, openUid: null });
        return;
      }
      set({ detail, detailLoading: false });
    } catch (err) {
      if (token !== detailToken) return;
      set({ error: errorMessage(err), detailLoading: false });
    }
  }

  return {
    workorders: [],
    loaded: false,
    loading: false,
    error: null,
    openUid: null,
    detail: null,
    detailLoading: false,
    panelOpen: false,

    openPanel() {
      set({ panelOpen: true });
      /*
       * Every open re-reads. The rail is followed only while the panel is open,
       * so a check another reader made, or a workorder an administrator created,
       * while it was put away is picked up here — and the open is also the first
       * look that has a list to compare a later change against. A read already in
       * flight is the fresh answer this open wanted, so it is not restarted on top
       * of itself.
       */
      if (!get().loading) void get().load();
    },

    closePanel() {
      set({ panelOpen: false });
    },

    async load() {
      if (get().loading) {
        // A refresh asked for mid-load is not dropped: it runs again once this
        // one ends, so the manual refresh always lands a fresh read.
        pendingReload = true;
        return;
      }
      const epoch = loadEpoch;
      set({ loading: true, error: null });
      const startedAt = mutationSeq;
      let listed: WorkorderListEntry[];
      try {
        listed = await listWorkorders();
      } catch (err) {
        // A read that started under the session that has since signed out
        // belongs to nobody: the store is already empty and stays so.
        if (epoch !== loadEpoch) return;
        // A failed read leaves the last list in place, or none; the panel shows
        // the error and the next open or refresh retries.
        set({ error: errorMessage(err), loading: false });
        if (pendingReload) {
          pendingReload = false;
          void get().load();
        }
        return;
      }
      if (epoch !== loadEpoch) return;
      set((s) => {
        /*
         * The read began before any mutation with a later sequence, and a
         * mutation's answer is the route's own — newer for that uid than a read
         * that started before it. Those uids keep the local summary, and one the
         * route accepted after the read started and the read does not list at
         * all is kept rather than dropped.
         */
        const workorders = listed.map((w) =>
          (mutatedAt.get(w.uid) ?? 0) > startedAt
            ? (s.workorders.find((x) => x.uid === w.uid) ?? w)
            : w,
        );
        for (const w of s.workorders)
          if (
            (mutatedAt.get(w.uid) ?? 0) > startedAt &&
            !workorders.some((x) => x.uid === w.uid)
          )
            workorders.push(w);
        return { workorders, loaded: true, loading: false };
      });
      if (pendingReload) {
        pendingReload = false;
        void get().load();
      }
    },

    /**
     * A change on the FileNode rail (ADR 0028): a workorder's parts are app
     * folder documents in the reader's own groups, and a check somebody else
     * made is a write there and nothing more — the rail carries no payload to
     * apply, so the answer is the route's read, which is also what re-decides
     * what this reader may see.
     *
     * It answers only while the panel is open — nobody is looking otherwise,
     * and a group's chat and knowledge base ride the same rail — and only for
     * an account this surface follows: the reader's own group mailboxes, the
     * accounts of the parts already held (which covers the window before the
     * mail probe has listed the groups), and the installation's own account,
     * where the global checklist and the registry live and no member's session
     * reaches as an account.
     *
     * What it follows, it does not read on the spot: the first change of a burst
     * opens `WORKORDER_CHANGE_WINDOW_MS`, later ones ride it, and its close is
     * the one read. The list is complete rather than the changed workorders'
     * parts, so a workorder an administrator created in a followed account in
     * between appears too.
     */
    applyChanges(accountId) {
      if (!accountId || !get().panelOpen) return;
      const held = get().workorders.some((w) =>
        w.parts.some((part) => part.accountId === accountId),
      );
      const mine = groupMailboxAccounts(useMail.getState().mailAccounts).some(
        (group) => group.accountId === accountId,
      );
      if (!held && !mine && accountId !== installationAccountId()) return;
      if (changeWindow !== undefined) return;
      changeWindow = setTimeout(() => {
        changeWindow = undefined;
        // The panel may have been put away while the window was open, and nobody
        // is looking then; the next open re-reads anyway.
        if (!get().panelOpen) return;
        // A read already in flight is not dropped: `load()` folds this one into
        // `pendingReload`, so a change that lands mid-read still ends fresh.
        void get().load();
      }, WORKORDER_CHANGE_WINDOW_MS);
    },

    show(uid) {
      if (!uid) {
        detailToken += 1;
        set({ openUid: null, detail: null, detailLoading: false });
        return;
      }
      set({ openUid: uid });
      // The detail already held for this uid is the answer this open wanted.
      if (get().detail?.uid === uid) return;
      set({ detail: null });
      void loadDetail(uid);
    },

    async create(input) {
      try {
        put(await createWorkorder(input));
        return true;
      } catch (err) {
        set({ error: errorMessage(err) });
        return false;
      }
    },

    async check(uid, scope, group, path, state, note) {
      try {
        put(
          await checkWorkorderStep({
            uid,
            scope,
            ...(group ? { group } : {}),
            path,
            state,
            ...(note !== undefined ? { note } : {}),
          }),
        );
        return true;
      } catch (err) {
        set({ error: errorMessage(err) });
        return false;
      }
    },

    async close(uid, state) {
      try {
        put(await closeWorkorder(uid, state));
        return true;
      } catch (err) {
        set({ error: errorMessage(err) });
        return false;
      }
    },

    async replace(uid, input) {
      try {
        const successor = await replaceWorkorder(uid, input);
        /*
         * Both documents moved, so the whole list is re-read rather than the one
         * summary put back: the predecessor is now `replaced` and carries who
         * succeeded it, and a list that still showed it running would be a
         * surface disagreeing with the record.
         */
        put(successor);
        await get().load();
        get().show(successor.uid);
        return true;
      } catch (err) {
        set({ error: errorMessage(err) });
        return false;
      }
    },

    async addRef(uid, ref) {
      try {
        put(await editWorkorderRefs(uid, { add: ref }));
        return true;
      } catch (err) {
        set({ error: errorMessage(err) });
        return false;
      }
    },

    async removeRef(uid, ref) {
      try {
        put(await editWorkorderRefs(uid, { remove: ref }));
        return true;
      } catch (err) {
        set({ error: errorMessage(err) });
        return false;
      }
    },

    reset() {
      mutatedAt.clear();
      pendingReload = false;
      if (changeWindow !== undefined) {
        clearTimeout(changeWindow);
        changeWindow = undefined;
      }
      loadEpoch += 1;
      detailToken += 1;
      set({
        workorders: [],
        loaded: false,
        loading: false,
        error: null,
        openUid: null,
        detail: null,
        detailLoading: false,
        panelOpen: false,
      });
    },
  };
});

/** The open workorder in full, or null while the list is what shows. */
export function openWorkorder(s: WorkorderStore): WorkorderSummary | null {
  return s.detail && s.detail.uid === s.openUid ? s.detail : null;
}

// Signing out empties the store: every summary was read through the signed-in
// session's own group membership, so nothing here survives the session.
useSession.subscribe((s, prev) => {
  if (s.status !== prev.status && s.status !== "authenticated")
    useWorkorders.getState().reset();
});
