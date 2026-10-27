/**
 * The run document against the mock Stalwart (ADR 0030).
 *
 * A run is one document in the group's own account, and these tests are the
 * two facts the design rests on: a **wait is a date in the run**, so a process
 * that never saw the run being written finds the wait it must re-arm; and a run
 * this build cannot read is reported with its path and the reason, never
 * guessed at. The create, the listing and the compare-and-set replace are the
 * same read-modify-write the rest of the tree does, pinned here because a run
 * is the only thing that may not be overwritten by a copy that read it earlier.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-runs";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { filesAccountId, readAppFileAt, writeAppBytesAt, writeAppFileAt } = await import(
  "../appFolder.js"
);
const { isStateMismatch } = await import("../jmap.js");
const { finishRun, isRunDue, RUN_VERSION, spendRun, startRun, waitUntil } = await import(
  "../shared/run.js"
);
const {
  createRun,
  listRuns,
  listRunsForReading,
  pageRunsForReading,
  readRun,
  replaceRun,
  RunError,
} = await import("./runs.js");
const { isGroupAccountRecord } = await import("../shared/sessionAccount.js");
const { archiveMonth, archiveOldRuns } = await import("./archive.js");

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

/** A `Ctx` of its own, standing in for a process that has just started. */
async function restarted(): Promise<Ctx> {
  return {
    authorization: AUTH,
    session: await fetchUpstreamSession(AUTH, BASE),
    username: "demo@example.com",
  };
}

test("a run read by a process that never wrote it carries its wait and its tally", async () => {
  const until = new Date(Date.now() + 60 * 60_000).toISOString();
  const asked = { channel: "mail", id: "m-ask" } as const;
  const waiting = spendRun(
    waitUntil(
      startRun({
        id: "restart-1",
        startedBy: { woke: "mail created: m-1" },
        plan: ["read the mail"],
      }),
      { what: "the shipper's answer", asked, until },
    ),
    { steps: 1, calls: 2, ms: 800 },
  );
  await createRun(ctx, accountId, waiting);

  const record = await readRun(await restarted(), accountId, "restart-1");
  assert.ok(record, "the run is there for a process that never wrote it");
  assert.equal(record.run.state, "running");
  assert.deepEqual(
    record.run.waiting,
    { what: "the shipper's answer", asked, until },
    "the wait is the date the document carries",
  );
  assert.deepEqual(
    record.run.spent,
    { steps: 1, calls: 2, ms: 800 },
    "and the tally is in the document, so a restart does not spend the budget twice",
  );
});

test("only the runs whose wait has come due are ready to be re-armed", async () => {
  const asked = { channel: "chat", id: "node-1" } as const;
  const past = waitUntil(
    startRun({
      id: "due-1",
      startedBy: { woke: "mail created: m-1" },
    }),
    { what: "the answer", asked, until: new Date(Date.now() - 60_000).toISOString() },
  );
  const future = waitUntil(
    startRun({
      id: "due-2",
      startedBy: { woke: "mail created: m-1" },
    }),
    { what: "the answer", asked, until: new Date(Date.now() + 60_000).toISOString() },
  );
  await createRun(ctx, accountId, past);
  await createRun(ctx, accountId, future);

  const list = await listRuns(ctx, accountId);
  const due = list.filter(({ run }) => isRunDue(run, new Date()));
  assert.deepEqual(
    due.map((record) => record.run.id),
    ["due-1"],
    "the wait that has passed is due, and the one still ahead is not",
  );

  const later = list.filter(({ run }) => isRunDue(run, new Date(Date.now() + 120_000)));
  assert.deepEqual(
    later.map((record) => record.run.id).sort(),
    ["due-1", "due-2"],
    "and every wait in the past is due",
  );
});

