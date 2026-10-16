/**
 * What a group's account changed, read from the server's own change logs
 * (ADR 0035).
 *
 * The installation holds a push subscription (ADR 0016), and a `StateChange`
 * names an account whose data moved. This is the reading that turns that
 * notification into the group's own vocabulary: mail that arrived or was sent,
 * and the nodes written in its Files — chat messages, workorders and everything
 * else among them — each handed back as a reference (`./accountEvent`), never as
 * the object itself.
 *
 * **Where the reading stands is the server's own state token, not a clock.**
 * JMAP answers `/changes` from a `sinceState` and hands back the state that
 * follows it as `newState`; the cursor is exactly those two tokens, one per
 * data type. A change is therefore reported once and the next read resumes
 * after it — there is no window, no timestamp and no overlap to reconcile.
 * Asking for a change that is behind the server's own log is refused rather
 * than answered as "nothing changed", and that refusal is the one end this
 * reading has: the changes between the cursor and the log the server still
 * holds are gone, so the caller starts again from a fresh anchor and they are
 * lost. The refusal says so (`readChanges`).
 *
 * **A log is read in pages, to its end.** The server answers a bounded window —
 * the `maxChanges` this asks for — and says whether it holds more; the reading
 * loops until it does not, taking each page's `newState` as the resume point.
 * A window larger than the log the server keeps is therefore drained rather
 * than refused: one burst bigger than a window would otherwise wedge the
 * account for ever, the caller keeping a cursor the server would never answer
 * again.
 *
 * A **first** read anchors at the account's current state, which is what makes
 * a process that starts ask for the changes after it started rather than for
 * the account's whole history. A cursor is process state and only process
 * state: the run document is what is durable (ADR 0034), and a process that
 * dies is replaced by one that anchors afresh. The consequence is stated rather
 * than hidden — mail that arrived while no agent was running is not replayed to
 * the next one.
 *
 * One write can appear as two changes, and the reading does not fold them: the
 * tree's own write path issues a create and then the update that puts the bytes
 * in it (`appFolder.ts`), and Stalwart reports both. Folding would have to
 * choose which one a reader sees, and a node created and then destroyed in one
 * window is both — hiding the removal behind the creation is the kind of
 * silence this design refuses.
 */

import {
  appFolderState,
  type Ctx,
  FILENODE_CAP,
  type FileNodeLike,
} from "../appFolder.js";
import { JmapError, type JmapResult } from "../jmap.js";
import { FILENODE_CHANGES, FILENODE_GET, FOLDER_PROPS } from "../shared/appFolder.js";
import { CAPABILITIES } from "../shared/capabilities.js";
import { clientOf } from "../util.js";
import {
  type AccountEvent,
  type AccountEventChange,
  eventSourceOf,
} from "./accountEvent.js";

/**
 * How many changes one page of a log asks for.
 *
 * A bounded window rather than the whole log: one answer is never as large as
 * the account's whole backlog, and the state a page ends at is the point the
 * next one is asked from. The loop is on `hasMoreChanges`, not on the page being
 * the size asked for, because a server caps a page at its own bound as well
 * (`crates/jmap/src/changes/get.rs` answers `min(maxChanges,
 * changes_max_results)`) — an answer shorter than this says nothing about
 * whether the log holds more.
 */
export const MAX_CHANGES_PER_READ = 100;

/**
 * How many node paths a cursor keeps.
 *
 * A removal has no address left to read, so the surface it happened on is the
 * one its former path was read at (`seen`); the memory is process state beside
 * the cursor and its bound is what keeps a process that reads a busy account
 * for a long time from growing without end. A node whose path fell out of it is
 * named by its id, which is what the reading does for a node it never saw.
 */
const MAX_SEEN_NODES = 2048;

/**
 * Where an account's reading has reached: one server state token per data type,
 * and the node paths this process has read.
 *
 * A cursor is process state and only process state: it is not written down, and
 * a process that dies is replaced by one that anchors afresh.
 */
export interface EventCursor {
  /** The Email state the last read ended at. */
  mail: string;
  /** The FileNode state the last read ended at. */
  files: string;
  /**
   * The path each node id was last read at, by id.
   *
   * A destroyed node cannot be read again, so a removal's surface is answered
   * from here: the node was a chat message or a workorder write because its
   * path was read as one before it went. A node this process never read falls
   * back to its id.
   */
  seen: Record<string, string>;
}

