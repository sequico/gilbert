/**
 * The file drops a burst leaves, held until the burst is over (ADR 0038).
 *
 * A person saving a mail's attachments to Files writes one node per file, and a
 * loading-doc pack is seven of them over half an hour. Read one event at a time
 * that is seven runs and seven chat messages for one delivery — the live run of
 * 2026-10-20 answered a seven-file drop with thirteen messages — while the
 * question the drop raises ("is the booking number right?") is asked once per
 * file. The drop is one thing, so the agent reports it once.
 *
 * This module is the queue that makes that true without losing a file: a file
 * event is noted against the folder it landed in and the events read are
 * consumed, and the folder is answered when it has been **quiet** for
 * `DROP_QUIET_MS` or when the drop has been open for `DROP_CAP_MS`. The queue
 * is one JSON document in the group's own app folder, so a process that dies
 * between passes resumes the same drop rather than forgetting it.
 *
 * One account's passes are serial in one process (the installation holds one
 * claim, ADR 0036), so the document is written plainly: a conditional write
 * would need the account's FileNode state on every file, and there is no second
 * writer to lose a race against.
 */

import type { Ctx } from "../appFolder.js";
import { readAppFileAt, writeAppFileAt } from "../appFolder.js";
import { APP_FOLDER_NAME } from "../shared/appFolder.js";
import { type AccountEvent, eventSourceOf } from "./accountEvent.js";

/** The app-folder path of the queue. */
export const PENDING_FILE = "pending.json";

/** The document's shape version. */
const PENDING_VERSION = 1;

/**
 * How long a folder must be quiet before its drop is reported.
 *
 * Long enough that a pack saved one file at a time is one drop (the live burst
 * paused two to four minutes between files), short enough that the report still
 * beats a same-day cut-off.
 */
export const DROP_QUIET_MS = 5 * 60_000;

/**
 * The longest a drop stays open, however busy the folder is.
 *
 * A drop that never ends would never be reported; this is the ceiling that
 * makes "one report" mean "one report, twenty minutes in".
 */
export const DROP_CAP_MS = 20 * 60_000;

/** How many folders the queue holds before it starts answering the oldest. */
const DROPS_MAX = 40;

/** How many paths one drop names; a longer burst keeps its newest files. */
const PATHS_PER_DROP_MAX = 200;

/** How long an empty queue is remembered, so every pass need not read it. */
const EMPTY_TTL_MS = 30_000;

/** The accounts whose queue was empty when last read, and when. */
const emptySince = new Map<string, number>();

/** One folder's burst, as the queue holds it. */
export interface Drop {
  /** The folder the files landed in; "" is the Files root. */
  folder: string;
  /** The files seen, in the order they arrived. */
  paths: string[];
  /** When the first file of the burst was seen. */
  firstAt: string;
  /** When the last one was. */
  lastAt: string;
}

interface PendingDoc {
  v: 1;
  drops: Drop[];
}

/** The folder a visible path sits in, or "" for a top-level file. */
function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at > 0 ? path.slice(0, at) : "";
}

/** Whether a value is a drop this build wrote. */
function isDrop(x: unknown): x is Drop {
  if (!x || typeof x !== "object") return false;
  const drop = x as Record<string, unknown>;
  return (
    typeof drop.folder === "string" &&
    Array.isArray(drop.paths) &&
    drop.paths.every((one) => typeof one === "string" && one !== "") &&
    typeof drop.firstAt === "string" &&
    typeof drop.lastAt === "string"
  );
}

/**
 * The queue as it stands.
 *
 * An absent document is an empty queue — the ordinary state before the first
 * file. A document that is there but cannot be read is **not** an empty queue:
 * the files it holds were consumed from the change log already, and reading the
 * damage as "nothing pending" would forget them in silence. The pass stops and
 * says so, and the operator removes the document to start again from the files
 * that are still in the folder.
 *
 * An empty queue that was just read is remembered for `EMPTY_TTL_MS`: every
 * pass asks, and a queue with nothing in it is the ordinary state. Any write
 * clears the memory, so a file noted now is never hidden by the read before it.
 */