test("a closed run older than a year moves to its month's drawer, and nothing else does", async () => {
  /*
   * `runs/` is the working set every pass lists (ADR 0030). A run that ended
   * more than twelve months ago is moved — never deleted — into
   * `runs/archive/<year-month>/`; a run still running, or one that ended inside
   * the year, stays where the surface reads it.
   */
  const closed = (id: string, at: string) =>
    finishRun(
      startRun({
        id,
        startedBy: { woke: "mail created: m-1" },
      }),
      "done",
      { at, why: "the work is done" },
    );
  const old = closed("old-run", "2025-09-15T10:00:00Z");
  const recent = closed("recent-run", new Date().toISOString());
  const running = startRun({
    id: "still-running",
    startedBy: { woke: "mail created: m-2" },
  });
  /*
   * A blocked run has an ending, but nobody is done with it: the answer that
   * comes back is correlated against the working set, so its question is not
   * moved to a drawer however old it is.
   */
  const blocked = finishRun(
    waitUntil(
      startRun({
        id: "blocked-run",
        startedBy: { woke: "mail created: m-3" },
      }),
      {
        what: "the shipper's answer",
        asked: { channel: "mail", id: "m-ask" },
        until: null,
      },
    ),
    "blocked",
    { at: "2025-09-10T10:00:00Z", why: "waiting on a person" },
  );
  await createRun(ctx, accountId, old);
  await createRun(ctx, accountId, recent);
  await createRun(ctx, accountId, running);
  await createRun(ctx, accountId, blocked);

  const gaps = await archiveOldRuns(
    ctx,
    accountId,
    await listRuns(ctx, accountId),
    new Date(),
  );
  assert.deepEqual(gaps, [], "every move succeeded");

  const month = archiveMonth(old);
  assert.equal(month, "2025-09");
  const moved = await readAppFileAt(ctx, accountId, `runs/archive/${month}/old-run.json`);
  assert.ok(moved, "the old run is in its month's drawer");
  assert.match(moved.text, /"id": ?"old-run"/, "with its record intact");
  assert.equal(await readRun(ctx, accountId, "old-run"), null, "and out of runs/");
  assert.ok(await readRun(ctx, accountId, "recent-run"), "the recent run stays");
  assert.ok(
    await readRun(ctx, accountId, "still-running"),
    "and a running one is never moved",
  );
  assert.ok(
    await readRun(ctx, accountId, "blocked-run"),
    "and one waiting on a person keeps its question",
  );
});

test("two accounts with a document at the same path do not read each other's", async () => {
  /*
   * The agent reads every group through one process and one `Ctx`, so the
   * document cache is shared unless the account is part of its key. A rule id or
   * a run id is a name a group chose: two accounts can hold the same path, and
   * the second read must not answer with the first group's bytes.
   */
  const other = Object.keys(ctx.session.accounts).find(
    (id) =>
      id !== accountId &&
      isGroupAccountRecord(
        ctx.session.accounts[id] as { name?: unknown; isPersonal?: unknown },
      ),
  );
  assert.ok(other, "the session holds a second account to read");
  const document = (about: string) =>
    startRun({
      id: "same-path-run",
      startedBy: { woke: "mail created: m-1", about },
    });
  await createRun(ctx, accountId, document("mine"));
  await createRun(ctx, other, document("theirs"));

  const mine = await listRunsForReading(ctx, accountId);
  const theirs = await listRunsForReading(ctx, other);
  assert.equal(
    mine.find((row) => row.id === "same-path-run")?.run?.startedBy.about,
    "mine",
  );
  assert.equal(
    theirs.find((row) => row.id === "same-path-run")?.run?.startedBy.about,
    "theirs",
    "the other account's document is its own",
  );
});

test("paging the folder loses no run, whatever its own order says", async () => {
  /*
   * The page is chosen from the folder's order (`created`) and the cursor is that
   * order's. Cutting a second time on recency (`startedAt ?? ended.at`) gave a
   * cursor naming a different node than the cut did, and a legacy document with no
   * `startedAt` fell between the two: 184 of 186 runs drawn, silently (live,
   * 2026-10-27). Every document here must appear exactly once.
   */
  const ids = ["page-a", "page-b", "page-c", "page-d"];
  for (const id of ids) {
    const run = startRun({ id, startedBy: { woke: "mail created: paging" } });
    await createRun(ctx, accountId, run);
  }
  // One of them is a document written before `startedAt` existed: the recency
  // order cannot place it, which is exactly the case that vanished.
  const legacy = (await readRun(ctx, accountId, "page-c"))!.run as unknown as Record<
    string,
    unknown
  >;
  delete legacy.startedAt;
  await writeAppFileAt(ctx, accountId, `runs/page-c.json`, legacy as never);

  const seen: string[] = [];
  let after = "";
  let more = true;
  for (let guard = 0; more && guard < 10; guard++) {
    const page = await pageRunsForReading(ctx, accountId, after, 2);
    seen.push(...page.rows.map((row) => row.id));
    after = page.after ?? "";
    more = page.more;
  }
  const wanted = seen.filter((id) => ids.includes(id));
  assert.equal(wanted.length, ids.length, "every run is drawn");
  assert.equal(new Set(wanted).size, ids.length, "and none of them twice");
});

