/**
 * The tools over the group's own conversation (ADR 0004).
 *
 * Finding a message and reading it, saying something in the conversation, and
 * asking a person there — the one question whose answer is read from the
 * conversation rather than from a mailbox.
 */

import { type Ctx, filesAccountId } from "../../appFolder.js";
import { groupMembers } from "../../groupAccess.js";
import { findChatMessages, postChatMessage, readChatMessageBy } from "../../groupChat.js";
import {
  CHAT_MAX_TEXT,
  type ChatMention,
  type ChatRef,
  mentionsByName,
  parseChatRef,
} from "../../shared/chat.js";
import { QUESTION_TTL_MS, type RunWait } from "../../shared/run.js";
import { listRunsForWorking } from "../runs.js";
import { argsRecord, countArg, notFound, optionalTextArg, textArg } from "./args.js";
import { defineTool, ToolError } from "./define.js";

/** A question's words, with the noise a retry changes taken out. */
function sameQuestion(a: string, b: string): boolean {
  const normal = (text: string): string =>
    text
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .trim();
  return normal(a) === normal(b);
}

/**
 * How many chat messages one search answers with, whatever the model asks for.
 *
 * Small on purpose: every hit's text is carried into the next prompt, and a
 * search for a common word once answered with six full messages -- thousands of
 * tokens for a greeting. The model reads the one it needs with `chat.read`.
 */
const CHAT_FIND_MAX = 8;

/** How much of each hit's text the answer carries. */
const HIT_TEXT_MAX = 280;

/** How much of a read message the answer carries; enough to answer from. */
const READ_TEXT_MAX = 2_000;

/** Words that identify nothing: a search for one of them is a scan of noise. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "is",
  "it",
  "on",
  "for",
  "at",
  "by",
  "with",
  "this",
  "that",
  "from",
  "as",
  "be",
  "are",
  "was",
]);

/** The first `max` characters of `text`, marked when there are more. */
function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const readChat = defineTool({
  name: "chat.read",
  description:
    "Read one message of this group's own conversation, by the id a search " +
    "answered with or the address an event names: who posted it, when, its " +
    "text, and the message it answers — with that message's own words, so a " +
    "reply can be read as what it is about.",
  authority: "reversible",
  writes: false,
  args: { id: { type: "text", about: "a chat message id, from open (chats)" } },
  parse: (raw: unknown) => ({ id: textArg(argsRecord(raw), "id") }),
  run: async ({ ctx, accountId }, { id }) => {
    const message = await readChatMessageBy(ctx, accountId, id);
    if (!message) throw notFound(`chat message "${id}" in this account`);
    /*
     * The message it answers travels with it: a person writes "@sq" under a
     * sentence to mean "about that", and an id alone leaves the reader without
     * the thing it was about.
     */
    const quoted = message.replyTo
      ? await readChatMessageBy(ctx, accountId, message.replyTo)
      : null;
    return {
      message: { ...message, text: shorten(message.text, READ_TEXT_MAX) },
      ...(quoted
        ? {
            quoted: {
              from: quoted.from,
              at: quoted.at,
              text: shorten(quoted.text, READ_TEXT_MAX),
            },
          }
        : {}),
    };
  },
});

export const findChat = defineTool({
  name: "chat.find",
  description:
    "Find messages of this group's recent conversation whose text contains the " +
    "given words — who was asked something, what was answered. The answer names " +
    'the messages it found, newest first; read one with `open` (`what: "chat"`).',
  authority: "reversible",
  writes: false,
  args: {
    query: { type: "text" },
    limit: { type: "number", min: 1, max: CHAT_FIND_MAX },
  },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    const query = textArg(args, "query");
    /*
     * A search for "the" scans the conversation and answers with noise, which
     * is then carried into the prompt: one word that identifies something is
     * what the tool asks for.
     */
    const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    if (!words.some((word) => word.length >= 3 && !STOPWORDS.has(word)))
      throw new ToolError(
        "bad_arguments",
        "search for a word that identifies the message, not a stopword or a fragment",
      );
    return {
      query,
      limit: countArg(args, "limit", CHAT_FIND_MAX) ?? CHAT_FIND_MAX,
    };
  },
  run: async ({ ctx, accountId }, { query, limit }) => {
    // One more than the page, so a search that found more can say so: a clipped
    // answer read as the whole result is how a model concludes the tail is not there.
    const messages = await findChatMessages(ctx, accountId, query, limit + 1);
    const page = messages.slice(0, limit);
    return {
      messages: page.map((one) => ({
        ...one,
        text: shorten(one.text, HIT_TEXT_MAX),
      })),
      ...(messages.length > limit ? { truncated: true } : {}),
    };
  },
});

