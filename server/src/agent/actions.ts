/**
 * The capability runner: the only place an automation's effects happen.
 *
 * ADR 0003 resolution 2: every effect is a named, capability-gated action, the
 * rule names the ones it may run, and a model never widens them. This module
 * implements the catalogue in `documents.ts` against Stalwart over JMAP — one
 * function per name — and refuses the first thing it cannot do instead of
 * doing part of the work quietly.
 *
 * Two refusals are load-bearing. A `G-` keyword is applied only when the
 * group's own `labels.json` defines it (resolution 9: a keyword nobody renders
 * is a state nobody can see). A `mail.draft` leaves the draft **unread**
 * (resolution 10: a pending draft is one a human has to see).
 */

import { randomUUID } from "node:crypto";
import { readGroupLabels } from "../account.js";
import {
  type Ctx,
  readVisibleFileBytes,
  unusedVisibleName,
  writeBytesIntoVisibleFolder,
} from "../appFolder.js";
import { JMAP_MAIL, JMAP_SUBMISSION, JmapClient } from "../jmap.js";
import { mentionsFromText } from "../shared/chat.js";
import { accountOwnIdentity } from "../shared/identityAssignment.js";
import {
  GROUP_LABELS_FILE,
  isAgentLabel,
  type LabelCatalogEntry,
  missingAgentLabels,
} from "../shared/labels.js";
import { textSignatureBlock } from "../shared/signature.js";
import { postMessage } from "./chat.js";
import {
  DOCUMENT_TEXT_MAX,
  DocumentError,
  type DocumentKind,
  type DocumentRead,
  documentKindOf,
  extractPages,
  mergePdfs,
  pdfPageCount,
  readDocument,
  splitPdf,
} from "./documentFamily.js";
import {
  AGENT_ATTENTION_FOLDER,
  AGENT_DOCUMENT_BYTES_MAX,
  AGENT_MAX_PAGES_DEFAULT,
  AGENT_NOTEBOOK_FACT_MAX,
  AGENT_NOTEBOOK_FACTS_MAX,
  AGENT_SPLIT_PAGES_MAX,
  type AgentAction,
  type AgentActionName,
  type AgentDraftRef,
  type AgentEmailView,
  type AgentNotebookFact,
  missingActionParams,
} from "./documents.js";
import { AgentStore } from "./store.js";

export interface ActionOpts {
  /** The message the run works on: `keyword.*`, `mail.move`, `mail.extract`. */
  emailId?: string;
  /** The agent's own address, which `chat.post` writes as. */
  from?: string;
  /** The message a chat post answers. */
  replyTo?: string;
  /** The chat's participants, so `@` mentions in a posted text are recorded. */
  participants?: ReadonlyArray<string>;
  /** The draft a paused run already prepared, which `mail.send` submits. */
  draftEmailId?: string;
  draftMailboxId?: string;
  /**
   * The path of the file this run was woken by, in the group's own Files.
   *
   * A document action that names no file works on this one: the run that a
   * file woke is the run that has it in hand, and the model names the file it
   * read in its context back the same way.
   */
  filePath?: string;
  /**
   * How many pages of a document this run reads, as the installation set it.
   *
   * The run's bound rather than one action's: `document.read` reads at most
   * this many pages, and the same number is what a run's prompt states, so what
   * the model is told and what the action reads cannot disagree (ADR 0003).
   */
  maxPages?: number;
  /** The instant the run works from, so a test can pin what a draft records. */
  now?: Date;
}

export interface ActionResult {
  action: AgentActionName;
  ok: true;
  result?: Record<string, unknown>;
}

/** An Email as this module and the executor both read it. */
export interface EmailRecord {
  id?: unknown;
  threadId?: unknown;
  mailboxIds?: Record<string, unknown> | null;
  keywords?: Record<string, unknown> | null;
  receivedAt?: unknown;
  size?: unknown;
  subject?: unknown;
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  preview?: unknown;
  textBody?: unknown;
  bodyValues?: unknown;
  attachments?: unknown;
  bodyStructure?: unknown;
}

interface SetResponse {
  created?: Record<string, { id?: unknown }>;
  notCreated?: Record<string, { description?: unknown; type?: unknown }>;
}

/* ------------------------------------------------------------------ */
/* Email reads — one shape, one fetch                                  */
/* ------------------------------------------------------------------ */

const EMAIL_LIST_PROPS = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "receivedAt",
  "size",
  "subject",
  "from",
  "to",
  "cc",
  "preview",
];

const EMAIL_BODY_PROPS = ["textBody", "bodyValues"];

/**
 * One message as a filter or a model reads it. The body is only asked for when
 * the caller needs it: matching runs against headers and the preview, and the
 * body is read for the run that actually acts on the message.
 */
export async function fetchEmailView(
  client: JmapClient,
  accountId: string,
  id: string,
  opts: { body?: boolean } = {},
): Promise<AgentEmailView | null> {
  const record = await fetchEmailRecord(client, accountId, id, {
    body: opts.body === true,
  });
  return record ? emailViewOf(record) : null;
}

/** The raw `Email/get` record, for the callers that need more than the view. */
export async function fetchEmailRecord(
  client: JmapClient,
  accountId: string,
  id: string,
  opts: { body?: boolean; properties?: ReadonlyArray<string> } = {},
): Promise<EmailRecord | null> {
  const properties = [
    ...EMAIL_LIST_PROPS,
    ...(opts.properties ?? []),
    ...(opts.body ? EMAIL_BODY_PROPS : []),
  ];
  const args: Record<string, unknown> = { accountId, ids: [id], properties };
  if (opts.body) {
    // RFC 8621: `bodyValues` is only handed over for the parts named here.
    args.bodyProperties = ["text/plain"];
    args.fetchTextBodyValues = true;
  }
  const res = await client.call<{ list?: EmailRecord[] }>("Email/get", args, [JMAP_MAIL]);
  return res.list?.[0] ?? null;
}

