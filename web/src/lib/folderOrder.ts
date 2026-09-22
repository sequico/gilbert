import type { Id, Mailbox } from "@/jmap/types";

/**
 * The order folders are listed in, at every level: Inbox first, then the rest
 * compared the way a reader reads them — case folded, and "Important 2" before
 * "Important 10".
 *
 * The rule lives here rather than in the sidebar because the sidebar is not
 * the only list of folders: the move-to picker, the folder settings and the
 * share dialog all show folders, and one order for all of them is what keeps a
 * folder where the reader last saw it.
 */
export function compareFolders(a: Mailbox, b: Mailbox): number {
  if ((a.role === "inbox") !== (b.role === "inbox")) return a.role === "inbox" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

/**
 * Folders bucketed under the parent they are listed under, siblings in
 * `compareFolders` order — the step every list of folders starts with, whether
 * it draws a tree or flattens one.
 *
 * `mailboxes` is the whole tree the parent lookup and the sibling order are
 * read from; `folders` is what this list offers, which may be a filtered part
 * of it — the sidebar hides what the reader has not subscribed.
 */
export function foldersByParent(
  mailboxes: Record<Id, Mailbox>,
  folders: Mailbox[] = Object.values(mailboxes),
): Map<Id | null, Mailbox[]> {
  const byParent = new Map<Id | null, Mailbox[]>();
  for (const m of folders) {
    const p = m.parentId && mailboxes[m.parentId] ? m.parentId : null;
    byParent.set(p, [...(byParent.get(p) ?? []), m]);
  }
  for (const list of byParent.values()) list.sort(compareFolders);
  return byParent;
}

/**
 * Every folder, parents before their children and siblings in `compareFolders`
 * order: the sidebar with every folder expanded. Lists that show all folders
 * at once — the move-to picker above all — use this so a folder sits where the
 * reader has seen it rather than where a flat A–Z would put it.
 *
 * A folder the walk from the top never reaches (a parent loop the server
 * should not allow) is appended rather than dropped, so it can still be
 * picked. Callers filter the result for what they offer; filtering after the
 * walk is what keeps the parents before their children.
 *
 * The record is keyed by `Mailbox["id"]`, as `Mailbox/get` returns it: the
 * walk looks a parent up by key and dedupes by id, and the two agree.
 */
export function treeOrder(mailboxes: Record<Id, Mailbox>): Mailbox[] {
  const byParent = foldersByParent(mailboxes);
  const out: Mailbox[] = [];
  const seen = new Set<Id>();
  const walk = (parent: Id | null) => {
    for (const m of byParent.get(parent) ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
      walk(m.id);
    }
  };
  walk(null);
  return out.concat(
    Object.values(mailboxes)
      .filter((m) => !seen.has(m.id))
      .sort(compareFolders),
  );
}
