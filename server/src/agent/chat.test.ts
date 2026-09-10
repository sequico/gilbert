import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ChatMessage } from "../shared/chat.js";

/**
 * The agent's side of the group chat against the mock (ADR 0006, resolution 11).
 *
 * Reading the transcript, deciding which messages address the agent, and the
 * closed yes/no vocabulary are all deterministic: those are what keep a model
 * from being asked to interpret an approval. The chat's ordering key is the
 * server's own node timestamp, so the test spaces its posts by a few
 * milliseconds rather than assuming two writes land in different milliseconds.
 */

const PORT = 18846;
process.env.MOCK_PORT = String(PORT);

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { writeAppFileAt } = await import("../appFolder.js");
const { JmapClient } = await import("../jmap.js");
const {
  conversationContext,
  indexChat,
  pendingRequests,
  postMessage,
  readApproval,
  readChat,
} = await import("./chat.js");

const BASE = `http://127.0.0.1:${PORT}`;
const GROUP = "a3";
const AGENT = "gilbert@example.com";
const ADA = "ada@example.org";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo").toString("base64")}`;

const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };
const client = new JmapClient(AUTH, session);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let first = "";
let agentMessage = "";
let reply = "";

before(async () => {
  first = await postMessage(ctx, GROUP, ADA, "morning everyone");
  await sleep(5);
  agentMessage = await postMessage(ctx, GROUP, AGENT, "I filed the invoices.");
  await sleep(5);
  reply = await postMessage(ctx, GROUP, ADA, "thanks", agentMessage);
  await sleep(5);
  await postMessage(ctx, GROUP, "grace@example.org", "@gilbert can you file mine?");
  await sleep(5);
  await postMessage(ctx, GROUP, "grace@example.org", "unrelated chatter");
  // A document that is not a chat message, which the reader must skip.
  await writeAppFileAt(ctx, GROUP, "chat/not-a-message.json", { v: 2, nope: true });
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the transcript is read oldest first and keeps only messages", async () => {
  const messages = await readChat(ctx, GROUP, client);
  assert.ok(messages.length >= 5);
  assert.equal(messages[0]?.id, first);
  assert.ok(!messages.some((message) => message.text === undefined));
  const texts = messages.map((message) => message.text);
  assert.ok(!texts.includes(undefined as unknown as string));
  assert.equal(
    messages.some((message) => message.id === "not-a-message"),
    false,
    "a document that is not a message is not in the transcript",
  );
});

test("a mention, the loose form included, and a direct reply address the agent", async () => {
  const messages = await readChat(ctx, GROUP, client);
  const requests = pendingRequests(messages, AGENT, indexChat(messages));
  const byId = new Map(requests.map((request) => [request.messageId, request]));
  assert.equal(byId.has(first), false, "an unaddressed message is not a request");
  assert.equal(byId.has(agentMessage), false, "the agent does not answer itself");
  assert.equal(byId.get(reply)?.reply, true, "a reply to the agent's own message counts");
  const mentioned = requests.find((request) =>
    request.text.includes("can you file mine"),
  );
  assert.ok(mentioned, "@gilbert typed by hand addresses the agent");
  assert.equal(mentioned.reply, false);
  assert.equal(mentioned.author, "grace@example.org");
});

test("a reply to somebody else's message is not a request", async () => {
  const other = await postMessage(ctx, GROUP, "grace@example.org", "sure", first);
  await sleep(5);
  const messages = await readChat(ctx, GROUP, client);
  const requests = pendingRequests(messages, AGENT, indexChat(messages));
  assert.equal(
    requests.some((request) => request.messageId === other),
    false,
    "only a direct reply to the agent's own message counts",
  );
});

test("the context is bounded, and a reply chain survives a narrow window", async () => {
  const messages = await readChat(ctx, GROUP, client);
  const newest = messages[messages.length - 1]!;
  const wide = conversationContext(messages, newest.created);
  assert.deepEqual(
    wide.map((message) => message.id),
    messages.map((message) => message.id),
    "the default bound is fifty messages and this chat is shorter",
  );
  /* The chain rule on a transcript built for it, so the test states the rule
     rather than depending on how many messages the mock's chat happens to
     hold by now: a one-message window is [m4], and the message it answers
     comes back with it. */
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 10, 8, minute)).toISOString();
  const synthetic: ChatMessage[] = [
    { v: 1, id: "m1", created: at(1), from: "ada@example.org", at: at(1), text: "start" },
    { v: 1, id: "m2", created: at(2), from: "grace@example.org", at: at(2), text: "hmm" },
    { v: 1, id: "m3", created: at(3), from: AGENT, at: at(3), text: "on it" },
    {
      v: 1,
      id: "m4",
      created: at(4),
      from: "ada@example.org",
      at: at(4),
      text: "@gilbert status?",
      replyTo: "m3",
    },
  ];
  const narrow = conversationContext(synthetic, at(4), 1);
  assert.deepEqual(
    narrow.map((message) => message.id),
    ["m3", "m4"],
    "the window plus the message it answers, and nothing else",
  );
  const fromTheStart = conversationContext(synthetic, at(4), 50);
  assert.deepEqual(
    fromTheStart.map((message) => message.id),
    ["m1", "m2", "m3", "m4"],
    "the default bound is fifty, so a short chat is whole",
  );
  const tiny = conversationContext(messages, newest.created, 1);
  assert.ok(tiny.length >= 1);
});

test("the approval vocabulary is closed, and refusal wins when both appear", () => {
  assert.equal(readApproval("yes"), "yes");
  assert.equal(readApproval("OK, go ahead"), "yes");
  assert.equal(readApproval("APPROVED"), "yes");
  assert.equal(readApproval("no"), "no");
  assert.equal(readApproval("please don't"), "no");
  assert.equal(readApproval("cancel that"), "no");
  assert.equal(
    readApproval("ok but don't send it"),
    "no",
    "an ambiguous answer is not an approval",
  );
  assert.equal(readApproval("maybe later"), "unclear");
  assert.equal(readApproval(""), "unclear");
  assert.equal(readApproval("what do you think?"), "unclear");
});

function replyCreated(
  messages: Awaited<ReturnType<typeof readChat>>,
  id: string,
): string {
  return messages.find((message) => message.id === id)?.created ?? "";
}

test("only a person saying so widens the run's context", async () => {
  const { widenRequested } = await import("./chat.js");
  // The bound is 50 by default and the run never widens itself (ADR 0003
  // resolution 11); these are the words that move it to the ceiling.  assert.equal(widenRequested("@gilbert can you file this?"), false);
  assert.equal(widenRequested("@gilbert please read the whole conversation"), true);
  assert.equal(widenRequested("read everything, @gilbert"), true);
  assert.equal(widenRequested("@gilbert start from the beginning"), true);
  assert.equal(widenRequested("@gilbert summarise all the messages"), true);
});

test("a folder is read only when a person names one", async () => {
  const { folderRequest } = await import("./chat.js");
  assert.equal(folderRequest("@gilbert file this?"), null);
  assert.equal(folderRequest("@gilbert read the Inbox folder"), "Inbox");
  assert.equal(folderRequest("@gilbert read folder Archive"), "Archive");
  assert.equal(folderRequest("@gilbert look in the Clients folder, please"), "Clients");
  assert.equal(folderRequest("@gilbert tell me about the movie folder"), "movie");
});
