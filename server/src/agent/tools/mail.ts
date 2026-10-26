/**
 * The tools over mail, its folders and the group's labels (ADR 0038).
 *
 * A search and a read of messages and their attachments, the account's folders,
 * filing and trashing and keywords, a label in the group's own catalog, a
 * draft, a send, a question by mail, and a folder in the mailbox. The doors the
 * other surfaces read a message through live here too — the account's mailboxes
 * and sending identities, the message a run's answer path reads — because no
 * other surface owns them.
 */

import { readGroupLabels, writeGroupLabels } from "../../account.js";
import type { Ctx } from "../../appFolder.js";
import { cachedMail } from "../../mailCache.js";
import { sameAddress } from "../../shared/address.js";
import { CAPABILITIES } from "../../shared/capabilities.js";
import { moveMailboxPatch, refusalOf, type SetResponse } from "../../shared/jmap.js";
import { queryThenGet } from "../../shared/jmapQuery.js";
import { isRecord } from "../../shared/json.js";
import {
  AGENT_DRAFT_KEYWORD,
  AGENT_LABELS,
  DRAFT_KEYWORD,
  G_LABEL_PREFIX,
  GROUP_LABELS_FILE,
  isAgentLabel,
  type LabelCatalogEntry,
} from "../../shared/labels.js";
import { mailboxesOf as accountMailboxes } from "../../shared/mailboxes.js";
import {
  buildFilter,
  parseQuery,
  resolveMailbox,
  SEARCH_GRAMMAR,
  type SearchMailbox,
} from "../../shared/search.js";
import { replySubject } from "../../shared/text.js";
import { clientOf } from "../../util.js";
import { fileWriteKey, markOwnWrite } from "../ownWrites.js";
import { argsRecord, countArg, notFound, optionalTextArg, textArg } from "./args.js";
import { READ_BYTES_MAX, readFileText } from "./content.js";
import { defineTool, ToolError } from "./define.js";

/** The properties a search hit carries: enough to choose what to read next. */
/**
 * The properties a search answers with — enough to choose what to read next,
 * and the **thread** a message belongs to, which is the id a chat reference
 * opens a conversation by (`thread:<id>`, ADR 0039).
 */
const HIT_PROPS = ["id", "threadId", "subject", "from", "receivedAt", "keywords"];

/** The properties a message is read with — its text, and no more of it than this. */
const MESSAGE_PROPS = [
  "id",
  "subject",
  "from",
  "to",
  "cc",
  "replyTo",
  "receivedAt",
  "sentAt",
  "keywords",
  "hasAttachment",
  /*
   * The attachment metadata, without which `mail.read` says a message has one
   * and never names it: `mail.readAttachment` takes a name "as mail.read
   * answered them", so the names have to be in this answer.
   */
  "attachments",
  "preview",
  "textBody",
  "bodyValues",
];

/** How much of a message's text one read carries, per part. */
const MESSAGE_BODY_MAX = 64 * 1024;

/** How many hits one search answers with, whatever the model asks for. */
const FIND_MAX = 50;

/** A mailbox as this tier reads it: what the search grammar resolves against. */
/** Every mailbox of the account, by id — what `resolveMailbox` reads. */
async function mailboxesOf(
  ctx: Ctx,
  accountId: string,
): Promise<Record<string, SearchMailbox & { parentId: string | null }>> {
  /*
   * One mailbox tree per unit of work: a step that files, drafts and answers
   * asked the same account for its folders three times. A mailbox write forgets
   * it (`jmap.ts`), and a FileNode write — a run's own document — does not; the
   * TTL bounds a change made elsewhere (`mailCache.ts`).
   */
  return await cachedMail(ctx, accountId, "mailboxes", async () => {
    const boxes: Record<string, SearchMailbox & { parentId: string | null }> = {};
    for (const box of await accountMailboxes(clientOf(ctx), accountId)) {
      if (typeof box.id !== "string" || typeof box.name !== "string") continue;
      boxes[box.id] = {
        id: box.id,
        name: box.name,
        role: typeof box.role === "string" ? box.role : null,
        parentId: typeof box.parentId === "string" ? box.parentId : null,
      };
    }
    return boxes;
  });
}

export const findMessages = defineTool({
  name: "mail.find",
  description:
    `Find messages in a mailbox of this account by ${SEARCH_GRAMMAR}. ` +
    "The answer names the messages it found; read the ones you need with mail.read.",
  authority: "reversible",
  writes: false,
  args: { query: { type: "text" }, limit: { type: "number", min: 1 } },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return {
      query: textArg(args, "query"),
      limit: countArg(args, "limit", FIND_MAX) ?? FIND_MAX,
    };
  },
  run: async ({ ctx, accountId }, { query, limit }) => {
    const mailboxes = await mailboxesOf(ctx, accountId);
    const filter = buildFilter(parseQuery(query), mailboxes);
    const client = clientOf(ctx);
    const answer = await client.chain(
      queryThenGet({
        query: "Email/query",
        get: "Email/get",
        accountId,
        maxObjectsInGet: client.maxObjectsInGet,
        filter,
        sort: [{ property: "receivedAt", isAscending: false }],
        limit,
        properties: HIT_PROPS,
      }),
      [CAPABILITIES.mail],
    );
    return { messages: answer.list<Record<string, unknown>>("g") };
  },
});

