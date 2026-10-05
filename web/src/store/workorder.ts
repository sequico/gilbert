/**
 * The workorder panel's store (ADR 0028).
 *
 * The surface is route-only: the store holds the summaries the route served
 * and every mutation asks the route and replaces the summary it answered with.
 * There is no direct FileNode read and no push rail, so `load()` is the one
 * read and the launcher exposes it for a manual refresh. The Master is the only
 * writer, so a failed mutation leaves the last state served in place — it
 * degrades to read-only rather than writing locally, and the panel shows the
 * error until the next attempt.
 *
 * The open workorder is the uid the panel shows, and its summary is derived
 * from the list (`openWorkorder`), so a mutation that replaces a summary is
 * enough to refresh both the list and the open panel.
 */

import { create } from "zustand";
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
  /** Put a summary the route echoed back into the list, replacing by uid. */
  function put(summary: WorkorderSummary): void {
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
      // Load once: the first open fetches the list, and every later open reuses
      // what is held. `load()` is exposed for a manual refresh.
      if (!get().loaded) void get().load();
    },

    closePanel() {
      set({ panelOpen: false });
    },

    async load() {
      if (get().loading) return;
      set({ loading: true, error: null });
      try {
        const workorders = await listWorkorders();
        set({ workorders, loaded: true, loading: false });
      } catch (err) {
        // A failed read leaves the last list in place, or none; the panel shows
        // the error and the next open or refresh retries.
        set({ error: (err as Error).message, loading: false });
      }
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