/**
 * The line a question carries so a person knows what answering it takes.
 *
 * A question is correlated with its answer by the **reply** (`shared/chat.ts`),
 * not by the next message in the channel — a live question sat unanswered for
 * hours beside a person who had no way of knowing that a reply was what it
 * took, and they wrote a new request instead.
 */
const ANSWER_WITH_A_REPLY = "Reply to this message to answer it.";

/**
 * The most a question may be: the conversation's ceiling, less the line the
 * question carries and the blank line before it, so what is posted is inside
 * the ceiling the tool itself refuses.
 */
const ASK_TEXT_MAX = CHAT_MAX_TEXT - ANSWER_WITH_A_REPLY.length - 2;

/**
 * The text of a chat message, bounded where the document is.
 *
 * `CHAT_MAX_TEXT` is the chat's own ceiling (ADR 0004): a message longer than it
 * is a message the reader would not render, so it is refused here rather than
 * written and silently cut.
 */
function chatText(args: Record<string, unknown>, max = CHAT_MAX_TEXT): string {
  /*
   * A mention is `@` and the local part, which is what the conversation reads
   * (`mentionsName`). The model is given whole addresses and prefixes them
   * whole, so the domain is dropped here rather than left in the message.
   */
  const text = textArg(args, "text").replace(
    /@([^\s@]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "@$1",
  );
  if (text.length > max)
    throw new ToolError("bad_arguments", `"text" must be at most ${max} characters.`);
  return text;
}

/**
 * The people a text addresses, resolved against the group's roster.
 *
 * The agent writes `@local`, which the conversation reads as a mention; the
 * stored mark is what the client and the off path look for, so the roster turns
 * the words back into principals.
 */ async function mentionsOf(
  ctx: Ctx,
  accountId: string,
  text: string,
): Promise<{ mentions?: ChatMention[] }> {
  if (!text.includes("@")) return {};
  const members = await groupMembers(ctx, accountId).catch(() => null);
  if (!members?.length) return {};
  const mentions = mentionsByName(
    text,
    members.filter((one) => one.toLowerCase() !== ctx.username.toLowerCase()),
  );
  return mentions.length ? { mentions } : {};
}

/** The most objects one message points at: a report links a few, not a dump. */
const REFS_MAX = 4;

/**
 * The references a message carries, or a refusal naming the shape.
 *
 * A reference is `kind:id`, and an event is `event:id@YYYY-MM-DD` because a
 * calendar route names a day. The kind and the shape are checked here, so the
 * client composes an address from them and can compose nothing else: a message
 * points at an object of this account, never at an address the text dictates.
 */
function refsArg(args: Record<string, unknown>): ChatRef[] {
  const raw = args.refs;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new ToolError("bad_arguments", '"refs" must be a list of "kind:id".');
  const refs: ChatRef[] = [];
  for (const one of raw) {
    const ref = typeof one === "string" ? parseChatRef(one) : null;
    if (!ref)
      throw new ToolError(
        "bad_arguments",
        `"${String(one)}" is not a reference: write "kind:id" — thread, file, contact — or "event:id@YYYY-MM-DD".`,
      );
    if (refs.some((held) => held.kind === ref.kind && held.id === ref.id)) continue;
    if (refs.length >= REFS_MAX)
      throw new ToolError(
        "bad_arguments",
        `"refs" carries at most ${REFS_MAX} references.`,
      );
    refs.push(ref);
  }
  return refs;
}

/**
 * The account each reference lives in, as the server knows it: a group's own
 * objects are the run's account, and **the contacts are the installation's** —
 * the one directory in the Master's account — so a card's link is not resolved
 * against the group it was mentioned in.
 */
function refsHomed(ctx: Ctx, accountId: string, refs: readonly ChatRef[]): ChatRef[] {
  return refs.map((ref) => ({
    ...ref,
    account: ref.kind === "contact" ? filesAccountId(ctx) : accountId,
  }));
}

export const sayInChat = defineTool({
  name: "chat.say",
  description:
    "Say something in this group's own conversation, as yourself: how the group " +
    "is told what the work did. Asking a person something the work needs " +
    'answered is `say` with `action: "ask"`.',
  authority: "reversible",
  writes: true,
  surface: "chat",
  spend: { steps: 1 },
  args: {
    text: { type: "text", max: CHAT_MAX_TEXT },
    replyTo: { type: "text" },
    refs: {
      type: "list",
      max: 200,
      about:
        'objects of this group\'s account the message points at, as "kind:id" — ' +
        "thread (a message's threadId), file (a Files node), contact (a card), or " +
        'event as "event:id@YYYY-MM-DD"; every id is one a read answered',
    },
  },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return {
      text: chatText(args),
      replyTo: optionalTextArg(args, "replyTo"),
      refs: refsArg(args),
    };
  },
  run: async ({ ctx, accountId }, { text, replyTo, refs }) => {
    // The agent writes as itself and acts in the group's account (ADR 0029):
    // the sender is the address the session signed in as.
    const id = await postChatMessage(ctx, accountId, ctx.username, text, {
      ...(replyTo ? { replyTo } : {}),
      ...(await mentionsOf(ctx, accountId, text)),
      ...(refs.length ? { refs: refsHomed(ctx, accountId, refs) } : {}),
    });
    return { id };
  },
});