/**
 * The message one id names, as every reader of a message reads it.
 *
 * One fetch shape: the reading tool answers with this record, the print turns it into
 * a page, and a question path reads the words — so the properties a message is read
 * with are stated once, and a new property reaches every reader at once.
 */
export async function messageDocument(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<Record<string, unknown>> {
  const answer = await clientOf(ctx).call<{ list?: Array<Record<string, unknown>> }>(
    "Email/get",
    {
      accountId,
      ids: [id],
      properties: MESSAGE_PROPS,
      fetchTextBodyValues: true,
      maxBodyValueBytes: MESSAGE_BODY_MAX,
    },
    [CAPABILITIES.mail],
  );
  const message = answer.list?.[0];
  if (!message) throw notFound(`message "${id}" in this account`);
  return message;
}

export const readMessage = defineTool({
  name: "mail.read",
  description:
    "Read one message in full: who wrote it, when it arrived, and its text. " +
    "The id is one a search answered with.",
  authority: "reversible",
  writes: false,
  args: { id: { type: "text", about: "a message id, from open (messages)" } },
  parse: (raw: unknown) => ({ id: textArg(argsRecord(raw), "id") }),
  run: async ({ ctx, accountId }, { id }) => ({
    message: await messageDocument(ctx, accountId, id),
  }),
});

export const readAttachment = defineTool({
  name: "mail.readAttachment",
  description:
    "Read one attachment of a message of this account, by the message's id and the " +
    "attachment's name — both as mail.read answered them. A document is read " +
    "inside (a PDF, a Word file, a spreadsheet, an OpenDocument, text) and a " +
    "picture is transcribed by the installation's model.",
  authority: "reversible",
  writes: false,
  args: { id: { type: "text" }, name: { type: "text" } },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { id: textArg(args, "id"), name: textArg(args, "name") };
  },
  run: async ({ ctx, accountId, readImage }, { id, name }) => {
    const answer = await clientOf(ctx).call<{
      list?: Array<{ attachments?: unknown }>;
    }>("Email/get", { accountId, ids: [id], properties: ["attachments"] }, [
      CAPABILITIES.mail,
    ]);
    const message = answer.list?.[0];
    if (!message) throw notFound(`message "${id}" in this account`);
    const held = (Array.isArray(message.attachments) ? message.attachments : []).filter(
      isRecord,
    );
    const one = held.find(
      (part) =>
        typeof part.name === "string" &&
        part.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (!one) throw notFound(`attachment "${name}" on message "${id}"`);
    const blobId = typeof one.blobId === "string" ? one.blobId : "";
    if (!blobId)
      throw new ToolError("bad_arguments", `The attachment "${name}" has no file.`, 422);
    const type =
      typeof one.type === "string" && one.type ? one.type : "application/octet-stream";
    if (typeof one.size === "number" && one.size > READ_BYTES_MAX)
      throw new ToolError(
        "too_large",
        `The attachment "${name}" is ${one.size} bytes; a read stops at ${READ_BYTES_MAX}.`,
        413,
      );
    const bytes = await clientOf(ctx).downloadBlob(accountId, blobId, name, type);
    // A server that hides the size cannot hide the bytes.
    if (bytes.length > READ_BYTES_MAX)
      throw new ToolError(
        "too_large",
        `The attachment "${name}" is ${bytes.length} bytes; a read stops at ${READ_BYTES_MAX}.`,
        413,
      );
    return {
      name,
      type,
      size: typeof one.size === "number" ? one.size : bytes.length,
      ...(await readFileText({ type, name, bytes }, readImage)),
    };
  },
});

export const listMailboxes = defineTool({
  name: "mail.folders",
  description:
    "List the mailboxes of this account: each folder's name, what it is for " +
    "(its role — inbox, sent, drafts, junk, trash) and the folder it sits in.",
  authority: "reversible",
  writes: false,
  args: {},
  parse: () => ({}),
  run: async ({ ctx, accountId }) => {
    const boxes = await mailboxesOf(ctx, accountId);
    return { folders: Object.values(boxes) };
  },
});

/** Move one message into one folder: the body `mail.file` and `mail.trash` share. */
async function moveMessage(
  ctx: Ctx,
  accountId: string,
  id: string,
  folder: string,
  opts: { allowTrash?: boolean } = {},
): Promise<{ id: string; folder: string }> {
  {
    const boxes = await mailboxesOf(ctx, accountId);
    /*
     * A folder is named by its name, its role, or the id `find folders`
     * answered: the map is keyed by id, and a model that copied the id it was
     * given was refused for a spelling it had in hand (eval, 2026-10-22).
     */
    const target = boxes[folder] ?? resolveMailbox(folder, boxes);
    if (!target) throw notFound(`folder "${folder}" in this account`);
    /*
     * Filing into Deleted Items is `mail.trash`'s act, and that tool carries
     * the destructive class and the act-binding a person's word needs. The
     * folder role is an argument of a reversible tool, so without this guard
     * the same move is one string away from needing nobody.
     */
    if (!opts.allowTrash && target.role === "trash")
      throw new ToolError(
        "needs_authority",
        `Filing into "${target.name}" is a move to Deleted Items: it is mail.trash, which a person authorises by naming the message.`,
        403,
      );
    const answer = await clientOf(ctx).call<{ list?: Array<{ mailboxIds?: unknown }> }>(
      "Email/get",
      { accountId, ids: [id], properties: ["mailboxIds"] },
      [CAPABILITIES.mail],
    );
    const message = answer.list?.[0];
    if (!message) throw notFound(`message "${id}" in this account`);
    /*
     * The per-folder patch, never a replacement of the whole map: a message can
     * sit in several folders at once, and the folders this move does not come
     * from are not its to take away. A move with no source folder named is a
     * move out of every folder the message is known to sit in, which is what
     * `mail.file` means: the client's optimistic move and this write are one
     * function (`moveMailboxPatch`).
     */
    const patch = moveMailboxPatch(
      isRecord(message.mailboxIds) ? (message.mailboxIds as Record<string, boolean>) : {},
      target.id,
      null,
    );
    const res = await clientOf(ctx).call<SetResponse>(
      "Email/set",
      { accountId, update: { [id]: patch } },
      [CAPABILITIES.mail],
    );
    const refused = res.notUpdated?.[id];
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    return { id, folder: target.name };
  }
}

export const fileMessage = defineTool({
  name: "mail.file",
  description:
    "File a message of this account into one of its folders, by the folder's " +
    "name, its role (inbox, archive, junk), or the id `find folders` answered. " +
    "The message is taken out of the " +
    "folders it was in: it is moved, not copied. Deleted Items is not a filing " +
    "destination: mail.trash is that act, and a person licenses it.",
  authority: "reversible",
  writes: true,
  surface: "mail",
  spend: { steps: 1 },
  args: { id: { type: "text" }, folder: { type: "text" } },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { id: textArg(args, "id"), folder: textArg(args, "folder") };
  },
  run: async ({ ctx, accountId }, { id, folder }) =>
    moveMessage(ctx, accountId, id, folder),
});

