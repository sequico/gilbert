/**
 * The catalogue as eight jobs (ADR 0038).
 *
 * Forty-five endpoint tools became eight, and every capability is a value of a
 * job or consciously dropped: `read` one known object, `find` what the account
 * holds, `place` something where it belongs, `draft` an outward message,
 * `event` a calendar, `say` in the conversation, `remember` a fact, `settle` a
 * workorder. The executors stay where they were, one per endpoint; a job routes
 * to one by its own `kind`/`action` and hands it the call's arguments, so the
 * validation, the authority and the answer remain the endpoint's.
 *
 * Three things this buys, and the reason the ADR pays for the rewrite:
 *
 * - **A provider accepts the names.** Function names match
 *   `^[a-zA-Z0-9_-]+$` on the providers this product speaks to, and `mail.find`
 *   is refused as an invalid name — the live eval of 2026-10-22 answered 400
 *   for exactly that. Eight bare words are legal everywhere.
 * - **The schema follows the areas.** `place` offers only the actions of the
 *   surfaces the run's instruction declared, and `draft`/`event`/`settle` are
 *   absent when their area is: a tool-level filter could not say which half of
 *   a job is allowed, and the values can (ADR 0038).
 * - **The guard reads the act, not the tool.** `place` files a message and
 *   destroys a folder: its authority comes from the endpoint the value names,
 *   through `authorityOf`, and the surface from `surfaceOf`.
 *
 * **The interface rules, in the words `aci.test.ts` holds the catalogue to:**
 *
 * - A name is one lowercase word containing no dot, because that is the
 *   provider's own pattern and a name it refuses costs a whole turn.
 * - One verb, one meaning: two tools that do one thing make the choice a
 *   lottery.
 * - A call is chosen by **one discriminator** — `kind` or `action` — whose every
 *   value appears in the job's description and carries its own schema branch, so
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
import { readRunTool } from "./runs.js";
import { listWorkorders, readWorkorder, settleStep } from "./workorders.js";

/** One value of a job: the endpoint it reaches, and the area that owns it. */
interface Route {
  tool: AnyTool;
  /** The area whose selection keeps this value, or null when every run has it. */
  area: AreaName | null;
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
  /** The argument that names the endpoint: `kind`, `action` or `what`. */
  discriminator: "kind" | "action" | "what";
  /** What the discriminator means, in the turn's words. */
  about: string;
  routes: Record<string, Route>;
  /** Whether the job changes anything (it does, except `read` and `find`). */
  writes: boolean;
  /** Values a narrowing keeps whichever areas are declared. */
  always?: boolean;
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
 * The parsed answer of a job call is `{ endpoint, args }`: the guard reads the
 * endpoint's authority, surface and wait through it, and the endpoint runs the
 * call. `narrow` builds the same job again with only the values the run's areas
 * keep — the catalogue's selection, one definition.
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
      argLine: () =>
        [
          `${spec.discriminator}: one of ${values.join(", ")}`,
          ...values.map((value) => {
            const one = routes[value];
            if (!one) return "";
            const keys = one.tool.keys.join(", ");
            return `; ${value} takes ${keys || "no other argument"}`;
          }),
        ].join(""),
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
        if (spec.always || areas === null) return tool;
        const kept: Record<string, Route> = {};
        for (const [value, route] of Object.entries(routes))
          if (route.area === null || areas.includes(route.area)) kept[value] = route;
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
    "`folders`, `events`, `calendars`, `chats`, `contacts`, `files`, `pages` or " +
    "`workorders` searches or lists, by a `query`, a `path` or a range, and " +
    "`search` looks for a knowledge page by words. The answer " +
    "carries the ids the next call takes.",
  discriminator: "what",
  about:
    "what to open: a message, an attachment, a file, an event, a page, a chat, a workorder, a run or the memory — or the plural, to search or list",
  writes: false,
  always: true,
  routes: {
    message: { tool: readMessage, area: "mail", set: true },
    attachment: { tool: readAttachment, area: "mail", set: true },
    file: { tool: readNode, area: "files", set: true },
    event: { tool: readEvent, area: "calendar", set: true },
    page: { tool: readKnowledgePage, area: "knowledge", set: true },
    chat: { tool: readChat, area: "chat", set: true },
    workorder: { tool: readWorkorder, area: "workorders", set: true },
    run: { tool: readRunTool, area: null },
    memory: { tool: memoryHistoryTool, area: "memory" },
    messages: { tool: findMessages, area: "mail" },
    folders: { tool: listMailboxes, area: "mail" },
    events: { tool: findEvents, area: "calendar" },
    calendars: { tool: listCalendars, area: "calendar" },
    chats: { tool: findChat, area: "chat" },
    contacts: { tool: findContacts, area: "contacts" },
    files: { tool: listFiles, area: "files" },
    pages: { tool: listKnowledge, area: "knowledge" },
    search: { tool: searchKnowledge, area: "knowledge" },
    workorders: { tool: listWorkorders, area: "workorders" },
  },
});