/** The `AgentEmailView` of a raw record — the one mapping, used by the executor. */
export function emailViewOf(record: EmailRecord): AgentEmailView {
  const view: AgentEmailView = { id: String(record.id) };
  if (record.mailboxIds && typeof record.mailboxIds === "object") {
    view.mailboxIds = stringFlags(record.mailboxIds);
  }
  if (record.keywords && typeof record.keywords === "object") {
    view.keywords = stringFlags(record.keywords);
  }
  if (typeof record.receivedAt === "string") view.receivedAt = record.receivedAt;
  if (typeof record.size === "number") view.size = record.size;
  if (typeof record.subject === "string") view.subject = record.subject;
  if (Array.isArray(record.from)) view.from = addressesOf(record.from);
  if (Array.isArray(record.to)) view.to = addressesOf(record.to);
  if (Array.isArray(record.cc)) view.cc = addressesOf(record.cc);
  view.body = emailBodyText(record);
  return view;
}

/** The message's plain-text body, or its preview when the parts carry none. */
export function emailBodyText(record: EmailRecord): string {
  const values =
    record.bodyValues && typeof record.bodyValues === "object"
      ? (record.bodyValues as Record<string, { value?: unknown }>)
      : {};
  const parts = Array.isArray(record.textBody)
    ? (record.textBody as Array<{ partId?: unknown }>)
    : [];
  for (const part of parts) {
    const value = values[String(part.partId)]?.value;
    if (typeof value === "string") return value;
  }
  for (const value of Object.values(values)) {
    if (typeof value?.value === "string") return value.value;
  }
  return typeof record.preview === "string" ? record.preview : "";
}

function stringFlags(source: Record<string, unknown>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(source)) out[key] = value === true;
  return out;
}