/**
 * A move to the account's Deleted Items folder, where the message can be
 * recovered (owner decision 2026-10-18), and a person authorises it by naming
 * the message. The catalogue's other destructive acts — replacing or removing
 * a document, removing an empty folder — carry the same class and the same
 * act-binding: none of them runs on the model's word alone.
 */
export const trashMessage = defineTool({
  name: "mail.trash",
  description:
    "Move a message of this account to its Deleted Items folder. It is not destroyed: " +
    "it stays there and can be recovered. The act is the message: a person's word " +
    "for it names the message, and licenses that one.",
  authority: "destructive",
  writes: true,
  surface: "mail",
  spend: { steps: 1 },
  act: (args: { id: string }) => ({ target: args.id, content: null }),
  args: { id: { type: "text", about: "a message id, from open (messages)" } },
  parse: (raw: unknown) => ({ id: textArg(argsRecord(raw), "id") }),
  run: async ({ ctx, accountId }, { id }) =>
    moveMessage(ctx, accountId, id, "trash", { allowTrash: true }),
});

export const untrashMessage = defineTool({
  name: "mail.untrash",
  description:
    "Take a message of this account out of its Deleted Items folder and back " +
    "into the inbox. It is a move, so it can be undone again; a message that is " +
    "not in Deleted Items is left where it is.",
  authority: "reversible",
  writes: true,
  surface: "mail",
  spend: { steps: 1 },
  args: { id: { type: "text", about: "a message id, from open (messages)" } },
  parse: (raw: unknown) => ({ id: textArg(argsRecord(raw), "id") }),
  run: async ({ ctx, accountId }, { id }) => moveMessage(ctx, accountId, id, "inbox"),
});