export const askInChat = defineTool({
  name: "chat.ask",
  description:
    "Ask a person a question in this group's own conversation and leave the run " +
    "waiting on their answer: the run stops until somebody replies, and the " +
    "answer is read from the conversation. Use it for what only a person can " +
    'decide; a report nobody has to answer is `say` with `action: "say"`. A question the group ' +
    "already has open is not asked again: this run waits on that same answer.",
  authority: "reversible",
  writes: true,
  surface: "chat",
  waits: true,
  spend: { steps: 1 },
  args: { text: { type: "text", max: ASK_TEXT_MAX } },
  parse: (raw: unknown) => ({ text: chatText(argsRecord(raw), ASK_TEXT_MAX) }),
  run: async ({ ctx, accountId, run }, { text }) => {
    /*
     * A question already open on a person is not asked twice: a second run that
     * asks the same thing parks beside the first, the group reads two copies of
     * one question, and the first answer moves only one run. The earlier run's
     * message is the answer, and this run continues instead of waiting.
     */
    const open = await listRunsForWorking(ctx, accountId);
    const held = open.records.find(
      ({ run: other }) =>
        other.id !== run.id &&
        other.state === "blocked" &&
        other.waiting?.asked?.channel === "chat" &&
        typeof other.waiting.what === "string" &&
        sameQuestion(other.waiting.what, text),
    );
    if (held?.run.waiting?.asked)
      /*
       * The group already has this question open: the words are not posted twice,
       * and this run waits on the same sentence and the same deadline — the one
       * answer continues every run that needed it (ADR 0029, `loop.ts`'s
       * `runsAwaiting`).
       */
      return {
        id: held.run.waiting.asked.id,
        alreadyAsked: true,
        wait: {
          what: held.run.waiting.what,
          asked: held.run.waiting.asked,
          until: held.run.waiting.until,
        },
      };
    const id = await postChatMessage(
      ctx,
      accountId,
      ctx.username,
      `${text}\n\n${ANSWER_WITH_A_REPLY}`,
      {
        ...(await mentionsOf(ctx, accountId, text)),
      },
    );
    /*
     * What the run waits for is a person's answer, and that wait carries the
     * **deadline** a question has (ADR 0029, 0030): when it comes due the run goes
     * on without the answer, with a step that says so, rather than waiting for
     * ever. The answer still arrives as an event in the conversation, never by the
     * clock; the date is what happens if it never comes. The answer goes into the
     * run's own document by the loop (`waitUntil`) — the run is the loop's to
     * write, as its tally is — and `asked` is the message the answer will reply to.
     */
    const wait: RunWait = {
      what: text,
      asked: { channel: "chat", id },
      until: new Date(Date.now() + QUESTION_TTL_MS).toISOString(),
    };
    return { id, wait };
  },
});
