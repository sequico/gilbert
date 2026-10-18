import { client } from "@/jmap/client";
import type { Id, QueryResponse } from "@/jmap/types";
import { t } from "@/lib/i18n";
import { toast } from "@/ui/toast";
import type { MailGet, MailSet, MailState } from "../types";

/**
 * Which rows are selected, and what "all of them" means.
 *
 * A slice of the mail store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function selectionSlice(
  set: MailSet,
  get: MailGet,
): Pick<
  MailState,
  | "select"
  | "clearSelection"
  | "selectAll"
  | "selectAllMatching"
  | "queryAllIds"
  | "setAnchor"
> {
  return {
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
  };
}