export const setKeyword = defineTool({
  name: "mail.keyword",
  description:
    "Put a keyword on a message of this account, or take it off. A keyword is a " +
    "mark on a message: $seen when it has been read, $flagged for a star, the " +
    "keyword of one of the group's own labels, or one of the reserved processing " +
    `labels the product names (${AGENT_LABELS.map((one) => one.keyword).join(", ")}), ` +
    "which is how you mark a message you have processed.",
  authority: "reversible",
  writes: true,
  surface: "mail",
  spend: { steps: 1 },
  args: {
    id: { type: "text" },
    keyword: { type: "text" },
    on: { type: "boolean" },
  },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const keyword = textArg(args, "keyword");
    /*
     * The `G-` namespace is the product's own: what may be applied is exactly
     * the vocabulary in `AGENT_LABELS`, so a `G-` string outside it is an
     * invented member of a namespace that is not the caller's and is refused
     * like any other argument the tool cannot use.
     */
    if (isAgentLabel(keyword) && !AGENT_LABELS.some((one) => one.keyword === keyword))
      throw new ToolError(
        "bad_arguments",
        `"${keyword}" is in the reserved "${G_LABEL_PREFIX}" namespace and is not one of its labels; that namespace is the product's own.`,
      );
    /*
     * The two marks that say "a draft this agent wrote" are the product's,
     * written by the draft tools alone. A tool that can put them on any message
     * would turn `mail.editDraft`'s "only the agent's own draft" into two
     * reversible calls followed by a destroy of a person's mail.
     */
    if (keyword === DRAFT_KEYWORD || keyword === AGENT_DRAFT_KEYWORD)
      throw new ToolError(
        "bad_arguments",
        `"${keyword}" is a draft mark the product sets; it is not a message keyword a tool puts on.`,
      );
    const on = args.on ?? true;
    if (typeof on !== "boolean")
      throw new ToolError("bad_arguments", `"on" must be true or false.`);
    return { id: textArg(args, "id"), keyword, on };
  },
  run: async ({ ctx, accountId }, { id, keyword, on }) => {
    const res = await clientOf(ctx).call<SetResponse>(
      "Email/set",
      { accountId, update: { [id]: { [`keywords/${keyword}`]: on ? true : null } } },
      [CAPABILITIES.mail],
    );
    const refused = res.notUpdated?.[id];
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    return { id, keyword, on };
  },
});

/** An address as a message carries it, from a JMAP address list. */
export interface MailAddress {
  email: string;
  name?: string;
}

/** One sending identity of the account: its address, its name and its Bcc. */
interface SendingIdentity extends MailAddress {
  /** The account's own id for it, which a submission names. */
  id: string;
  bcc: MailAddress[];
}

/** The addresses a JMAP property carries, in order, skipping what is not one. */
export function addressesIn(value: unknown): MailAddress[] {
  if (!Array.isArray(value)) return [];
  const out: MailAddress[] = [];
  for (const one of value) {
    if (!isRecord(one) || typeof one.email !== "string" || !one.email) continue;
    out.push({
      email: one.email,
      ...(typeof one.name === "string" && one.name ? { name: one.name } : {}),
    });
  }
  return out;
}

