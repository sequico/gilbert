/**
 * The waits a run leaves behind, armed against the mock Stalwart (ADR 0030).
 *
 * A wait is a date in the run document, so the five facts here are the whole of
 * the in-process side: a dated wait is armed and fires at its date, a wait with
 * no date — a question left for a person, or a date on a run that has stopped —
 * is never armed at all, a **fresh process** re-arms every wait it finds by
 * reading the documents (which is what makes a restart free), a wait this
 * process has already fired is not handed over again at the same instant, and a
 * wait further out than a single timer may run is armed in hops rather than
 * fired at once.
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
const { createRun, readRun, replaceRun } = await import("./runs.js");
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
      startRun({
        id: "boot",
        startedBy: { rule: "intake", instruction: null, woke: "mail created: m-1" },
      }),
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
      waitUntil(
        startRun({
          id,
          startedBy: { rule: "intake", instruction: null, woke: "mail created: m-1" },
        }),
        {
          what: "what it waits for",
          asked: { channel: "chat", id: `c-${id}` },
          until,
        },
      ),
    );

  await arm("soon", dueAt)();
  await arm("hour", new Date(now + 60 * 60_000).toISOString())();
  // A date that came while no process was running is not lost: it is armed at
  // once, because the document is the source and not the alarm.
  await arm("past", new Date(now - 60_000).toISOString())();
  // A question left for a person carries no date, and the answer arrives as an
  // event rather than as a timer (ADR 0029).
  await arm("person", null)();
  // A run that ended stopped waiting: a date it kept beside a blocking question
  // is not a wait to fire, or the end of the run would start itself again.
  await createRun(
    ctx,
    accountId,
    finishRun(
      waitUntil(
        startRun({
          id: "blocked",
          startedBy: { rule: "intake", instruction: null, woke: "mail created: m-1" },
        }),
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

test("a wait this process already fired is not handed over again at the same instant", async () => {
  await createRun(
    ctx,
    accountId,
    waitUntil(
      startRun({
        id: "once",
        startedBy: { rule: "intake", instruction: null, woke: "mail created: m-1" },
      }),
      {
        what: "the answer",
        asked: { channel: "chat", id: "c-once" },
        until: new Date(Date.now() - 60_000).toISOString(),
      },
    ),
  );

  const fired: string[] = [];
  const timers = new WaitTimers((wait) => fired.push(wait.runId));
  assert.ok(
    (await timers.arm(ctx, accountId)).includes("once"),
    "the past-due wait is armed",
  );
  await until(() => fired.includes("once"), "the wait to fire");

  // The caller has not advanced the run: its document still names the instant
  // that just fired, so arming beside it hands nothing over again.
  await sleep(50);
  assert.ok(
    !(await timers.arm(ctx, accountId)).includes("once"),
    "the run whose wait fired is not armed again",
  );
  await sleep(50);
  assert.equal(
    fired.filter((id) => id === "once").length,
    1,
    "and the date is not fired twice",
  );

  // The caller's half of the contract: the run advances to a new wait, which
  // is armed in its turn — the instant that fired stays fired.
  const record = await readRun(ctx, accountId, "once");
  assert.ok(record, "the run is there");
  await replaceRun(
    ctx,
    accountId,
    waitUntil(record.run, {
      what: "the next thing",
      asked: { channel: "chat", id: "c-once" },
      until: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
    { ifInState: record.state },
  );
  assert.ok(
    (await timers.arm(ctx, accountId)).includes("once"),
    "the wait the run advanced to is armed",
  );
  await sleep(50);
  assert.equal(
    fired.filter((id) => id === "once").length,
    1,
    "the instant that fired is not fired again beside the new wait",
  );
  timers.stop();
});

test("a wait further out than one timer may run is armed in hops, and fires at its date", async (t) => {
  // The platform's own bound: a single `setTimeout` past it overflows and fires
  // at once, which would make a wait months out come due the moment it was
  // armed. The clock is faked so the hops can be walked rather than waited.
  const HOP = 2 ** 31 - 1;
  // Two hops and a second short of them: within the second hop's reach, so the
  // walk ends at the date rather than a hop short of it.
  const due = new Date(Date.now() + 2 * HOP - 1000).toISOString();
  await createRun(
    ctx,
    accountId,
    waitUntil(
      startRun({
        id: "hops",
        startedBy: { rule: "intake", instruction: null, woke: "mail created: m-1" },
      }),
      {
        what: "something months away",
        asked: { channel: "chat", id: "c-hops" },
        until: due,
      },
    ),
  );

  // The faked clock starts where the real one is, so the wait is still the same
  // distance away and the hops can be walked rather than waited.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const mocked = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((...rest: Parameters<typeof setTimeout>) => {
    delays.push(Number(rest[1] ?? 0));
    return mocked(...rest);
  }) as typeof setTimeout;
  const fired: string[] = [];
  const timers = new WaitTimers((wait) => fired.push(wait.runId));
  try {
    assert.ok(
      (await timers.arm(ctx, accountId)).includes("hops"),
      "the wait months out is armed",
    );
    // A delay past the platform's bound overflows and fires at once, so no
    // single timer is ever asked for one.
    assert.ok(
      delays.length > 0 && delays.every((delay) => delay <= HOP),
      "every hop is within the bound a single timer may wait",
    );
    t.mock.timers.tick(HOP);
    assert.ok(!fired.includes("hops"), "the hop is not the wait: nothing fired yet");
    t.mock.timers.tick(HOP);
    assert.ok(fired.includes("hops"), "the rest of the wait is armed and fires");
    assert.equal(
      fired.filter((id) => id === "hops").length,
      1,
      "and it fires once, at its date",
    );
  } finally {
    globalThis.setTimeout = mocked;
    timers.stop();
    t.mock.timers.reset();
  }
});
