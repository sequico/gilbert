/**
 * What changed in a group's own account (ADR 0035).
 *
 * A rule watches the activity of the group's own account: the mail that arrived
 * or was sent, the pages and checklist templates written in its KB, the
 * messages posted in its chat, the writes to its own workorders, and everything
 * else written in its Files. This module names that description once, beside
 * the reader that fills it (`events.ts`), so the events the agent reads out of
 * the server and what a rule says it watches are the same vocabulary — a shape
 * declared a second time would drift from the first the day one of them gains a
 * source.
 *
 * An event says **what** changed and **where it is**, and never carries the
 * object itself: the payload is Stalwart's, and whoever acts on an event reads
 * it by the reference when a rule asks for it. That is what keeps a burst of
 * mail out of the process's memory, and it is what makes one description enough
 * for every surface a rule can watch.
 *
 * `source` is the group's own vocabulary rather than the protocol's: the five
 * surfaces ADR 0035 lists are answered as five, and the three of them that live
 * in Files are told apart by the folder a node sits in. `eventSourceOf` is the
 * one place that decides, and it reads the folder's own name rather than a
 * second spelling of the path.
 */

import { APP_FOLDER_NAME } from "../shared/appFolder.js";
import { CHAT_FOLDER } from "../shared/chat.js";
import { KNOWLEDGE_FOLDER } from "../shared/knowledge.js";
import { WORKORDER_FOLDER } from "../shared/workorder.js";

/**
 * A surface of a group's own account that activity happens on (ADR 0031, 0035).
 *
 * The five the records name: its `chat`, its `mail`, its `knowledge` base, its
 * `workorder`s and its `files`. A chat message, a KB page and a workorder are
 * Files nodes like any other — the folder a node sits in is the whole of what
 * makes it what it is — but each is a surface of its own to a rule that watches
 * it, so a node outside those three folders is simply `files`.
 */
export type AccountEventSource = "mail" | "files" | "chat" | "workorder" | "knowledge";

/**
 * What happened to the object: it appeared, it changed, or it was removed.
 *
 * A create and a later update of the same node are one event, named `created`
 * (`events.ts`, ADR 0034): the reading folds the two changes of one address.
 */
export type AccountEventChange = "created" | "updated" | "destroyed";

/**
 * One thing that changed in a group's account.
 *
 * `where` is the object's address in its own surface: the id of a message, or
 * the path of a node — app-folder-relative under the `gilbert` folder, the
 * account's own path for a node in the visible tree. A node the server has
 * already destroyed has no address left to read, and such an event carries the
 * node's **id** unless the reader already read its path while the node was
 * there: the removal is reported either way, because a removal is activity, and
 * the surface it happened on is the one its former path belonged to.
 */
export interface AccountEvent {
  source: AccountEventSource;
  change: AccountEventChange;
  where: string;
}

/**
 * Which surface a node's path belongs to.
 *
 * A chat message, a KB page and a workorder are Files nodes like any other —
 * the folder they live in is the whole of what makes them what they are — so
 * the test is that folder's own name (`CHAT_FOLDER`, `KNOWLEDGE_FOLDER`,
 * `WORKORDER_FOLDER`), never a second spelling of it. `chat-state` is
 * deliberately not chat: it holds read markers, and a marker moving is not a
 * message anybody wrote.
 */
export function eventSourceOf(path: string): AccountEventSource {
  const under = (folder: string): boolean =>
    path.startsWith(`${APP_FOLDER_NAME}/${folder}/`);
  if (under(CHAT_FOLDER)) return "chat";
  if (under(KNOWLEDGE_FOLDER)) return "knowledge";
  if (under(WORKORDER_FOLDER)) return "workorder";
  return "files";
}
