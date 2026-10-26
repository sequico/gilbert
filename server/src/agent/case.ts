/**
 * The case's scratchpad, as a file the agent keeps for itself (ADR 0034).
 *
 * One note per **case**, named by the key the group's report calls it, under the
 * agent's own bookkeeping in the account's app folder (`cases/<key>.md`). It is
 * working memory and not the record: what must outlive the case is a fact in the
 * memory (ADR 0033), and the run's own document is where its steps are evidence.
 *
 * It lives here rather than on the run so the increments of one case read what the
 * one before it learned: a drop of seven messages is seven runs, and the second must
 * not look for a folder the first has already found. The instruction asks for exactly
 * that — "record what you need in memory, do not re-read a page you have already
 * read" — and a note the next increment cannot see is a note the harness made
 * impossible.
 */
import {
  type Ctx,
  listAppDir,
  readAppFileAt,
  removeAppFile,
  writeAppBytesAt,
} from "../appFolder.js";

/** Where the agent's case notes live, under its own bookkeeping. */
export const CASES_FOLDER = "cases";

/** The most of a case note a turn carries, and the most the file keeps. */
export const CASE_NOTE_MAX = 4 * 1024;

/** How many case keys a turn is told about. */
export const CASE_KEYS_MAX = 40;

const NOTE_TYPE = "text/markdown";

/**
 * The file name a case is kept under: a key as the file system can hold it.
 *
 * Lower case, letters, digits and dashes, and bounded — a key is a report's own
 * name for a case ("BK-901", "March import"), and what a later increment must be
 * able to compute again from the same words. Two keys that differ only in
 * punctuation or case share one file: a case is named by its words, and the
 * punctuation of a report's sentence is not part of its identity.
 */
export function caseSlug(key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "case";
}

/** The note's path in the app folder, for one key. */
export function casePath(key: string): string {
  return `${CASES_FOLDER}/${caseSlug(key)}.md`;
}

/** A case's note, or null when it has none yet. */
export async function readCaseNote(
  ctx: Ctx,
  accountId: string,
  key: string,
): Promise<{ text: string; path: string } | null> {
  const path = casePath(key);
  const held = await readAppFileAt(ctx, accountId, path);
  if (!held) return null;
  const text = held.text.trim();
  return text ? { text: text.slice(0, CASE_NOTE_MAX), path } : null;
}

/**
 * Keep a case's note, replacing what it held; an empty text removes the file.
 *
 * Written as bytes rather than as a JSON document: the note is Markdown the model
 * writes and reads back word for word, and wrapping it in a document it never sees
 * would spend a bound on the wrapper.
 */
export async function writeCaseNote(
  ctx: Ctx,
  accountId: string,
  key: string,
  text: string,
): Promise<void> {
  const path = casePath(key);
  const kept = text.trim();
  if (!kept) {
    await removeAppFile(ctx, accountId, path);
    return;
  }
  await writeAppBytesAt(
    ctx,
    accountId,
    path,
    new TextEncoder().encode(kept.slice(0, CASE_NOTE_MAX)),
    NOTE_TYPE,
  );
}

/**
 * The keys of the cases already on file, names only.
 *
 * The index a turn needs to recognise a case it has seen before without a lookup —
 * and the reason a case can be named by its own report: what a later increment can
 * read is the same list the earlier one wrote.
 */
export async function listCases(ctx: Ctx, accountId: string): Promise<string[]> {
  const entries = await listAppDir(ctx, accountId, CASES_FOLDER);
  return entries
    .flatMap((entry) => {
      const name = typeof entry.name === "string" ? entry.name : "";
      if (!name.endsWith(".md") || entry.nodeType === "directory") return [];
      return [name.slice(0, -".md".length)];
    })
    .sort()
    .slice(0, CASE_KEYS_MAX);
}
