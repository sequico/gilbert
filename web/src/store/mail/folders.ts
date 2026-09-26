import type { Id, MailboxRole } from "@/jmap/types";
import { loadPlace, placeOwnerFrom } from "@/lib/lastPlace";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import type { FolderRef } from "@/lib/sieveFolders";
import { useSession } from "../session";
import type { MailState } from "./types";

/**
 * The mail account to open at boot: the one this device was last on, when it
 * is still one of the reader's.
 *
 * Asked after discovery rather than at sign-in, because a remembered group
 * mailbox has nothing to be compared against until the probe has named the
 * accounts that exist.
 */
export function rememberedMailAccount(
  accounts: readonly MailAccountInfo[],
): string | null {
  const remembered = loadPlace(placeOwnerFrom(useSession.getState())).mailAccountId;
  return remembered && accounts.some((a) => a.accountId === remembered)
    ? remembered
    : null;
}

export function mailboxIcon(role: MailboxRole): string {
  switch (role) {
    case "inbox":
      return "inbox";
    case "drafts":
      return "file";
    case "sent":
      return "send";
    case "trash":
      return "trash";
    case "junk":
      return "alert";
    case "archive":
      return "archive";
    case "all":
      return "mail";
    case "flagged":
      return "star";
    case "important":
      return "tag";
    default:
      return "folder";
  }
}

export const ROLE_ORDER: Record<string, number> = {
  inbox: 0,
  flagged: 1,
  important: 2,
  drafts: 3,
  sent: 4,
  archive: 5,
  all: 6,
  junk: 7,
  trash: 8,
};

/**
 * Resolve `parentId/segments...` to a mailbox id, creating what is missing.
 *
 * Reuses a folder that is already there rather than making a second one beside
 * it, so archiving by month twice in the same month files into the same place
 * -- including a folder somebody made by hand, or one another client made
 * first, which is the usual way `Archive/2026` already exists.
 *
 * Sequential on purpose: each level is the next level's parent, and
 * `createMailbox` reloads the tree, so the lookup for `09` can see the `2026`
 * that was just created.
 */
export async function ensureFolderPath(
  state: () => MailState,
  parentId: Id,
  segments: string[],
): Promise<Id> {
  let current = parentId;
  for (const name of segments) {
    const existing = Object.values(state().mailboxes).find(
      (m) => m.parentId === current && m.name === name,
    );
    current = existing ? existing.id : await state().createMailbox(name, current);
  }
  return current;
}

/**
 * A folder and everything under it, with the paths they have right now.
 *
 * Taken before a rename or a move, because renaming a parent silently rewrites
 * the path of every folder beneath it, and the rules filing into those children
 * name the old path just as much as the rules filing into the folder itself.
 */
export function folderRefs(state: MailState, id: Id): FolderRef[] {
  const all = Object.values(state.mailboxes);
  const ids = new Set<Id>([id]);
  // Walk down as far as the tree goes; depth is small and bounded by the server.
  for (let pass = 0; pass < 20; pass++) {
    const before = ids.size;
    for (const m of all) if (m.parentId && ids.has(m.parentId)) ids.add(m.id);
    if (ids.size === before) break;
  }
  return [...ids].map((i) => ({ id: i, path: state.mailboxPath(i) }));
}
