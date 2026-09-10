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

import {
  type Ctx,
  readAppJsonAt,
  unusedVisibleName,
  writeBytesIntoVisibleFolder,
} from "../appFolder.js";
import { JMAP_MAIL, JMAP_SUBMISSION, JmapClient } from "../jmap.js";
import { mentionsFromText } from "../shared/chat.js";
import {
  GROUP_LABELS_FILE,
  isAgentLabel,
  isLabelCatalog,
  type LabelCatalogEntry,
  missingAgentLabels,
} from "../shared/labels.js";
import { textSignatureBlock } from "../shared/signature.js";
import { postMessage } from "./chat.js";
import {
  AGENT_ATTENTION_FOLDER,
  type AgentAction,
  type AgentActionName,
  type AgentDraftRef,
  type AgentEmailView,
  missingActionParams,
} from "./documents.js";

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
  const raw = await readAppJsonAt(ctx, accountId, GROUP_LABELS_FILE);
  return isLabelCatalog(raw) ? raw.labels : [];
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
async function mailboxIdByRole(
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

interface Identity {
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
): Promise<Identity> {
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
  const own = String(
    (ctx.session.accounts?.[accountId] as { name?: unknown } | undefined)?.name ?? "",
  ).toLowerCase();
  const chosen =
    (own ? list.find((i) => String(i.email).toLowerCase() === own) : undefined) ??
    list[0]!;
  if (typeof chosen.email !== "string" || !chosen.email)
    throw new Error("the account's identity carries no address");
  const identity: Identity = {
    name: typeof chosen.name === "string" ? chosen.name : "",
    email: chosen.email,
    signature: typeof chosen.textSignature === "string" ? chosen.textSignature : "",
  };
  if (typeof chosen.id === "string") identity.id = chosen.id;
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
 * Run the actions in order and return what each one produced.
 *
 * The first failure throws: a job records one outcome, and half a proposal
 * applied in silence is exactly the failure mode "failure is loud" rules out.
 */
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
   * twice.
   */
  onApplied?: (action: AgentAction) => Promise<void>;
  /**
   * Before an action that leaves the process. A rejection stops the run here,
   * which is the point: a unit somebody else has taken over does nothing more.
   */
  beforeAction?: (action: AgentAction) => Promise<void>;
}

export async function runActions(
  ctx: Ctx,
  accountId: string,
  actions: ReadonlyArray<AgentAction>,
  opts: ActionOpts = {},
  hooks: ActionHooks = {},
): Promise<ActionResult[]> {
  const client = new JmapClient(ctx.authorization, ctx.session);
  const results: ActionResult[] = [];
  for (const action of actions) {
    const missing = missingActionParams(action);
    if (missing.length)
      throw new Error(`"${action.do}" needs ${missing.join(", ")} to run`);
    try {
      await hooks.beforeAction?.(action);
      results.push(await runOne(ctx, client, accountId, action, opts));
      await hooks.onApplied?.(action);
    } catch (err) {
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
      await writeBytesIntoVisibleFolder(
        ctx,
        accountId,
        folder,
        name,
        new TextEncoder().encode(textOf(action.with?.text)),
        "text/plain",
      );
      return { action: action.do, ok: true, result: { path: `${folder}/${name}` } };
    }
  }
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
    await writeBytesIntoVisibleFolder(ctx, accountId, folder, name, bytes, type);
    saved.push(`${folder}/${name}`);
  }
  return { emailId, folder, saved };
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
