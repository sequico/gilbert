/**
 * The tools over the group's own conversation (ADR 0005).
 *
 * Finding a message and reading it, saying something in the conversation, and
 * asking a person there — the one question whose answer is read from the
 * conversation rather than from a mailbox.
 */

import { findChatMessages, postChatMessage, readChatMessageBy } from "../../groupChat.js";
import { CHAT_MAX_TEXT } from "../../shared/chat.js";
import type { RunWait } from "../../shared/run.js";
import { argsRecord, countArg, notFound, optionalTextArg, textArg } from "./args.js";
import { defineTool, ToolError } from "./define.js";

/** How many chat messages one search answers with, whatever the model asks for. */
const CHAT_FIND_MAX = 50;

export const readChat = defineTool({
  name: "chat.read",
  description:
    "Read one message of this group's own conversation, by the id a search " +
    "answered with or the address an event names: who posted it, when, its " +
    "text, and the message it answers.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => ({ id: textArg(argsRecord(raw), "id") }),
  run: async ({ ctx, accountId }, { id }) => {
    const message = await readChatMessageBy(ctx, accountId, id);
    if (!message) throw notFound(`chat message "${id}" in this account`);
    return { message };
  },
});

export const findChat = defineTool({
  name: "chat.find",
  description:
    "Find messages of this group's recent conversation whose text contains the " +
    "given words — who was asked something, what was answered. The answer names " +
    "the messages it found, newest first; read one with chat.read.",
  authority: "reversible",
  writes: false,
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return {
      query: textArg(args, "query"),
      limit: countArg(args, "limit", CHAT_FIND_MAX) ?? CHAT_FIND_MAX,
    };
  },
  run: async ({ ctx, accountId }, { query, limit }) => ({
    messages: await findChatMessages(ctx, accountId, query, limit),
  }),
});

/**
 * The text of a chat message, bounded where the document is.
 *
 * `CHAT_MAX_TEXT` is the chat's own ceiling (ADR 0005): a message longer than it
 * is a message the reader would not render, so it is refused here rather than
 * written and silently cut.
 */
function chatText(args: Record<string, unknown>): string {
  const text = textArg(args, "text");
  if (text.length > CHAT_MAX_TEXT)
    throw new ToolError(
      "bad_arguments",
      `"text" must be at most ${CHAT_MAX_TEXT} characters.`,
    );
  return text;
}

export const sayInChat = defineTool({
  name: "chat.say",
  description:
    "Say something in this group's own conversation, as yourself: how the group " +
    "is told what the work did. Asking a person something the work needs " +
    "answered is chat.ask.",
  authority: "reversible",
  writes: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { text: chatText(args), replyTo: optionalTextArg(args, "replyTo") };
  },
  run: async ({ ctx, accountId }, { text, replyTo }) => {
    // The agent writes as itself and acts in the group's account (ADR 0033):
    // the sender is the address the session signed in as.
    const id = await postChatMessage(ctx, accountId, ctx.username, text, { replyTo });
    return { id };
  },
});

export const askInChat = defineTool({
  name: "chat.ask",
  description:
    "Ask a person a question in this group's own conversation and leave the run " +
    "waiting on their answer: the run stops until somebody replies, and the " +
    "answer is read from the conversation. Use it for what only a person can " +
    "decide; a report nobody has to answer is chat.say.",
  authority: "reversible",
  writes: true,
  waits: true,
  spend: { steps: 1 },
  parse: (raw: unknown) => ({ text: chatText(argsRecord(raw)) }),
  run: async ({ ctx, accountId }, { text }) => {
    const id = await postChatMessage(ctx, accountId, ctx.username, text);
    /*
     * What the run waits for is a person's answer, and that wait carries **no
     * date**: the run is picked up when the answer arrives in the conversation,
     * never by a clock (ADR 0033, 0034). The answer goes into the run's own
     * document by the loop (`waitUntil`) — the run is the loop's to write, as
     * its tally is — and `asked` is the message the answer will reply to.
     */
    const wait: RunWait = {
      what: text,
      asked: { channel: "chat", id },
      until: null,
    };
    return { id, wait };
  },
});
