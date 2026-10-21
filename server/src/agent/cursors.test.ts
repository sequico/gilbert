/**
 * The reading cursor as a document (ADR 0037).
 *
 * What a restart depends on: the state three change logs ended at, the paths a
 * destroyed node was read at, and the instant the reading was taken — written
 * into the group's own app folder and read back whole. A document that is there
 * and is not this shape is refused in a code, never read as an anchor: an
 * anchor nobody can name is a window of changes reported as an ordinary read.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_DEMO = "1";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-cursors";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { destroyAppNode, filesAccountId, readAppFileAt, writeAppFileAt } = await import(
  "../appFolder.js"
);
const { CURSOR_FILE, CursorError, readCursor, writeCursor } = await import(
  "./cursors.js"
);

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const AT = new Date("2026-10-21T14:51:38.000Z");

let ctx: Ctx;
let accountId: string;

before(async () => {
  await waitForPort(BASE, AUTH);
  const session = await fetchUpstreamSession(AUTH, BASE);
  ctx = { authorization: AUTH, session, username: "demo@example.com" };
  accountId = filesAccountId(ctx);
  assert.ok(accountId, "the Master's session owns Files");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** Put the account back to a group never read, whatever the test left. */
async function forget(): Promise<void> {
  const found = await readAppFileAt(ctx, accountId, CURSOR_FILE);
  const nodeId = found?.file.id;
  if (typeof nodeId === "string") await destroyAppNode(ctx, accountId, nodeId, {});
}

test("a cursor written is the cursor read back, with the instant it was taken", async () => {
  await forget();
  assert.equal(
    await readCursor(ctx, accountId),
    null,
    "a group never read has no cursor",
  );

  const cursor = {
    mail: "Ma",
    files: "Fa",
    calendar: "Ca",
    seen: { c: "gilbert/chat/one.json", d: "MS2/order.pdf" },
  };
  await writeCursor(ctx, accountId, cursor, AT);

  const held = await readCursor(ctx, accountId);
  assert.deepEqual(held?.cursor, cursor, "the three states and the paths survive whole");
  assert.equal(
    held?.at,
    AT.getTime(),
    "and the instant is the one the read was taken at",
  );
  await forget();
});

test("a document that is not this shape is refused, never read as an anchor", async () => {
  await forget();
  for (const text of [
    "not json at all",
    JSON.stringify({ v: 99, mail: "m", files: "f", calendar: "c", seen: {}, at: AT }),
    JSON.stringify({ v: 1, mail: "m", files: 2, calendar: "c", seen: {}, at: AT }),
    JSON.stringify({
      v: 1,
      mail: "m",
      files: "f",
      calendar: "c",
      seen: { x: 1 },
      at: AT,
    }),
    JSON.stringify({ v: 1, mail: "m", files: "f", calendar: "c", seen: {}, at: "now" }),
  ]) {
    await writeAppFileAt(ctx, accountId, CURSOR_FILE, text);
    await assert.rejects(
      () => readCursor(ctx, accountId),
      (err: unknown) => err instanceof CursorError && err.code === "cursor_unreadable",
      `a cursor of "${text.slice(0, 40)}" is a gap, not an anchor`,
    );
  }
  await forget();
});
