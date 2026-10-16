/**
 * The agent's tools (ADR 0031) — the shape, the guard, and the reading half.
 *
 * Four properties are pinned here, and each of them is a mechanism rather than
 * a run of the code: a tool's arguments are validated **before** its executor
 * runs, a tool that writes is unreachable through the reading half, the guard
 * asks the authority class the tool **declares**, and a read spends nothing of
 * the run's budget. The catalogue's own shape is checked beside them — no two
 * tools take one name, every one of them is described for the model, and the
 * arguments a tool cannot use are refused before the server is asked anything —
 * and the reading tools are then driven against the mock Stalwart, so an
 * executor that throws fails here rather than at the first run of the loop.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import type { RunDoc } from "../shared/run.js";
import { freePort, waitForPort } from "../testkit.js";
import type { UpstreamSession } from "../upstream.js";

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_DEMO = "1";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-tools";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { filesAccountId, writeAppFileAt, writeBytesIntoVisibleFolder } = await import(
  "../appFolder.js"
);
const { clientOf } = await import("../util.js");
const { CAPABILITIES } = await import("../shared/capabilities.js");
const { blocksFromText, buildDraft, knowledgeFolderName } = await import(
  "../shared/knowledge.js"
);
const { spendRun, startRun, takeAuthorisation } = await import("../shared/run.js");
const { buildChecklist, buildWorkorderDoc } = await import("../shared/workorder.js");
const { createRun } = await import("./runs.js");
const { defineTool, READING_TOOLS, readingTools, runTool, TOOLS } = await import(
  "./tools.js"
);

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

/** A run that has decided nothing: the authority every read needs is its own. */
function plainRun(): RunDoc {
  return startRun({ id: "r1", startedBy: { rule: "intake", instruction: null } });
}

/** Call a reading tool the way the loop will: through the write-free half. */
function callTool<T>(name: string, raw: unknown): Promise<T> {
  return runTool(
    READING_TOOLS,
    { ctx, accountId, run: plainRun() },
    name,
    raw,
  ) as Promise<T>;
}

/**
 * A call context for a fixture tool.
 *
 * The fixture executors never reach the server, and the two fields exist so the
 * shape is the one a real call carries.
 */
const fixtureCall = (run: RunDoc) => ({
  ctx: { authorization: "", session: null as unknown as UpstreamSession, username: "" },
  accountId: "a1",
  run,
});

/** A tool whose executor counts its own calls, for the pins below. */
function countingTool(spec: {
  name: string;
  authority: "reversible" | "destructive" | "outward" | "beyond-policy" | "intent";
  writes: boolean;
  calls: number[];
}) {
  return defineTool({
    name: spec.name,
    description: "a tool that does nothing, for a test",
    authority: spec.authority,
    writes: spec.writes,
    parse: (raw: unknown) => {
      if (!(raw && typeof raw === "object" && "ok" in raw))
        throw new Error("the arguments are not this tool's");
      return raw as { ok: boolean };
    },
    run: async () => {
      spec.calls.push(1);
      return { ran: true };
    },
  });
}

test("a tool's arguments are validated before its executor runs", async () => {
  const calls: number[] = [];
  const tool = countingTool({
    name: "mail.find",
    authority: "reversible",
    writes: false,
    calls,
  });
  const call = fixtureCall(plainRun());

  await assert.rejects(
    () => runTool([tool], call, tool.name, "not an object"),
    /the arguments are not this tool's/,
    "the refusal is the tool's own",
  );
  assert.equal(calls.length, 0, "and its executor never ran");
  assert.deepEqual(
    await runTool([tool], call, tool.name, { ok: true }),
    { ran: true },
    "arguments it can use reach the executor",
  );
  assert.equal(calls.length, 1);
});

