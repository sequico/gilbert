/**
 * What changed in a group's own account (ADR 0031, 0038).
 *
 * The group's instruction is woken by the activity of its own account: the mail
 * that arrived, the pages and checklist templates written in its KB, the messages
 * posted in its chat, the writes to its own workorders, and everything else
 * written in its Files. This module names that description once, beside
 * the reader that fills it (`events.ts`), so the events the agent reads out of
 * the server and what a surface matrix names are the same vocabulary — a shape
 * declared a second time would drift from the first the day one of them gains a
 * source.
 *
 * An event says **what** changed and **where it is**, and never carries the
 * object itself: the payload is Stalwart's, and whoever acts on an event reads
 * it by the reference when the work needs it. That is what keeps a burst of
 * mail out of the process's memory, and it is what makes one description enough
 * for every surface an instruction can work.
 *
 * `source` is the group's own vocabulary rather than the protocol's: the five
 * **event** surfaces are answered as five, and the three of them that live in
 * Files are told apart by the folder a node sits in. `eventSourceOf` is the one
 * place that decides, and it reads the folder's own name rather than a second
 * spelling of the path. A surface matrix also names **calendar**, whose change
 * log is not read yet: no event carries it (ADR 0031).
 */

import { APP_FOLDER_NAME } from "../shared/appFolder.js";
import { CHAT_FOLDER } from "../shared/chat.js";
import { KNOWLEDGE_FOLDER } from "../shared/knowledge.js";
import type { SurfaceName } from "../shared/surfaces.js";
import { WORKORDER_FOLDER } from "../shared/workorder.js";

/**
 * A surface of a group's own account that activity happens on (ADR 0027, 0031).
 *
 * The six the records name — `chat`, `mail`, `knowledge`, `workorder`, `files`
 * and `calendar` — are the surfaces of the matrix that says where a run may act
 * (`shared/surfaces.ts`), so this is that vocabulary, not a second copy of it. A
 * chat message, a KB page and a workorder are Files nodes like any other — the
 * folder a node sits in is the whole of what makes it what it is — but each is a
 * surface of its own to the work that names it, so a node outside those three
 * folders is simply `files`. A calendar event is not a node: it is read from its
 * own log (`CalendarEvent/changes`), so its surface is the one the reading names.
 */
export type AccountEventSource = SurfaceName;

/**
 * What happened to the object: it appeared, it changed, or it was removed.
 *
 * A create and a later update of the same node are one event, named `created`
 * (`events.ts`, ADR 0030): the reading folds the two changes of one address.
 *
 * Mail is the one surface that only ever answers `created`: a rule watching mail
 * is woken by a message that **arrived** — created and in the Inbox — so reading,
 * marking, filing and removing a message are not events at all (`events.ts`,
 * ADR 0031).
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
  /**
   * The files a batched drop brought, when one event stands for a burst
   * (`queue.ts`): the folder is `where`, and these are its contents.
   */
  also?: readonly string[];
  /** When a batched drop opened; part of what makes it a run of its own. */
  at?: string;
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
