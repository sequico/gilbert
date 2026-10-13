/**
 * The workorder panel's store (ADR 0028).
 *
 * The surface is route-only: the store holds the summaries the route served
 * and every mutation asks the route and replaces the summary it answered with.
 * There is no direct FileNode read and no push **payload**: a change on the
 * FileNode rail says which account moved and nothing else, so the answer to one
 * is a read through the route — which is also what keeps visibility the route's
 * decision, since the store never composes a document itself. `load()` is that
 * read: an open and a FileNode change on an account this surface follows both
 * re-read, and the launcher exposes it for a manual refresh besides. The Master
 * is the only writer, so a failed mutation leaves the last state served in place
 * — it degrades to read-only rather than writing locally, and the panel shows the
 * error until the next attempt.
 *
 * The open workorder is the uid the panel shows, and its summary is derived
 * from the list (`openWorkorder`), so a mutation that replaces a summary is
 * enough to refresh both the list and the open panel.
 */

import { create } from "zustand";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import {
  checkWorkorderStep,
  closeWorkorder,
  createWorkorder,
  editWorkorderRefs,
  listWorkorders,
  type WorkorderCreateInput,
  type WorkorderRef,
  type WorkorderScope,
  type WorkorderState,
  type WorkorderStepState,
  type WorkorderSummary,
} from "@/lib/workorder";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";

export interface WorkorderStore {
  workorders: WorkorderSummary[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The open workorder's uid, or null when the panel shows the list. */
  openUid: string | null;
  /** Whether the launcher's panel is open. */
  panelOpen: boolean;
  openPanel(): void;
  closePanel(): void;
  load(): Promise<void>;
  /**
   * A FileNode change arrived for one account (the push rail's own frame, which
   * names the account and never the document): re-read when it is an account
   * this surface follows, so a check somebody else made appears.
   */
  applyChanges(accountId: string): Promise<void>;
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
  /** A refresh asked for while one is running, run again when it ends. */
  let pendingReload = false;
  /*
   * Bumped when the store is emptied, so a read that started under the session
   * that has since signed out drops its answer instead of repopulating the store
   * behind the sign-out. The rail makes a read arrive more often, which is why
   * the guard is here rather than left to how rarely a read used to be asked for.
   */
  let loadEpoch = 0;

  /** Put a summary the route echoed back into the list, replacing by uid. */
  function put(summary: WorkorderSummary): void {
    mutatedAt.set(summary.uid, (mutationSeq += 1));
    set((s) => {
      const at = s.workorders.findIndex((w) => w.uid === summary.uid);
      if (at < 0) return { workorders: [...s.workorders, summary] };
      const workorders = s.workorders.slice();
      workorders[at] = summary;
      return { workorders };
    });
  }

  return {
    workorders: [],
    loaded: false,
    loading: false,
    error: null,
    openUid: null,
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
      let listed: WorkorderSummary[];
      try {
        listed = await listWorkorders();
      } catch (err) {
        // A read that started under the session that has since signed out
        // belongs to nobody: the store is already empty and stays so.
        if (epoch !== loadEpoch) return;
        // A failed read leaves the last list in place, or none; the panel shows
        // the error and the next open or refresh retries.
        set({ error: (err as Error).message, loading: false });
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
     * an account this surface follows: the reader's own group mailboxes, and
     * the accounts of the parts already held (which covers the window before the
     * mail probe has listed the groups).
     */
    async applyChanges(accountId) {
      if (!accountId || !get().panelOpen) return;
      const held = get().workorders.some((w) =>
        w.parts.some((part) => part.accountId === accountId),
      );
      const mine = groupMailboxAccounts(useMail.getState().mailAccounts).some(
        (group) => group.accountId === accountId,
      );
      if (!held && !mine) return;
      await get().load();
    },

    show(uid) {
      set({ openUid: uid });
    },

    async create(input) {
      try {
        put(await createWorkorder(input));
        return true;
      } catch (err) {
        set({ error: (err as Error).message });
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
        set({ error: (err as Error).message });
        return false;
      }
    },

    async close(uid, state) {
      try {
        put(await closeWorkorder(uid, state));
        return true;
      } catch (err) {
        set({ error: (err as Error).message });
        return false;
      }
    },

    async addRef(uid, ref) {
      try {
        put(await editWorkorderRefs(uid, { add: ref }));
        return true;
      } catch (err) {
        set({ error: (err as Error).message });
        return false;
      }
    },

    async removeRef(uid, ref) {
      try {
        put(await editWorkorderRefs(uid, { remove: ref }));
        return true;
      } catch (err) {
        set({ error: (err as Error).message });
        return false;
      }
    },

    reset() {
      mutatedAt.clear();
      pendingReload = false;
      loadEpoch += 1;
      set({
        workorders: [],
        loaded: false,
        loading: false,
        error: null,
        openUid: null,
        panelOpen: false,
      });
    },
  };
});

/** The open workorder's summary, or null when the panel shows the list. */
export function openWorkorder(s: WorkorderStore): WorkorderSummary | null {
  return s.workorders.find((w) => w.uid === s.openUid) ?? null;
}

// Signing out empties the store: every summary was read through the signed-in
// session's own group membership, so nothing here survives the session.
useSession.subscribe((s, prev) => {
  if (s.status !== prev.status && s.status !== "authenticated")
    useWorkorders.getState().reset();
});
