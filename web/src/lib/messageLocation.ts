/**
 * Where a message is stored, for the row that shows it.
 *
 * A list is not always a folder. A label, a starred view and a search are all
 * questions *about* messages, and a row answering one of them says nothing
 * about where the message actually lives — so it says it here, through one
 * function, for every list that is not a folder.
 *
 * In a folder view the answer is the folder being looked at, and the row
 * already says it by being in it; what such a row adds is only the *other*
 * folders the message also sits in, which is why `listing` is subtracted
 * rather than special-cased at the call site.
 *
 * The names are `mailboxDisplayPath`'s — the same translated path the folder
 * pickers show, so a standard folder reads in the interface language here too,
 * and a nested one reads as the whole path rather than its last segment.
 */
import type { Id, Mailbox } from "@/jmap/types";
import { mailboxDisplayPath } from "@/lib/mailboxName";

/** The shape this needs of an email: which folders hold it. */
export interface StoredIn {
  mailboxIds?: Record<Id, boolean>;
}

/**
 * The folders a message sits in, as the reader should see them.
 *
 * Empty means "nowhere to add": the message is in no folder at all, or the
 * only folder holding it is the one the list is already showing.
 */
export function messageFolders(
  email: StoredIn,
  mailboxes: Record<Id, Mailbox>,
  /** The folder the list is showing, left out of the answer. */
  listing?: Id | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [id, held] of Object.entries(email.mailboxIds ?? {})) {
    if (!held || id === listing) continue;
    const box = mailboxes[id];
    if (!box) continue;
    const path = mailboxDisplayPath(box, mailboxes);
    // Two folders can render the same path — a role folder beside somebody's
    // same-named one — and a row that says it twice is a row that lies about
    // how many places the message is in.
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  // Stable, so a row does not reshuffle when the map's key order changes. A
  // plain comparison rather than `localeCompare`: this is presentation order,
  // and it must not differ between the runtime that renders it and the one
  // that tests it.
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
