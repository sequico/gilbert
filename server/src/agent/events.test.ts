/**
 * What a group's account changed, read against the mock Stalwart (ADR 0035).
 *
 * Three facts the design rests on are pinned here: a read describes the mail,
 * the nodes and the workorder writes an account made — a write to a workorder is
 * an event like any other — and a change is reported **once**, because the
 * cursor is the server's own state token and the next read resumes after it. The
 * second is the whole reason the cursor exists: a rule that fired twice on one
 * arrival would answer one message twice. The third is what a removal is: a
 * destroyed node cannot be read again, so the surface it happened on is the one
 * its former path was read at, and a log bigger than one page is drained rather
 * than refused.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
// The demo traffic writes into the account on an interval; a test that measures
// changes reads an account nothing else is writing to.
process.env.MOCK_NO_DEMO = "1";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-events";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { filesAccountId, readAppFileAt, writeAppFileAt, writeBytesIntoVisibleFolder } =
  await import("../appFolder.js");
const { destroyAppNode } = await import("../appFolder.js");
const { clientOf } = await import("../util.js");
const { CAPABILITIES } = await import("../shared/capabilities.js");
const { anchorEvents, MAX_CHANGES_PER_READ, readAccountEvents, readChangeSet } =
  await import("./events.js");

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;

let ctx: Ctx;
let accountId: string;

before(async () => {
  await waitForPort(BASE, AUTH);
  const session = await fetchUpstreamSession(AUTH, BASE);
  ctx = { authorization: AUTH, session, username: "demo@example.com" };
  accountId = filesAccountId(ctx);
  assert.ok(accountId, "the demo account owns Files");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** One message delivered into the account: a create in its own Email log. */
async function deliver(subject: string): Promise<string> {
  const answer = await clientOf(ctx).call<{ created?: { c?: { id?: string } } }>(
    "Email/set",
    { accountId, create: { c: { subject, mailboxIds: { inbox: true } } } },
    [CAPABILITIES.mail],
  );
  const id = answer.created?.c?.id;
  assert.ok(id, "the mock created the message");
  return id;
}

test("a change log answer without a resume state, or with a list that is not ids, is refused", () => {
  assert.throws(
    () => readChangeSet({ created: ["m1"] }, "Email"),
    /answered no state to resume from/,
    "without the state it ends at there is no cursor to move",
  );
  assert.throws(
    () => readChangeSet({ newState: "s2", destroyed: [7] }, "FileNode"),
    /not a list of ids/,
    "a change list names things the log changed, and a number is not one",
  );
  assert.deepEqual(
    readChangeSet({ newState: "s2" }, "Email"),
    {
      created: [],
      updated: [],
      destroyed: [],
      newState: "s2",
      hasMoreChanges: false,
    },
    "a window with nothing in it is a window like any other",
  );
  assert.equal(
    readChangeSet({ newState: "s2", hasMoreChanges: true }, "Email").hasMoreChanges,
    true,
    "and a log with more to say is read as saying so, not as a refusal",
  );
});

test("a read describes the mail, the files, the chat and the workorder writes it carries", async () => {
  const anchor = await anchorEvents(ctx, accountId);

  const message = await deliver("a booking confirmation");
  await writeAppFileAt(ctx, accountId, "workorders/wo-1.json", { v: 1, uid: "wo-1" });
  await writeAppFileAt(ctx, accountId, "chat/c-1.json", {
    v: 1,
    from: "a@example.com",
    at: new Date().toISOString(),
    text: "ciao",
  });
  await writeBytesIntoVisibleFolder(
    ctx,
    accountId,
    "Documents",
    "order.pdf",
    new TextEncoder().encode("%PDF-1.4"),
    "application/pdf",
  );

  const { events } = await readAccountEvents(ctx, accountId, anchor);

  assert.ok(
    events.some(
      (event) =>
        event.source === "mail" && event.change === "created" && event.where === message,
    ),
    "the message that arrived is an event naming the message",
  );
  assert.deepEqual(
    events.find((event) => event.source === "workorder"),
    { source: "workorder", change: "created", where: "gilbert/workorders/wo-1.json" },
    "a write to a workorder is an event like any other",
  );
  assert.deepEqual(
    events.find((event) => event.source === "chat"),
    { source: "chat", change: "created", where: "gilbert/chat/c-1.json" },
    "a chat message is its own surface, named by its own folder",
  );
  assert.ok(
    events.some(
      (event) => event.source === "files" && event.where === "Documents/order.pdf",
    ),
    "a node in the visible tree carries its own path",
  );
});

