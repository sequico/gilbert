/**
 * What a group's account changed, read against the mock Stalwart (ADR 0035).
 *
 * Two facts the design rests on are pinned here: a read describes the mail, the
 * nodes and the workorder writes an account made — a write to a workorder is an
 * event like any other — and a change is reported **once**, because the cursor
 * is the server's own state token and the next read resumes after it. The
 * second is the whole reason the cursor exists: a rule that fired twice on one
 * arrival would answer one message twice.
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
const { anchorEvents, readAccountEvents } = await import("./events.js");

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
  // One write arrives as two changes on purpose: the tree's write path issues a
  // create and then the update that puts the bytes in the node, and Stalwart
  // reports each. What matters here is that only the new change is reported.
  assert.ok(
    written.length >= 1 && written.every((event) => event.source === "workorder"),
    "the new workorder write is reported",
  );
  assert.ok(
    !third.events.some((event) => event.where === message),
    "and the change the cursor already passed is not reported again",
  );
});

test("a node the server has already destroyed is reported by its id", async () => {
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
  await destroyAppNode(ctx, accountId, id);

  const { events } = await readAccountEvents(ctx, accountId, anchor);
  assert.deepEqual(
    events.find((event) => event.change === "destroyed" && event.where === id),
    { source: "files", change: "destroyed", where: id },
    "the removal is reported, and a node that is gone can only be named by its id",
  );
});
