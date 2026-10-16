/**
 * The waits a run leaves behind, armed against the mock Stalwart (ADR 0034).
 *
 * A wait is a date in the run document, so the three facts here are the whole
 * of the in-process side: a dated wait is armed and fires at its date, a wait
 * with no date — a question left for a person, or a date on a run that has
 * stopped — is never armed at all, and a **fresh process** re-arms every wait
 * it finds by reading the documents, which is what makes a restart free.
 *
 * "Never armed" is asserted on the arming rather than on the absence of a fire:
 * waiting out a timer that should not exist proves only that the test was
 * patient.
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
process.env.APP_SECRET = "test-secret-for-waits";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { filesAccountId } = await import("../appFolder.js");
const { sleep } = await import("../shared/async.js");
const { finishRun, startRun, waitUntil } = await import("../shared/run.js");
const { createRun } = await import("./runs.js");
const { WaitTimers } = await import("./timers.js");

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

/** Wait for what the test is watching, or fail with the moment named. */
async function until(want: () => boolean, why: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (want()) return;
    await sleep(20);
  }
  assert.fail(`waited 2s for ${why}`);
}

test("a fresh process re-arms every wait by reading the runs", async () => {
  const due = new Date(Date.now() + 300).toISOString();
  await createRun(
    ctx,
    accountId,
    waitUntil(
      startRun({ id: "boot", startedBy: { rule: "intake", instruction: null } }),
      {
        what: "the booking window",
        asked: { channel: "chat", id: "c-1" },
        until: due,
      },
    ),
  );

  // The process that armed it dies before the date arrives: the alarm is gone
  // with it, and the document is all that is left.
  const beforeRestart: string[] = [];
  const first = new WaitTimers((wait) => beforeRestart.push(wait.runId));
  assert.ok((await first.arm(ctx, accountId)).includes("boot"), "the wait is armed");
  first.stop();
  await sleep(500);
  assert.deepEqual(
    beforeRestart,
    [],
    "the process that armed it is gone, so nothing fired",
  );

  // A process that has just started knows nothing but the account it signs in
  // to, and the account's runs are where the wait survived.
  const afterRestart: string[] = [];
  const second = new WaitTimers((wait) => afterRestart.push(wait.runId));
  assert.ok(
    (await second.arm(ctx, accountId)).includes("boot"),
    "the fresh process finds the same wait",
  );
  await until(() => afterRestart.includes("boot"), "the re-armed wait to fire");
  second.stop();
});

test("a dated wait fires once at its date, and a wait with no date is never armed", async () => {
  const now = Date.now();
  const dueAt = new Date(now + 300).toISOString();
  const arm = (id: string, until: string | null) => async () =>
    createRun(
      ctx,
      accountId,
      waitUntil(startRun({ id, startedBy: { rule: "intake", instruction: null } }), {
        what: "what it waits for",
        asked: { channel: "chat", id: `c-${id}` },
        until,
      }),
    );

  await arm("soon", dueAt)();
  await arm("hour", new Date(now + 60 * 60_000).toISOString())();
  // A date that came while no process was running is not lost: it is armed at
  // once, because the document is the source and not the alarm.
  await arm("past", new Date(now - 60_000).toISOString())();
  // A question left for a person carries no date, and the answer arrives as an
  // event rather than as a timer (ADR 0033).
  await arm("person", null)();
  // A run that ended stopped waiting: a date it kept beside a blocking question
  // is not a wait to fire, or the end of the run would start itself again.
  await createRun(
    ctx,
    accountId,
    finishRun(
      waitUntil(
        startRun({ id: "blocked", startedBy: { rule: "intake", instruction: null } }),
        {
          what: "the answer",
          asked: { channel: "mail", id: "m-1" },
          until: new Date(now - 60_000).toISOString(),
        },
      ),
      "blocked",
      { at: new Date().toISOString(), why: "only a person can answer" },
    ),
  );

  const fired: Array<{ runId: string; at: number }> = [];
  const timers = new WaitTimers((wait) =>
    fired.push({ runId: wait.runId, at: Date.now() }),
  );
  const armed = await timers.arm(ctx, accountId);
  assert.ok(armed.includes("soon"), "the dated wait is armed");
  assert.ok(armed.includes("past"), "a date that already came is armed, not skipped");
  assert.ok(!armed.includes("person"), "a wait with no date is never armed");
  assert.ok(!armed.includes("blocked"), "a run that ended is never armed");

  await until(
    () => fired.some((f) => f.runId === "past") && fired.some((f) => f.runId === "soon"),
    "both dated waits to fire",
  );
  // A window long enough for a timer that re-armed itself on firing — the shape
  // this asserts against — to have fired many times over.
  await sleep(150);
  const soon = fired.filter((f) => f.runId === "soon");
  assert.equal(soon.length, 1, "the wait fires once");
  assert.ok(soon[0]!.at >= Date.parse(dueAt), "and not before its date");
  assert.ok(!fired.some((f) => f.runId === "hour"), "a wait still ahead has not fired");
  assert.ok(!fired.some((f) => f.runId === "person"), "the dateless wait never fired");
  assert.ok(!fired.some((f) => f.runId === "blocked"), "the ended run never fired");
  timers.stop();
});
