import { APP_DOCUMENT_TYPE } from "@gilbert/shared/appFolder";
import { GROUP_LABELS_FILE, isLabelCatalog } from "@gilbert/shared/labels";
import { create } from "zustand";
import { client } from "@/jmap/client";
import { push } from "@/jmap/push";
import type { Id } from "@/jmap/types";
import { ensureFolder, findInFolder } from "@/lib/appFolder";
import { debouncedReload } from "@/lib/fileNodeReload";
import { isGroupMailboxAccount } from "@/lib/mailAccounts";
import type { Label } from "@/store/settings";
import { useMail } from "./mail";

/**
 * Group-owned label catalogs (ADR 0005, "group label catalog").
 *
 * A group mailbox is the group's own account; the labels that name its
 * messages belong to the group, not to any member. They live in a
 * `labels.json` in the group account's own app folder, beside the
 * chat documents — membership is the grant, no `shareWith`, no ACL.
 *
 * The keyword is the stable identity that rides on the messages; the name,
 * colour and nesting here are display only. Renaming a label therefore
 * changes nothing on any message.
 */

interface GroupLabelsState {
  /** label list per group account, as loaded from its `labels.json`. */
  byAccount: Record<Id, Label[]>;
  loading: Record<Id, boolean>;
  load: (accountId: Id) => Promise<void>;
  reset: () => void;
}

/** A read asked for while one was in flight, re-run when that one lands. */
const pendingLoads = new Set<Id>();

export const useGroupLabels = create<GroupLabelsState>((set, get) => ({
  byAccount: {},
  loading: {},
  load: async (accountId) => {
    // Reading a catalog reaches `ensureFolder`, which creates the `gilbert`
    // app folder in whatever account it is handed, so the account has to be a
    // group mailbox and not merely somebody else's: one classifier, the mail
    // store's probe (`isGroupMailboxAccount`).
    if (!isGroupMailboxAccount(accountId, useMail.getState().mailAccounts)) return;
    if (get().loading[accountId]) {
      // A push while a read is in flight is a newer catalog: re-read when this
      // one lands rather than dropping the change until the next event.
      pendingLoads.add(accountId);
      return;
    }
    set((s) => ({ loading: { ...s.loading, [accountId]: true } }));
    try {
      const labels = await readGroupLabels(accountId);
      set((s) => ({
        // An unreadable file keeps whatever is cached (or nothing) rather than wiping it.
        byAccount:
          labels === null ? s.byAccount : { ...s.byAccount, [accountId]: labels },
      }));
      // The sidebar's counts come from the mail store, and a catalog that lands
      // after the account tree — or is edited by an administrator — changes them.
      // The recount belongs to the one place that writes `byAccount`, so the two
      // stores do not need to observe each other.
      if (labels !== null && accountId === useMail.getState().accountId)
        void useMail.getState().loadLabelCounts();
    } finally {
      set((s) => ({ loading: { ...s.loading, [accountId]: false } }));
      if (pendingLoads.delete(accountId)) void get().load(accountId);
    }
  },
  reset: () => set({ byAccount: {}, loading: {} }),
}));

/**
 * A group's label catalog, read once for this tier.
 *
 * Validated as the document it is, through the same shared validator the server
 * reads through (`isLabelCatalog`), rather than entry by entry: a catalog with
 * one entry the two tiers disagree about is a catalog neither of them has, and
 * rendering the entries this side happens to like is how the surface and the
 * keyword guard come to see different labels.
 */
async function readGroupLabels(accountId: Id): Promise<Label[] | null> {
  try {
    const folderId = await ensureFolder(accountId);
    const node = await findInFolder(accountId, folderId, GROUP_LABELS_FILE);
    if (!node?.blobId) return null;
    const text = await client.fetchBlobText(accountId, node.blobId, APP_DOCUMENT_TYPE);
    const parsed: unknown = JSON.parse(text);
    return isLabelCatalog(parsed) ? parsed.labels : null;
  } catch {
    // A catalog we cannot read must not cost anyone their mail view.
    return null;
  }
}

/**
 * The labels for an account as the mail UI must see them: a group mailbox's
 * own catalog, or the reader's personal labels for their own mailbox.
 *
 * The question goes to the one classifier rather than to a local "is this
 * account not mine": that wider test counts a calendar or files share as a
 * group, so this answer and the one the surfaces render -- `useEffectiveLabels`
 * -- could differ.
 */
export function labelsForAccount(accountId: Id | null, personal: Label[]): Label[] {
  if (!accountId || !isGroupMailboxAccount(accountId, useMail.getState().mailAccounts))
    return personal;
  return useGroupLabels.getState().byAccount[accountId] ?? [];
}

const reloads = debouncedReload();

// A group's catalog is a FileNode. When an admin edits it, the push rail
// reports a FileNode StateChange for that account; re-read it so every member
// sees the change live. A StateChange carries only account+type (not which
// node changed), and chat messages ride the same rail, so the re-read goes
// through the one per-key debounce (`lib/fileNodeReload`).
push.subscribe((accountId, type) => {
  if (type !== "FileNode") return;
  if (!(accountId in useGroupLabels.getState().byAccount)) return;
  reloads.schedule(accountId, () => {
    void useGroupLabels.getState().load(accountId);
  });
});

// Push replays nothing to a tab that was away, so a catalog already loaded is
// re-read when the connection comes back. The debounce above is for a burst
// of live events; this is one pass, and only for the accounts already loaded.
push.onReconnect(() => {
  for (const accountId of Object.keys(useGroupLabels.getState().byAccount))
    void useGroupLabels.getState().load(accountId);
});
