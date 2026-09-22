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
  if ((a.role === "inbox") !== (b.role === "inbox"))
    return a.role === "inbox" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
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
 */
export function treeOrder(mailboxes: Record<Id, Mailbox>): Mailbox[] {
  const byParent = new Map<Id | null, Mailbox[]>();
  for (const m of Object.values(mailboxes)) {
    const p = m.parentId && mailboxes[m.parentId] ? m.parentId : null;
    byParent.set(p, [...(byParent.get(p) ?? []), m]);
  }
  for (const list of byParent.values()) list.sort(compareFolders);
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
