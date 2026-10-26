/**
 * The catalogue as four verbs (ADR 0038).
 *
 * Forty-five endpoint tools are four, and every capability is a value of one or
 * consciously dropped: `open` what the account holds, `act` a change to it, `say`
 * in the conversation, `note` the case's scratchpad. The executors stay where they
 * were, one per endpoint; a verb routes to one by its own `what` or `action` and
 * hands it the call's arguments, so the validation, the authority and the answer
 * remain the endpoint's.
 *
 * Three things this buys, and the reason the ADR pays for the rewrite:
 *
 * - **A provider accepts the names.** Function names match
 *   `^[a-zA-Z0-9_-]+$` on the providers this product speaks to, and `mail.find`
 *   is refused as an invalid name — the live eval of 2026-10-22 answered 400
 *   for exactly that. Four bare words are legal everywhere.
 * - **The schema follows the areas.** `act` offers only the acts of the areas the
 *   run's instruction declared, and `page`/`fact`/`settle` are absent when their
 *   area is: a tool-level filter could not say which half of a verb is allowed,
 *   and the values can (ADR 0038).
 * - **The guard reads the act, not the tool.** `act` files a message and destroys
 *   a folder: its authority comes from the endpoint the value names, through
 *   `authorityOf`, and the surface from `surfaceOf`.
 *
 * **The interface rules, in the words `aci.test.ts` holds the catalogue to:**
 *
 * - A name is one lowercase word containing no dot, because that is the
 *   provider's own pattern and a name it refuses costs a whole turn.
 * - One verb, one meaning: two tools that do one thing make the choice a
 *   lottery.
 * - A call is chosen by **one discriminator** — `what` or `action` — whose every
 *   value appears in the verb's description and carries its own schema branch, so
 *   an argument of another route is refused before the step is paid for.
 * - **A refusal names what it accepts**: the values of the discriminator, or the
 *   argument it could not read; and a name the catalogue does not hold is
 *   answered with the nearest real one (`nearestTool` in `model.ts`).
 * - A tool answers a distillation, never the payload: what happened, and the id
 *   to use next.
 */

import type { AreaName } from "../../shared/areas.js";
import { argsRecord } from "./args.js";
import {
  createEvent,
  deleteEvent,
  findEvents,
  listCalendars,
  readEvent,
  updateEvent,
} from "./calendar.js";
import { askInChat, findChat, readChat, sayInChat } from "./chat.js";
import { findContacts } from "./contacts.js";
import {
  type AnyTool,
  type ArgSpec,
  argSchema,
  defineTool,
  ToolError,
} from "./define.js";
import {
  createFileFolder,
  deleteDocument,
  listFiles,
  moveFile,
  overwriteDocument,
  readNode,
  renameFile,
  saveFile,
  writeDocument,
} from "./files.js";
import {
  listKnowledge,
  proposePage,
  readKnowledgePage,
  searchKnowledge,
} from "./knowledge.js";
import {
  createMailFolder,
  defineLabel,
  deleteMailFolder,
  draftReply,
  editDraft,
  fileMessage,
  findMessages,
  listMailboxes,
  readAttachment,
  readMessage,
  renameMailFolder,
  setKeyword,
  trashMessage,
  untrashMessage,
} from "./mail.js";
import { memoryHistoryTool, rememberFactTool } from "./memory.js";
import { noteTool } from "./note.js";
import { printMessage } from "./print.js";
import { readBrief } from "./reader.js";
import { readRunTool } from "./runs.js";
import { listWorkorders, readWorkorder, settleStep } from "./workorders.js";

/** One value of a job: the endpoint it reaches, and the area that owns it. */
interface Route {
  tool: AnyTool;
  /**
   * The area whose selection keeps this value. Absent when every run has it: a
   * reading is free, so no reading value is ever narrowed away — only a write
   * names the area it needs (ADR 0038).
   */
  area?: AreaName;
  /**
   * Whether the value may name **several** objects at once, with `ids`: the job is
   * then run once per id and answers a list (R4's "a set answered in one call"). Only
   * reading values carry it — a set of acts is a plan, not one call.
   */
  set?: boolean;
}

/** The most objects one call opens at once. */
export const OPEN_SET_MAX = 10;

