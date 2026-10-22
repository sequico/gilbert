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
import { readRunTool } from "./runs.js";
import { listWorkorders, readWorkorder, settleStep } from "./workorders.js";

/** One value of a job: the endpoint it reaches, and the area that owns it. */
interface Route {
  tool: AnyTool;
  /** The area whose selection keeps this value, or null when every run has it. */
  area: AreaName | null;
}

/** What every job has, and what a narrowed copy keeps. */
interface JobSpec {
  name: string;
  description: string;
  /** The argument that names the endpoint: `kind` or `action`. */
  discriminator: "kind" | "action";
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
            ...Object.fromEntries(
              Object.entries(routes[value]?.tool.args ?? {}).map(([key, one]) => [
                key,
                argSchema(one),
              ]),
            ),
          },
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
      run: async (call, parsed) => await parsed.endpoint.run(call, parsed.args),
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

/** Reading is free: every area's objects are `read`-able, whoever the run is. */
export const readJob = job({
  name: "read",
  description:
    "Read one known object by its id or path: a message, one of a message's " +
    "attachments, a file, a calendar event, a knowledge page, a chat message, " +
    "a workorder, one of this account's runs, or what the installation's " +
    "memory has held about one entity over time (`kind: memory` — the entity's " +
    "`subject`, and optionally `from`/`to`). Choose what it is in `kind`, and " +
    "give the id that `find` answered for that kind.",
  discriminator: "kind",
  about:
    "what the object is: message, attachment, file, event, knowledge, chat, workorder, run or memory",
  writes: false,
  always: true,
  routes: {
    message: { tool: readMessage, area: "mail" },
    attachment: { tool: readAttachment, area: "mail" },
    file: { tool: readNode, area: "files" },
    event: { tool: readEvent, area: "calendar" },
    knowledge: { tool: readKnowledgePage, area: "knowledge" },
    chat: { tool: readChat, area: "chat" },
    workorder: { tool: readWorkorder, area: "workorders" },
    run: { tool: readRunTool, area: null },
    memory: { tool: memoryHistoryTool, area: "memory" },
  },
});

/** Finding is free too, and one job answers every surface the account holds. */
export const findJob = job({
  name: "find",
  description:
    "Ask this account what it holds. `kind` is what to look among: mail " +
    "messages by the mail client's own search words, the mail folders, the " +
    "calendar events in a range, the calendars, the conversation's messages, " +
    "the address book, the files of a folder, the knowledge pages (by a query, " +
    "or all of them), or the workorders. Answers ids and the few fields that " +
    "let you choose what to read next.",
  discriminator: "kind",
  about:
    "what to search: mail, folders, calendar, calendars, chat, contacts, files, knowledge, pages or workorders",
  writes: false,
  always: true,
  routes: {
    mail: { tool: findMessages, area: "mail" },
    folders: { tool: listMailboxes, area: "mail" },
    calendar: { tool: findEvents, area: "calendar" },
    calendars: { tool: listCalendars, area: "calendar" },
    chat: { tool: findChat, area: "chat" },
    contacts: { tool: findContacts, area: "contacts" },
    files: { tool: listFiles, area: "files" },
    knowledge: { tool: searchKnowledge, area: "knowledge" },
    pages: { tool: listKnowledge, area: "knowledge" },
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

/** One outward message, as a draft. No tool sends (ADR 0041). */
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

/** The eight jobs, in the order a turn reads them. */
export const JOBS: readonly AnyTool[] = [
  readJob,
  findJob,
  placeJob,
  draftJob,
  eventJob,
  sayJob,
  rememberJob,
  settleJob,
];