/** What one read found, and where the next one resumes. */
export interface AccountEvents {
  events: AccountEvent[];
  cursor: EventCursor;
}

/**
 * The account's reading position now: the cursor a first read starts from.
 *
 * The Email state comes from an empty `/get` — the answer that carries the
 * state and no objects — and the FileNode state from the app folder's own
 * reader: the same token a conditional write is made against, so "where the
 * reading stands" and "what a write is conditional on" are one value rather
 * than two derivations that could disagree.
 */
export async function anchorEvents(ctx: Ctx, accountId: string): Promise<EventCursor> {
  const mail = await clientOf(ctx).call<{ state?: unknown }>(
    "Email/get",
    { accountId, ids: [] },
    [CAPABILITIES.mail],
  );
  if (typeof mail.state !== "string")
    throw new Error("The mail server answered no Email state for this account.");
  return { mail: mail.state, files: await appFolderState(ctx, accountId), seen: {} };
}

/** One `/changes` answer, as this build can use it. */
export interface ChangeSet {
  created: string[];
  updated: string[];
  destroyed: string[];
  newState: string;
  hasMoreChanges: boolean;
}

/**
 * Read one `/changes` answer.
 *
 * Two shapes are refused rather than guessed at, because each of them would
 * report a window as other than it is. Without the state the answer ends at
 * there is no cursor to move, and keeping the old one would report this window's
 * changes a second time; a change list that is not a list of ids names things
 * the log cannot have changed. `hasMoreChanges` is the server saying it holds
 * more, and the reading pages on it rather than refusing.
 */
export function readChangeSet(args: Record<string, unknown>, type: string): ChangeSet {
  const ids = (key: AccountEventChange): string[] => {
    const list = args[key];
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.some((id) => typeof id !== "string"))
      throw new Error(
        `The ${type} change log answered a "${key}" that is not a list of ids.`,
      );
    return list as string[];
  };
  // Without the state the answer ends at there is no cursor to move, and
  // keeping the old one would report this window's changes a second time.
  if (typeof args.newState !== "string")
    throw new Error(
      `The ${type} change log answered no state to resume from; the changes cannot be read exactly once.`,
    );
  return {
    created: ids("created"),
    updated: ids("updated"),
    destroyed: ids("destroyed"),
    newState: args.newState,
    hasMoreChanges: args.hasMoreChanges === true,
  };
}

/**
 * What the account changed since `cursor`.
 *
 * Both logs are asked in one request per page: this is one question about one
 * account, and a notification that woke the agent for mail must not cost a
 * second round trip for the files that moved in the same instant. Each log is
 * paged until the server says it holds no more, so a burst larger than one
 * window is read whole rather than refused.
 *
 * A refusal of either log is a refusal of the reading: half an answer cannot
 * advance the cursor without re-reporting the other half, which is the one
 * thing this must never do. A `cannotCalculateChanges` is turned into the one
 * sentence that says what it costs.
 */
export async function readAccountEvents(
  ctx: Ctx,
  accountId: string,
  cursor: EventCursor,
): Promise<AccountEvents> {
  let mail = cursor.mail;
  let files = cursor.files;
  let seen = cursor.seen;
  const events: AccountEvent[] = [];
  for (;;) {
    const { mail: mailed, files: filed } = await readChanges(ctx, accountId, mail, files);
    const paths = await nodePaths(ctx, accountId, [
      ...filed.created,
      ...filed.updated,
      ...filed.destroyed,
    ]);
    seen = rememberPaths(seen, paths);

    for (const change of ["created", "updated", "destroyed"] as const) {
      for (const id of mailed[change]) events.push({ source: "mail", change, where: id });
      for (const id of filed[change]) {
        // The path the server still answers for the node, or the one this
        // process read while the node was there: a removal named by the surface
        // its former path belonged to, and by its id only when neither is known.
        const path = paths.get(id) ?? seen[id];
        events.push(
          path
            ? { source: eventSourceOf(path), change, where: path }
            : { source: "files", change, where: id },
        );
      }
    }

    mail = mailed.newState;
    files = filed.newState;
    if (!mailed.hasMoreChanges && !filed.hasMoreChanges) break;
  }
  return { events, cursor: { mail, files, seen } };
}