/** What every job has, and what a narrowed copy keeps. */
interface JobSpec {
  name: string;
  description: string;
  /** The argument that names the endpoint of a call. */
  discriminator: "action" | "what";
  /** What the discriminator means, in the turn's words. */
  about: string;
  routes: Record<string, Route>;
  /** Whether the job changes anything (it does, except `open`). */
  writes: boolean;
}

/** The arguments every route of a job takes, in one object. */
function unionArgs(routes: Record<string, Route>): Record<string, ArgSpec> {
  const args: Record<string, ArgSpec> = {};
  for (const { tool } of Object.values(routes))
    for (const [key, spec] of Object.entries(tool.args)) args[key] ??= spec;
  return args;
}

/** What one job call parses to: the endpoint it names and that endpoint's arguments. */
interface Routed {
  endpoint: AnyTool;
  args: unknown;
  /** The ids a set names; absent for a call that names one object. */
  ids?: string[];
  /** How many ids the call named, before the bound cut them. */
  named?: number;
  /** The raw arguments without the discriminator, for a set to parse per id. */
  rest?: Record<string, unknown>;
}

/** The endpoint one call names, with its arguments validated by the endpoint itself. */
function routeOf(spec: JobSpec, routes: Record<string, Route>, raw: unknown): Routed {
  const held = argsRecord(raw);
  const value = held[spec.discriminator];
  const values = Object.keys(routes);
  if (typeof value !== "string" || !value.trim())
    throw new ToolError(
      "bad_arguments",
      `"${spec.name}" needs a "${spec.discriminator}": one of ${values.join(", ")}.`,
    );
  const route = routes[value.trim()];
  if (!route)
    throw new ToolError(
      "bad_arguments",
      `"${value.trim()}" is not a "${spec.discriminator}" of "${spec.name}": one of ${values.join(", ")}.`,
    );
  const rest = { ...held };
  delete rest[spec.discriminator];
  /*
   * Several objects at once (R4): a reading value may name `ids`, and the job runs the
   * endpoint once for each. The endpoint's own parser is asked per id at run time, so a
   * set is never validated against one object's arguments.
   */
  if (route.set && Array.isArray(rest.ids)) {
    const named = rest.ids.filter(
      (id): id is string => typeof id === "string" && id.trim() !== "",
    );
    const ids = named.slice(0, OPEN_SET_MAX);
    if (!ids.length)
      throw new ToolError(
        "bad_arguments",
        `"${value.trim()}" with "ids" needs at least one id.`,
      );
    delete rest.ids;
    return { endpoint: route.tool, args: {}, ids, named: named.length, rest };
  }
  return { endpoint: route.tool, args: route.tool.parse(rest) };
}

/**
 * One job, built from its routes.
 *
 * The parsed answer of a job call is a `Routed`: the endpoint the call names, and
 * the endpoint's own validated arguments — or, for a set, the ids it named and the
 * rest of the arguments, parsed per id as each is run. The guard reads the
 * endpoint's authority, surface and wait through it. `narrow` builds the same job
 * again with only the values the run's areas keep — the catalogue's selection, one
 * definition.
 */
