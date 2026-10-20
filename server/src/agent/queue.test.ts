/**
 * The file queue that makes a burst one report (ADR 0035).
 *
 * Pinned here is what the live run of 2026-10-20 needed: seven files saved into
 * one folder over half an hour are one drop, not seven — a folder answers when
 * it has been quiet for five minutes or when the drop has been open for twenty,
 * and a burst that never goes quiet still ends at the cap. The queue is one
 * document in the group's app folder, so it is read and written through the
 * same mock account the rest of the agent uses.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_DEMO = "1";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-queue";

const mock = await import("../mock/index.js");
const { filesAccountId } = await import("../appFolder.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { DROP_CAP_MS, DROP_QUIET_MS, dueDrops, forgetDrop, noteFile } = await import(
  "./queue.js"
);

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const FOLDER = "MS2/279726936 5X20 Ennore/TEMU5974430";

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

beforeEach(async () => {
  await forgetDrop(ctx, accountId, FOLDER);
});

const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 20, 8, minutes, 0));

test("a burst in one folder is one drop, answered when the folder is quiet", async () => {
  await noteFile(ctx, accountId, `${FOLDER}/WhatsApp 09.31.57.jpeg`, at(0));
  await noteFile(ctx, accountId, `${FOLDER}/WhatsApp 09.32.56.jpeg`, at(2));
  await noteFile(ctx, accountId, `${FOLDER}/DOC201026.pdf`, at(4));

  assert.deepEqual(
    await dueDrops(ctx, accountId, at(5)),
    [],
    "the folder is still being written to, so nothing is reported yet",
  );
  const due = await dueDrops(ctx, accountId, at(9));
  assert.equal(due.length, 1, "one folder, one drop");
  assert.deepEqual(due[0]?.paths, [
    `${FOLDER}/WhatsApp 09.31.57.jpeg`,
    `${FOLDER}/WhatsApp 09.32.56.jpeg`,
    `${FOLDER}/DOC201026.pdf`,
  ]);
  assert.equal(due[0]?.firstAt, at(0).toISOString());
  assert.equal(due[0]?.lastAt, at(4).toISOString());
  assert.ok(DROP_QUIET_MS > 0 && DROP_CAP_MS > DROP_QUIET_MS);
});

test("a folder that never goes quiet is answered at the cap", async () => {
  // One file every four minutes: the drop never sees five quiet minutes, so the
  // cap is what ends it — otherwise a busy folder would never be reported.
  for (let minute = 0; minute <= 20; minute += 4)
    await noteFile(ctx, accountId, `${FOLDER}/file-${minute}.jpeg`, at(minute));
  const due = await dueDrops(ctx, accountId, at(20));
  assert.equal(due.length, 1);
  assert.equal(due[0]?.paths.length, 6, "every file of the burst is in the one drop");
});

test("a file noted twice is named once, and forgetting empties the queue", async () => {
  await noteFile(ctx, accountId, `${FOLDER}/DOC201026.pdf`, at(0));
  await noteFile(ctx, accountId, `${FOLDER}/DOC201026.pdf`, at(1));
  const due = await dueDrops(ctx, accountId, at(10));
  assert.deepEqual(due[0]?.paths, [`${FOLDER}/DOC201026.pdf`]);
  await forgetDrop(ctx, accountId, FOLDER);
  assert.deepEqual(await dueDrops(ctx, accountId, at(30)), [], "the drop is gone");
});

test("two folders are two drops, each answered on its own clock", async () => {
  await noteFile(ctx, accountId, `${FOLDER}/DOC201026.pdf`, at(0));
  await noteFile(ctx, accountId, "MS2/other/book.pdf", at(8));
  const due = await dueDrops(ctx, accountId, at(9));
  assert.deepEqual(
    due.map((drop) => drop.folder),
    [FOLDER],
    "the quiet folder answers; the one just written to waits",
  );
  await forgetDrop(ctx, accountId, FOLDER);
  await forgetDrop(ctx, accountId, "MS2/other");
});