test("a tool that writes cannot be reached through the reading half", async () => {
  const calls: number[] = [];
  const writer = countingTool({
    name: "files.write",
    authority: "reversible",
    writes: true,
    calls,
  });
  const catalogue = [...TOOLS, writer];
  const reading = readingTools(catalogue);

  assert.ok(
    reading.every((tool) => !tool.writes),
    "the half a reading caller is handed holds nothing that writes",
  );
  assert.ok(
    !reading.some((tool) => tool.name === writer.name),
    "and not the tool that writes",
  );
  await assert.rejects(
    () => runTool(reading, fixtureCall(plainRun()), writer.name, { ok: true }),
    /no tool named "files.write"/,
    "so a call to it finds nothing to run",
  );
  assert.equal(calls.length, 0, "and nothing ran");
});

test("the guard asks the authority class the tool declares", async () => {
  const calls: number[] = [];
  const outward = countingTool({
    name: "mail.send",
    authority: "outward",
    writes: true,
    calls,
  });
  const run = plainRun();
  const call = fixtureCall(run);

  await assert.rejects(
    () => runTool([outward], call, outward.name, { ok: true }),
    /carries no authority/,
    "an act a person must authorise is refused while the run carries none",
  );
  assert.equal(calls.length, 0, "and it does not run");

  const authorised = takeAuthorisation(run, {
    what: "answer the shipper",
    authority: "outward",
    by: "a@example.com",
    at: "2026-10-16T10:00:00.000Z",
    from: { channel: "mail", id: "m-1" },
  });
  await runTool([outward], fixtureCall(authorised), outward.name, { ok: true });
  assert.equal(calls.length, 1, "with the authority the run carries, it runs");

  // The same call, with the tool declaring the agent's own class: the class the
  // tool declares is what the guard answered, not the tool's name.
  const reversible = countingTool({
    name: "mail.send",
    authority: "reversible",
    writes: true,
    calls,
  });
  await runTool([reversible], call, reversible.name, { ok: true });
  assert.equal(calls.length, 2, "a class the agent decides alone needs nobody");

  // And the intent is never the agent's, whatever authority the run holds.
  const intent = countingTool({
    name: "kb.accept",
    authority: "intent",
    writes: true,
    calls,
  });
  await assert.rejects(
    () => runTool([intent], fixtureCall(authorised), intent.name, { ok: true }),
    /carries no authority/,
    "a class no run can be authorised to decide",
  );
  assert.equal(calls.length, 2);
});

test("a read spends nothing of the run's budget", () => {
  const run = plainRun();
  assert.ok(READING_TOOLS.length > 0, "the reading half has tools");
  for (const tool of READING_TOOLS) {
    assert.deepEqual(tool.spend, {}, `"${tool.name}" reads and so declares no budget`);
    assert.deepEqual(
      spendRun(run, tool.spend).spent,
      run.spent,
      `and spending it leaves the run's tally where it was`,
    );
  }
});

test("every tool has a name of its own and something to say for itself", () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "no two tools do one thing");
  for (const tool of TOOLS) {
    assert.ok(tool.name.trim(), "a tool has a name");
    assert.ok(
      tool.description.trim().length > 20,
      `"${tool.name}" is described for the model that must choose it`,
    );
  }
});

/** One message delivered into the account, so a search has something to find. */
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

test("a tool refuses arguments it cannot use, and asks the server nothing", async () => {
  const before = mock.methodCalls["Email/query"] ?? 0;
  await assert.rejects(
    () => callTool("mail.find", {}),
    /"query" must be text/,
    "a find with no query is not a find",
  );
  assert.equal(
    mock.methodCalls["Email/query"] ?? 0,
    before,
    "and nothing was asked of the server",
  );
  await assert.rejects(
    () => callTool("files.read", { path: 7 }),
    /"path" must be text/,
    "a path that is not a path is refused the same way",
  );
});