function job(spec: JobSpec): AnyTool {
  const build = (routes: Record<string, Route>): AnyTool | null => {
    const values = Object.keys(routes);
    if (!values.length) return null;
    const args: Record<string, ArgSpec> = {
      [spec.discriminator]: {
        type: "one of",
        values,
        about: spec.about,
      },
      ...unionArgs(routes),
    };
    if (values.some((value) => routes[value]?.set))
      args.ids = {
        type: "list",
        about: `several at once, when the value takes them (at most ${OPEN_SET_MAX})`,
      };
    const tool = defineTool<Routed>({
      name: spec.name,
      description: spec.description,
      authority: "reversible",
      authorityOf: (parsed) => parsed.endpoint.authorityOf(parsed.args),
      writes: spec.writes,
      surfaceOf: (parsed) => parsed.endpoint.surfaceOf(parsed.args),
      waitsOf: (parsed) => parsed.endpoint.waitsOf(parsed.args),
      // Reading is free; an act takes the step (ADR 0027, 0038).
      spend: spec.writes ? { steps: 1 } : {},
      args,
      /*
       * One branch per value, so the provider refuses `path` on a mail search
       * before the endpoint does: a single object with every route's keys would
       * say that a mail search takes a `path`, which is exactly the refusal the
       * live eval paid for (2026-10-22). The `required` keys are the endpoint
       * parser's question and are not stated twice here.
       */
      parameters: () => ({
        type: "object",
        oneOf: values.map((value) => ({
          properties: {
            [spec.discriminator]: { type: "string", enum: [value] },
            ...(routes[value]?.set ? { ids: argSchema({ type: "list" }) } : {}),
            ...Object.fromEntries(
              Object.entries(routes[value]?.tool.args ?? {}).map(([key, one]) => [
                key,
                argSchema(one),
              ]),
            ),
          },
          // The discriminator is the one argument a call cannot leave out: the
          // endpoint is chosen by it, and a provider can refuse its absence
          // before the step is paid for (the eval recorded a `say` without one).
          required: [spec.discriminator],
          additionalProperties: false,
        })),
      }),
      parse: (raw) => routeOf(spec, routes, raw),
      act: (parsed) => parsed.endpoint.act(parsed.args),
      run: async (call, parsed) => {
        /*
         * Several objects at once: one call, one row per id, and the endpoint's own
         * parser and answer for each. A set is bounded, and says so when it is cut.
         */
        if (parsed.ids && parsed.rest) {
          const items: unknown[] = [];
          for (const id of parsed.ids)
            items.push(
              await parsed.endpoint.run(
                call,
                parsed.endpoint.parse({ ...parsed.rest, id }),
              ),
            );
          return {
            items,
            total: items.length,
            truncated: (parsed.named ?? items.length) > items.length,
          };
        }
        return await parsed.endpoint.run(call, parsed.args);
      },
    });
    return {
      ...tool,
      narrow: (areas) => {
        /*
         * Reading is free: the selection narrows what a run may **change**, never
         * what it may look at, so a reading verb is offered whole (ADR 0038).
         */
        if (!spec.writes || areas === null) return tool;
        const kept: Record<string, Route> = {};
        for (const [value, route] of Object.entries(routes))
          if (route.area === undefined || areas.includes(route.area)) kept[value] = route;
        return build(kept);
      },
    };
  };
  const built = build(spec.routes);
  if (!built) throw new Error(`The job "${spec.name}" has no routes.`);
  return built;
}

/**
 * Reading is free: one verb opens what the account holds (R4).
 *
 * `what` names the object — a message, a file, a page, a folder, a thread's messages —
 * and the **singular** values open one object by `id`, or several of them by `ids` in
 * one call, while the **plural** ones search or list. That grammar is the whole of what
 * a run has to learn: `message`/`messages`, `page`/`pages`, `file`/`files`, and so on.
 * The endpoint behind each value is unchanged, so the validation, the authority and the
 * answer remain the endpoint's.
 */
export const openJob = job({
  name: "open",
  description:
    "Open what this account holds. `what` is the object: `message`, `attachment`, " +
    "`file`, `event`, `page`, `chat`, `workorder`, `run` or `memory` opens one by " +
    "`id` — or several at once by `ids`, answered as a list — and `messages`, " +
    "`folders`, `events`, `calendars`, `chats`, `contacts`, `files`, `pages`, " +
    "`search` or `workorders` searches or lists, by a `query`, a `path` or a range. " +
    "`brief` asks one question about the account (`question`, and `about` what it " +
    "concerns) and is answered in a few lines, by a reader that reads what it needs " +
    "itself. The answer carries the ids the next call takes.",
  discriminator: "what",
  about:
    "what to open: a message, an attachment, a file, an event, a page, a chat, a workorder, a run, the memory or a brief — or the plural, to search or list",
  writes: false,
  routes: {
    message: { tool: readMessage, set: true },
    attachment: { tool: readAttachment, set: true },
    file: { tool: readNode, set: true },
    event: { tool: readEvent, set: true },
    page: { tool: readKnowledgePage, set: true },
    chat: { tool: readChat, set: true },
    workorder: { tool: readWorkorder, set: true },
    run: { tool: readRunTool },
    memory: { tool: memoryHistoryTool },
    brief: { tool: readBrief },
    messages: { tool: findMessages },
    folders: { tool: listMailboxes },
    events: { tool: findEvents },
    calendars: { tool: listCalendars },
    chats: { tool: findChat },
    contacts: { tool: findContacts },
    files: { tool: listFiles },
    pages: { tool: listKnowledge },
    search: { tool: searchKnowledge },
    workorders: { tool: listWorkorders },
  },
});

