/**
 * The order the server holds these in, ties broken by name.
 *
 * Address books, calendars and the boxes a message may be filed in all arrive
 * with a **`sortOrder` the reader arranged**, and every list of them has to agree
 * on the order or a row moves between surfaces. The name is the tie break because
 * two objects may share a position, and a list that fell back to insertion order
 * would put them in a different place depending on which request answered first.
 *
 * One definition, imported by the sidebars, the move-to dialogs and the pickers.
 * Mail's own folders are ordered by `compareFolders` instead, which puts the Inbox
 * first on top of this rule.
 */
export function bySortOrder<T extends { sortOrder: number; name: string }>(
  a: T,
  b: T,
): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}
