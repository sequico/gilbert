/**
 * What a group's account changed, read from the server's own change logs
 * (ADR 0035).
 *
 * The installation holds a push subscription (ADR 0016), and a `StateChange`
 * names an account whose data moved. This is the reading that turns that
 * notification into the group's own vocabulary: mail that arrived or was sent,
 * and the nodes written in its Files — chat messages, workorders and everything
 * else among them — each handed back as a reference
 * (`@gilbert/shared/accountEvent`), never as the object itself.
 *
 * **Where the reading stands is the server's own state token, not a clock.**
 * JMAP answers `/changes` from a `sinceState` and hands back the state that
 * follows it as `newState`; the cursor is exactly those two tokens, one per
 * data type. A change is therefore reported once and the next read resumes
 * after it — there is no window, no timestamp and no overlap to reconcile, and
 * asking for a change that is behind the server's own log is refused rather
 * than answered as "nothing changed".
 *
 * A log that answers **part** of a window is refused too: its `newState` is
 * where the rest of the window would resume, and this reading does not page a
 * log, so advancing the cursor onto a partial window would drop the unanswered
 * changes without a word. A window a server answers whole is the window this
 * reads.
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
import {
  type AccountEvent,
  type AccountEventChange,
  eventSourceOf,
} from "../shared/accountEvent.js";
import { FILENODE_CHANGES, FILENODE_GET, FOLDER_PROPS } from "../shared/appFolder.js";
import { CAPABILITIES } from "../shared/capabilities.js";
import { clientOf } from "../util.js";

/** Where an account's reading has reached: one server state token per data type. */
export interface EventCursor {
  /** The Email state the last read ended at. */
  mail: string;
  /** The FileNode state the last read ended at. */
  files: string;
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
  return { mail: mail.state, files: await appFolderState(ctx, accountId) };
}

/** One `/changes` answer, as this build can use it. */
interface ChangeSet {
  created: string[];
  updated: string[];
  destroyed: string[];
  newState: string;
}

function changeSetOf(args: Record<string, unknown>, type: string): ChangeSet {
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
  // A log with more to say was answered only in part, and the state it hands
  // back is the resume point for the rest of it. Advancing the cursor onto a
  // partial window would drop what was not answered without a word, so this
  // build reads a window whole and refuses rather than doing that.
  if (args.hasMoreChanges === true)
    throw new Error(
      `The ${type} change log answered only part of the window, and this reading does not page it.`,
    );
  return {
    created: ids("created"),
    updated: ids("updated"),
    destroyed: ids("destroyed"),
    newState: args.newState,
  };
}

/**
 * What the account changed since `cursor`.
 *
 * Both logs are asked in one request: this is one question about one account,
 * and a notification that woke the agent for mail must not cost a second round
 * trip for the files that moved in the same instant. The two answers are read
 * together and a refusal of either is a refusal of the reading — half an answer
 * cannot advance the cursor without re-reporting the other half, which is the
 * one thing this must never do.
 */
export async function readAccountEvents(
  ctx: Ctx,
  accountId: string,
  cursor: EventCursor,
): Promise<AccountEvents> {
  const answered = await clientOf(ctx).chain(
    [
      ["Email/changes", { accountId, sinceState: cursor.mail }, "mail"],
      [FILENODE_CHANGES, { accountId, sinceState: cursor.files }, "files"],
    ],
    [CAPABILITIES.mail, FILENODE_CAP],
  );
  const mail = changeSetOf(answered.args("mail"), "Email");
  const files = changeSetOf(answered.args("files"), "FileNode");
  const paths = await nodePaths(ctx, accountId, [
    ...files.created,
    ...files.updated,
    ...files.destroyed,
  ]);

  const events: AccountEvent[] = [];
  for (const change of ["created", "updated", "destroyed"] as const) {
    for (const id of mail[change]) events.push({ source: "mail", change, where: id });
    for (const id of files[change]) {
      const path = paths.get(id);
      events.push(
        path
          ? { source: eventSourceOf(path), change, where: path }
          : { source: "files", change, where: id },
      );
    }
  }
  return { events, cursor: { mail: mail.newState, files: files.newState } };
}

/**
 * The path of every node named, where one can still be read.
 *
 * A node's path is not a property: JMAP answers a node's name and its parent,
 * and the path is the names of the chain above it — so this walks up one level
 * at a time, asking for a whole level's nodes in one `/get` rather than one
 * node per call. A node the server no longer holds (a destroyed one) has no
 * path, and neither has one whose parent is missing: half a chain would name a
 * node as something it is not.
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