function addressesOf(
  list: ReadonlyArray<unknown>,
): Array<{ name?: string; email?: string }> {
  const out: Array<{ name?: string; email?: string }> = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const address = entry as { name?: unknown; email?: unknown };
    const parsed: { name?: string; email?: string } = {};
    if (typeof address.name === "string" && address.name) parsed.name = address.name;
    if (typeof address.email === "string") parsed.email = address.email;
    out.push(parsed);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The label guard                                                     */
/* ------------------------------------------------------------------ */

/** The `G-` keywords an action names, in the order it names them. */
function agentKeywordsOf(action: AgentAction): string[] {
  if (action.do !== "keyword.add" && action.do !== "keyword.remove") return [];
  const keyword = textOf(action.with?.keyword);
  return keyword && isAgentLabel(keyword) ? [keyword] : [];
}

async function catalogOf(ctx: Ctx, accountId: string): Promise<LabelCatalogEntry[]> {
  /*
   * The group's own reader, not a second one: this module used to read the
   * document again, with the agent's own idea of what a catalog is. A document
   * the validator refuses answers no labels here, which is the conservative
   * half — the guard below refuses a keyword the catalog does not define.
   */
  const read = await readGroupLabels(ctx, accountId);
  return read.state === "catalog" ? read.labels : [];
}

/**
 * The `G-` keywords these actions name that the account's label catalog does
 * not define. The executor asks this before it starts acting on a run; the
 * runner asks it again per action, so a caller that skipped the pre-check still
 * cannot apply a label nobody renders.
 */
export async function undefinedAgentLabels(
  ctx: Ctx,
  accountId: string,
  actions: ReadonlyArray<AgentAction>,
): Promise<string[]> {
  const keywords = actions.flatMap(agentKeywordsOf);
  if (!keywords.length) return [];
  return missingAgentLabels(await catalogOf(ctx, accountId), keywords);
}

async function assertAgentLabelsDefined(
  ctx: Ctx,
  accountId: string,
  keywords: ReadonlyArray<string>,
): Promise<void> {
  const missing = missingAgentLabels(await catalogOf(ctx, accountId), keywords);
  if (missing.length)
    throw new Error(
      `the group's ${GROUP_LABELS_FILE} does not define ${missing.join(", ")}; a keyword ` +
        "outside the catalog is not rendered, so applying it would be a state nobody can see",
    );
}

/* ------------------------------------------------------------------ */
/* Mailbox lookups                                                     */
/* ------------------------------------------------------------------ */

interface MailboxRecord {
  id?: unknown;
  name?: unknown;
  role?: unknown;
}

async function mailboxesOf(
  client: JmapClient,
  accountId: string,
  ids: string[] | null,
): Promise<MailboxRecord[]> {
  const res = await client.call<{ list?: MailboxRecord[] }>(
    "Mailbox/get",
    { accountId, ids, properties: ["id", "name", "role"] },
    [JMAP_MAIL],
  );
  return res.list ?? [];
}

/**
 * Whether an account answers as a mail store — the one group classifier.
 *
 * Stalwart advertises the same capabilities on every account a session lists,
 * so a folder, calendar or address-book share that carries an address looks
 * exactly like a group mailbox from the session alone. What tells the two apart
 * is the mail store: an account that answers `Mailbox/get` with a folder tree
 * is a mailbox, and one that shares only files, calendars or books answers with
 * none and is not a group. An account this cannot read is not served as one —
 * "I could not prove it is a mailbox" is not "it is a mailbox".
 */
export type MailStoreProbe = "mailbox" | "share" | "unreadable";

/**
 * What the mail store says about an account: it has one, it has none, or nobody
 * could ask.
 *
 * Three answers rather than two, because the third is not a fact about the
 * account: "this is not a group" and "I could not reach the server" are
 * different sentences, and a surface that showed the first for the second would
 * be telling a person to fix a grant that was never the problem (ADR 0005).
 * Writes stay closed on the third answer — nothing is written into an account
 * nobody could prove is a mailbox — while a read names it.
 */
export async function probeMailStore(
  client: JmapClient,
  accountId: string,
): Promise<MailStoreProbe> {
  try {
    return (await mailboxesOf(client, accountId, null)).length > 0 ? "mailbox" : "share";
  } catch (err) {
    // The reason is said out loud rather than swallowed, so an operator is not
    // left reading a broken probe as a group that is not granted (ADR 0005).
    console.warn(
      `[gilbert] could not probe the account ${accountId} for a mail store:`,
      (err as Error).message,
    );
    return "unreadable";
  }
}

/**
 * The groups of a session: the session's candidates, then the mail store's
 * probe — the one classifier this product has for what a group is.
 *
 * One rule, one owner: every surface that needs to know which accounts are
 * groups (the administration's doors, the member's read, the daemon's list of
 * what it may serve) reads it here. The candidates are the non-personal
 * accounts that carry an address; the probe is `probeMailStore`, because a
 * folder share with an address looks exactly like a group mailbox from the
 * session alone and only the mail store tells them apart. Nothing is cached: a
 * grant withdrawn in Stalwart is read here the next time a surface asks.
 */
export interface GroupReach {
  /** The groups, by name, with the account each one answers as. */
  groups: Map<string, string>;
  /**
   * The candidates the mail server did not answer about: not groups this
   * reader can prove, and not proven shares either.
   */
  unreadable: string[];
}
export async function groupAccountsDetailed(ctx: Ctx): Promise<GroupReach> {
  const candidates: Array<[string, string]> = [];
  for (const [accountId, account] of Object.entries(ctx.session.accounts ?? {})) {
    const a = account as { name?: unknown; isPersonal?: unknown };
    if (a.isPersonal !== false) continue;
    if (typeof a.name !== "string") continue;
    const name = a.name.trim().toLowerCase();
    if (name.indexOf("@") <= 0) continue;
    if (!candidates.some(([, seen]) => seen === name)) candidates.push([accountId, name]);
  }
  const client = new JmapClient(ctx);
  const probed = await Promise.all(
    candidates.map(async ([accountId, name]) => {
      const probe = await probeMailStore(client, accountId);
      return { accountId, name, probe };
    }),
  );
  // The map is read by group name — `Map<name, accountId>` — so the pairs are
  // turned around here, once, where the probe's own order is still visible. A
  // candidate nobody could ask about is named rather than dropped: the caller
  // that writes ignores it, and the caller that shows a person says so.
  const groups = new Map<string, string>();
  const unreadable: string[] = [];
  for (const row of probed) {
    if (row.probe === "mailbox") groups.set(row.name, row.accountId);
    else if (row.probe === "unreadable") unreadable.push(row.name);
  }
  return { groups, unreadable };
}

/**
 * The groups alone, for the callers that have nothing to say about a probe that
 * did not answer.
 */
export async function groupAccounts(ctx: Ctx): Promise<Map<string, string>> {
  return (await groupAccountsDetailed(ctx)).groups;
}

/**
 * A mailbox by name. The name is matched here rather than trusted to a server
 * filter: `Mailbox/query` is a hint, and a server that cannot answer it would
 * otherwise turn every move into a failure instead of a lookup over a tree the
 * account already holds.
 */
export async function findMailboxByName(
  client: JmapClient,
  accountId: string,
  name: string,
): Promise<string | null> {
  const wanted = name.trim().toLowerCase();
  const query = await client.chain(
    [["Mailbox/query", { accountId, filter: { name }, limit: 50 }, "q"]],
    [JMAP_MAIL],
  );
  const raw = query.raw("q");
  const ids =
    raw && raw[0] === "Mailbox/query" && Array.isArray(raw[1].ids)
      ? (raw[1].ids as unknown[]).map(String)
      : [];
  const list = ids.length
    ? await mailboxesOf(client, accountId, ids)
    : await mailboxesOf(client, accountId, null);
  const found =
    list.find((mailbox) => String(mailbox.name) === name) ??
    list.find((mailbox) => String(mailbox.name).toLowerCase() === wanted);
  return found && typeof found.id === "string" ? found.id : null;
}

/** The account's mailbox for a role (`drafts`, `sent`), or null when it has none. */
export async function mailboxIdByRole(
  client: JmapClient,
  accountId: string,
  role: string,
): Promise<string | null> {
  const found = (await mailboxesOf(client, accountId, null)).find(
    (mailbox) => mailbox.role === role && typeof mailbox.id === "string",
  );
  return found ? String(found.id) : null;
}

/* ------------------------------------------------------------------ */
/* Identities and addresses                                            */
/* ------------------------------------------------------------------ */

/**
 * The sending projection the agent works with: the account's own identity,
 * reduced to what a composed message needs. Not `@gilbert/shared/identityViews`'s
 * `Identity`, which is the full object the settings surfaces read — naming this
 * one its own way keeps the two from being mistaken for each other.
 */
interface SendingIdentity {
  id?: string;
  name: string;
  email: string;
  signature: string;
}

/**
 * The sending identity of the account the run works in — the group's own, not
 * the agent's: the sent copy is the group's and lands in the group's Sent, and
 * the signature is the group's footer (ADR resolutions 2 and 12).
 */
async function defaultIdentity(
  ctx: Ctx,
  client: JmapClient,
  accountId: string,
): Promise<SendingIdentity> {
  const res = await client.call<{
    list?: Array<{
      id?: unknown;
      name?: unknown;
      email?: unknown;
      textSignature?: unknown;
    }>;
  }>(
    "Identity/get",
    { accountId, properties: ["id", "name", "email", "textSignature"] },
    [JMAP_MAIL],
  );
  const list = res.list ?? [];
  if (!list.length)
    throw new Error("the account this run works in has no sending identity");
  /*
   * Through the rule the composer in a group mailbox uses for the same
   * question (ADR 0007): a member with no identity assigned to them and the
   * agent send a group's mail identically, because there is one definition of
   * which identity is the account's own (`accountOwnIdentity`), not two that
   * happen to agree.
   */
  const chosen = accountOwnIdentity(
    list.map((i) => ({
      id: typeof i.id === "string" ? i.id : "",
      email: typeof i.email === "string" ? i.email : "",
      name: typeof i.name === "string" ? i.name : "",
      textSignature: typeof i.textSignature === "string" ? i.textSignature : "",
    })),
    String(
      (ctx.session.accounts?.[accountId] as { name?: unknown } | undefined)?.name ?? "",
    ),
  );
  if (!chosen) throw new Error("the account this run works in has no sending identity");
  if (!chosen.email) throw new Error("the account's identity carries no address");
  const identity: SendingIdentity = {
    name: chosen.name,
    email: chosen.email,
    signature: chosen.textSignature,
  };
  if (chosen.id) identity.id = chosen.id;
  return identity;
}

/** The recipients a `to` parameter names: comma-separated, `Name <addr>` allowed. */
function parseAddresses(raw: string): Array<{ name?: string; email: string }> {
  const out: Array<{ name?: string; email: string }> = [];
  for (const part of raw.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const angle = /^(.*)<([^>]+)>\s*$/.exec(item);
    if (angle) {
      const email = angle[2]!.trim();
      if (!email) continue;
      const name = angle[1]!.trim().replace(/^"|"$/g, "");
      out.push(name ? { name, email } : { email });
      continue;
    }
    out.push({ email: item });
  }
  return out;
}

/** The composer's signature behaviour, for the one part of it the agent uses. */
function withSignature(text: string, signature: string): string {
  return `${text}${textSignatureBlock(signature)}`;
}

/** A file name an attachment can be written under. */
function fileSafeName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/]/g, "-")
    // Control characters cannot appear in a FileNode name; they are dropped
    // rather than escaped, because the name is somebody else's attachment.
    .split("")
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join("")
    .trim();
  return cleaned || fallback;
}