test("a change is read once: the next read resumes where the last one ended", async () => {
  const anchor = await anchorEvents(ctx, accountId);
  const message = await deliver("another one");
  const first = await readAccountEvents(ctx, accountId, anchor);
  assert.ok(
    first.events.some((event) => event.where === message),
    "the arrival is in the first read",
  );

  assert.deepEqual(
    (await readAccountEvents(ctx, accountId, first.cursor)).events,
    [],
    "the same window read twice reports nothing the second time",
  );

  await writeAppFileAt(ctx, accountId, "workorders/wo-2.json", { v: 1, uid: "wo-2" });
  const third = await readAccountEvents(ctx, accountId, first.cursor);
  const written = third.events.filter(
    (event) => event.where === "gilbert/workorders/wo-2.json",
  );
  // One write may arrive as more than one change — the tree's write path makes
  // the folders a document needs on the way — and what matters here is that
  // only the new change is reported.
  assert.ok(
    written.length >= 1 && written.every((event) => event.source === "workorder"),
    "the new workorder write is reported",
  );
  assert.ok(
    !third.events.some((event) => event.where === message),
    "and the change the cursor already passed is not reported again",
  );
});

test("a log larger than one page is read to its end", async () => {
  const anchor = await anchorEvents(ctx, accountId);
  const before = mock.methodCalls["Email/changes"] ?? 0;
  const delivered: string[] = [];
  // One change past the page the reading asks for, so a read that stopped at
  // its first page would leave one change behind and the cursor would move
  // past it.
  for (let i = 0; i <= MAX_CHANGES_PER_READ; i++)
    delivered.push(await deliver(`burst ${i}`));

  const { events } = await readAccountEvents(ctx, accountId, anchor);
  const reported = new Set(
    events.filter((event) => event.change === "created").map((event) => event.where),
  );
  assert.ok(
    delivered.every((id) => reported.has(id)),
    "every change of the burst is reported, not only the first page",
  );
  assert.ok(
    (mock.methodCalls["Email/changes"] ?? 0) - before >= 2,
    "the reading asked the log again rather than stopping at one page",
  );
});

test("a cursor the log no longer reaches is refused, and the refusal says what it costs", async () => {
  const anchor = await anchorEvents(ctx, accountId);
  // Past the window the log still holds, so what it can answer no longer
  // reaches back to where the reading stands.
  for (let i = 0; i < 201; i++) await deliver(`gap ${i}`);
  await assert.rejects(
    () => readAccountEvents(ctx, accountId, anchor),
    /no longer holds the changes this account's reading asks for/,
    "the changes in between are lost, and the reading has to begin again",
  );
});

test("a removal is reported on the surface its former path was read at", async () => {
  const anchor = await anchorEvents(ctx, accountId);
  await writeAppFileAt(ctx, accountId, "chat/c-2.json", {
    v: 1,
    from: "a@example.com",
    at: new Date().toISOString(),
    text: "ciao",
  });
  const written = await readAppFileAt(ctx, accountId, "chat/c-2.json");
  assert.ok(written, "the message is written");
  const id = String(written.file.id);

  // Read while the node is there: a destroyed node cannot be read again, so
  // this is what the removal that follows is named by.
  const seen = await readAccountEvents(ctx, accountId, anchor);
  assert.ok(
    seen.events.some(
      (event) => event.source === "chat" && event.where === "gilbert/chat/c-2.json",
    ),
    "the message is read as the chat it is",
  );

  await destroyAppNode(ctx, accountId, id);
  const removed = await readAccountEvents(ctx, accountId, seen.cursor);
  assert.deepEqual(
    removed.events.find(
      (event) => event.change === "destroyed" && event.where === "gilbert/chat/c-2.json",
    ),
    { source: "chat", change: "destroyed", where: "gilbert/chat/c-2.json" },
    "a rule watching chat is told the message went",
  );
});

test("a removal whose path this process never read is named by its id", async () => {
  const anchor = await anchorEvents(ctx, accountId);
  await writeAppFileAt(ctx, accountId, "workorders/wo-3.json", { v: 1, uid: "wo-3" });
  const written = await readAppFileAt(ctx, accountId, "workorders/wo-3.json");
  assert.ok(written, "the workorder is written");
  const id = String(written.file.id);
  await destroyAppNode(ctx, accountId, id);

  const { events } = await readAccountEvents(ctx, accountId, anchor);
  assert.deepEqual(
    events.find((event) => event.change === "destroyed" && event.where === id),
    { source: "files", change: "destroyed", where: id },
    "with no former path to report, the id is the whole of what it can be named by",
  );
});
