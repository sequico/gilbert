/**
 * The agent's reading positions, as documents in the group's own account.
 *
 * A pass reads each account's change log from where the last one ended, and the
 * cursor is the state the server answered for that read. Held only in memory —
 * the shape before this module — a restart began by anchoring at the state the
 * server held **then** (`events.ts`'s `anchorEvents`), so every change that
 * arrived while the process was down was never read and never named: one group's
 * chat message mentioned the agent, produced no run, and nothing in the
 * installation could say why. The process is disposable by law (ADR 0032), so
 * the cursor is a document beside the runs and the instruction, in the group's own app
 * folder, read at the first pass of a process and written after a batch the pass
 * answered (ADR 0037).
 *
 * **Two readers, two positions.** The working pass resumes a window of work; the
 * switched-off pass answers the people who wrote, and answers each of them once.
 * They are not the same reading: each has its own document and its own writer, so
 * neither can destroy the other's position, and a freshness anchor written by one
 * never throws away the window the other exists to keep.
 *
 * An unreadable document is a **gap the pass says out loud** and the reading
 * anchors afresh, which is what the server's own `cannotCalculateChanges` is
 * answered with: a cursor guessed at from a shape this build cannot read would
 * be a window reported as an ordinary one. It is left exactly as it is — the
 * pass that could not read it does not write over it, so what made it unreadable
 * is still there for whoever looks.
 */

import { type Ctx, readAppFileAt, writeAppFileAt } from "../appFolder.js";
import { APP_FOLDER_NAME } from "../shared/appFolder.js";
import { CodedError, errorMessage } from "../shared/errors.js";
import type { EventCursor } from "./events.js";

/** The app-folder path of the working cursor. */
export const CURSOR_FILE = "cursors.json";

/** The app-folder path of the switched-off pass's own position. */
export const NOTICE_CURSOR_FILE = "notices.json";

/** The document's shape version. */
const CURSOR_VERSION = 1;

/**
 * How many paths of destroyed nodes the document keeps.
 *
 * `seen` answers "which surface was this node on" for a node that is gone, and
 * in memory it holds up to `MAX_SEEN_NODES` (2048) — a hundred kilobytes or more
 * as one document, written after every batch that moved the reading. The stored
 * copy is trimmed to the newest few hundred: a node older than that answers by
 * its id, which is the shortcut the in-memory map already states, and the
 * document stays a cursor rather than an index.
 */
const SEEN_STORED_MAX = 256;

/** A cursor this build cannot use, in a code a pass composes its gap from. */
export class CursorError extends CodedError {
  constructor(message: string) {
    super("cursor_unreadable", message, 502, "CursorError");
  }
}

/** A cursor as the document carries it: the reading, and when it was taken. */
export interface StoredCursor {
  cursor: EventCursor;
  /** The instant of the read that produced it, in milliseconds. */
  at: number;
}

function unreadable(file: string, why: string): CursorError {
  return new CursorError(
    `The agent's reading position (${APP_FOLDER_NAME}/${file}) ${why} It is left exactly as it is, so whoever looks can see what it holds, and the reading of this account starts afresh: what fell in between is lost.`,
  );
}

/** Whether a value is the path map a cursor keeps. */
function isSeen(x: unknown): x is Record<string, string> {
  return (
    !!x &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    Object.values(x).every((value) => typeof value === "string")
  );
}

/**
 * The position this account left in `file`, or null when it has none.
 *
 * Absence is the ordinary state of a group read for the first time; a document
 * that is there and cannot be used is a refusal, because the alternative is a
 * reading that hides a window nobody can name. `at` is the instant of the read
 * that produced it, so the off path's freshness question is answered across a
 * restart as it is within one.
 */
export async function readCursor(
  ctx: Ctx,
  accountId: string,
  file: string = CURSOR_FILE,
): Promise<StoredCursor | null> {
  let found: Awaited<ReturnType<typeof readAppFileAt>>;
  try {
    found = await readAppFileAt(ctx, accountId, file);
  } catch (err) {
    throw unreadable(file, `is there and could not be read: ${errorMessage(err)}`);
  }
  if (!found) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(found.text);
  } catch {
    throw unreadable(file, "is not readable JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw unreadable(file, "is not a cursor document.");
  const doc = raw as Record<string, unknown>;
  if (doc.v !== CURSOR_VERSION)
    throw unreadable(file, "is not a shape this build writes.");
  const { mail, files, calendar, seen, at } = doc;
  if (
    typeof mail !== "string" ||
    typeof files !== "string" ||
    typeof calendar !== "string" ||
    !isSeen(seen) ||
    typeof at !== "string" ||
    !Number.isFinite(Date.parse(at))
  )
    throw unreadable(file, "is not a shape this build writes.");
  return { cursor: { mail, files, calendar, seen: { ...seen } }, at: Date.parse(at) };
}

/**
 * Write the position a reading has reached, into `file`.
 *
 * The instant is taken **here**, from the write's own clock: the caller used to
 * pass its pass's start, so a document written after a long pass said it was read
 * five minutes before it was. The write moves the account's own FileNode state,
 * so the state the write produced is handed back through `onState`: that is where
 * this process's reading has now reached, and the caller takes it into the
 * cursor. Without it the next pass finds our own document as a change and
 * rewrites it, which is a change of its own.
 */
export async function writeCursor(
  ctx: Ctx,
  accountId: string,
  cursor: EventCursor,
  opts: { file?: string; onState?: (state: string) => void } = {},
): Promise<void> {
  await writeAppFileAt(
    ctx,
    accountId,
    opts.file ?? CURSOR_FILE,
    {
      v: CURSOR_VERSION,
      mail: cursor.mail,
      files: cursor.files,
      calendar: cursor.calendar,
      seen: Object.fromEntries(Object.entries(cursor.seen).slice(-SEEN_STORED_MAX)),
      at: new Date().toISOString(),
    },
    opts.onState ? { onState: opts.onState } : {},
  );
}
