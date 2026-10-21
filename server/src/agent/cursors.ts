/**
 * The agent's reading cursor, as a document in the group's own account.
 *
 * A pass reads each account's change log from where the last one ended, and the
 * cursor is the state the server answered for that read. Held only in memory —
 * the shape before this module — a restart began by anchoring at the state the
 * server held **then** (`events.ts`'s `anchorEvents`), so every change that
 * arrived while the process was down was never read and never named: one group's
 * chat message mentioned the agent, produced no run, and nothing in the
 * installation could say why. The process is disposable by law (ADR 0032), so
 * the cursor is a document beside the runs and the rules, in the group's own app
 * folder, read at the first pass of a process and written after a batch the pass
 * answered (ADR 0037).
 *
 * An unreadable document is a **gap the pass says out loud** and the reading
 * anchors afresh, which is what the server's own `cannotCalculateChanges` is
 * answered with: a cursor guessed at from a shape this build cannot read would
 * be a window reported as an ordinary one.
 */

import { type Ctx, readAppFileAt, writeAppFileAt } from "../appFolder.js";
import { APP_FOLDER_NAME } from "../shared/appFolder.js";
import { CodedError, errorMessage } from "../shared/errors.js";
import type { EventCursor } from "./events.js";

/** The app-folder path of the cursor. */
export const CURSOR_FILE = "cursors.json";

/** The document's shape version. */
const CURSOR_VERSION = 1;

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

function unreadable(why: string): CursorError {
  return new CursorError(
    `The agent's reading cursor (${APP_FOLDER_NAME}/${CURSOR_FILE}) ${why} It is left exactly as it is, and the reading of this account starts afresh: what fell in between is lost.`,
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
 * The cursor this account left, or null when the installation has never read it.
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
): Promise<StoredCursor | null> {
  let found: Awaited<ReturnType<typeof readAppFileAt>>;
  try {
    found = await readAppFileAt(ctx, accountId, CURSOR_FILE);
  } catch (err) {
    throw unreadable(`is there and could not be read: ${errorMessage(err)}`);
  }
  if (!found) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(found.text);
  } catch {
    throw unreadable("is not readable JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw unreadable("is not a cursor document.");
  const doc = raw as Record<string, unknown>;
  if (doc.v !== CURSOR_VERSION) throw unreadable("is not a shape this build writes.");
  const { mail, files, calendar, seen, at } = doc;
  if (
    typeof mail !== "string" ||
    typeof files !== "string" ||
    typeof calendar !== "string" ||
    !isSeen(seen) ||
    typeof at !== "string" ||
    !Number.isFinite(Date.parse(at))
  )
    throw unreadable("is not a shape this build writes.");
  return { cursor: { mail, files, calendar, seen: { ...seen } }, at: Date.parse(at) };
}

/** Write the cursor this account's reading has reached, and when. */
export async function writeCursor(
  ctx: Ctx,
  accountId: string,
  cursor: EventCursor,
  at: Date,
): Promise<void> {
  await writeAppFileAt(ctx, accountId, CURSOR_FILE, {
    v: CURSOR_VERSION,
    mail: cursor.mail,
    files: cursor.files,
    calendar: cursor.calendar,
    seen: cursor.seen,
    at: at.toISOString(),
  });
}