function sentAtOf(opts: ActionOpts): string {
  return (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/* ------------------------------------------------------------------ */
/* The runner                                                          */
/* ------------------------------------------------------------------ */

/**
 * A refusal: the run must not continue as it is, so a retry changes nothing.
 *
 * The executor's fence throws it, and `runActions` propagates it unchanged —
 * wrapping it in a plain `Error` would turn "nothing more is run" into a
 * bounded retry of the very effect the fence stopped. It lives in this module
 * because this is where it is caught and rethrown; the executor imports it
 * rather than the other way round, so there is no import cycle.
 */
export class RefusedError extends Error {}

/**
 * What the caller wants to know while the actions run, and when to stop.
 *
 * Separate from `ActionOpts` on purpose: those are what the actions read, these
 * are the caller's own concerns — a ledger a retry resumes from, and a fence
 * asked before anything leaves the process.
 */
export interface ActionHooks {
  /**
   * After an action has landed and before the next one starts: the executor
   * records it on the job, so a retry resumes after it instead of doing it
   * twice. The result rides along, because that is where the id of the record
   * the action wrote is, and a woken run's lineage is read from that id.
   */
  onApplied?: (action: AgentAction, result: ActionResult) => Promise<void>;
  /**
   * Before an action that leaves the process. A rejection stops the run here,
   * which is the point: a unit somebody else has taken over does nothing more.
   */
  beforeAction?: (action: AgentAction) => Promise<void>;
}

/**
 * Run the actions in order and return what each one produced.
 *
 * The first failure throws: a job records one outcome, and half a proposal
 * applied in silence is exactly the failure mode "failure is loud" rules out.
 */
export async function runActions(
  ctx: Ctx,
  accountId: string,
  actions: ReadonlyArray<AgentAction>,
  opts: ActionOpts = {},
  hooks: ActionHooks = {},
): Promise<ActionResult[]> {
  const client = new JmapClient(ctx);
  const results: ActionResult[] = [];
  for (const action of actions) {
    const missing = missingActionParams(action);
    if (missing.length)
      throw new Error(`"${action.do}" needs ${missing.join(", ")} to run`);
    try {
      await hooks.beforeAction?.(action);
      const result = await runOne(ctx, client, accountId, action, opts);
      results.push(result);
      await hooks.onApplied?.(action, result);
    } catch (err) {
      // The fence's own refusal is not an action failure: it means the unit was
      // taken over (or the job document moved), and the caller dead-letters the
      // job on this type (`runJob`). Wrapping it would erase the reason and let
      // a retry run the effect the fence just stopped.
      if (err instanceof RefusedError) throw err;
      throw new Error(
        `"${action.do}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return results;
}

async function runOne(
  ctx: Ctx,
  client: JmapClient,
  accountId: string,
  action: AgentAction,
  opts: ActionOpts,
): Promise<ActionResult> {
  switch (action.do) {
    case "noop":
      return { action: action.do, ok: true };
    case "keyword.add":
      return {
        action: action.do,
        ok: true,
        result: await setKeyword(ctx, client, accountId, action, opts, true),
      };
    case "keyword.remove":
      return {
        action: action.do,
        ok: true,
        result: await setKeyword(ctx, client, accountId, action, opts, false),
      };
    case "mail.move":
      return {
        action: action.do,
        ok: true,
        result: await moveMail(client, accountId, action, opts),
      };
    case "mail.extract":
      return {
        action: action.do,
        ok: true,
        result: await extractAttachments(ctx, client, accountId, action, opts),
      };
    case "mail.draft":
      return {
        action: action.do,
        ok: true,
        result: await createDraft(ctx, client, accountId, action, opts),
      };
    case "mail.send":
      return {
        action: action.do,
        ok: true,
        result: await submitMail(ctx, client, accountId, action, opts),
      };
    case "chat.post": {
      const from = opts.from ?? "";
      if (!from) throw new Error("chat.post needs the agent's own address");
      const text = textOf(action.with?.text);
      const mentions = opts.participants
        ? mentionsFromText(text, opts.participants)
        : undefined;
      const nodeId = await postMessage(
        ctx,
        accountId,
        from,
        text,
        opts.replyTo,
        mentions,
      );
      return { action: action.do, ok: true, result: { nodeId } };
    }
    case "file.write": {
      // Where a member reads it: the group's own **visible** Files, in the
      // folder the action names (ADR 0003 resolution 15) — never the hidden app
      // folder, and never over a file that is already there. The name the run
      // actually used is what it reports, exactly as an extraction does, so a
      // rule that asks for one note and runs twice leaves two rather than
      // losing the first.
      const folder = textOf(action.with?.folder) || AGENT_ATTENTION_FOLDER;
      const name = await unusedVisibleName(
        ctx,
        accountId,
        folder,
        fileSafeName(textOf(action.with?.name), "note.txt"),
      );
      const nodeId = await writeBytesIntoVisibleFolder(
        ctx,
        accountId,
        folder,
        name,
        new TextEncoder().encode(textOf(action.with?.text)),
        "text/plain",
      );
      return {
        action: action.do,
        ok: true,
        result: { path: `${folder}/${name}`, nodeId },
      };
    }
    case "notebook.write": {
      /*
       * The group's memory, written by a run (ADR 0006 decision three).
       *
       * The notebook is one document of facts, and a run adds one, corrects one
       * by its id, or removes one by writing it with no text. Which one it does
       * is the action's own parameters, and the bounds are the document's — a
       * fact longer than `AGENT_NOTEBOOK_FACT_MAX`, or a notebook past
       * `AGENT_NOTEBOOK_FACTS_MAX`, is refused in words here rather than written
       * as a document that no reader will accept.
       */
      const store = new AgentStore(ctx, accountId);
      const text = textOf(action.with?.text).trim();
      const id = textOf(action.with?.id).trim();
      const found = await store.readNotebook();
      const facts: AgentNotebookFact[] = [...(found?.doc.facts ?? [])];
      const at = id ? facts.findIndex((fact) => fact.id === id) : -1;
      if (id && at === -1)
        throw new Error(
          `notebook.write names a fact this group's notebook does not hold: ${id}`,
        );
      if (text.length > AGENT_NOTEBOOK_FACT_MAX)
        throw new Error(
          `notebook.write writes a fact of ${text.length} characters; a fact is at most ${AGENT_NOTEBOOK_FACT_MAX}`,
        );
      if (at === -1 && !text)
        throw new Error(
          "notebook.write needs text to add a fact, or an id to correct or remove one",
        );
      if (at === -1 && facts.length >= AGENT_NOTEBOOK_FACTS_MAX)
        throw new Error(
          `notebook.write would hold more than ${AGENT_NOTEBOOK_FACTS_MAX} facts`,
        );
      const by = opts.from ?? "";
      const now = (opts.now ?? new Date()).toISOString();
      if (at !== -1 && !text) facts.splice(at, 1);
      else if (at !== -1) facts[at] = { ...facts[at]!, text, addedAt: now, addedBy: by };
      else facts.push({ id: randomUUID(), text, addedAt: now, addedBy: by });
      await store.writeNotebook(facts, by, found ? { ifInState: found.state } : {});
      return { action: action.do, ok: true, result: { facts: facts.length } };
    }
    case "document.read": {
      const source = await documentSourceOf(ctx, accountId, action, opts);
      // Two bounds stand between a file and this process: how many bytes are
      // read at all, and how many pages are looked at. A file past either is
      // refused in words rather than paid for in memory.
      if (source.bytes.byteLength > AGENT_DOCUMENT_BYTES_MAX)
        throw new DocumentError(
          "document_too_large",
          `${source.path} is larger than the ${AGENT_DOCUMENT_BYTES_MAX} bytes a run reads`,
        );
      const read = await readDocument(
        source.bytes,
        kindOfDocument(action, source),
        opts.maxPages ?? AGENT_MAX_PAGES_DEFAULT,
      );
      return {
        action: action.do,
        ok: true,
        result: {
          file: source.path,
          kind: read.kind,
          pages: read.pages,
          text: read.text,
          // The pages with no text layer are named rather than passed over, and
          // so is what that means: there is no OCR here, and this action reads
          // text. A run woken by the file hands those pages to the model as
          // images; an action that named them and said nothing else would let a
          // reader conclude the page says nothing (ADR 0003).
          pixelPages: read.pixelPages,
          // Text and workbooks have no pages to name, so a reading that stopped
          // short says so here: what is above is the beginning of the file, not
          // the whole of it (ADR 0003).
          truncated: read.truncated,
          ...(readNote(read) ? { note: readNote(read) } : {}),
        },
      };
    }
    case "document.split": {
      const source = await documentSourceOf(ctx, accountId, action, opts);
      assertPdf(action, source);
      // The ceiling is asked of the document before a page of it is copied: a
      // split writes a file a page, so the count is read from the page tree
      // rather than from the pages a split has already materialised.
      const count = await pdfPageCount(source.bytes);
      if (count > AGENT_SPLIT_PAGES_MAX)
        throw new DocumentError(
          "document_too_many_pages",
          `${source.path} has ${count} pages, and one split writes at most ${AGENT_SPLIT_PAGES_MAX}`,
        );
      const pages = await splitPdf(source.bytes);
      const folder = textOf(action.with?.folder) || AGENT_ATTENTION_FOLDER;
      const stem = fileSafeName(source.name.replace(/\.pdf$/i, ""), "document");
      const written: string[] = [];
      const nodeIds: string[] = [];
      for (const [index, bytes] of pages.entries()) {
        const name = await unusedVisibleName(
          ctx,
          accountId,
          folder,
          `${stem}-page-${index + 1}.pdf`,
        );
        const nodeId = await writeBytesIntoVisibleFolder(
          ctx,
          accountId,
          folder,
          name,
          bytes,
          PDF_TYPE,
        );
        if (nodeId) nodeIds.push(nodeId);
        written.push(`${folder}/${name}`);
      }
      return {
        action: action.do,
        ok: true,
        result: { file: source.path, folder, pages: pages.length, written, nodeIds },
      };
    }
    case "document.extract": {
      const source = await documentSourceOf(ctx, accountId, action, opts);
      assertPdf(action, source);
      const range = textOf(action.with?.pages);
      const cut = await extractPages(source.bytes, range);
      const folder = textOf(action.with?.folder) || AGENT_ATTENTION_FOLDER;
      const stem = fileSafeName(source.name.replace(/\.pdf$/i, ""), "document");
      const wanted =
        textOf(action.with?.name) ||
        `${stem}-pages-${fileSafeName(range, "extract").replace(/,/g, "-")}.pdf`;
      const name = await unusedVisibleName(
        ctx,
        accountId,
        folder,
        fileSafeName(wanted, "extract.pdf"),
      );
      const nodeId = await writeBytesIntoVisibleFolder(
        ctx,
        accountId,
        folder,
        name,
        cut.bytes,
        PDF_TYPE,
      );
      return {
        action: action.do,
        ok: true,
        result: {
          file: source.path,
          folder,
          pages: cut.pages,
          written: `${folder}/${name}`,
          nodeIds: nodeId ? [nodeId] : [],
        },
      };
    }
    case "document.merge": {
      const paths = documentPathsOf(textOf(action.with?.files));
      const sources: Uint8Array[] = [];
      for (const path of paths) {
        const source = await readDocumentSource(ctx, accountId, path, action.do);
        assertPdf(action, source);
        sources.push(source.bytes);
      }
      const merged = await mergePdfs(sources);
      const folder = textOf(action.with?.folder) || AGENT_ATTENTION_FOLDER;
      const stem = fileSafeName(
        (paths[0] ?? "")
          .split("/")
          .pop()
          ?.replace(/\.pdf$/i, "") || "merged",
        "merged",
      );
      const name = await unusedVisibleName(
        ctx,
        accountId,
        folder,
        fileSafeName(textOf(action.with?.name) || `${stem}-merged.pdf`, "merged.pdf"),
      );
      const nodeId = await writeBytesIntoVisibleFolder(
        ctx,
        accountId,
        folder,
        name,
        merged,
        PDF_TYPE,
      );
      return {
        action: action.do,
        ok: true,
        result: {
          files: paths,
          folder,
          written: `${folder}/${name}`,
          nodeIds: nodeId ? [nodeId] : [],
        },
      };
    }
  }
}

/** The media type everything the page work writes carries. */
const PDF_TYPE = "application/pdf";

/** A file the document family works on: where it is, and what it holds. */
interface DocumentSource {
  path: string;
  name: string;
  type: string;
  bytes: Uint8Array;
}

/**
 * The file a document action works on: the one it names, or the one that woke
 * the run.
 *
 * A file the action cannot name is refused by its own code rather than skipped
 * (ADR 0003): an action that quietly did nothing would leave the run reading
 * "done" over work that never happened.
 */
async function documentSourceOf(
  ctx: Ctx,
  accountId: string,
  action: AgentAction,
  opts: ActionOpts,
): Promise<DocumentSource> {
  const named = textOf(action.with?.file);
  const path = named || opts.filePath || "";
  if (!path)
    throw new DocumentError(
      "no_file",
      `"${action.do}" names no file, and no file woke this run`,
    );
  return readDocumentSource(ctx, accountId, path, action.do);
}

/** The bytes of one file of the group's Files, by path. */
async function readDocumentSource(
  ctx: Ctx,
  accountId: string,
  path: string,
  action: AgentActionName,
): Promise<DocumentSource> {
  const found = await readVisibleFileBytes(ctx, accountId, path);
  if (!found)
    throw new DocumentError(
      "no_such_file",
      `the group's Files hold no file at "${path}", so "${action}" has nothing to work on`,
    );
  const type =
    typeof found.file.type === "string" && found.file.type ? found.file.type : "";
  return { path, name: found.name, type, bytes: found.bytes };
}

/**
 * What a reading has to say about itself beyond its text, in one line.
 *
 * One line rather than one per fact: the result carries a single `note`, and
 * two spreads writing it would leave whichever came second. A document either
 * stopped at a bound or carries pages with no text layer, and when both are
 * true both are said.
 */
function readNote(read: DocumentRead): string {
  const notes: string[] = [];
  if (read.pixelPages.length && !read.text.trim())
    notes.push(
      `${read.pixelPages.length} page(s) carry no text layer: they are read by the model, as images, when a run is woken by this file.`,
    );
  if (read.truncated)
    notes.push(
      `the text is longer than the ${DOCUMENT_TEXT_MAX} characters one reading carries, so what is above is the beginning of the file.`,
    );
  return notes.join(" ");
}

/** Which of the two document kinds this is, or a refusal naming what it is. */
function kindOfDocument(action: AgentAction, source: DocumentSource): DocumentKind {
  const kind = documentKindOf(source.name, source.type);
  if (!kind)
    throw new DocumentError(
      "unsupported_type",
      `"${source.name}" is none of the kinds this installation reads — a PDF, a .docx, a spreadsheet (.xls, .xlsx), a text file or an image (.png, .jpg, .gif, .webp) — so "${action.do}" cannot read it`,
    );
  return kind;
}

/** The page work is PDFs only, and says so rather than parsing something else. */
function assertPdf(action: AgentAction, source: DocumentSource): void {
  if (documentKindOf(source.name, source.type) === "pdf") return;
  throw new DocumentError(
    "unsupported_type",
    `"${source.name}" is not a PDF, so "${action.do}" cannot work on its pages`,
  );
}

/**
 * The paths a `files` list names: one to a line, in the order written.
 *
 * One line a path, rather than a separator inside a line, because a file's own
 * name can hold anything — a comma and a space included — and a list that
 * guessed at one would merge the wrong documents.
 */
function documentPathsOf(text: string): string[] {
  const paths = text
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  if (!paths.length)
    throw new DocumentError(
      "no_file",
      '"document.merge" names no file to merge: give the paths one to a line',
    );
  return paths;
}

async function setKeyword(
  ctx: Ctx,
  client: JmapClient,
  accountId: string,
  action: AgentAction,
  opts: ActionOpts,
  applied: boolean,
): Promise<Record<string, unknown>> {
  const emailId = requireEmail(opts, action.do);
  const keyword = textOf(action.with?.keyword);
  if (isAgentLabel(keyword)) await assertAgentLabelsDefined(ctx, accountId, [keyword]);
  await client.call(
    "Email/set",
    {
      accountId,
      update: { [emailId]: { [`keywords/${keyword}`]: applied ? true : null } },
    },
    [JMAP_MAIL],
  );
  return { emailId, keyword, applied };
}

async function moveMail(
  client: JmapClient,
  accountId: string,
  action: AgentAction,
  opts: ActionOpts,
): Promise<Record<string, unknown>> {
  const emailId = requireEmail(opts, action.do);
  const name = textOf(action.with?.mailbox);
  let mailboxId = await findMailboxByName(client, accountId, name);
  if (!mailboxId) {
    if (!truthy(action.with?.create))
      throw new Error(
        `the account has no mailbox named "${name}", and the action does not create one`,
      );
    const created = await client.call<SetResponse>(
      "Mailbox/set",
      { accountId, create: { m: { name, parentId: null } } },
      [JMAP_MAIL],
    );
    const id = created.created?.m?.id;
    if (typeof id !== "string")
      throw new Error(
        `the server refused to create the mailbox "${name}": ${
          created.notCreated?.m?.description ?? "no reason given"
        }`,
      );
    mailboxId = id;
  }
  // Moving replaces the mailbox set instead of adding to it: the message leaves
  // every mailbox it was in, which is what a move means to both mail stores.
  await client.call(
    "Email/set",
    { accountId, update: { [emailId]: { mailboxIds: { [mailboxId]: true } } } },
    [JMAP_MAIL],
  );
  return { emailId, mailboxId, mailbox: name };
}

async function extractAttachments(
  ctx: Ctx,
  client: JmapClient,
  accountId: string,
  action: AgentAction,
  opts: ActionOpts,
): Promise<Record<string, unknown>> {
  const emailId = requireEmail(opts, action.do);
  const folder = textOf(action.with?.folder) || AGENT_ATTENTION_FOLDER;
  const record = await fetchEmailRecord(client, accountId, emailId, {
    properties: ["attachments", "bodyStructure"],
  });
  if (!record) throw new Error(`the message ${emailId} is gone`);
  const saved: string[] = [];
  // The nodes the extraction made, so the trail and a chain's lineage can name
  // the files a run wrote rather than the paths it asked for.
  const nodeIds: string[] = [];
  const used = new Set<string>();
  for (const [index, part] of attachmentParts(record).entries()) {
    const blobId = typeof part.blobId === "string" ? part.blobId : "";
    if (!blobId) continue;
    const type =
      typeof part.type === "string" && part.type ? part.type : "application/octet-stream";
    let name = fileSafeName(
      typeof part.name === "string" ? part.name : "",
      `attachment-${index + 1}`,
    );
    if (used.has(name)) name = `${index + 1}-${name}`;
    used.add(name);
    // Two different things can already hold this name: another attachment of
    // the same message (handled above, in one pass) and a file the group filed
    // there earlier. The second is somebody's work — the run writes beside it
    // rather than over it, and the name it actually used is what `saved` and
    // the audit report.
    name = await unusedVisibleName(ctx, accountId, folder, name);
    used.add(name);
    const bytes = await client.downloadBlob(accountId, blobId, name, type);
    // A person has to be able to find this: the file goes into the group's
    // *visible* Files, in the folder the automation named or the model chose
    // (ADR 0003 resolution 15), and into the needs-attention folder when
    // nothing determined one — never into the hidden app folder, and never
    // loose in the root.
    const nodeId = await writeBytesIntoVisibleFolder(
      ctx,
      accountId,
      folder,
      name,
      bytes,
      type,
    );
    if (nodeId) nodeIds.push(nodeId);
    saved.push(`${folder}/${name}`);
  }
  return { emailId, folder, saved, nodeIds };
}

interface AttachmentPart {
  blobId?: unknown;
  type?: unknown;
  name?: unknown;
  subParts?: unknown;
}

/**
 * The parts of a message that are attachments. `attachments` is the server's
 * own answer; a server that does not compute it is walked through
 * `bodyStructure` instead, which describes the same parts.
 */
function attachmentParts(record: EmailRecord): AttachmentPart[] {
  const listed = Array.isArray(record.attachments)
    ? (record.attachments as AttachmentPart[])
    : [];
  if (listed.length) return listed.filter((part) => Boolean(part.blobId));
  const out: AttachmentPart[] = [];
  const walk = (part: AttachmentPart | undefined) => {
    if (!part || typeof part !== "object") return;
    const type = typeof part.type === "string" ? part.type : "";
    if (part.blobId && !type.startsWith("multipart/")) out.push(part);
    if (Array.isArray(part.subParts))
      for (const child of part.subParts as AttachmentPart[]) walk(child);
  };
  walk(record.bodyStructure as AttachmentPart | undefined);
  return out;
}

async function createDraft(
  ctx: Ctx,
  client: JmapClient,
  accountId: string,
  action: AgentAction,
  opts: ActionOpts,
): Promise<Record<string, unknown>> {
  const mailboxId = await mailboxIdByRole(client, accountId, "drafts");
  if (!mailboxId)
    throw new Error(
      "the account has no Drafts mailbox, so a pending approval has nowhere to wait",
    );
  const identity = await defaultIdentity(ctx, client, accountId);
  const to = parseAddresses(textOf(action.with?.to));
  const text = withSignature(textOf(action.with?.text), identity.signature);
  const created = await client.call<SetResponse>(
    "Email/set",
    {
      accountId,
      create: {
        draft: {
          from: [{ name: identity.name || null, email: identity.email }],
          to,
          subject: textOf(action.with?.subject),
          sentAt: sentAtOf(opts),
          bodyStructure: { partId: "text", type: "text/plain" },
          bodyValues: { text: { value: text } },
          mailboxIds: { [mailboxId]: true },
          // `$draft` and deliberately not `$seen`: Gilbert's pending drafts are
          // kept unread so a human sees them (ADR resolution 10).
          keywords: { $draft: true },
        },
      },
    },
    [JMAP_MAIL],
  );
  const emailId = created.created?.draft?.id;
  if (typeof emailId !== "string")
    throw new Error(
      `the server refused the draft: ${
        created.notCreated?.draft?.description ?? "no reason given"
      }`,
    );
  return { emailId, mailboxId };
}

async function submitMail(
  ctx: Ctx,
  client: JmapClient,
  accountId: string,
  action: AgentAction,
  opts: ActionOpts,
): Promise<Record<string, unknown>> {
  const identity = await defaultIdentity(ctx, client, accountId);
  const rcpts = parseAddresses(textOf(action.with?.to));
  if (!rcpts.length) throw new Error("the send names no recipient");
  const sentId = await mailboxIdByRole(client, accountId, "sent");
  if (!sentId)
    throw new Error("the account has no Sent mailbox to file the sent copy in");

  let emailId = opts.draftEmailId ?? "";
  if (!emailId) {
    const text = withSignature(textOf(action.with?.text), identity.signature);
    const created = await client.call<SetResponse>(
      "Email/set",
      {
        accountId,
        create: {
          message: {
            from: [{ name: identity.name || null, email: identity.email }],
            to: rcpts,
            subject: textOf(action.with?.subject),
            sentAt: sentAtOf(opts),
            bodyStructure: { partId: "text", type: "text/plain" },
            bodyValues: { text: { value: text } },
            mailboxIds: { [sentId]: true },
            keywords: { $seen: true },
          },
        },
      },
      [JMAP_MAIL],
    );
    const createdId = created.created?.message?.id;
    if (typeof createdId !== "string")
      throw new Error(
        `the server refused the message: ${
          created.notCreated?.message?.description ?? "no reason given"
        }`,
      );
    emailId = createdId;
  } else {
    // The run prepared a draft and a person approved it: that draft is what
    // goes out, edits included, because the draft is what they read.
  }

  // The live shape (ADR resolution 12): submit the message and let the
  // submission file it in the group's own Sent, clearing `$draft`.
  const onSuccess: Record<string, unknown> = {
    "keywords/$draft": null,
    "keywords/$seen": true,
    [`mailboxIds/${sentId}`]: true,
  };
  if (opts.draftMailboxId && opts.draftMailboxId !== sentId)
    onSuccess[`mailboxIds/${opts.draftMailboxId}`] = null;
  const submitted = await client.call<SetResponse>(
    "EmailSubmission/set",
    {
      accountId,
      create: {
        submission: {
          ...(identity.id ? { identityId: identity.id } : {}),
          emailId,
          envelope: {
            mailFrom: { email: identity.email },
            rcptTo: rcpts.map((address) => ({ email: address.email })),
          },
        },
      },
      onSuccessUpdateEmail: { "#submission": onSuccess },
    },
    [JMAP_SUBMISSION, JMAP_MAIL],
  );
  const submissionId = submitted.created?.submission?.id;
  if (typeof submissionId !== "string")
    throw new Error(
      `the server refused the submission: ${
        submitted.notCreated?.submission?.description ?? "no reason given"
      }`,
    );
  return { emailId, mailboxId: sentId, submissionId };
}

/** The draft reference a `mail.draft` result carries, for a job to record. */
export function draftRefOf(result: ActionResult | undefined): AgentDraftRef | null {
  const emailId = result?.result?.emailId;
  const mailboxId = result?.result?.mailboxId;
  if (typeof emailId !== "string" || typeof mailboxId !== "string") return null;
  return { emailId, mailboxId };
}

function requireEmail(opts: ActionOpts, action: AgentActionName): string {
  if (!opts.emailId)
    throw new Error(`${action} works on a message and the run named none`);
  return opts.emailId;
}

function textOf(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : value === undefined
      ? ""
      : String(value);
}

function truthy(value: unknown): boolean {
  return value === true || value === "true";
}
