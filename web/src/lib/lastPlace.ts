import { CAP } from "@/jmap/client";
import { accountKey, loadJson, saveJson } from "@/lib/storage";

/**
 * Where the reader was, so the next session can put them back there.
 *
 * Four surfaces remember the place they were left in -- the mail account on
 * screen, the address book being read, the task list, the folder open in Files
 * -- and one record holds all four, keyed by the reader rather than by the
 * surface, because they are one answer to one question.
 *
 * Device-local on purpose. It changes on nearly every click, so syncing it
 * would rewrite the account's settings file that often, and "where I was
 * sitting" is not a preference to inherit on another machine. `storage.ts`
 * namespaces the key per account, so two people on one browser keep their own.
 *
 * Nothing here validates what it reads: a book, a list or a folder may be gone
 * by the time it is restored, and each surface checks that against what it
 * actually has before moving.
 */
export interface LastPlace {
  /** The mail account whose mailbox tree was on screen. */
  mailAccountId?: string | null;
  /** The address book being read, and the account holding it. */
  book?: { accountId: string | null; bookId: string } | null;
  /** The selected task list, as `taskListKey` writes it. */
  taskList?: string | null;
  /** The Files account, and the folder that was open in it. */
  files?: { accountId: string | null; parentId: string | null } | null;
}

/**
 * Whose record this is: the reader's own account, whatever capability is
 * being asked about. One id, so the four surfaces share one record.
 */
export function placeOwnerFrom(
  session: { ownAccountFor(cap: string): string | null } | null | undefined,
): string | null {
  return session?.ownAccountFor(CAP.mail) ?? null;
}

export function loadPlace(owner: string | null | undefined): LastPlace {
  if (!owner) return {};
  return loadJson<LastPlace>(accountKey(owner, "lastPlace"), {});
}

/** Remember one surface's place, leaving the other three as they were. */
export function rememberPlace(
  owner: string | null | undefined,
  patch: Partial<LastPlace>,
): void {
  if (!owner) return;
  saveJson(accountKey(owner, "lastPlace"), { ...loadPlace(owner), ...patch });
}