/** The list with one entry per address, the first spelling of it kept. */
function onePerAddress(list: MailAddress[]): MailAddress[] {
  const seen = new Set<string>();
  return list.filter((one) => {
    const key = one.email.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The addresses this account sends as: the identities configured on the group.
 *
 * The group's identities are the account's own list — the same one the composer
 * offers — so a group with none has nobody to draft as, and says so rather than
 * writing a draft no mail server would send.
 */
async function sendingIdentities(
  ctx: Ctx,
  accountId: string,
): Promise<SendingIdentity[]> {
  // As the mailboxes: briefly remembered, forgotten on an identity write.
  return await cachedMail(ctx, accountId, "identities", async () => {
    const answer = await clientOf(ctx).call<{
      list?: Array<Record<string, unknown>>;
    }>("Identity/get", { accountId, ids: null }, [
      CAPABILITIES.mail,
      CAPABILITIES.submission,
    ]);
    const identities: SendingIdentity[] = [];
    for (const one of answer.list ?? []) {
      const [address] = addressesIn([one]);
      if (!address) continue;
      identities.push({
        ...address,
        id: typeof one.id === "string" ? one.id : "",
        bcc: addressesIn(one.bcc),
      });
    }
    if (!identities.length)
      throw new ToolError(
        "no_identity",
        "This account has no sending identity, so a draft could not say who it is from.",
        409,
      );
    return identities;
  });
}

/**
 * One message as the pass reads it: its sender, its text and its subject.
 *
 * The pass reads a mail twice — to decide the change it woke, and to answer a
 * person while the agent is off — and neither reads anything about how the
 * message arrived: no run takes its answer from mail (ADR 0038), so a mail is
 * data like any other, and its sender is a fact the pass records, never a
 * licence.
 */
export async function readMessageForPass(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<{ from: string | null; text: string; subject: string | null }> {
  const message = await messageDocument(ctx, accountId, id);
  return {
    from: addressesIn(message.from)[0]?.email ?? null,
    text: messageTextOf(message),
    subject: typeof message.subject === "string" ? message.subject : null,
  };
}

/**
 * The first non-empty text part of a message, and whether the read cut it short.
 *
 * One selection for every reader of a body: the pass that reads a message and the
 * print. A part the server truncated is still the text — the caller says so rather than
 * presenting half a message as the whole one.
 */
export function messageBodyOf(
  message: Record<string, unknown>,
): { text: string; truncated: boolean } | null {
  const values = isRecord(message.bodyValues) ? message.bodyValues : {};
  const parts = Array.isArray(message.textBody) ? message.textBody : [];
  for (const part of parts) {
    if (!isRecord(part) || typeof part.partId !== "string") continue;
    const held = values[part.partId];
    const value = isRecord(held) ? held.value : null;
    if (typeof value === "string" && value.trim())
      return { text: value, truncated: isRecord(held) && held.isTruncated === true };
  }
  return null;
}

/** The text a message carries: its first non-empty text part, else its preview. */
export function messageTextOf(message: Record<string, unknown>): string {
  const body = messageBodyOf(message);
  if (body) return body.text;
  return typeof message.preview === "string" ? message.preview : "";
}

export const draftReply = defineTool({
  name: "mail.draft",
  description:
    "Draft a reply to a message of this account, in the group's own Drafts " +
    "folder, without sending it: a person reads it, changes what they want and " +
    "sends it. It is a reply to everyone: the sender — or the address the " +
    "message says to reply to — in To, and everybody else the message reached " +
    "in Cc, the account's own addresses left out. It carries the thread so it " +
    `lands in the conversation, and "${DRAFT_KEYWORD}" until somebody sends it.`,
  authority: "reversible",
  writes: true,
  surface: "mail",
  spend: { steps: 1 },
  args: { id: { type: "text" }, text: { type: "text" } },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { id: textArg(args, "id"), text: textArg(args, "text") };
  },
  run: async ({ ctx, accountId }, { id, text }) => {
    const answer = await clientOf(ctx).call<{
      list?: Array<Record<string, unknown>>;
    }>(
      "Email/get",
      {
        accountId,
        ids: [id],
        properties: ["from", "replyTo", "to", "cc", "subject", "messageId", "references"],
      },
      [CAPABILITIES.mail],
    );
    const original = answer.list?.[0];
    if (!original) throw notFound(`message "${id}" in this account`);
    const identities = await sendingIdentities(ctx, accountId);
    const isOwn = (one: MailAddress) =>
      identities.some((identity) => sameAddress(identity.email, one.email));
    /*
     * Reply to all. A person's own addresses are taken out of both lists: a
     * reply the group addresses to itself is a reply nobody reads, and the
     * address a message reached is not one it is answered to.
     */
    const replyTo = addressesIn(original.replyTo);
    const senders = onePerAddress(
      replyTo.length ? replyTo : addressesIn(original.from),
    ).filter((one) => !isOwn(one));
    const others = onePerAddress([
      ...addressesIn(original.to),
      ...addressesIn(original.cc),
    ]).filter((one) => !isOwn(one));
    // A message of the group's own has no sender to answer: the reply goes on
    // with the people it was written to.
    const to = senders.length ? senders : others;
    const cc = senders.length
      ? others.filter((one) => !to.some((held) => sameAddress(held.email, one.email)))
      : [];
    if (!to.length)
      throw new ToolError(
        "no_recipient",
        `The message "${id}" reached nobody a reply could answer.`,
        422,
      );
    // The identity the message was addressed to is the one that answers it; a
    // group with several addresses does not reply as whichever came first.
    const reached = [...addressesIn(original.to), ...addressesIn(original.cc)].map(
      (one) => one.email,
    );
    const from =
      identities.find((identity) =>
        reached.some((email) => sameAddress(identity.email, email)),
      ) ?? identities[0];
    if (!from) throw notFound("sending identity in this account");
    const drafts = resolveMailbox("drafts", await mailboxesOf(ctx, accountId));
    if (!drafts) throw notFound("drafts folder in this account");
    const repliedTo = Array.isArray(original.messageId)
      ? (original.messageId.find((one): one is string => typeof one === "string") ?? null)
      : null;
    const references = Array.isArray(original.references)
      ? original.references.filter((one): one is string => typeof one === "string")
      : [];
    if (repliedTo && !references.includes(repliedTo)) references.push(repliedTo);
    const subject = replySubject(
      typeof original.subject === "string" ? original.subject : "",
      "Re",
    );
    const bcc = onePerAddress(from.bcc).filter(
      (one) =>
        !isOwn(one) &&
        !to.some((held) => sameAddress(held.email, one.email)) &&
        !cc.some((held) => sameAddress(held.email, one.email)),
    );
    const res = await clientOf(ctx).call<SetResponse<{ id?: string }>>(
      "Email/set",
      {
        accountId,
        create: {
          draft: {
            from: [{ email: from.email, ...(from.name ? { name: from.name } : {}) }],
            to,
            ...(cc.length ? { cc } : {}),
            ...(bcc.length ? { bcc } : {}),
            subject,
            sentAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            mailboxIds: { [drafts.id]: true },
            // Every mark the draft carried stays, and it is a draft whatever
            // else it was.
            keywords: {
              ...(isRecord(original.keywords) ? original.keywords : {}),
              [DRAFT_KEYWORD]: true,
              [AGENT_DRAFT_KEYWORD]: true,
            },
            bodyStructure: { partId: "text", type: "text/plain" },
            bodyValues: { text: { value: text } },
            ...(repliedTo ? { inReplyTo: [repliedTo] } : {}),
            ...(references.length ? { references } : {}),
          },
        },
      },
      [CAPABILITIES.mail],
    );
    const refused = res.notCreated?.draft;
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    const draft = res.created?.draft?.id;
    if (!draft)
      throw new ToolError(
        "write_refused",
        "The draft was not created, and the server said nothing about why.",
        409,
      );
    return {
      id: draft,
      to: to.map((one) => one.email),
      cc: cc.map((one) => one.email),
      subject,
      folder: drafts.name,
    };
  },
});

/** The addresses a tool argument names, one per entry, separated by , or ;. */
function addressesFromText(value: string | undefined): MailAddress[] | undefined {
  if (value === undefined) return undefined;
  return onePerAddress(
    value
      .split(/[,;]/)
      .map((one) => one.trim())
      .filter((one) => one.includes("@"))
      .map((email) => ({ email })),
  );
}

export const editDraft = defineTool({
  name: "mail.editDraft",
  description:
    "Replace one of this account's drafts with a new one carrying the words you " +
    "give: the old draft is destroyed and the new one keeps its thread and its " +
    "place in Drafts. `subject`, `to` and `cc` change only when you name them " +
    "(addresses separated by commas). The draft is not sent. Only a draft this " +
    "agent wrote is replaced: a person's draft is refused, never rewritten.",
  authority: "reversible",
  writes: true,
  surface: "mail",
  spend: { steps: 1 },
  args: {
    id: { type: "text" },
    text: { type: "text" },
    subject: { type: "text" },
    to: { type: "text" },
    cc: { type: "text" },
  },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return {
      id: textArg(args, "id"),
      text: textArg(args, "text"),
      subject: optionalTextArg(args, "subject"),
      to: optionalTextArg(args, "to"),
      cc: optionalTextArg(args, "cc"),
    };
  },
  run: async ({ ctx, accountId }, { id, text, subject, to, cc }) => {
    const answer = await clientOf(ctx).call<{ list?: Array<Record<string, unknown>> }>(
      "Email/get",
      {
        accountId,
        ids: [id],
        properties: [
          "from",
          "to",
          "cc",
          "bcc",
          "subject",
          "mailboxIds",
          "keywords",
          "messageId",
          "references",
          "inReplyTo",
        ],
      },
      [CAPABILITIES.mail],
    );
    const original = answer.list?.[0];
    if (!original) throw notFound(`draft "${id}" in this account`);
    /*
     * A draft is a message in Drafts, not a message wearing a mark: the mark can
     * be set by a tool, the mailbox cannot. This is the check the guarantee
     * rests on — a person's mail is never destroyed by a draft replacement.
     */
    const drafts = resolveMailbox("drafts", await mailboxesOf(ctx, accountId));
    if (!drafts)
      throw new ToolError(
        "not_a_draft",
        "This account has no Drafts folder, so it holds no draft to replace.",
        409,
      );
    const inDrafts =
      isRecord(original.mailboxIds) && original.mailboxIds[drafts.id] === true;
    if (!inDrafts)
      throw new ToolError(
        "not_a_draft",
        `"${id}" is not in the Drafts folder; the draft tools replace only what is there.`,
        409,
      );
    const keywords = isRecord(original.keywords) ? original.keywords : {};
    if (keywords[DRAFT_KEYWORD] !== true)
      throw new ToolError(
        "not_a_draft",
        `"${id}" is a message of the account, not a draft; a message is not rewritten.`,
        409,
      );
    if (keywords[AGENT_DRAFT_KEYWORD] !== true)
      throw new ToolError(
        "not_agent_draft",
        `"${id}" is a draft a person wrote; this agent replaces only the drafts it wrote itself.`,
        409,
      );
    const nextTo = addressesFromText(to) ?? addressesIn(original.to);
    if (!nextTo.length)
      throw new ToolError("no_recipient", "A draft needs somebody to go to.", 422);
    const nextCc = addressesFromText(cc) ?? addressesIn(original.cc);
    const mailboxIds = isRecord(original.mailboxIds)
      ? Object.fromEntries(Object.keys(original.mailboxIds).map((one) => [one, true]))
      : {};
    const res = await clientOf(ctx).call<SetResponse<{ id?: string }>>(
      "Email/set",
      {
        accountId,
        create: {
          draft: {
            from: addressesIn(original.from),
            to: nextTo,
            ...(nextCc.length ? { cc: nextCc } : {}),
            ...(addressesIn(original.bcc).length
              ? { bcc: addressesIn(original.bcc) }
              : {}),
            subject:
              subject ?? (typeof original.subject === "string" ? original.subject : ""),
            sentAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            mailboxIds,
            keywords: {
              [DRAFT_KEYWORD]: true,
              $seen: true,
              [AGENT_DRAFT_KEYWORD]: true,
            },
            bodyStructure: { partId: "text", type: "text/plain" },
            bodyValues: { text: { value: text } },
            ...(Array.isArray(original.inReplyTo) && original.inReplyTo.length
              ? { inReplyTo: original.inReplyTo }
              : {}),
            ...(Array.isArray(original.references) && original.references.length
              ? { references: original.references }
              : {}),
          },
        },
        destroy: [id],
      },
      [CAPABILITIES.mail],
    );
    const refused = res.notCreated?.draft;
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    const draft = res.created?.draft?.id;
    if (!draft)
      throw new ToolError(
        "write_refused",
        "The draft was not replaced, and the server said nothing about why.",
        409,
      );
    /*
     * The create and the destroy are one call, and either half can be refused.
     * A destroy that was refused leaves the old draft beside the new one: the
     * answer says so rather than reporting a replacement that left two.
     */
    const kept = res.notDestroyed?.[id];
    if (kept)
      throw new ToolError(
        "write_partial",
        `The new draft is ${draft}, and the draft it replaces could not be removed (${refusalOf(kept)}); both are in Drafts.`,
        409,
      );
    return { id: draft, replaced: id, to: nextTo.map((one) => one.email) };
  },
});

/**
 * Send the product's own one-line notice from this group's identity: written
 * into Sent, then submitted (ADR 0038, the switched-off notice).
 *
 * **It is not a tool and no run can reach it.** The catalogue has no send
 * (ADR 0038: an outward message is a draft a person sends); this is the loop's
 * answer to a message addressed to an agent that is off, and the name says so —
 * a general `sendMail` beside the tools is an invitation to make a tool of it.
 * The identity is the account's own first sending identity, never a `From:` a
 * caller supplies.
 */
export async function sendNotice(
  ctx: Ctx,
  accountId: string,
  message: { to: string; subject: string; text: string },
): Promise<{ id: string; from: string }> {
  const identities = await sendingIdentities(ctx, accountId);
  const from = identities[0];
  if (!from) throw notFound("sending identity in this account");
  const boxes = await mailboxesOf(ctx, accountId);
  const sent = resolveMailbox("sent", boxes) ?? resolveMailbox("inbox", boxes);
  if (!sent) throw notFound("sent folder in this account");
  const created = await clientOf(ctx).call<SetResponse<{ id?: string }>>(
    "Email/set",
    {
      accountId,
      create: {
        m: {
          from: [{ email: from.email, ...(from.name ? { name: from.name } : {}) }],
          to: [{ email: message.to }],
          subject: message.subject,
          sentAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          mailboxIds: { [sent.id]: true },
          keywords: { $seen: true },
          bodyStructure: { partId: "text", type: "text/plain" },
          bodyValues: { text: { value: message.text } },
        },
      },
    },
    [CAPABILITIES.mail],
  );
  const refusedCreate = created.notCreated?.m;
  if (refusedCreate) throw new ToolError("write_refused", refusalOf(refusedCreate), 409);
  const emailId = created.created?.m?.id;
  if (!emailId)
    throw new ToolError(
      "write_refused",
      "The message was not written, and the server said nothing about why.",
      409,
    );
  const submitted = await clientOf(ctx).call<SetResponse<{ id?: string }>>(
    "EmailSubmission/set",
    {
      accountId,
      create: {
        s: {
          identityId: from.id,
          emailId,
          envelope: {
            mailFrom: { email: from.email },
            rcptTo: [{ email: message.to }],
          },
        },
      },
    },
    [CAPABILITIES.mail, CAPABILITIES.submission],
  );
  const refusedSubmit = submitted.notCreated?.s;
  if (refusedSubmit) {
    /*
     * The message was written into Sent before the server could accept it.
     * Left there, it reads as mail that went out, and a model's retry files a
     * second copy beside it. The write is taken back before the refusal is
     * reported; a failed take-back leaves the copy, which is worse but honest.
     */
    await clientOf(ctx)
      .call("Email/set", { accountId, destroy: [emailId] }, [CAPABILITIES.mail])
      .catch(() => undefined);
    throw new ToolError("send_refused", refusalOf(refusedSubmit), 409);
  }
  return { id: emailId, from: from.email };
}

export const defineLabel = defineTool({
  name: "mail.label",
  description:
    "Add a label to this group's own label catalog, or change the name or the " +
    "colour of one it already holds. A label is a keyword with a name and a " +
    "colour; mail.keyword puts one on a message.",
  authority: "reversible",
  writes: true,
  surface: "mail",
  spend: { steps: 1 },
  args: {
    keyword: { type: "text" },
    name: { type: "text" },
    color: { type: "text" },
  },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const keyword = textArg(args, "keyword");
    if (isAgentLabel(keyword))
      throw new ToolError(
        "bad_arguments",
        `"${keyword}" is in the reserved "${G_LABEL_PREFIX}" namespace, which is the product's own; this catalog holds the group's human labels.`,
      );
    return {
      keyword,
      name: textArg(args, "name"),
      color: textArg(args, "color"),
    };
  },
  run: async ({ ctx, accountId }, { keyword, name, color }) => {
    const read = await readGroupLabels(ctx, accountId);
    if (read.state === "unreadable")
      throw new ToolError(
        "catalog_unreadable",
        "The group's label catalog is there and cannot be read; it has been left exactly as it is.",
        409,
      );
    const labels: LabelCatalogEntry[] = read.state === "catalog" ? [...read.labels] : [];
    const at = labels.findIndex((one) => one.keyword === keyword);
    if (at < 0) labels.push({ keyword, name, color });
    else labels[at] = { keyword, name, color };
    await writeGroupLabels(ctx, accountId, labels);
    // Its own catalog, so the change reading does not answer it.
    markOwnWrite(accountId, fileWriteKey(GROUP_LABELS_FILE));
    return { keyword, name, color, added: at < 0 };
  },
});

export const renameMailFolder = defineTool({
  name: "mail.renameFolder",
  description:
    "Rename a folder of this account's mailbox in place, by its current name " +
    "and the name to give it. Its messages stay where they are. The account's " +
    "system folders (inbox, sent and the rest) are not renamed: the mail " +
    "server keeps them by role.",
  authority: "reversible",
  writes: true,
  surface: "mail",
  spend: { steps: 1 },
  args: { name: { type: "text" }, to: { type: "text" } },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { name: textArg(args, "name"), to: textArg(args, "to") };
  },
  run: async ({ ctx, accountId }, { name, to }) => {
    const boxes = await mailboxesOf(ctx, accountId);
    const found = resolveMailbox(name, boxes);
    if (!found) throw notFound(`folder "${name}" in this account`);
    if (found.role)
      throw new ToolError(
        "reserved_folder",
        `"${found.name}" is the account's ${found.role} folder, which the mail server keeps by role and does not rename.`,
        409,
      );
    const res = await clientOf(ctx).call<SetResponse>(
      "Mailbox/set",
      { accountId, update: { [found.id]: { name: to } } },
      [CAPABILITIES.mail],
    );
    const refused = res.notUpdated?.[found.id];
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    return { id: found.id, name: to, was: found.name };
  },
});