/**
 * Putting something where it belongs: the one job that spans two surfaces, so
 * its `action` decides both the endpoint and the area the guard reads.
 */
export const placeJob = job({
  name: "place",
  description:
    "Put something where it belongs. A message is filed (`file`), trashed " +
    "(`trash`), restored (`untrash`), tagged with a keyword (`keyword`) or a " +
    "label (`label`); a label catalogued (`labelDefine`); a mail folder made, " +
    "renamed or deleted (`mailFolder`, `renameFolder`, `deleteFolder`). A file " +
    "is saved (`save`), written over (`write`), replaced (`overwrite`), moved " +
    "(`moveFile`), renamed (`renameFile`), deleted (`deleteFile`), or a folder " +
    "made (`folder`). `action` says which, and the arguments are that action's.",
  discriminator: "action",
  about: "what to do with it",
  writes: true,
  routes: {
    file: { tool: fileMessage, area: "mail" },
    trash: { tool: trashMessage, area: "mail" },
    untrash: { tool: untrashMessage, area: "mail" },
    keyword: { tool: setKeyword, area: "mail" },
    label: { tool: defineLabel, area: "mail" },
    mailFolder: { tool: createMailFolder, area: "mail" },
    renameFolder: { tool: renameMailFolder, area: "mail" },
    deleteFolder: { tool: deleteMailFolder, area: "mail" },
    save: { tool: saveFile, area: "files" },
    write: { tool: writeDocument, area: "files" },
    overwrite: { tool: overwriteDocument, area: "files" },
    moveFile: { tool: moveFile, area: "files" },
    renameFile: { tool: renameFile, area: "files" },
    deleteFile: { tool: deleteDocument, area: "files" },
    folder: { tool: createFileFolder, area: "files" },
  },
});

/** One outward message, as a draft. No tool sends (ADR 0038). */
export const draftJob = job({
  name: "draft",
  description:
    "Write an outward message into this account's Drafts, or replace one you " +
    "wrote before. A draft is never sent: a person reads it and sends it. " +
    "`kind` is `reply` (to the message `id`, in its thread) or `edit` (replace " +
    "the draft `id` with these words, keeping its thread).",
  discriminator: "kind",
  about: "which draft: reply or edit",
  writes: true,
  routes: {
    reply: { tool: draftReply, area: "mail" },
    edit: { tool: editDraft, area: "mail" },
  },
});

/** A calendar event or a series, in one job. */
export const eventJob = job({
  name: "event",
  description:
    "Create a calendar event, change one, or cancel it. `action` is `create` " +
    "(a title and a start), `update` (the event `id` and the fields to change) " +
    "or `delete` (the event `id`).",
  discriminator: "action",
  about: "what to do: create, update or delete",
  writes: true,
  routes: {
    create: { tool: createEvent, area: "calendar" },
    update: { tool: updateEvent, area: "calendar" },
    delete: { tool: deleteEvent, area: "calendar" },
  },
});

/** Speaking in the conversation, or asking a person and waiting. */
export const sayJob = job({
  name: "say",
  description:
    "Speak in this group's conversation: `say` posts a message (a `replyTo` " +
    "keeps it in a thread); `ask` posts a question and parks this run until a " +
    "person answers it. A question is asked here and never by mail.",
  discriminator: "action",
  about: "say a message, or ask a question and wait",
  writes: true,
  always: true,
  routes: {
    say: { tool: sayInChat, area: "chat" },
    ask: { tool: askInChat, area: "chat" },
  },
});

/** Keeping one thing: a fact the installation remembers, or a knowledge page. */
export const rememberJob = job({
  name: "remember",
  description:
    "Keep one thing for later runs: `fact` records a fact about an entity in " +
    "the installation's memory — the entity's `subject`, the relation " +
    "(`predicate`, `is` unless it matters) and one sentence (`fact`), plus " +
    "`object` when the value is another entity and `entityKind` when the fact " +
    "creates the entity. What stays true beyond this change, never what happened once. " +
    "`page` proposes a knowledge page from the words you give, for a person to " +
    "accept. Neither grants anything.",
  discriminator: "kind",
  about: "a fact, or a knowledge page",
  writes: true,
  always: true,
  routes: {
    fact: { tool: rememberFactTool, area: "memory" },
    page: { tool: proposePage, area: "knowledge" },
  },
});

/** Closing a workorder step. */
export const settleJob = job({
  name: "settle",
  description:
    "Settle a step of one of this account's workorders: mark it done, skipped " +
    "or not-applicable, or open it again, with an optional note. The step is " +
    "named by its `uid` and its `path`, as `read workorder` answers them.",
  discriminator: "action",
  about: "settle the step",
  writes: true,
  routes: {
    settle: { tool: settleStep, area: "workorders" },
  },
});

/** The verbs, and the case's scratchpad, in the order a turn reads them. */
export const JOBS: readonly AnyTool[] = [
  openJob,
  noteTool,
  placeJob,
  draftJob,
  eventJob,
  sayJob,
  rememberJob,
  settleJob,
];