test("the reading tools answer from the group's account", async () => {
  const tool = callTool;

  // A run of this account, read as the document it is.
  const stored = startRun({
    id: "read-me",
    startedBy: { rule: "intake", instruction: null },
  });
  await createRun(ctx, accountId, stored);
  const read = await tool<{ run: RunDoc }>("run.read", { id: "read-me" });
  assert.equal(read.run.id, "read-me");
  assert.deepEqual(read.run.startedBy, stored.startedBy);

  // A message found by the search grammar, then read by the id it answered.
  const delivered = await deliver("a booking confirmation");
  const other = await deliver("an unrelated note");
  const found = await tool<{ messages: Array<{ id?: string }> }>("mail.find", {
    query: "subject:booking",
  });
  assert.ok(
    found.messages.some((message) => message.id === delivered),
    "the message is found by its subject",
  );
  assert.ok(
    !found.messages.some((message) => message.id === other),
    "and the query is the one that was asked, not every message",
  );
  assert.ok(
    found.messages.every((message) => !("bodyValues" in message)),
    "a hit is a reference, not the message",
  );
  const message = await tool<{ message: { id?: string; subject?: string } }>(
    "mail.read",
    {
      id: delivered,
    },
  );
  assert.equal(message.message.subject, "a booking confirmation");

  const folders = await tool<{ folders: Array<{ role?: string | null }> }>(
    "mail.folders",
    {},
  );
  assert.ok(
    folders.folders.some((folder) => folder.role === "inbox"),
    "the account's folders are listed with what each is for",
  );

  // A document of the visible tree, listed and then read.
  await writeBytesIntoVisibleFolder(
    ctx,
    accountId,
    "Documents",
    "order.txt",
    new TextEncoder().encode("hello"),
    "text/plain",
  );
  const listed = await tool<{
    nodes: Array<{ path: string; nodeType: string; modified: string }>;
  }>("files.list", { folder: "Documents" });
  const order = listed.nodes.find((node) => node.path === "Documents/order.txt");
  assert.ok(order, "the folder's own children are listed by their path");
  assert.equal(order.nodeType, "file");
  assert.ok(
    Number.isFinite(Date.parse(order.modified)),
    "a reader sorts a level by each node's own stamp",
  );
  const file = await tool<{ text: string; name: string }>("files.read", {
    path: "Documents/order.txt",
  });
  assert.equal(file.name, "order.txt");
  assert.equal(file.text, "hello");

  // A workorder this account holds, read whole.
  const at = new Date().toISOString();
  await writeAppFileAt(
    ctx,
    accountId,
    "workorders/wo-1.json",
    buildWorkorderDoc({
      uid: "wo-1",
      name: "Booking 1",
      state: "running",
      by: "a@example.com",
      at,
      checklist: buildChecklist({
        template: { accountId, id: "template-1", revision: "rev-1" },
        variants: {},
        items: {},
        stepPaths: ["intake.confirm"],
      }),
    }),
  );
  const workorder = await tool<{ uid: string; name: string; steps: unknown[] }>(
    "workorder.read",
    { uid: "wo-1" },
  );
  assert.equal(workorder.uid, "wo-1");
  assert.equal(workorder.name, "Booking 1");
  assert.equal(workorder.steps.length, 1, "the checklist's steps are what a run settles");

  // A page of the knowledge base, by its title.
  const text = "When a booking arrives, answer within a day.";
  await writeAppFileAt(
    ctx,
    accountId,
    `knowledge/${knowledgeFolderName("Our intake")}/draft.json`,
    buildDraft({
      id: "k-1",
      title: "Our intake",
      tags: ["intake"],
      blocks: blocksFromText(text),
      text,
      by: "a@example.com",
      at,
    }),
  );
  const page = await tool<{ title: string; text: string; revision: number | null }>(
    "knowledge.read",
    { title: "Our intake" },
  );
  assert.equal(page.title, "Our intake");
  assert.equal(
    page.text,
    text,
    "the prose a rule is written in is what the tool answers",
  );
  assert.equal(page.revision, null, "a page with no approved revision is the draft");
});
