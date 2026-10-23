/**
 * What a group's account changed, read against the mock Stalwart (ADR 0031).
 *
 * Three facts the design rests on are pinned here: a read describes the mail,
 * the nodes and the workorder writes an account made — a write to a workorder is
 * an event like any other, and among mail changes only an **arrival** is one — and
 * a change is reported **once**, because the
 * cursor is the server's own state token and the next read resumes after it. The
 * second is the whole reason the cursor exists: a rule that fired twice on one
 * arrival would answer one message twice. The third is what a removal is: a
 * destroyed node cannot be read again, so the surface it happened on is the one
 * its former path was read at, and a log bigger than one page is drained rather
 * than refused. Two answers of the server's own are pinned against a stand-in:
 * a page that says it holds more without moving the state it resumes from is
 * refused rather than paged for ever, and a refusal arriving mid-read keeps the
 * pages already read and names the gap.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";
import type { UpstreamSession } from "../upstream.js";

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

test("a create and the update that writes its bytes are one event", async () => {
  const anchor = await anchorEvents(ctx, accountId);
  // A node written twice in one batch: the write path makes it, then a second
  // write goes through the update path (`setFileNode`, `appFolder.ts`), and the
  // change log carries `created` and `updated` for one address. A rule watching
  // that surface must hear about one document once.
  await writeAppFileAt(ctx, accountId, "workorders/wo-fused.json", {
    v: 1,
    uid: "wo-fused",
  });
  await writeAppFileAt(ctx, accountId, "workorders/wo-fused.json", {
    v: 1,
    uid: "wo-fused",
    name: "written again",
  });

  const { events } = await readAccountEvents(ctx, accountId, anchor);
  assert.deepEqual(
    events.filter((event) => event.where === "gilbert/workorders/wo-fused.json"),
    [
      {
        source: "workorder",
        change: "created",
        where: "gilbert/workorders/wo-fused.json",
      },
    ],
    "the create and the update that followed it are one event, named created",
  );
});

test("a message is an event once it arrived; reading, filing and removing it are not", async () => {
  const first = await anchorEvents(ctx, accountId);
  const message = await deliver("a delivery");
  const arrived = await readAccountEvents(ctx, accountId, first);
  assert.deepEqual(
    arrived.events.filter((event) => event.source === "mail"),
    [{ source: "mail", change: "created", where: message }],
    "the delivery is the one mail event",
  );

  // A person opens it and files it: both are changes of the same message, and
  // neither is mail that arrived.
  await clientOf(ctx).call(
    "Email/set",
    {
      accountId,
      update: {
        [message]: {
          "keywords/$seen": true,
          "mailboxIds/archive": true,
          "mailboxIds/inbox": null,
        },
      },
    },
    [CAPABILITIES.mail],
  );
  const after = await readAccountEvents(ctx, accountId, arrived.cursor);
  assert.deepEqual(
    after.events.filter((event) => event.source === "mail"),
    [],
    "the read and the filing wake nothing",
  );

  // Removed from the account: a removal is not an arrival either.
  await clientOf(ctx).call("Email/set", { accountId, destroy: [message] }, [
    CAPABILITIES.mail,
  ]);
  assert.deepEqual(
    (await readAccountEvents(ctx, accountId, after.cursor)).events.filter(
      (event) => event.source === "mail",
    ),
    [],
    "removing a message wakes nothing",
  );
});

test("a draft, a send and a message filed straight into a folder are not arrivals", async () => {
  const anchor = await anchorEvents(ctx, accountId);
  await clientOf(ctx).call(
    "Email/set",
    {
      accountId,
      create: {
        d: { subject: "a draft", mailboxIds: { drafts: true } },
        s: { subject: "a send", mailboxIds: { sent: true } },
        f: { subject: "filed by a filter", mailboxIds: { work: true } },
      },
    },
    [CAPABILITIES.mail],
  );
  assert.deepEqual(
    (await readAccountEvents(ctx, accountId, anchor)).events.filter(
      (event) => event.source === "mail",
    ),
    [],
    "only a message in the Inbox arrived",
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

test("a cursor the log no longer reaches is named as a gap, and the reading goes on", async () => {
  const anchor = await anchorEvents(ctx, accountId);
  // Past the window the log still holds, so what it can answer no longer
  // reaches back to where the reading stands.
  for (let i = 0; i < 201; i++) await deliver(`gap ${i}`);
  const refused = await readAccountEvents(ctx, accountId, anchor);
  assert.deepEqual(
    refused.events,
    [],
    "the refusal arrived on the first page, so no page had been read",
  );
  assert.match(
    String(refused.gap),
    /no longer holds the changes this account's reading asks for/,
    "and the loss is named rather than shrugged off",
  );

  const after = await readAccountEvents(ctx, accountId, refused.cursor);
  assert.equal(after.gap, null, "the reading anchors at the state the server holds now");
});

/**
 * One page of both logs, as a stand-in server is told to answer them.
 *
 * `refuse` is a `cannotCalculateChanges` for that log, which is what a real
 * server answers a `sinceState` older than the window it keeps.
 */