async function readPending(ctx: Ctx, accountId: string): Promise<PendingDoc> {
  const known = emptySince.get(accountId);
  if (known !== undefined && Date.now() - known < EMPTY_TTL_MS)
    return { v: PENDING_VERSION, drops: [] };
  const found = await readAppFileAt(ctx, accountId, PENDING_FILE);
  if (!found) {
    emptySince.set(accountId, Date.now());
    return { v: PENDING_VERSION, drops: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(found.text);
  } catch {
    throw new Error(
      `The agent's drop queue (${APP_FOLDER_NAME}/${PENDING_FILE}) is not readable JSON, so the files it holds cannot be reported.`,
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new Error(
      `The agent's drop queue (${APP_FOLDER_NAME}/${PENDING_FILE}) is not a drop document.`,
    );
  }
  const doc = raw as Record<string, unknown>;
  if (doc.v !== PENDING_VERSION || !Array.isArray(doc.drops)) {
    throw new Error(
      `The agent's drop queue (${APP_FOLDER_NAME}/${PENDING_FILE}) is not a shape this build writes.`,
    );
  }
  if (!doc.drops.every(isDrop)) {
    throw new Error(
      `The agent's drop queue (${APP_FOLDER_NAME}/${PENDING_FILE}) holds a drop this build cannot read, so the files it names cannot be reported.`,
    );
  }
  if (!doc.drops.length) emptySince.set(accountId, Date.now());
  else emptySince.delete(accountId);
  return { v: PENDING_VERSION, drops: doc.drops };
}

async function writePending(
  ctx: Ctx,
  accountId: string,
  drops: readonly Drop[],
): Promise<void> {
  // A write is the end of "nothing pending", whatever it leaves behind.
  emptySince.delete(accountId);
  await writeAppFileAt(ctx, accountId, PENDING_FILE, {
    v: PENDING_VERSION,
    drops: [...drops],
  } satisfies PendingDoc);
}

/**
 * Note one file against its folder, without answering anything yet.
 *
 * The event's own pass is consuming it: the cursor moves past the file, and the
 * queue is what remembers it until the burst is over.
 */
export async function noteFile(
  ctx: Ctx,
  accountId: string,
  path: string,
  now: Date,
): Promise<void> {
  const at = now.toISOString();
  const folder = parentOf(path);
  const doc = await readPending(ctx, accountId);
  const held = doc.drops.find((drop) => drop.folder === folder);
  if (held) {
    if (!held.paths.includes(path)) held.paths.push(path);
    held.paths = held.paths.slice(-PATHS_PER_DROP_MAX);
    held.lastAt = at;
  } else {
    doc.drops.push({ folder, paths: [path], firstAt: at, lastAt: at });
  }
  await writePending(ctx, accountId, doc.drops);
}

/**
 * The drops that are over: quiet for `DROP_QUIET_MS`, or `DROP_CAP_MS` old.
 *
 * A drop is answered by this pass and removed by `forgetDrop` once its run has
 * been worked; a crash in between leaves it in the queue, and the run's own key
 * (the folder and the instant the drop opened) makes the second attempt the
 * same run rather than a second one.
 */
export async function dueDrops(ctx: Ctx, accountId: string, now: Date): Promise<Drop[]> {
  const at = now.getTime();
  const drops = (await readPending(ctx, accountId)).drops;
  /*
   * Past the ceiling, the oldest are answered even if their folder was just
   * written to: the ceiling bounds a pass, it is never a reason to drop a
   * folder's files on the floor.
   */
  const over = Math.max(0, drops.length - DROPS_MAX);
  return drops.filter((drop, index) => {
    const last = Date.parse(drop.lastAt);
    const first = Date.parse(drop.firstAt);
    return (
      index < over ||
      (Number.isFinite(last) && at - last >= DROP_QUIET_MS) ||
      (Number.isFinite(first) && at - first >= DROP_CAP_MS)
    );
  });
}

/** Drop one folder's burst from the queue, once its run has been worked. */
export async function forgetDrop(
  ctx: Ctx,
  accountId: string,
  folder: string,
): Promise<void> {
  const doc = await readPending(ctx, accountId);
  await writePending(
    ctx,
    accountId,
    doc.drops.filter((drop) => drop.folder !== folder),
  );
}

/**
 * Take one path out of the queue, because the file is no longer there.
 *
 * A drop names what the change log said arrived; a file destroyed (or renamed,
 * which is a destroy and a create) before the drop is answered must not be
 * reported as if it were still in the folder. A drop left with no path is
 * removed: there is nothing left to report.
 */
export async function forgetPath(
  ctx: Ctx,
  accountId: string,
  path: string,
): Promise<void> {
  const doc = await readPending(ctx, accountId);
  let changed = false;
  const drops = doc.drops
    .map((drop) => {
      if (!drop.paths.includes(path)) return drop;
      changed = true;
      return { ...drop, paths: drop.paths.filter((one) => one !== path) };
    })
    .filter((drop) => drop.paths.length > 0);
  if (changed) await writePending(ctx, accountId, drops);
}

/**
 * One event that stands for a whole drop.
 *
 * `where` is the folder, which is what the run is filed under and what the
 * prompt names; `also` is the files themselves, so the decision reads the pack
 * rather than the one node that happened to arrive last; `at` is when the drop
 * opened, and it is what makes a second drop in the same folder a second run.
 */
export function dropEvent(drop: Drop): AccountEvent {
  return {
    source: eventSourceOf(drop.folder),
    change: "created",
    where: drop.folder,
    also: drop.paths,
    at: drop.firstAt,
  };
}