/**
 * One verb changes the account (R4).
 *
 * `what` is the act, not the endpoint: file a message where it belongs, save or write
 * a file, write an outward message as a draft, schedule or cancel an event, keep a
 * fact, propose a page, settle a workorder step. The endpoint behind each value is
 * unchanged, so the class of the act, the surface it writes and the wait it takes are
 * still read from the endpoint itself (`authorityOf`, `surfaceOf`, `waitsOf`), and the
 * areas narrow the values by the area the instruction declares.
 */
export const actJob = job({
  name: "act",
  description:
    "Change what this account holds. `what` is the act: a message is `file`d, " +
    "`trash`ed, `untrash`ed, given a `keyword` or a `label`, `print`ed to a PDF in " +
    "Files, and a mail folder is `mailFolder` (make it one), `mailFolderRename` or " +
    "`mailFolderDelete`; a file is `save`d, `write` (a document's words are replaced), " +
    "`overwrite`d, `move`d, `rename`d, `delete`d, or a folder made with `folder`; an " +
    "outward message is `reply` (a draft in the message's thread) or `edit` (replace a " +
    "draft you wrote); an event is `schedule`d, `reschedule`d or `cancel`led; a `fact` " +
    "or a `page` is kept for later runs; a workorder step is `settle`d. Nothing is " +
    "sent: an outward message leaves as a draft a person sends.",
  discriminator: "what",
  about:
    "the act: file, trash, untrash, keyword, label, print, mailFolder, mailFolderRename, mailFolderDelete, save, write, overwrite, move, rename, delete, folder, reply, edit, schedule, reschedule, cancel, fact, page or settle",
  writes: true,
  routes: {
    file: { tool: fileMessage, area: "mail" },
    trash: { tool: trashMessage, area: "mail" },
    untrash: { tool: untrashMessage, area: "mail" },
    keyword: { tool: setKeyword, area: "mail" },
    label: { tool: defineLabel, area: "mail" },
    print: { tool: printMessage, area: "files" },
    mailFolder: { tool: createMailFolder, area: "mail" },
    mailFolderRename: { tool: renameMailFolder, area: "mail" },
    mailFolderDelete: { tool: deleteMailFolder, area: "mail" },
    save: { tool: saveFile, area: "files" },
    write: { tool: writeDocument, area: "files" },
    overwrite: { tool: overwriteDocument, area: "files" },
    move: { tool: moveFile, area: "files" },
    rename: { tool: renameFile, area: "files" },
    delete: { tool: deleteDocument, area: "files" },
    folder: { tool: createFileFolder, area: "files" },
    reply: { tool: draftReply, area: "mail" },
    edit: { tool: editDraft, area: "mail" },
    schedule: { tool: createEvent, area: "calendar" },
    reschedule: { tool: updateEvent, area: "calendar" },
    cancel: { tool: deleteEvent, area: "calendar" },
    fact: { tool: rememberFactTool, area: "memory" },
    page: { tool: proposePage, area: "knowledge" },
    settle: { tool: settleStep, area: "workorders" },
  },
});

/**
 * Speaking in the conversation, or asking a person and waiting.
 *
 * The one verb that is a conversation rather than the account: `say` posts a message
 * (a `replyTo` keeps it in a thread), `ask` posts a question and parks the run until a
 * person answers. A question is asked here and never by mail.
 */
export const sayJob = job({
  name: "say",
  description:
    "Speak in this group's conversation: `say` posts a message (a `replyTo` " +
    "keeps it in a thread); `ask` posts a question and parks this run until a " +
    "person answers it. A question is asked here and never by mail.",
  discriminator: "action",
  about: "say a message, or ask a question and wait",
  writes: true,
  routes: {
    say: { tool: sayInChat },
    ask: { tool: askInChat },
  },
});

/** The four verbs and the case's scratchpad, in the order a turn reads them. */
export const JOBS: readonly AnyTool[] = [openJob, noteTool, actJob, sayJob];
