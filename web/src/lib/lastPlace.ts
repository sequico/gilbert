import { CAP } from "@/jmap/client";
import { accountKey, loadJson, saveJson } from "@/lib/storage";

/**
 * Where the reader was, so the next session can put them back there.
 *
 * Three surfaces remember the place they were left in -- the mail account on
 * screen, the address book being read, the folder open in Files -- and one
 * record holds all three, keyed by the reader rather than by the surface,
 * because they are one answer to one question. The same record carries the
 * shape of the two folder trees (`openFolders`): where a tree was left, and
 * which of its folders were open, are one answer to one question too.
 *
 * Device-local on purpose. It changes on nearly every click, so syncing it
 * would rewrite the account's settings file that often, and "where I was
 * sitting" is not a preference to inherit on another machine. `storage.ts`
 * namespaces the key per account, so two people on one browser keep their own.
 *
 * Nothing here validates what it reads: a book or a folder may be gone
 * by the time it is restored, and each surface checks that against what it
 * actually has before moving.
 */
export interface LastPlace {
  /** The mail account whose mailbox tree was on screen. */
  mailAccountId?: string | null;
  /** The address book being read, and the account holding it. */
  book?: { accountId: string | null; bookId: string } | null;
  /** The Files account, and the folder that was open in it. */
  files?: { accountId: string | null; parentId: string | null } | null;
  /**
   * Which folders were open in each sidebar tree, keyed by account and folder
   * (`folderKey`), with **only the open ones written**: a folder that is not
   * named is collapsed, which is what an account the reader has never touched
   * and a tree this device has never seen both look like.
   *
   * Namespaced by account because the ids inside one are the server's, and two
   * accounts hand out ids that collide: a bare id remembered from the personal
   * mailbox would open a stranger's folder in a group's tree, and the reader
   * never opened it.
   */
  openFolders?: Partial<Record<TreeKind, Record<string, boolean>>>;
  /**
   * How each file folder was last ordered on this device, keyed by account and
   * folder (`folderKey`).
   *
   * Per folder rather than one order for Files, because which order is wanted
   * is a property of what is in the folder -- a download folder by date, a
   * documents folder by name -- and, like the open folders beside it, it is
   * where this reader was reading rather than a preference to carry to another
   * machine.
   */
  filesSort?: Record<string, FilesSort>;
}

/** Which sidebar tree a set of open folders belongs to. */
export type TreeKind = "mail" | "files" | "kb";

/**
 * The columns a file listing can be ordered by.
 *
 * Two states and no third: a listing is always in *some* order (the server
 * answers in name order, and that is the default here), so clicking the column
 * already in force turns it around rather than turning it off.
 */
export type FilesSortKey = "name" | "size" | "modified";

export interface FilesSort {
  key: FilesSortKey;
  /** Largest first, newest first, Z–A -- the reverse of the column's own order. */
  desc: boolean;
}

/** How a folder nobody has ordered yet is drawn: the order the server answers in. */
export const DEFAULT_FILES_SORT: FilesSort = { key: "name", desc: false };

const SORT_KEYS: FilesSortKey[] = ["name", "size", "modified"];

/**
 * Whose record this is: the reader's own account, whatever capability is being
 * asked about. One id, so the three surfaces share one record.
 *
 * Never "the mail account" alone: Files and Contacts have nothing to do
 * with mail, and a session whose own account does not advertise it would
 * otherwise leave all three surfaces silently inert. The order is the order a
 * session is most likely to answer in, not a ranking.
 */
export function placeOwnerFrom(
  session: { ownAccountFor(cap: string): string | null } | null | undefined,
): string | null {
  if (!session) return null;
  return (
    session.ownAccountFor(CAP.mail) ??
    session.ownAccountFor(CAP.filenode) ??
    session.ownAccountFor(CAP.calendars) ??
    session.ownAccountFor(CAP.contacts) ??
    null
  );
}

export function loadPlace(owner: string | null | undefined): LastPlace {
  if (!owner) return {};
  return loadJson<LastPlace>(accountKey(owner, "lastPlace"), {});
}

/** Remember one surface's place, leaving the others as they were. */
export function rememberPlace(
  owner: string | null | undefined,
  patch: Partial<LastPlace>,
): void {
  if (!owner) return;
  saveJson(accountKey(owner, "lastPlace"), { ...loadPlace(owner), ...patch });
}

/** Which folders one tree has open, for this reader. */
export function loadOpenFolders(
  owner: string | null | undefined,
  kind: TreeKind,
): Record<string, boolean> {
  return loadPlace(owner).openFolders?.[kind] ?? {};
}

/**
 * Remember one tree's open folders, leaving the other tree -- and every other
 * surface -- as it was.
 *
 * Its own function rather than a `rememberPlace` patch because the two trees
 * share one field: a caller patching `openFolders` wholesale would trade the
 * Files tree's open folders for the mailbox tree's on the next toggle.
 */
export function rememberOpenFolders(
  owner: string | null | undefined,
  kind: TreeKind,
  open: Record<string, boolean>,
): void {
  if (!owner) return;
  const place = loadPlace(owner);
  saveJson(accountKey(owner, "lastPlace"), {
    ...place,
    openFolders: { ...place.openFolders, [kind]: open },
  });
}

/**
 * One folder's remembered order, or the default when there is none to read.
 *
 * Validated rather than trusted: this record is written by one build and read
 * by the next, and a column that is no longer one would otherwise reach a
 * comparator that has nothing to say about it. Anything the shape does not
 * recognise reads as "never sorted", which is a folder in the server's order
 * rather than a listing in no order at all.
 */
export function loadFilesSort(
  owner: string | null | undefined,
  folder: string,
): FilesSort {
  const stored = loadPlace(owner).filesSort?.[folder];
  if (stored && SORT_KEYS.includes(stored.key) && typeof stored.desc === "boolean")
    return { key: stored.key, desc: stored.desc };
  return DEFAULT_FILES_SORT;
}

/** Remember one folder's order, leaving every other folder's as it was. */
export function rememberFilesSort(
  owner: string | null | undefined,
  folder: string,
  sort: FilesSort,
): void {
  if (!owner) return;
  const place = loadPlace(owner);
  saveJson(accountKey(owner, "lastPlace"), {
    ...place,
    filesSort: { ...place.filesSort, [folder]: sort },
  });
}
