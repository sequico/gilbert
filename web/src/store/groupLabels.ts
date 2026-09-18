import { isRecord } from "@gilbert/shared/json";
import { GROUP_LABELS_FILE, isLabelCatalogEntry } from "@gilbert/shared/labels";
import { JSON_MIME } from "@/lib/mime";
import { create } from "zustand";
import { client } from "@/jmap/client";
import { push } from "@/jmap/push";
import type { Id } from "@/jmap/types";
import { ensureFolder, findInFolder } from "@/lib/appFolder";
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

/** Coalesce the FileNode changes of one burst (a chat message floods the same rail) into one read. */
const RELOAD_DEBOUNCE_MS = 400;

interface GroupLabelsState {
  /** label list per group account, as loaded from its `labels.json`. */
  byAccount: Record<Id, Label[]>;
  loading: Record<Id, boolean>;
  load: (accountId: Id) => Promise<void>;
  reset: () => void;
}

export const useGroupLabels = create<GroupLabelsState>((set, get) => ({
  byAccount: {},
  loading: {},
  load: async (accountId) => {
    // Reading a catalog reaches `ensureFolder`, which creates the `gilbert`
    // app folder in whatever account it is handed, so the account has to be a
    // group mailbox and not merely somebody else's: one classifier, the mail
    // store's probe (`isGroupMailboxAccount`).
    if (!isGroupMailboxAccount(accountId, useMail.getState().mailAccounts)) return;
    if (get().loading[accountId]) return;
    set((s) => ({ loading: { ...s.loading, [accountId]: true } }));
    const labels = await readGroupLabels(accountId);
    set((s) => ({
      loading: { ...s.loading, [accountId]: false },
      // An unreadable file keeps whatever is cached (or nothing) rather than wiping it.
      byAccount: labels === null ? s.byAccount : { ...s.byAccount, [accountId]: labels },
    }));
    // The sidebar's counts come from the mail store, and a catalog that lands
    // after the account tree — or is edited by an administrator — changes them.
    // The recount belongs to the one place that writes `byAccount`, so the two
    // stores do not need to observe each other.
    if (labels !== null && accountId === useMail.getState().accountId)
      void useMail.getState().loadLabelCounts();
  },
  reset: () => set({ byAccount: {}, loading: {} }),
}));

/** Whether a catalog entry is usable: one validator, shared with the server tier. */
function validLabel(x: unknown): x is Label {
  return isLabelCatalogEntry(x);
}
async function readGroupLabels(accountId: Id): Promise<Label[] | null> {
  try {
    const folderId = await ensureFolder(accountId);
    const node = await findInFolder(accountId, folderId, GROUP_LABELS_FILE);
    if (!node?.blobId) return null;
    const text = await client.fetchBlobText(accountId, node.blobId, JSON_MIME);
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    const list = parsed.labels;
    return Array.isArray(list) ? list.filter(validLabel) : null;
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

const reloadTimers: Record<Id, number> = {};

// A group's catalog is a FileNode. When an admin edits it, the push rail
// reports a FileNode StateChange for that account; re-read it so every member
// sees the change live. A StateChange carries only account+type (not which
// node changed), and chat messages ride the same rail, so the re-read is
// debounced per account.
push.subscribe((accountId, type) => {
  if (type !== "FileNode") return;
  if (!(accountId in useGroupLabels.getState().byAccount)) return;
  if (reloadTimers[accountId]) clearTimeout(reloadTimers[accountId]);
  reloadTimers[accountId] = window.setTimeout(() => {
    delete reloadTimers[accountId];
    void useGroupLabels.getState().load(accountId);
  }, RELOAD_DEBOUNCE_MS);
});

// Push replays nothing to a tab that was away, so a catalog already loaded is
// re-read when the connection comes back. The debounce above is for a burst
// of live events; this is one pass, and only for the accounts already loaded.
push.onReconnect(() => {
  for (const accountId of Object.keys(useGroupLabels.getState().byAccount))
    void useGroupLabels.getState().load(accountId);
});