/**
 * One page of both logs, with the one refusal this reading has turned into its
 * own sentence.
 *
 * `cannotCalculateChanges` means the cursor fell further behind than the log the
 * server still holds, so the changes in between cannot be read at all: keeping
 * the cursor would refuse every later read for the same reason, and the honest
 * answer is the refusal with its cost named. It is a method-level error inside
 * an otherwise successful response, so it arrives where the answer is read
 * rather than where the call is made.
 */
async function readChanges(
  ctx: Ctx,
  accountId: string,
  mail: string,
  files: string,
): Promise<{ mail: ChangeSet; files: ChangeSet }> {
  try {
    const answered: JmapResult = await clientOf(ctx).chain(
      [
        [
          "Email/changes",
          { accountId, sinceState: mail, maxChanges: MAX_CHANGES_PER_READ },
          "mail",
        ],
        [
          FILENODE_CHANGES,
          { accountId, sinceState: files, maxChanges: MAX_CHANGES_PER_READ },
          "files",
        ],
      ],
      [CAPABILITIES.mail, FILENODE_CAP],
    );
    return {
      mail: readChangeSet(answered.args("mail"), "Email"),
      files: readChangeSet(answered.args("files"), "FileNode"),
    };
  } catch (err) {
    if (err instanceof JmapError && err.type === "cannotCalculateChanges")
      throw new Error(
        "The mail server no longer holds the changes this account's reading asks for: the changes it missed are lost, and the reading has to begin again from the state the server holds now.",
      );
    throw err;
  }
}

/** The same paths, with this page's reads remembered and the oldest dropped. */
function rememberPaths(
  previous: Record<string, string>,
  found: Map<string, string>,
): Record<string, string> {
  const next: Record<string, string> = { ...previous };
  for (const [id, path] of found) next[id] = path;
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SEEN_NODES)))
    delete next[key];
  return next;
}

/**
 * The path of every node named, where one can still be read.
 *
 * A node's path is not a property: JMAP answers a node's name and its parent,
 * and the path is the names of the chain above it — so this walks up one level
 * at a time, asking for a whole level's nodes in one `/get` rather than one
 * node per call. A node the server no longer holds (a destroyed one) has no
 * path, and neither has one whose parent is missing: half a chain would name a
 * node as something it is not. Such a node is the caller's to name by its id.
 */
async function nodePaths(
  ctx: Ctx,
  accountId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const known = new Map<string, { name: string; parentId: string | null }>();
  let frontier = [...new Set(ids)];
  while (frontier.length) {
    const level = await nodeNames(ctx, accountId, frontier);
    const next: string[] = [];
    for (const [id, node] of level) {
      known.set(id, node);
      if (node.parentId && !known.has(node.parentId) && !next.includes(node.parentId))
        next.push(node.parentId);
    }
    frontier = next;
  }
  const paths = new Map<string, string>();
  for (const id of ids) {
    const path = pathOf(known, id);
    if (path !== null) paths.set(id, path);
  }
  return paths;
}

/** One page-at-a-time read of the nodes named: their names and their parents. */
async function nodeNames(
  ctx: Ctx,
  accountId: string,
  ids: readonly string[],
): Promise<Map<string, { name: string; parentId: string | null }>> {
  const client = clientOf(ctx);
  const found = new Map<string, { name: string; parentId: string | null }>();
  const size = client.maxObjectsInGet;
  for (let at = 0; at < ids.length; at += size) {
    const answer = await client.call<{ list?: FileNodeLike[] }>(
      FILENODE_GET,
      { accountId, ids: ids.slice(at, at + size), properties: FOLDER_PROPS },
      [FILENODE_CAP],
    );
    for (const node of answer.list ?? []) {
      if (typeof node.id !== "string" || typeof node.name !== "string") continue;
      found.set(node.id, {
        name: node.name,
        parentId: typeof node.parentId === "string" ? node.parentId : null,
      });
    }
  }
  return found;
}

/** A node's path from the account's root, or null when its chain is not all there. */
function pathOf(
  known: Map<string, { name: string; parentId: string | null }>,
  id: string,
): string | null {
  const names: string[] = [];
  const seen = new Set<string>();
  let at: string | null = id;
  while (at) {
    if (seen.has(at)) return null;
    seen.add(at);
    const node = known.get(at);
    if (!node) return null;
    names.unshift(node.name);
    at = node.parentId;
  }
  return names.join("/");
}