interface ScriptedPage {
  mail?: {
    newState?: string;
    hasMoreChanges?: boolean;
    created?: string[];
    refuse?: boolean;
  };
  files?: {
    newState?: string;
    hasMoreChanges?: boolean;
    created?: string[];
    refuse?: boolean;
  };
  calendar?: {
    newState?: string;
    hasMoreChanges?: boolean;
    created?: string[];
    refuse?: boolean;
  };
}

/**
 * A stand-in mail server that answers a scripted sequence of change pages.
 *
 * Two answers the mock cannot be made to produce are pinned through it: a log
 * that says it holds more without moving the state its page resumes from, and a
 * refusal that arrives on a page **after** one already read. Both are answers
 * about the server, so the fake is the server and the reading under test is the
 * one that ships.
 */
async function scriptedUpstream(
  pages: ScriptedPage[],
): Promise<{ ctx: Ctx; close: () => void }> {
  let answered = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        methodCalls: Array<[string, Record<string, unknown>, string]>;
      };
      const page = pages[Math.min(answered++, pages.length - 1)] ?? {};
      const methodResponses = body.methodCalls.map(([name, , id]) => {
        if (name.endsWith("/changes")) {
          const side =
            name === "Email/changes"
              ? page.mail
              : name === "FileNode/changes"
                ? page.files
                : page.calendar;
          if (side?.refuse)
            return ["error", { type: "cannotCalculateChanges", description: "gone" }, id];
          return [
            name,
            {
              accountId: "a1",
              oldState: "s0",
              newState: side?.newState ?? "s1",
              hasMoreChanges: side?.hasMoreChanges ?? false,
              created: side?.created ?? [],
              updated: [],
              destroyed: [],
            },
            id,
          ];
        }
        // Everything else is a `/get` for a state or a node's path: the state
        // the reading anchors at, and no objects.
        return [name, { accountId: "a1", state: "s9", list: [] }, id];
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ methodResponses }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const ctx: Ctx = {
    authorization: "Basic presented",
    username: "demo@example.com",
    session: {
      apiUrl: "/jmap",
      baseUrl: `http://127.0.0.1:${port}`,
      capabilities: {},
    } as unknown as UpstreamSession,
  };
  return { ctx, close: () => server.close() };
}

test("a log that says it holds more without moving its state is refused", async () => {
  const { ctx: fake, close } = await scriptedUpstream([
    { mail: { newState: "s0", hasMoreChanges: true, created: ["m1"] } },
    { mail: { newState: "s1" } },
  ]);
  try {
    await assert.rejects(
      () =>
        readAccountEvents(fake, "a1", {
          mail: "s0",
          files: "f0",
          calendar: "c0",
          seen: {},
        }),
      /holds more but answered the state it was asked from/,
      "a page that does not move the reading forward cannot be paged past",
    );
  } finally {
    close();
  }
});