export const deleteMailFolder = defineTool({
  name: "mail.deleteFolder",
  description:
    "Remove an empty folder of this account's mailbox by its name. A folder " +
    "that still holds messages is refused rather than emptied: file or move " +
    "what is in it first. The account's system folders are kept by role and are " +
    "not removed. The act is the folder: a person's word for it names the folder.",
  authority: "destructive",
  writes: true,
  surface: "mail",
  spend: { steps: 1 },
  act: (args: { name: string }) => ({ target: args.name, content: null }),
  args: { name: { type: "text" } },
  parse: (raw: unknown) => ({ name: textArg(argsRecord(raw), "name") }),
  run: async ({ ctx, accountId }, { name }) => {
    const boxes = await mailboxesOf(ctx, accountId);
    const found = resolveMailbox(name, boxes);
    if (!found) throw notFound(`folder "${name}" in this account`);
    if (found.role)
      throw new ToolError(
        "reserved_folder",
        `"${found.name}" is the account's ${found.role} folder, which the mail server keeps by role and does not remove.`,
        409,
      );
    const held = await clientOf(ctx).call<{ ids?: string[] }>(
      "Email/query",
      { accountId, filter: { inMailbox: found.id }, limit: 1 },
      [CAPABILITIES.mail],
    );
    if (held.ids?.length)
      throw new ToolError(
        "folder_not_empty",
        `"${found.name}" still holds messages; file or move them first, so the folder is removed only when it is empty.`,
        409,
      );
    const res = await clientOf(ctx).call<SetResponse>(
      "Mailbox/set",
      { accountId, destroy: [found.id] },
      [CAPABILITIES.mail],
    );
    const refused = res.notDestroyed?.[found.id];
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    return { name: found.name, removed: true };
  },
});

