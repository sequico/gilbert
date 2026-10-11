/**
 * Where a message goes when it is archived by date.
 *
 * The folders are **numeric and zero-padded** -- `Archive/2026`,
 * `Archive/2026/09` -- and deliberately not month names. Two reasons, both
 * about the fact that these are real server-side mailboxes rather than
 * anything of Gilbert's:
 *
 *  - Every other client sees them. A folder created as "September" by someone
 *    reading in English stays "September" for the same account read in
 *    Japanese, because the name is stored, not translated. A number reads the
 *    same in every language Gilbert ships.
 *  - They sort. `09` sits between `08` and `10` in any folder list; "September"
 *    sits between "October" and nothing useful.
 *
 * The date is read in UTC, from the instant the server stored. The folder is a
 * real mailbox that everyone who reads the account shares, so its name cannot
 * depend on which zone the person archiving happens to sit in: naming it from
 * the reader's own clock would put the same message in different months for two
 * readers, and build a tree no one could agree the shape of. `receivedAt` is a
 * UTC instant to begin with, and the folder name follows it.
 */

export type ArchiveGranularity = "year" | "month";

/**
 * Path segments below the Archive folder. Empty means "no dated subfolder" --
 * a message whose date cannot be read belongs in Archive itself rather than in
 * a folder named after a guess.
 */
export function archiveSegments(
  when: string | null | undefined,
  granularity: ArchiveGranularity,
): string[] {
  if (!when) return [];
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return [];
  const year = String(d.getUTCFullYear());
  if (granularity === "year") return [year];
  return [year, String(d.getUTCMonth() + 1).padStart(2, "0")];
}

/** The segments as one string, for grouping and for naming the destination. */
export function archivePath(segments: string[]): string {
  return segments.join("/");
}

export interface ArchiveGroup {
  segments: string[];
  ids: string[];
}

/**
 * Split a selection by where each message is going.
 *
 * Archiving by month across a selection spanning two months is two
 * destinations, not one, so this is the shape the caller needs -- and the
 * reason the action cannot simply resolve one folder up front. Groups come
 * back in the order their first message appeared, so the toast that follows
 * names them in the order the reader was looking at.
 */
export function groupByArchivePath(
  entries: Array<{ id: string; receivedAt?: string | null }>,
  granularity: ArchiveGranularity,
): ArchiveGroup[] {
  const groups = new Map<string, ArchiveGroup>();
  for (const e of entries) {
    const segments = archiveSegments(e.receivedAt, granularity);
    const key = archivePath(segments);
    const existing = groups.get(key);
    if (existing) existing.ids.push(e.id);
    else groups.set(key, { segments, ids: [e.id] });
  }
  return [...groups.values()];
}