test("a refusal mid-read keeps the pages already read, and names the gap", async () => {
  const { ctx: fake, close } = await scriptedUpstream([
    {
      mail: { newState: "s1", hasMoreChanges: true, created: ["m1"] },
      files: { newState: "f1" },
    },
    { mail: { refuse: true } },
  ]);
  try {
    const read = await readAccountEvents(fake, "a1", {
      mail: "s0",
      files: "f0",
      calendar: "c0",
      seen: {},
    });
    assert.deepEqual(
      read.events,
      [{ source: "mail", change: "created", where: "m1" }],
      "the page read before the refusal is kept: it is a real change nobody would see again",
    );
    assert.ok(read.gap, "and the loss in between is named");
    assert.equal(
      read.cursor.mail,
      "s9",
      "the cursor anchors at the state the server holds now, so nothing is reported twice",
    );
  } finally {
    close();
  }
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

test("a removal whose path this process never read never wakes a rule", async () => {
  const anchor = await anchorEvents(ctx, accountId);
  await writeAppFileAt(ctx, accountId, "workorders/wo-3.json", { v: 1, uid: "wo-3" });
  const written = await readAppFileAt(ctx, accountId, "workorders/wo-3.json");
  assert.ok(written, "the workorder is written");
  const id = String(written.file.id);
  await destroyAppNode(ctx, accountId, id);

  const { events } = await readAccountEvents(ctx, accountId, anchor);
  assert.equal(
    events.find((event) => event.change === "destroyed" && event.where === id),
    undefined,
    "a removal nobody can name is not actionable, and the id is no address to report",
  );
});

test("a calendar event written in the account is one change on the calendar surface", async () => {
  /*
   * The calendar is its own log, not a node in Files (ADR 0031): an event is
   * named by its id, which is exactly what `calendar.read` takes, and it is read
   * once — the cursor moves with the page like the other two logs.
   */
  const anchor = await anchorEvents(ctx, accountId);
  const created = await clientOf(ctx).call<{ created?: { e?: { id?: string } } }>(
    "CalendarEvent/set",
    {
      accountId,
      create: {
        e: {
          "@type": "Event",
          start: "2026-10-21T09:00:00",
          timeZone: "Europe/Rome",
          duration: "PT1H",
          title: "Container 12 arrives",
        },
      },
    },
    [CAPABILITIES.calendars],
  );
  const id = created.created?.e?.id;
  assert.ok(id, "the mock created the event");

  const read = await readAccountEvents(ctx, accountId, anchor);
  assert.deepEqual(
    read.events.filter((event) => event.source === "calendar"),
    [{ source: "calendar", change: "created", where: id }],
    "the event is a change on the calendar surface, named by its id",
  );

  const again = await readAccountEvents(ctx, accountId, read.cursor);
  assert.deepEqual(
    again.events.filter((event) => event.source === "calendar"),
    [],
    "and the cursor it answered means the change is not reported twice",
  );
});

test("the agent's own calendar write leaves a mark the reading takes once", async () => {
  /*
   * A rule watching the calendar that woke on the agent's own event would open a
   * run whose write wakes it again: the writer leaves the event's id behind, and
   * the change reading takes that mark as it reads the change (`changes.ts`), so
   * the agent's own act is never answered.
   */
  const { runTool, TOOLS } = await import("./tools.js");
  const { takeOwnCalendarChange } = await import("./tools/calendar.js");
  const { startRun } = await import("../shared/run.js");
  const run = startRun({
    id: "r-calendar",
    startedBy: { rule: "cal", instruction: null, woke: "test" },
  });
  const listed = (await runTool(TOOLS, { ctx, accountId, run }, "find", {
    kind: "calendars",
  })) as {
    calendars: Array<{ id: string; mayWrite: boolean }>;
  };
  const writable = listed.calendars.find((one) => one.mayWrite);
  assert.ok(writable, "the account has a calendar the agent may write");

  // The reading's position is taken *before* the write, so what it reports is
  // what the agent did since it.
  const anchor = await anchorEvents(ctx, accountId);
  const created = (await runTool(TOOLS, { ctx, accountId, run }, "event", {
    action: "create",
    calendar: writable.id,
    title: "Written by the agent",
    start: "2026-10-21T10:00:00",
  })) as { id: string };
  assert.ok(created.id, "the agent's event exists");

  const read = await readAccountEvents(ctx, accountId, anchor);
  assert.deepEqual(
    read.events.filter((event) => event.source === "calendar"),
    [{ source: "calendar", change: "created", where: created.id }],
    "the change is in the log: the reading reports it, and the mark is what answers it",
  );
  assert.equal(
    takeOwnCalendarChange(created.id),
    true,
    "the writer's mark is there for the change it explains",
  );
  assert.equal(
    takeOwnCalendarChange(created.id),
    false,
    "and it explains one change only",
  );
});