export const createMailFolder = defineTool({
  name: "mail.folder",
  description:
    "Create a folder in this account's mailbox, by its name, inside the folder " +
    "`parent` names or at the top level. A folder already there by that name is " +
    "the answer rather than an error.",
  authority: "reversible",
  writes: true,
  surface: "mail",
  spend: { steps: 1 },
  args: { name: { type: "text" }, parent: { type: "text" } },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { name: textArg(args, "name"), parent: optionalTextArg(args, "parent") };
  },
  run: async ({ ctx, accountId }, { name, parent }) => {
    const boxes = await mailboxesOf(ctx, accountId);
    let parentId: string | null = null;
    if (parent) {
      const found = resolveMailbox(parent, boxes);
      if (!found) throw notFound(`folder "${parent}" in this account`);
      parentId = found.id;
    }
    // A folder already carrying the name is the one the caller asked for, so the
    // call is safe to repeat and rests on no server refusal this build has not
    // read.
    const held = Object.values(boxes).find(
      (box) => box.parentId === parentId && box.name.toLowerCase() === name.toLowerCase(),
    );
    if (held) return { id: held.id, name: held.name, parent: parentId };
    const res = await clientOf(ctx).call<SetResponse<{ id?: string }>>(
      "Mailbox/set",
      { accountId, create: { n: { name, parentId, isSubscribed: true } } },
      [CAPABILITIES.mail],
    );
    const refused = res.notCreated?.n;
    if (refused) throw new ToolError("write_refused", refusalOf(refused), 409);
    const id = res.created?.n?.id;
    if (!id)
      throw new ToolError(
        "write_refused",
        "The mail server created the folder but returned no id.",
        502,
      );
    return { id, name, parent: parentId };
  },
});
