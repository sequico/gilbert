/**
 * Which folder tree the Settings -> Folders surface is about.
 *
 * That surface edits the reader's own account. The store's `mailboxes` is the
 * ACTIVE account's tree, so while a group mailbox is open it holds the group's
 * folders -- listing them here would offer the reader edits that land on the
 * group account. The per-account cache `accountTrees` holds every account's
 * tree, written through by `loadMailboxes`, so the reader's own folders are
 * there whatever account the sidebar shows. Group folders stay in the mail
 * sidebar, which is a different surface.
 */
import type { Id, Mailbox } from "@/jmap/types";

/**
 * One empty tree for every miss, so a store selector built on this function
 * hands back a referentially stable snapshot instead of a fresh object on each
 * read (which would re-render forever).
 */
const EMPTY: Record<Id, Mailbox> = {};

/** The folder tree the folders settings surface lists and edits. */
export function settingsMailboxTree(args: {
  accountTrees: Record<Id, Record<Id, Mailbox>>;
  ownAccountId: Id | null;
  accountId: Id | null;
  mailboxes: Record<Id, Mailbox>;
}): Record<Id, Mailbox> {
  const { accountTrees, ownAccountId, accountId, mailboxes } = args;
  if (ownAccountId) return accountTrees[ownAccountId] ?? EMPTY;
  // No own account id yet, so there is no cache entry to read: the active tree
  // counts only when the active account is the reader's own account. Another
  // account's tree never reaches this surface.
  return accountId === ownAccountId ? mailboxes : EMPTY;
}