test("a run is created once and replaced under the state it was read at", async () => {
  const run = startRun({
    id: "cas-1",
    startedBy: { woke: "mail created: m-1" },
  });
  await createRun(ctx, accountId, run);
  await assert.rejects(
    () => createRun(ctx, accountId, run),
    (err: unknown) => err instanceof RunError && err.code === "run_exists",
    "a run's id names one run, and a create does not write over it",
  );

  const listed = await listRuns(ctx, accountId);
  assert.ok(
    listed.some((record) => record.run.id === "cas-1"),
    "the run is in the group's listing",
  );

  const record = await readRun(ctx, accountId, "cas-1");
  assert.ok(record, "and it reads back");
  const ended = finishRun(record.run, "done", {
    at: new Date().toISOString(),
    why: "there was nothing to do",
  });
  await replaceRun(ctx, accountId, ended, { ifInState: record.state });
  assert.equal((await readRun(ctx, accountId, "cas-1"))?.run.state, "done");

  // The token the first read carried is stale now: a copy that read the run
  // before this write is refused rather than overwriting it.
  await assert.rejects(
    () => replaceRun(ctx, accountId, run, { ifInState: record.state }),
    (err: unknown) => isStateMismatch(err),
    "a stale token does not land",
  );
  assert.equal(
    (await readRun(ctx, accountId, "cas-1"))?.run.state,
    "done",
    "and the run it would have overwritten is untouched",
  );
});

/**
 * The documents of the runs named that the process downloaded while a walk ran.
 *
 * The walk is the whole cost of a pass on an idle installation, so what it spends
 * is read off the wire rather than counted out of the reader: a download is a
 * `GET` on the session's own download path, and it carries the document's name.
 */
async function downloadsOf<T>(
  names: string[],
  walk: () => Promise<T>,
): Promise<{ answer: T; downloads: string[] }> {
  const real = globalThis.fetch;
  const downloads: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (names.some((name) => url.includes(`/${name}.json`))) downloads.push(url);
    return await real(input, init);
  }) as typeof fetch;
  try {
    return { answer: await walk(), downloads };
  } finally {
    globalThis.fetch = real;
  }
}

test("a run whose stamp has not moved is not downloaded a second time", async () => {
  /*
   * A pass reads a group's runs at least twice and nothing prunes the folder, so
   * what decides whether an installation that has done a lot of work keeps paying
   * for it is whether a document that has not moved is read again: one write
   * lands, one document's stamp moves, and the documents beside it are what must
   * not be paid for a second time.
   */
  const named = ["stamp-a", "stamp-b"];
  const one = (id: string, why: string) =>
    finishRun(
      startRun({
        id,
        startedBy: { woke: "mail created: m-1" },
      }),
      "done",
      { at: new Date().toISOString(), why },
    );
  await createRun(ctx, accountId, one("stamp-a", "the first act"));
  await createRun(ctx, accountId, one("stamp-b", "the second act"));

  const first = await downloadsOf(named, () => listRunsForReading(ctx, accountId));
  assert.equal(first.downloads.length, 2, "the first walk reads both documents");

  // One document is written again, which drops the remembered level (`jmap.ts`)
  // and moves that node's own stamp, and nothing else.
  await replaceRun(ctx, accountId, one("stamp-a", "the first act, done twice"), {});
  const second = await downloadsOf(named, () => listRunsForReading(ctx, accountId));
  assert.equal(
    second.downloads.length,
    1,
    "the document that moved is read again, and the one that did not is not",
  );
  const ends = second.answer
    .filter((row) => named.includes(row.id))
    .map((row) => [row.id, row.run?.ended?.why]);
  assert.deepEqual(
    ends,
    [
      ["stamp-a", "the first act, done twice"],
      ["stamp-b", "the second act"],
    ],
    "and the document that did not move is answered from what was read before",
  );
});

test("an unreadable run is reported, never guessed at", async () => {
  await writeAppBytesAt(
    ctx,
    accountId,
    "runs/junk.json",
    new TextEncoder().encode("not a document"),
    "application/json",
  );
  await assert.rejects(
    () => readRun(ctx, accountId, "junk"),
    (err: unknown) => err instanceof RunError && err.code === "run_unreadable",
    "a run whose bytes do not parse is refused with its own code",
  );
  await assert.rejects(() => listRuns(ctx, accountId), /The run at runs\/junk\.json/);

  // A document of the right JSON that is not the shape this build writes.
  await writeAppFileAt(ctx, accountId, "runs/other.json", {
    v: RUN_VERSION,
    id: "other",
  });
  await assert.rejects(() => readRun(ctx, accountId, "other"), /"startedBy" must name/);

  // A run that is not there is absent, and that is not the same answer.
  assert.equal(await readRun(ctx, accountId, "no-such-run"), null);
});
