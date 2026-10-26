/**
 * The agent's tools (ADR 0038) — the shape, the guard, and both halves.
 *
 * Six properties are pinned here, and each of them is a mechanism rather than a
 * run of the code: a tool's arguments are validated **before** its executor
 * runs, a tool that writes is unreachable through the reading half, every
 * surface has a reading tool that reaches it, the guard asks the authority class
 * the tool **declares** and the act that authority is for, a read spends nothing
 * of the run's budget, and a question leaves the run waiting on a person with the
 * deadline ADR 0029 gives it. Beside them is the one write that leaves the group's
 * account entirely —
 * the memory tool, which records a fact into the installation's own store while
 * refusing the one a person holds. The catalogue's own shape is checked
 * beside them — no two tools take one
 * name, every one of them is described for the model, and the arguments a tool
 * cannot use are refused before the server is asked anything — and both halves
 * are then driven against the mock Stalwart, so an executor that throws fails
 * here rather than at the first run of the loop.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import { QUESTION_TTL_MS, type RunDoc, type RunWait } from "../shared/run.js";
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
const {
  destroyAppNode,
  filesAccountId,
  readAppFileAt,
  readVisibleFileAt,
  uploadBlobBytes,
  writeAppFileAt,
  writeBytesIntoVisibleFolder,
} = await import("../appFolder.js");
const { readGroupLabels } = await import("../account.js");
const { clientOf } = await import("../util.js");
const { CAPABILITIES } = await import("../shared/capabilities.js");
const { blocksFromText, buildDraft, knowledgeFolderName } = await import(
  "../shared/knowledge.js"
);
const { AGENT_LABEL } = await import("../shared/labels.js");
const { MEMORY_FACT_MAX, entityIdFor, parseFactDocumentDetailed } = await import(
  "../shared/memory.js"
);
const { finishRun, spendRun, startRun, takeAuthorisation, waitUntil } = await import(
  "../shared/run.js"
);
const { buildChecklist, buildWorkorderDoc } = await import("../shared/workorder.js");
const { createRun } = await import("./runs.js");
const { groupMembers } = await import("../groupAccess.js");
const { isGroupAccountRecord } = await import("../shared/sessionAccount.js");
const { localPart } = await import("../shared/chat.js");
const { entityPath, factPath, listMemory } = await import("./memory.js");
const { isEndpointName, jobCall } = await import("./testkit.js");
const {
  defineTool,
  mayRun,
  READING_TOOLS,
  readingTools,
  repeatable,
  runTool: rawRunTool,
  TOOLS,
} = await import("./tools.js");

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
  return startRun({
    id: "r1",
    startedBy: { rule: "intake", instruction: null, woke: "mail created: m-1" },
  });
}

/**
 * `runTool`, with a former endpoint name taken to its job (ADR 0038).
 *
 * A catalogue that holds the named tool is left alone — the guard's own
 * fixtures are tools of their own — and only a name it does not hold, whose
 * prefix is one of the product's surfaces, is translated, so every existing
 * test keeps calling what it called. The translation is `testkit.ts`'s, one
 * copy for every test file that was written before the jobs.
 */
function runTool(...args: Parameters<typeof rawRunTool>): ReturnType<typeof rawRunTool> {
  const [catalogue, call, name, raw, opts] = args;
  if (isEndpointName(name) && !catalogue.some((tool) => tool.name === name)) {
    const routed = jobCall(name, raw);
    return rawRunTool(catalogue, call, routed.name, routed.args, opts);
  }
  return rawRunTool(catalogue, call, name, raw, opts);
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

/** Call a tool the agent may write with: the whole catalogue, and this run. */
async function writeTool<T>(name: string, raw: unknown): Promise<T> {
  // The memory as a pass would hand it over: read once, and handed to the step
  // (ADR 0033), so the one write that reaches it is against this reading.
  return (await runTool(
    TOOLS,
    {
      ctx,
      accountId,
      run: plainRun(),
      memory: await listMemory(ctx, accountId),
    },
    name,
    raw,
  )) as T;
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
  act?: (args: { ok: boolean; to?: string; text?: string }) => {
    target: string;
    content: string | null;
  } | null;
}) {
  return defineTool({
    name: spec.name,
    description: "a tool that does nothing, for a test",
    authority: spec.authority,
    writes: spec.writes,
    act: spec.act,
    args: { ok: { type: "boolean" }, to: { type: "text" }, text: { type: "text" } },
    parse: (raw: unknown) => {
      if (!(raw && typeof raw === "object" && "ok" in raw))
        throw new Error("the arguments are not this tool's");
      return raw as { ok: boolean; to?: string; text?: string };
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
    /arguments must be an object/,
    "a call the tool cannot read is refused before its executor",
  );
  assert.equal(calls.length, 0, "and its executor never ran");
  assert.deepEqual(
    await runTool([tool], call, tool.name, { ok: true }),
    { ran: true },
    "arguments it can use reach the executor",
  );
  assert.equal(calls.length, 1);
});

test("an argument the tool does not take is refused, naming the one it does", async () => {
  /*
   * The live failure this pins: `files.list` was asked for `folder` while it
   * reads `path`, and answered with the top level of Files as if it were the
   * folder asked for. A wrong answer with no refusal is worse than a refusal.
   */
  await assert.rejects(
    () => callTool("files.list", { folder: "MS2" }),
    /not "folder"/,
    "the field the model meant is not silently dropped",
  );
  const top = await callTool<{ nodes: unknown[] }>("files.list", {});
  assert.ok(Array.isArray(top.nodes), "the call that names what the tool takes runs");
});

test("a tool that writes cannot be reached through the reading half", async () => {
  const calls: number[] = [];
  const writer = countingTool({
    name: "fixture.write",
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
    /no tool named "fixture.write"/,
    "so a call to it finds nothing to run",
  );
  assert.equal(calls.length, 0, "and nothing ran");
});

test("a write on a surface the run's matrix keeps off is refused, and a read is not", async () => {
  /*
   * The matrix says where a run may act (ADR 0038). Files are off for this
   * run: a write is refused before the class is asked, while reading Files
   * stays free — a reading is proof, not an act.
   */
  const off = startRun({
    id: "r-off",
    startedBy: {
      rule: "intake",
      instruction: null,
      woke: "mail created: m-1",
      surfaces: {
        chat: "watch",
        mail: "watch",
        files: "off",
        knowledge: "off",
        workorder: "off",
        calendar: "off",
      },
    },
  });
  await assert.rejects(
    () =>
      runTool(TOOLS, { ctx, accountId, run: off }, "files.write", {
        path: "Documents/off.md",
        text: "x",
      }),
    (err: unknown) => (err as { code?: string }).code === "surface_off",
    "the rule keeps Files off, so the write is refused",
  );
  const listed = (await runTool(
    READING_TOOLS,
    { ctx, accountId, run: off },
    "files.list",
    {},
  )) as { nodes: unknown[] };
  assert.ok(Array.isArray(listed.nodes), "reading an off surface stays free");
});

test("the guard asks the authority class the tool declares", async () => {
  const calls: number[] = [];
  const outward = countingTool({
    name: "mail.send",
    authority: "outward",
    writes: true,
    calls,
    act: (args) => ({ target: args.to ?? "", content: args.text ?? null }),
  });
  const run = plainRun();
  const call = fixtureCall(run);

  await assert.rejects(
    () => runTool([outward], call, outward.name, { ok: true, to: "shipper@example.com" }),
    /carries no authority/,
    "an act a person must authorise is refused while the run carries none",
  );
  assert.equal(calls.length, 0, "and it does not run");

  const authorised = takeAuthorisation(run, {
    what: "answer the shipper",
    authority: "outward",
    act: { target: "shipper@example.com", content: "the booking is confirmed" },
    by: "a@example.com",
    at: "2026-10-16T10:00:00.000Z",
    from: { channel: "mail", id: "m-1" },
  });
  await runTool([outward], fixtureCall(authorised), outward.name, {
    ok: true,
    to: "shipper@example.com",
    text: "the booking is confirmed",
  });
  assert.equal(
    calls.length,
    1,
    "with the authority the run carries, the act it named runs",
  );

  // The same class, and the same person's word, for an act nobody authorised:
  // "an instruction that asks for a send authorises that send and no other".
  await assert.rejects(
    () =>
      runTool([outward], fixtureCall(authorised), outward.name, {
        ok: true,
        to: "somebody-else@example.com",
        text: "the booking is confirmed",
      }),
    /carries no authority/,
    "the authorisation does not reach another person",
  );
  await assert.rejects(
    () =>
      runTool([outward], fixtureCall(authorised), outward.name, {
        ok: true,
        to: "shipper@example.com",
        text: "something else entirely",
      }),
    /carries no authority/,
    "nor the same person with something else to say",
  );
  assert.equal(calls.length, 1, "and neither ran");

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

  // An act a person must authorise, with no act to compare: the guard cannot
  // match it against anything, so it refuses rather than reaching for the class.
  const unscoped = countingTool({
    name: "mail.send",
    authority: "outward",
    writes: true,
    calls,
  });
  await assert.rejects(
    () => runTool([unscoped], fixtureCall(authorised), unscoped.name, { ok: true }),
    /carries no authority/,
    "a class-only act is what the binding exists to refuse",
  );
  assert.equal(calls.length, 2);
});

test("the reading half this build ships holds no writer, and spends nothing", () => {
  const run = plainRun();
  assert.ok(READING_TOOLS.length > 0, "the reading half has tools");
  for (const tool of READING_TOOLS) {
    assert.equal(tool.writes, false, `"${tool.name}" is in the reading half and writes`);
    assert.deepEqual(tool.spend, {}, `"${tool.name}" reads and so declares no budget`);
    assert.deepEqual(
      spendRun(run, tool.spend).spent,
      run.spent,
      `and spending it leaves the run's tally where it was`,
    );
  }

  // The other half: an act that changes the account takes a step of the run's
  // budget, which is what makes reading free and acting cost. The one writer that
  // spends nothing is the case's own note: it changes the agent's bookkeeping, not
  // the group's data (ADR 0034).
  const writers = TOOLS.filter((tool) => tool.writes && tool.name !== "note");
  assert.ok(writers.length > 0, "the catalogue has acts that change the account");
  assert.ok(
    !READING_TOOLS.some((tool) => tool.name === "note"),
    "and the case's note, which writes, is not handed to a turn that may only read",
  );
  const note = TOOLS.find((tool) => tool.name === "note");
  assert.deepEqual(note?.spend, {}, "the note is the case's memory, not an act");
  for (const tool of writers) {
    assert.deepEqual(
      tool.spend,
      { steps: 1 },
      `"${tool.name}" takes a step of the run's budget`,
    );
    assert.deepEqual(
      spendRun(run, tool.spend).spent,
      { ...run.spent, steps: 1 },
      `and spending it moves the tally by the one step`,
    );
  }
});

test("a failed call is repeated only when the act it names is reversible", () => {
  /*
   * The four verbs are one tool each, so a verb's declared class is its default:
   * `act` files a message (reversible) and trashes one (destructive). Reading the
   * verb's class would call every act reversible and run a destructive one a
   * second time after a failure that may already have landed — so the class is
   * the endpoint's, through the verb's own `authorityOf`, and a call this build
   * cannot read is not one to repeat.
   */
  assert.equal(
    repeatable(TOOLS, "act", { what: "folder", path: "Containers/2026" }),
    true,
    "a folder made is the agent's own to retry",
  );
  assert.equal(
    repeatable(TOOLS, "act", { what: "trash", id: "m-1" }),
    false,
    "a message trashed may already be trashed",
  );
  assert.equal(
    repeatable(TOOLS, "open", { what: "messages", query: "from:x" }),
    true,
    "a reading spends nothing to repeat",
  );
  assert.equal(
    repeatable(TOOLS, "act", { what: "nonsense" }),
    false,
    "and a call the catalogue cannot read is not made again",
  );
});

test("every surface the agent works on has a reading value that reaches it", () => {
  const doors: Record<string, readonly string[]> = {
    chat: ["chat"],
    mail: ["messages", "folders"],
    kb: ["page", "pages", "search"],
    workorder: ["workorders"],
    runs: ["run"],
    files: ["files"],
    calendar: ["events", "calendars"],
  };
  const open = TOOLS.find((tool) => tool.name === "open");
  assert.ok(open);
  const values = new Set([...(open.args.what?.values ?? [])]);
  for (const [surface, names] of Object.entries(doors))
    assert.ok(
      names.some((name) => values.has(name)),
      `the ${surface} surface has a reading value that reaches it`,
    );
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

test("a workorder listing is the newest page, not the first files the folder holds", async () => {
  /*
   * A page is cut before the roots are read, because each row costs a read of the
   * Master's root. Ordered after the cut, a listing of twenty would draw the first
   * documents ever filed while today's work sat behind them — the runs listing's
   * own defect. The node's stamp is the order, and it is taken before the slice.
   */
  const at = new Date().toISOString();
  for (let n = 1; n <= 21; n += 1) {
    await writeAppFileAt(
      ctx,
      accountId,
      `workorders/wo-page-${n}.json`,
      buildWorkorderDoc({
        uid: `wo-page-${n}`,
        name: `Booking ${n}`,
        state: "running",
        by: "a@example.com",
        at,
        checklist: buildChecklist({
          template: { accountId, id: "template-page", revision: "rev-page" },
          variants: {},
          items: {},
          stepPaths: ["intake.confirm"],
        }),
      }),
    );
    // The mock stamps a node with its write's clock, and the order is that stamp.
    await new Promise((done) => setTimeout(done, 2));
  }
  const page = await callTool<{
    workorders: Array<{ uid: string }>;
    total: number;
    truncated: boolean;
  }>("workorder.list", { limit: 5 });
  assert.deepEqual(
    page.workorders.map((one) => one.uid),
    ["wo-page-21", "wo-page-20", "wo-page-19", "wo-page-18", "wo-page-17"],
    "the page is the five most recent, not the five filed first",
  );
  assert.ok(page.total >= 21, "and the total counts every workorder");
  assert.equal(page.truncated, true, "and says there is more");
});

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

test("an outward act asks for a person's word, and a rule's declaration is not one", () => {
  /*
   * ADR 0028's class 3. The rule declaration that used to license a send is
   * gone with `mail.send` (ADR 0038: an outward message is a draft a person
   * sends); what remains is the person's own word for that act, and no other.
   */
  const send = countingTool({
    name: "fixture.send",
    authority: "outward",
    writes: true,
    calls: [],
    act: (args) => (args.to ? { target: args.to, content: args.text ?? null } : null),
  });
  const args = {
    ok: true,
    to: "shipper@example.org",
    subject: "Booking 4417",
    text: "Confirmed.",
  };

  const quiet = startRun({
    id: "quiet",
    startedBy: { rule: "shipper", instruction: null, woke: "mail created: m-1" },
  });
  assert.equal(mayRun(send, quiet, args), false, "a run with no word sends nothing");
  assert.equal(
    mayRun(
      send,
      takeAuthorisation(quiet, {
        what: "send it",
        authority: "outward",
        act: { target: "shipper@example.org", content: "Confirmed." },
        by: "ada@example.org",
        at: new Date().toISOString(),
        from: { channel: "chat", id: "msg-1" },
      }),
      args,
    ),
    true,
    "and a person's word for this act is",
  );
});

test("a message is trashed only with a person's word for that message", async () => {
  /*
   * The one destructive act in the catalogue is a move to Deleted Items (owner
   * decision 2026-10-18): recoverable, and licensed by the person naming the
   * message. Without that word the tool refuses and the message stays where it is.
   */
  const id = await deliver("a message somebody wants out of the way");
  const plain = startRun({
    id: "trash-none",
    startedBy: { rule: "intake", instruction: null, woke: "mail created: m-1" },
  });
  await assert.rejects(
    () => runTool(TOOLS, { ctx, accountId, run: plain }, "mail.trash", { id }),
    /needs_authority|authority/,
    "no word, no trash",
  );

  const allowed = takeAuthorisation(plain, {
    what: "move it to the trash",
    authority: "destructive",
    act: { target: id, content: null },
    by: "ada@example.org",
    at: new Date().toISOString(),
    from: { channel: "chat", id: "msg-1" },
  });
  const moved = (await runTool(TOOLS, { ctx, accountId, run: allowed }, "mail.trash", {
    id,
  })) as { folder?: string };
  assert.equal(moved.folder, "Deleted Items", "the message is in the trash folder");
});

test("the reading tools answer from the group's account", async () => {
  const tool = callTool;

  // A run of this account, read as the document it is.
  const stored = startRun({
    id: "read-me",
    startedBy: { rule: "intake", instruction: null, woke: "mail created: m-1" },
  });
  await createRun(ctx, accountId, stored);
  const read = await tool<{ run: RunDoc }>("run.read", { id: "read-me" });
  assert.equal(read.run.id, "read-me");
  assert.deepEqual(read.run.startedBy, stored.startedBy);

  // A message found by the search grammar, then read by the id it answered.
  const delivered = await deliver("a booking confirmation");
  const other = await deliver("an unrelated note");
  const found = await tool<{ messages: Array<{ id?: string; threadId?: string }> }>(
    "mail.find",
    {
      query: "subject:booking",
    },
  );
  assert.ok(
    found.messages.some((message) => message.id === delivered),
    "the message is found by its subject",
  );
  assert.ok(
    found.messages.some(
      (message) => message.id === delivered && typeof message.threadId === "string",
    ),
    "and a hit carries its thread, which is the id a conversation link opens",
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
  }>("files.list", { path: "Documents" });
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

  // The group's own conversation: a search finds what it holds, and the node a
  // search answered with reads back as the message it is.
  await writeAppFileAt(ctx, accountId, "chat/c-1.json", {
    v: 1,
    from: "sam@example.com",
    at,
    text: "the container has left the port",
  });
  const written = await readAppFileAt(ctx, accountId, "chat/c-1.json");
  assert.ok(written, "the message is in the conversation");
  const hits = await tool<{ messages: Array<{ id: string; text: string }> }>(
    "chat.find",
    {
      query: "container",
    },
  );
  assert.equal(hits.messages.length, 1, "the conversation is searched where it is kept");
  assert.equal(hits.messages[0]?.id, String(written.file.id));
  const chatMessage = await tool<{ message: { id: string; text: string; from: string } }>(
    "chat.read",
    { id: String(written.file.id) },
  );
  assert.equal(chatMessage.message.text, "the container has left the port");
  assert.equal(chatMessage.message.from, "sam@example.com");
});

/** Whether a message carries a keyword, read straight from the account. */
async function hasKeyword(id: string, keyword: string): Promise<boolean> {
  const answer = await clientOf(ctx).call<{
    list?: Array<{ keywords?: Record<string, boolean> }>;
  }>("Email/get", { accountId, ids: [id], properties: ["keywords"] }, [
    CAPABILITIES.mail,
  ]);
  return Boolean(answer.list?.[0]?.keywords?.[keyword]);
}

test("a mailbox folder is renamed in place, and a system folder is not", async () => {
  const folder = await writeTool<{ id: string; name: string }>("mail.folder", {
    name: "Old name",
  });
  const renamed = await writeTool<{ id: string; name: string; was: string }>(
    "mail.renameFolder",
    { name: "Old name", to: "New name" },
  );
  assert.equal(renamed.id, folder.id, "the folder is the same one, renamed");
  assert.equal(renamed.name, "New name");
  assert.equal(renamed.was, "Old name");
  await assert.rejects(
    () => writeTool("mail.renameFolder", { name: "Old name", to: "Third name" }),
    /no folder "Old name"/,
    "the old name is gone, so nothing is left behind to duplicate",
  );
  await assert.rejects(
    () => writeTool("mail.renameFolder", { name: "inbox", to: "Post" }),
    /keeps by role/,
    "a system folder is kept by role and is not renamed",
  );
});

test("a message is filed by the folder id find answered, as well as by its name", async () => {
  /*
   * The eval of 2026-10-22 measured the model copying the id `find folders`
   * gave it and being refused for a spelling it had in hand: a folder is
   * named by its name, its role, or that id (ADR 0038).
   */
  const folder = await writeTool<{ id: string; name: string }>("mail.folder", {
    name: "Cases by id",
  });
  const message = await deliver("a message to file by id");
  const filed = await writeTool<{ id: string; folder: string }>("mail.file", {
    id: message,
    folder: folder.id,
  });
  assert.equal(filed.folder, "Cases by id", "the id reaches the folder it names");
});

test("the calendar is read and changed through its own tools", async () => {
  const listed = await callTool<{
    calendars: Array<{ id: string; name: string; mayWrite: boolean }>;
  }>("calendar.list", {});
  const personal = listed.calendars.find((one) => one.name === "Personal");
  assert.ok(personal?.mayWrite, "the account's own calendar is writable");

  const created = await writeTool<{ id: string }>("calendar.create", {
    calendar: personal.id,
    title: "Container 12 arrives",
    start: "2026-10-20T09:00:00",
    duration: "PT2H",
  });
  const found = await callTool<{ events: Array<{ id: string; title: string }> }>(
    "calendar.find",
    { from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z" },
  );
  assert.ok(
    found.events.some((one) => one.title === "Container 12 arrives"),
    "the event is in the window it was made in",
  );

  const read = await callTool<{ event: Record<string, unknown> }>("calendar.read", {
    id: created.id,
  });
  assert.equal(read.event.title, "Container 12 arrives");

  const allowed = takeAuthorisation(plainRun(), {
    what: "correct the event's title",
    authority: "destructive",
    act: { target: created.id, content: null },
    by: "ada@example.org",
    at: new Date().toISOString(),
    from: { channel: "chat", id: "msg-event" },
  });
  await assert.rejects(
    () =>
      runTool(TOOLS, { ctx, accountId, run: plainRun() }, "calendar.update", {
        id: created.id,
        title: "Container 12 has arrived",
      }),
    /authority/,
    "changing an event takes a person's word for it",
  );
  await runTool(TOOLS, { ctx, accountId, run: allowed }, "calendar.update", {
    id: created.id,
    title: "Container 12 has arrived",
  });
  const changed = await callTool<{ event: Record<string, unknown> }>("calendar.read", {
    id: created.id,
  });
  assert.equal(changed.event.title, "Container 12 has arrived");

  await assert.rejects(
    () =>
      runTool(TOOLS, { ctx, accountId, run: plainRun() }, "calendar.delete", {
        id: created.id,
      }),
    /authority/,
    "removing an event takes a person's word for it",
  );
  await runTool(TOOLS, { ctx, accountId, run: allowed }, "calendar.delete", {
    id: created.id,
  });
  await assert.rejects(
    () => callTool("calendar.read", { id: created.id }),
    /no event/,
    "a removed event is gone, not drawn blank",
  );
});

test("a document is written once, replaced and removed only under a word", async () => {
  const written = await writeTool<{ id: string; path: string; bytes: number }>(
    "files.write",
    { path: "Journal/2026/note.md", text: "# Today\n\nContainer 12 left." },
  );
  assert.equal(written.path, "Journal/2026/note.md", "the folders of the path are made");
  assert.ok(written.bytes > 0, "the words are the bytes written");
  const read = await callTool<{ text?: string }>("files.read", {
    path: "Journal/2026/note.md",
  });
  assert.match(read.text ?? "", /Container 12 left/);

  await assert.rejects(
    () => writeTool("files.write", { path: "Journal/2026/note.md", text: "again" }),
    /already holds a document/,
    "a write never replaces what a person filed",
  );

  const plain = plainRun();
  await assert.rejects(
    () =>
      runTool(TOOLS, { ctx, accountId, run: plain }, "files.overwrite", {
        path: "Journal/2026/note.md",
        text: "Container 13 left.",
      }),
    /authority/,
    "replacing a document needs a person's word",
  );
  const allowed = takeAuthorisation(plain, {
    what: "replace the note with today's words",
    authority: "destructive",
    act: { target: "Journal/2026/note.md", content: null },
    by: "ada@example.org",
    at: new Date().toISOString(),
    from: { channel: "chat", id: "msg-note" },
  });
  await runTool(TOOLS, { ctx, accountId, run: allowed }, "files.overwrite", {
    path: "Journal/2026/note.md",
    text: "Container 13 left.",
  });
  const changed = await callTool<{ text?: string }>("files.read", {
    path: "Journal/2026/note.md",
  });
  assert.match(changed.text ?? "", /Container 13 left/);

  await runTool(TOOLS, { ctx, accountId, run: allowed }, "files.delete", {
    path: "Journal/2026/note.md",
  });
  await assert.rejects(
    () => callTool("files.read", { path: "Journal/2026/note.md" }),
    /There is no file/,
    "a removed document is gone, not drawn blank",
  );
});

test("a draft is replaced with new words, trash is undone, and an empty folder goes", async () => {
  const delivered = await clientOf(ctx).call<{ created?: { c?: { id?: string } } }>(
    "Email/set",
    {
      accountId,
      create: {
        c: {
          subject: "booking 4418",
          from: [{ email: "ops@shipper.example" }],
          to: [{ email: "demo@example.com" }],
          mailboxIds: { inbox: true },
        },
      },
    },
    [CAPABILITIES.mail],
  );
  const message = delivered.created?.c?.id;
  assert.ok(message, "the message to answer is in the account");
  const draft = await writeTool<{ id: string }>("mail.draft", {
    id: message,
    text: "first words",
  });
  /*
   * A draft the agent wrote is its own to correct; a draft a person wrote is not
   * rewritten at all — the class is reversible because the mark decides whose
   * draft it is, not a person's word for every typo.
   */
  const edited = (await writeTool("mail.editDraft", {
    id: draft.id,
    text: "second words",
    subject: "Re: an answer",
  })) as { id: string; replaced: string };
  const personsDraft = await clientOf(ctx).call<{ created?: { d?: { id?: string } } }>(
    "Email/set",
    {
      accountId,
      create: {
        d: {
          from: [{ email: "demo@example.com" }],
          to: [{ email: "ops@shipper.example" }],
          subject: "a person's draft",
          mailboxIds: { drafts: true },
          keywords: { $draft: true },
          bodyStructure: { partId: "text", type: "text/plain" },
          bodyValues: { text: { value: "my words" } },
        },
      },
    },
    [CAPABILITIES.mail],
  );
  const theirs = personsDraft.created?.d?.id;
  assert.ok(theirs, "the person's draft is in Drafts");
  await assert.rejects(
    () => writeTool("mail.editDraft", { id: theirs, text: "rewritten" }),
    /a person wrote/,
    "a person's draft is refused, never rewritten",
  );
  assert.equal(edited.replaced, draft.id, "the old draft is the one replaced");
  const read = await callTool<{
    message: { bodyValues?: Record<string, { value?: string }>; subject?: string };
  }>("mail.read", { id: edited.id });
  const words = Object.values(read.message.bodyValues ?? {})
    .map((one) => one.value ?? "")
    .join("");
  assert.match(words, /second words/);
  assert.equal(read.message.subject, "Re: an answer");

  // The trash is a move, and the way back is one too.
  const plain = plainRun();
  const allowed = takeAuthorisation(plain, {
    what: "put it in the trash",
    authority: "destructive",
    act: { target: message, content: null },
    by: "ada@example.org",
    at: new Date().toISOString(),
    from: { channel: "chat", id: "msg-trash" },
  });
  await runTool(TOOLS, { ctx, accountId, run: allowed }, "mail.trash", { id: message });
  const back = (await writeTool<{ folder: string }>("mail.untrash", {
    id: message,
  })) as { folder?: string };
  assert.equal(back.folder, "Inbox", "the way back is the inbox");

  // A folder that still holds something is refused; an empty one is removed
  // under the person's word for that folder.
  await writeTool("mail.folder", { name: "Throwaway" });
  await writeTool("mail.file", { id: message, folder: "Throwaway" });
  const wordForFolder = takeAuthorisation(plain, {
    what: "remove the Throwaway folder",
    authority: "destructive",
    act: { target: "Throwaway", content: null },
    by: "ada@example.org",
    at: new Date().toISOString(),
    from: { channel: "chat", id: "msg-folder" },
  });
  await assert.rejects(
    () =>
      runTool(TOOLS, { ctx, accountId, run: wordForFolder }, "mail.deleteFolder", {
        name: "Throwaway",
      }),
    /still holds messages/,
    "a folder is removed only when it is empty",
  );
  await writeTool("mail.file", { id: message, folder: "inbox" });
  const gone = await runTool(
    TOOLS,
    { ctx, accountId, run: wordForFolder },
    "mail.deleteFolder",
    { name: "Throwaway" },
  );
  assert.deepEqual(gone, { name: "Throwaway", removed: true });
});

test("the Global contacts are searchable by name and by address", async () => {
  const { GLOBAL_CONTACTS_BOOK_NAME } = await import("../shared/globalContacts.js");
  const book = await clientOf(ctx).call<{ created?: { b?: { id?: string } } }>(
    "AddressBook/set",
    { accountId, create: { b: { name: GLOBAL_CONTACTS_BOOK_NAME } } },
    [CAPABILITIES.contacts],
  );
  const bookId = book.created?.b?.id;
  assert.ok(bookId, "the directory book is made");
  await clientOf(ctx).call(
    "ContactCard/set",
    {
      accountId,
      create: {
        c: {
          addressBookIds: { [bookId]: true },
          name: { full: "Ada Lovelace" },
          emails: { e: { address: "ada@shipper.example" } },
          organizations: { o: { name: "Analytical Engines" } },
        },
      },
    },
    [CAPABILITIES.contacts],
  );

  const byName = await callTool<{
    contacts: Array<{ name: string; emails: string[] }>;
  }>("contacts.find", { query: "ada" });
  assert.equal(byName.contacts[0]?.name, "Ada Lovelace");
  const byEmail = await callTool<{
    contacts: Array<{ name: string; emails: string[] }>;
  }>("contacts.find", { query: "ada@shipper.example" });
  assert.deepEqual(byEmail.contacts[0]?.emails, ["ada@shipper.example"]);
  const none = await callTool<{ contacts: unknown[] }>("contacts.find", {
    query: "nobody-by-this-name",
  });
  assert.equal(none.contacts.length, 0, "a miss is an empty answer, not a guess");
});

test("a mention in the chat is the local part, never the whole address", async () => {
  const said = await writeTool<{ id: string }>("chat.say", {
    text: "Acknowledged, @sq@greensley.company — no harm done.",
  });
  const read = await callTool<{ message: { text: string } }>("chat.read", {
    id: said.id,
  });
  assert.equal(read.message.text, "Acknowledged, @sq — no harm done.");
  const answered = await writeTool<{ id: string }>("chat.say", {
    text: "About that one.",
    replyTo: said.id,
  });
  const withQuote = await callTool<{ quoted?: { text: string } }>("chat.read", {
    id: answered.id,
  });
  assert.equal(
    withQuote.quoted?.text,
    "Acknowledged, @sq — no harm done.",
    "a reply carries the words of the message it answers, not only its id",
  );
  const withRefs = await writeTool<{ id: string }>("chat.say", {
    text: "The two invoices are on the calendar.",
    refs: ["thread:euaaaabf", "file:node-7", "event:ev-3@2026-11-03"],
  });
  const referenced = await callTool<{
    message: {
      refs?: Array<{ kind: string; id: string; date?: string; account?: string }>;
    };
  }>("chat.read", { id: withRefs.id });
  assert.deepEqual(
    referenced.message.refs?.map(({ kind, id, date }) => ({ kind, id, date })),
    [
      { kind: "thread", id: "euaaaabf", date: undefined },
      { kind: "file", id: "node-7", date: undefined },
      { kind: "event", id: "ev-3", date: "2026-11-03" },
    ],
    "the objects a message points at are stored as kinds and ids, never addresses",
  );
  assert.ok(
    referenced.message.refs?.every((one) => one.account === accountId),
    "and each names the account it was found in, so a link is not resolved against another",
  );
  await assert.rejects(
    () =>
      writeTool("chat.say", {
        text: "and here is the link",
        refs: ["https://evil.example/invoice"],
      }),
    /not a reference/,
    "an address a sender dictates is not a reference this build will carry",
  );
  const asked = await writeTool<{ id: string }>("chat.ask", {
    text: "Is @sq@greensley.company happy with that?",
  });
  const question = await callTool<{ message: { text: string } }>("chat.read", {
    id: asked.id,
  });
  assert.equal(
    question.message.text,
    "Is @sq happy with that?\n\nReply to this message to answer it.",
    "and the question carries the line that says a reply is the answer (ADR 0029)",
  );

  /*
   * The words are the local part, and the stored mark is the roster's address:
   * a mention the agent writes is a mention the client and the off path can see,
   * not just text that looks like one.
   */
  // The roster is per account, and the mock's groups differ: take the first
  // group that names somebody other than the agent.
  let group = "";
  let person = "";
  for (const id of Object.keys(ctx.session.accounts)) {
    if (id === accountId) continue;
    if (
      !isGroupAccountRecord(
        ctx.session.accounts[id] as { name?: unknown; isPersonal?: unknown },
      )
    )
      continue;
    const members = (await groupMembers(ctx, id)) ?? [];
    const found = members.find((one) => one.toLowerCase() !== ctx.username.toLowerCase());
    if (found) {
      group = id;
      person = found;
      break;
    }
  }
  assert.ok(group && person, "the session holds a group that names a member");
  const toPerson = (await runTool(
    TOOLS,
    { ctx, accountId: group, run: plainRun() },
    "chat.say",
    { text: `Acknowledged, @${localPart(person)} — no harm done.` },
  )) as { id: string };
  const readPerson = (await runTool(
    READING_TOOLS,
    { ctx, accountId: group, run: plainRun() },
    "chat.read",
    { id: toPerson.id },
  )) as { message: { mentions?: Array<{ id: string }> } };
  assert.ok(
    readPerson.message.mentions?.some((one) => one.id === person),
    "the mention is marked as the person it names",
  );

  /*
   * The account a reference lives in is the server's to say (ADR 0039): a
   * group's own objects are the group's, and a **card is the installation's** —
   * the one directory in the Master's account — so a link written in a group's
   * conversation must not be resolved against the group.
   */
  const homed = (await runTool(
    TOOLS,
    { ctx, accountId: group, run: plainRun() },
    "chat.say",
    { text: "Two references.", refs: ["thread:t-1", "contact:card-1"] },
  )) as { id: string };
  const readHomed = (await runTool(
    READING_TOOLS,
    { ctx, accountId: group, run: plainRun() },
    "chat.read",
    { id: homed.id },
  )) as { message: { refs?: Array<{ kind: string; account?: string }> } };
  assert.deepEqual(
    readHomed.message.refs?.map((one) => [one.kind, one.account]),
    [
      ["thread", group],
      ["contact", filesAccountId(ctx)],
    ],
    "a group's thread names the group, and a card names the installation",
  );
});

test("a folder is renamed, moved and removed like a document", async () => {
  /*
   * The live freight run could rename its mail folders but not the three
   * folders in Files: the node readers took documents only. A folder is a node
   * too, and the same path vocabulary acts on it — with its own guards: a folder
   * cannot move into its own subtree, and one still holding something is not
   * removed.
   */
  await writeTool("files.folder", { path: "Bookings/2026" });
  await writeTool("files.write", { path: "Bookings/2026/a.txt", text: "a" });
  await writeTool("files.rename", { path: "Bookings/2026", name: "2027" });
  const listed = await callTool<{
    nodes: Array<{ path: string; id?: string }>;
  }>("files.list", {
    path: "Bookings/2027",
  });
  assert.deepEqual(
    listed.nodes.map((one) => one.path),
    ["Bookings/2027/a.txt"],
    "the folder is renamed with what it holds",
  );
  assert.ok(
    listed.nodes.every((one) => typeof one.id === "string" && one.id !== ""),
    "and each row carries the id a chat reference opens the file by",
  );

  const word = takeAuthorisation(plainRun(), {
    what: "move the folder to the Trash",
    authority: "destructive",
    act: { target: "Bookings/2027", content: null },
    by: "ada@example.org",
    at: new Date().toISOString(),
    from: { channel: "chat", id: "msg-folder" },
  });
  const gone = await runTool(TOOLS, { ctx, accountId, run: word }, "files.delete", {
    path: "Bookings/2027",
  });
  assert.deepEqual(gone, { path: "Bookings/2027", trashed: true });

  /*
   * The folder arrives whole: deleting moves it into the account's Trash and
   * nothing under it is lost (ADR 0013). The Trash is the account's, so it may
   * hold what an earlier test left there — this asserts what this test put in.
   */
  const trashed = await callTool<{ nodes: Array<{ path: string }> }>("files.list", {
    path: "Trash",
  });
  assert.ok(
    trashed.nodes.some((one) => one.path === "Trash/2027"),
    "the folder is in the Trash",
  );
  const within = await callTool<{ nodes: Array<{ path: string }> }>("files.list", {
    path: "Trash/2027",
  });
  assert.deepEqual(
    within.nodes.map((one) => one.path),
    ["Trash/2027/a.txt"],
  );

  const wordForTrash = takeAuthorisation(plainRun(), {
    what: "remove the Trash",
    authority: "destructive",
    act: { target: "Trash", content: null },
    by: "ada@example.org",
    at: new Date().toISOString(),
    from: { channel: "chat", id: "msg-trash" },
  });
  await assert.rejects(
    () =>
      runTool(TOOLS, { ctx, accountId, run: wordForTrash }, "files.delete", {
        path: "Trash",
      }),
    /is the Trash/,
    "the Trash folder itself is never deleted",
  );
  const wordForTrashed = takeAuthorisation(plainRun(), {
    what: "remove a node already in the Trash",
    authority: "destructive",
    act: { target: "Trash/2027", content: null },
    by: "ada@example.org",
    at: new Date().toISOString(),
    from: { channel: "chat", id: "msg-trashed" },
  });
  await assert.rejects(
    () =>
      runTool(TOOLS, { ctx, accountId, run: wordForTrashed }, "files.delete", {
        path: "Trash/2027",
      }),
    /already in the Trash/,
    "a node already there is not moved again",
  );

  await writeTool("files.write", { path: "Bookings/keep.txt", text: "kept" });
  await assert.rejects(
    () => writeTool("files.move", { path: "Bookings/keep.txt", folder: "Trash" }),
    /is the Trash/,
    "the Trash is not a destination for a move",
  );
  await assert.rejects(
    () => writeTool("files.write", { path: "Trash/planted.txt", text: "planted" }),
    /is not a destination/,
    "the Trash is not a destination for a write",
  );

  await writeTool("files.folder", { path: "Outer/Inner" });
  await assert.rejects(
    () => writeTool("files.move", { path: "Outer", folder: "Outer/Inner" }),
    /cannot be moved into itself/,
    "a folder is not moved into its own subtree",
  );
});

test("the writing tools change the group's own account", async () => {
  // A folder of the mailbox, made once and answered the same way the second
  // time: the call is safe to repeat.
  const folder = await writeTool<{ id: string; name: string }>("mail.folder", {
    name: "Filed 2026",
  });
  assert.equal(folder.name, "Filed 2026");
  const again = await writeTool<{ id: string }>("mail.folder", { name: "filed 2026" });
  assert.equal(
    again.id,
    folder.id,
    "a folder already there is the answer, not a second one",
  );

  // A message filed into it: moved, not copied.
  const message = await deliver("an invoice for container 12");
  await writeTool("mail.file", { id: message, folder: "Filed 2026" });
  const filed = await clientOf(ctx).call<{
    list?: Array<{ mailboxIds?: Record<string, boolean> }>;
  }>("Email/get", { accountId, ids: [message], properties: ["mailboxIds"] }, [
    CAPABILITIES.mail,
  ]);
  assert.deepEqual(
    filed.list?.[0]?.mailboxIds,
    { [folder.id]: true },
    "the message is in the folder it was filed into, and out of the ones it was in",
  );
  await assert.rejects(
    () => writeTool("mail.file", { id: message, folder: "Nowhere" }),
    /no folder "Nowhere"/,
    "a folder that is not there is not a destination",
  );

  // A keyword, on and off, and the reserved namespace: the vocabulary's own
  // label is the agent's to apply, an invented member of it is nobody's.
  await writeTool("mail.keyword", { id: message, keyword: "$flagged" });
  assert.ok(await hasKeyword(message, "$flagged"), "the mark is on the message");
  await writeTool("mail.keyword", { id: message, keyword: "$flagged", on: false });
  assert.ok(!(await hasKeyword(message, "$flagged")), "and it comes off again");
  await writeTool("mail.keyword", { id: message, keyword: AGENT_LABEL.processed });
  assert.ok(
    await hasKeyword(message, AGENT_LABEL.processed),
    "the agent marks a message processed with the product's own label",
  );
  await assert.rejects(
    () => writeTool("mail.keyword", { id: message, keyword: "G-filed" }),
    /reserved/,
    "an invented member of the reserved namespace is refused",
  );

  // The group's own label catalog: a label joins it, and the same keyword
  // changes rather than doubling.
  await writeTool("mail.label", {
    keyword: "shipping",
    name: "Shipping",
    color: "#123456",
  });
  const catalog = await readGroupLabels(ctx, accountId);
  assert.ok(
    catalog.state === "catalog" &&
      catalog.labels.some((one) => one.keyword === "shipping" && one.name === "Shipping"),
    "the label is in the group's own catalog",
  );
  const changed = await writeTool<{ added: boolean }>("mail.label", {
    keyword: "shipping",
    name: "Shipped",
    color: "#123456",
  });
  assert.equal(
    changed.added,
    false,
    "a keyword the catalog holds is changed, not added twice",
  );
  await assert.rejects(
    () =>
      writeTool("mail.label", {
        keyword: AGENT_LABEL.processed,
        name: "Processed",
        color: "#123456",
      }),
    /reserved/,
    "the catalog is the group's human labels, and the reserved namespace is never stored in it",
  );

  // A folder of the account's own Files, and a node moved and renamed into it.
  const made = await writeTool<{ folder: string; id: string }>("files.folder", {
    path: "Containers/2026",
  });
  assert.equal(made.folder, "Containers/2026", "a path of folders is made whole");
  await writeBytesIntoVisibleFolder(
    ctx,
    accountId,
    "Documents",
    "booking.txt",
    new TextEncoder().encode("a booking"),
    "text/plain",
  );
  const booking = await readVisibleFileAt(ctx, accountId, "Documents/booking.txt");
  assert.ok(booking, "the document is in the visible tree");
  await writeTool("files.move", {
    path: "Documents/booking.txt",
    folder: "Containers/2026",
  });
  const moved = await writeTool<{ nodes: Array<{ path: string }> }>("files.list", {
    path: "Containers/2026",
  });
  assert.deepEqual(
    moved.nodes.map((one) => one.path),
    ["Containers/2026/booking.txt"],
    "the node is where it was moved to",
  );
  const left = await writeTool<{ nodes: Array<{ path: string }> }>("files.list", {
    path: "Documents",
  });
  assert.ok(
    !left.nodes.some((one) => one.path === "Documents/booking.txt"),
    "and no longer where it was",
  );
  await writeTool("files.rename", {
    path: "Containers/2026/booking.txt",
    name: "booking-2026.txt",
  });
  const renamed = await writeTool<{ name: string; text: string }>("files.read", {
    path: "Containers/2026/booking-2026.txt",
  });
  assert.equal(
    renamed.name,
    "booking-2026.txt",
    "the node keeps its bytes and its place",
  );
  assert.equal(renamed.text, "a booking");

  // The top level of Files is a destination like any folder, and `null` has to
  // reach the server for the move to happen at all.
  await writeTool("files.move", { path: "Containers/2026/booking-2026.txt" });
  const atTop = await writeTool<{ nodes: Array<{ path: string }> }>("files.list", {});
  assert.ok(
    atTop.nodes.some((one) => one.path === "booking-2026.txt"),
    "a move that names no folder is a move to the top level of Files",
  );

  // The conversation: a report, and a question the run waits on.
  const said = await writeTool<{ id: string }>("chat.say", {
    text: "container 12 is on its way",
  });
  const saidBack = await writeTool<{ message: { text: string; from: string } }>(
    "chat.read",
    { id: said.id },
  );
  assert.equal(saidBack.message.text, "container 12 is on its way");
  assert.equal(
    saidBack.message.from,
    ctx.username,
    "the agent writes as itself (ADR 0029)",
  );

  const question = "@sam@example.com is the delivery confirmed?";
  const asked = await writeTool<{ id: string; wait: RunWait }>("chat.ask", {
    text: question,
  });
  assert.deepEqual(
    { what: asked.wait.what, asked: asked.wait.asked },
    {
      // A mention is the local part, as the conversation reads it; the wait
      // carries the question exactly as it was written.
      what: "@sam is the delivery confirmed?",
      asked: { channel: "chat", id: asked.id },
    },
    "a question is a run waiting on a person (ADR 0030)",
  );
  /*
   * …and it carries its deadline: ADR 0029 gives the question 72 hours, after
   * which the work goes on without the answer rather than parking for ever.
   */
  const remaining = Date.parse(asked.wait.until ?? "") - Date.now();
  assert.ok(
    remaining > 70 * 60 * 60_000 && remaining <= QUESTION_TTL_MS,
    "the deadline is the one ADR 0029 declares, not one the tool invented",
  );
  const askedBack = await writeTool<{ message: { text: string } }>("chat.read", {
    id: asked.id,
  });
  assert.equal(
    askedBack.message.text,
    "@sam is the delivery confirmed?\n\nReply to this message to answer it.",
    "and the question is in the conversation, the mention by its local part",
  );
});

test("a question already open on a person is not asked a second time", async () => {
  /*
   * The live failure this pins: one booking question went to the group five
   * times in a morning, each from a new run that had no way to know the first
   * was still waiting — and only one of the runs could be moved by the answer.
   */
  const parked = finishRun(
    waitUntil(
      startRun({
        id: "r-parked",
        startedBy: { rule: "intake", instruction: null, woke: "mail created: m-0" },
      }),
      {
        what: "@sam is the seal confirmed?",
        asked: { channel: "chat", id: "c-old" },
        until: null,
      },
    ),
    "blocked",
    { at: "2026-10-20T09:00:00.000Z", why: "waiting on a person" },
  );
  await createRun(ctx, accountId, parked);

  const asked = await writeTool<{
    id: string;
    alreadyAsked?: boolean;
    wait?: unknown;
  }>("chat.ask", { text: "@sam@example.com is the seal confirmed?" });
  assert.equal(asked.alreadyAsked, true, "the same question is not posted again");
  assert.equal(asked.id, "c-old", "the open question's own message is the answer");
  assert.equal(
    asked.wait,
    undefined,
    "and this run does not park on a second copy of the question",
  );
});

test("a name the memory does not hold becomes the entity the fact is about", async () => {
  /*
   * The live failure this pins: the agent named the booking and the container it
   * was working, the memory held no fact about them yet, and the write was
   * refused fourteen times in one morning — each a model call, and the next
   * attempt dropped the link by hand. A fact about a subject the memory does not
   * hold now **creates** the entity (ADR 0038), and a fact whose value is another
   * entity is a relation, which is what one hop follows.
   */
  const recorded = await writeTool<{ id: string; subject: string }>("memory.remember", {
    subject: "container TEMU5974430",
    entityKind: "container",
    predicate: "shipped-from",
    object: "279726936 5X20 Ennore",
    fact: "29 blocks of zinc dross",
  });
  assert.equal(recorded.subject, "container TEMU5974430");
  const sheet = await readAppFileAt(ctx, accountId, factPath(recorded.id));
  const parsed = parseFactDocumentDetailed(sheet?.text ?? "");
  assert.ok("fact" in parsed, "the fact is written");
  const held = await listMemory(ctx, accountId);
  const object = held.entities.find(
    (entity) => entity.normalized === "279726936 5x20 ennore",
  );
  assert.ok(object, "the name the fact named is an entity of its own");
  assert.deepEqual(
    parsed.fact.value,
    { entity: object.id },
    "and the fact points at it: a relation, not a link to a sheet",
  );
  assert.equal(
    held.entities.find((entity) => entity.id === parsed.fact.entity)?.kind,
    "container",
    "the subject's kind is the one the fact stated",
  );
});

test("the memory tool records a fact where the installation keeps them", async () => {
  // The one tool that writes outside the group's account (ADR 0033, ADR 0038):
  // the fact lands in the Master's own memory, and the whole store reads it back.
  const recorded = await writeTool<{ id: string; subject: string }>("memory.remember", {
    subject: "Bologna Express",
    entityKind: "client",
    fact: "the shipper the office books containers with",
  });
  assert.equal(recorded.subject, "Bologna Express");
  const sheet = await readAppFileAt(ctx, accountId, factPath(recorded.id));
  assert.ok(sheet, "the fact is one document in the memory");
  const parsed = parseFactDocumentDetailed(sheet.text);
  assert.ok("fact" in parsed, "and it is the shape this build writes");
  assert.deepEqual(
    parsed.fact.origin,
    { by: "run", run: "r1" },
    "with the run that recorded it",
  );
  assert.equal(parsed.fact.predicate, "is", "the relation a fact states by default");
  assert.equal(parsed.fact.validTo, undefined, "and it is in force");
  assert.ok(
    (await listMemory(ctx, accountId)).facts.some((fact) => fact.id === recorded.id),
    "the store answers the whole memory, so a selection can be made from it",
  );

  // A fact a person wrote is in force: the tool writes the agent's conclusion
  // beside it as a proposal and says so, and the person's sentence is untouched.
  await writeAppFileAt(ctx, accountId, factPath("person-2"), {
    v: 3,
    id: "person-2",
    subject: "Maersk",
    fact: "the account's own shipper",
    origin: { by: "person", who: "admin@example.com" },
    at: "2026-10-16T10:00:00.000Z",
    links: [],
    standing: false,
    group: accountId,
  });
  const proposed = await writeTool<{
    proposed?: string;
    inForce?: string;
  }>("memory.remember", {
    subject: "Maersk",
    fact: "what the agent concluded instead",
  });
  assert.equal(
    proposed.proposed,
    "what the agent concluded instead",
    "the model is told its conclusion is a proposal, not a fact",
  );
  assert.equal(
    proposed.inForce,
    "the account's own shipper",
    "and what the person's word still is",
  );
  const personSheet = await readAppFileAt(ctx, accountId, factPath("person-2"));
  const parsedPerson = parseFactDocumentDetailed(personSheet?.text ?? "");
  assert.ok("fact" in parsedPerson);
  assert.equal(
    parsedPerson.fact.fact,
    "the account's own shipper",
    "the document keeps its sentence",
  );
  assert.equal(
    parsedPerson.fact.proposal?.fact,
    "what the agent concluded instead",
    "with the proposal beside it",
  );
  await destroyAppNode(ctx, accountId, String(personSheet?.file.id), {});

  // Arguments the tool cannot use are refused before the memory is touched.
  await assert.rejects(
    () =>
      writeTool("memory.remember", {
        subject: "shipper",
        fact: "y",
        predicate: "Ships with!",
      }),
    /is not a relation/,
  );
  await assert.rejects(
    () =>
      writeTool("memory.remember", {
        subject: "shipper",
        fact: "y",
        entityKind: "parcel",
      }),
    /"entityKind" must be one of/,
  );
  await assert.rejects(
    () => writeTool("memory.remember", { subject: "", fact: "y" }),
    /"subject" must be text/,
  );
  // A subject shorter than a few characters is one nearly every change
  // carries, so the catalogue refuses it where the write is asked for
  // (`subjectProblem`, ADR 0038).
  await assert.rejects(
    () => writeTool("memory.remember", { subject: "id", fact: "some sentence" }),
    /"subject" must be at least 3 characters/,
  );
  await assert.rejects(
    () =>
      writeTool("memory.remember", {
        subject: "shipper",
        fact: "y".repeat(MEMORY_FACT_MAX + 1),
      }),
    /"fact" must be at most/,
  );
  /*
   * The memory is standing knowledge, not a log (ADR 0033). What happened in
   * one change is the run's record's business: a dated sentence and a sentence
   * naming a record are refused at the door, and so is a subject that is one
   * record rather than a thing a later change names again.
   */
  await assert.rejects(
    () =>
      writeTool("memory.remember", {
        subject: "Maersk",
        fact: "the booking arrived on 2026-10-21 at 09:00",
      }),
    /carries a date or a time/,
    "a dated sentence is an event, and the run's record holds it",
  );
  await assert.rejects(
    () =>
      writeTool("memory.remember", {
        subject: "Maersk",
        fact: "message e907000 asked for the papers",
      }),
    /carries a record's id/,
    "a sentence about one message is not a fact",
  );
  await assert.rejects(
    () =>
      writeTool("memory.remember", {
        subject: "e907000",
        fact: "the shipper asked for the papers",
      }),
    /names one record or one date/,
    "a subject that is one record is recalled by nothing later",
  );

  for (const id of [recorded.id, "person-2"]) {
    const found = await readAppFileAt(ctx, accountId, factPath(id));
    const nodeId = found?.file.id;
    if (typeof nodeId === "string") await destroyAppNode(ctx, accountId, nodeId, {});
  }
});

test("a run reads when a fact stopped being true, closed facts and all", async () => {
  /*
   * The live retrieval carries what is true now (ADR 0038); a run asked "since
   * when" reads one entity's interval through the same `read` job every run has,
   * and the closed fact is the answer it could not get any other way.
   */
  await writeTool("memory.remember", {
    subject: "Cargo 77",
    entityKind: "client",
    fact: "books on Fridays",
  });
  await writeTool("memory.remember", {
    subject: "Cargo 77",
    fact: "books on Fridays and Mondays",
  });
  const history = await writeTool<{
    subject: string;
    facts: Array<{ fact: string; from: string; until?: string; inForce: boolean }>;
  }>("open", { what: "memory", subject: "Cargo 77" });
  assert.equal(history.subject, "Cargo 77");
  assert.deepEqual(
    history.facts.map((fact) => fact.fact),
    ["books on Fridays", "books on Fridays and Mondays"],
    "oldest first, the one it replaced and the one in force",
  );
  assert.equal(history.facts[0]?.inForce, false, "the earlier fact is closed");
  assert.ok(history.facts[0]?.until, "and says when it stopped being true");
  assert.equal(history.facts[1]?.inForce, true, "the later one is in force");

  const held = await listMemory(ctx, accountId);
  for (const fact of held.facts)
    if (fact.entity === entityIdFor("Cargo 77")) {
      const found = await readAppFileAt(ctx, accountId, factPath(fact.id));
      const nodeId = found?.file.id;
      if (typeof nodeId === "string") await destroyAppNode(ctx, accountId, nodeId, {});
    }
  const entity = await readAppFileAt(ctx, accountId, entityPath(entityIdFor("Cargo 77")));
  if (typeof entity?.file.id === "string")
    await destroyAppNode(ctx, accountId, entity.file.id, {});
});

test("the outward reach is a draft, and no tool submits mail", async () => {
  /*
   * ADR 0038 dropped `mail.send` and `mail.ask`: an outward message is a draft a
   * person sends (ADR 0038), so the catalogue holds no submission at all. The
   * draft path is exercised in its own test; this pins the absence, which is the
   * boundary a malicious mail runs into.
   */
  const submissions = mock.methodCalls["EmailSubmission/set"] ?? 0;
  const submitting = TOOLS.filter(
    (tool) => tool.name === "mail.send" || tool.name === "send",
  );
  assert.deepEqual(submitting, [], "no job sends a message");
  assert.equal(
    mock.methodCalls["EmailSubmission/set"] ?? 0,
    submissions,
    "and the catalogue alone submits nothing",
  );
});

test("an attachment of a message is read inside, by the same reader as a document in Files", async () => {
  /*
   * The document that matters usually arrives attached: a purchase order, a
   * price list. Nothing is downloaded to disk and nothing is asked of the
   * browser — the blob is read through the same format readers a file in Files
   * goes through (ADR 0038).
   */
  const XLSX = (await import("@e965/xlsx")) as unknown as {
    utils: {
      book_new(): unknown;
      aoa_to_sheet(rows: unknown[][]): unknown;
      book_append_sheet(book: unknown, sheet: unknown, name: string): void;
    };
    write(book: unknown, opts: { type: "buffer"; bookType: string }): Uint8Array;
  };
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Booking", "Shipper"],
      ["BK-1", "Maersk"],
    ]),
    "Inbound",
  );
  const type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const bytes = new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
  const blobId = await uploadBlobBytes(ctx, accountId, bytes, type);

  const created = await clientOf(ctx).call<{ created?: { c?: { id?: string } } }>(
    "Email/set",
    {
      accountId,
      create: {
        c: {
          subject: "a price list",
          from: [{ email: "ops@shipper.example" }],
          mailboxIds: { inbox: true },
          bodyStructure: {
            type: "multipart/mixed",
            subParts: [
              { partId: "text", type: "text/plain" },
              { blobId, type, name: "prices.xlsx", disposition: "attachment" },
            ],
          },
          bodyValues: { text: { value: "see the attached list" } },
        },
      },
    },
    [CAPABILITIES.mail],
  );
  const id = created.created?.c?.id;
  assert.ok(id, "the message with its attachment is in the account");

  const read = await callTool<{ readable: boolean; text: string; kind: string }>(
    "mail.readAttachment",
    { id, name: "prices.xlsx" },
  );
  assert.equal(read.readable, true);
  assert.equal(read.kind, "sheet");
  assert.match(read.text, /BK-1,Maersk/, "the spreadsheet's cells are the answer");

  await assert.rejects(
    () => callTool("mail.readAttachment", { id, name: "nobody.xlsx" }),
    /no attachment "nobody.xlsx"/,
    "an attachment the message does not carry is a refusal, not an empty answer",
  );
});

test("the agent saves a file into Files, from an attachment or from a document", async () => {
  /*
   * The bytes, not a transcription: a document the agent was only able to read
   * used to be a document it could not keep — a PDF's text is not the PDF. An
   * attachment is read and written again, because a FileNode holds a whole blob
   * while an attachment's id is only a part of the message's: naming that id
   * left a file of raw message nothing could open. A name already taken gets a
   * numbered one beside it rather than replacing what a person filed.
   */
  const text = "The booking is BK-42, sealed on the second door.";
  const type = "text/plain";
  const blobId = await uploadBlobBytes(
    ctx,
    accountId,
    new TextEncoder().encode(text),
    type,
  );
  const created = await clientOf(ctx).call<{ created?: { c?: { id?: string } } }>(
    "Email/set",
    {
      accountId,
      create: {
        c: {
          subject: "the booking papers",
          from: [{ email: "ops@shipper.example" }],
          mailboxIds: { inbox: true },
          bodyStructure: {
            type: "multipart/mixed",
            subParts: [
              { partId: "body", type: "text/plain" },
              { blobId, type, name: "booking.txt", disposition: "attachment" },
            ],
          },
          bodyValues: { body: { value: "the papers are attached" } },
        },
      },
    },
    [CAPABILITIES.mail],
  );
  const message = created.created?.c?.id;
  assert.ok(message, "the message with its attachment is in the account");

  const saved = await writeTool<{ path: string; from: string; type: string }>(
    "files.save",
    { message, attachment: "booking.txt", path: "Bookings/BK-42.txt" },
  );
  assert.equal(saved.path, "Bookings/BK-42.txt", "the file lands where it was asked");
  assert.equal(saved.from, `${message}/booking.txt`, "and the record names its source");
  const held = await readVisibleFileAt(ctx, accountId, "Bookings/BK-42.txt");
  assert.equal(held?.text, text, "the bytes are the attachment's, never a transcription");
  assert.equal(held?.file.type, type, "with the type it arrived with");

  const again = await writeTool<{ path: string }>("files.save", {
    message,
    attachment: "booking.txt",
    path: "Bookings/BK-42.txt",
  });
  assert.equal(
    again.path,
    "Bookings/2-BK-42.txt",
    "a name already taken gets a numbered one beside it, never a replaced file",
  );

  const copied = await writeTool<{ path: string }>("files.save", {
    from: "Bookings/BK-42.txt",
    path: "Archive/booking.txt",
  });
  assert.equal(
    copied.path,
    "Archive/booking.txt",
    "a document already in Files is copied",
  );
  assert.equal(
    (await readVisibleFileAt(ctx, accountId, "Archive/booking.txt"))?.text,
    text,
    "with its bytes",
  );

  await assert.rejects(
    () => writeTool("files.save", { message, attachment: "nobody.txt", path: "x.txt" }),
    /no attachment "nobody.txt"/,
    "an attachment the message does not carry is a refusal",
  );
  await assert.rejects(
    () => writeTool("files.save", { path: "x.txt" }),
    /A source is needed/,
    "a save with no source is refused rather than made empty",
  );
  await assert.rejects(
    () =>
      writeTool("files.save", {
        from: "Bookings/BK-42.txt",
        message,
        attachment: "booking.txt",
        path: "x.txt",
      }),
    /One source/,
    "and one save names one source",
  );
});

test("a picture is read by the model's eyes when the caller has them, and says so when it has not", async () => {
  /*
   * A scan or a photograph has no text a reader can take (ADR 0038): the model
   * transcribes it, and only a caller holding the model's eyes can ask. That is
   * the two halves pinned here — the answer when the eyes are there, and the
   * honest refusal when they are not, never the bytes.
   */
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeBytesIntoVisibleFolder(
    ctx,
    accountId,
    "Documents",
    "scan.png",
    png,
    "image/png",
  );

  const blind = (await runTool(
    READING_TOOLS,
    { ctx, accountId, run: plainRun() },
    "files.read",
    { path: "Documents/scan.png" },
  )) as { readable: boolean; problem?: string };
  assert.equal(
    blind.readable,
    false,
    "a caller without the model's eyes cannot read a picture",
  );
  assert.match(blind.problem ?? "", /cannot look at an image/);

  const seenImage: Array<{ type: string; data: Uint8Array }> = [];
  const read = (await runTool(
    READING_TOOLS,
    {
      ctx,
      accountId,
      run: plainRun(),
      readImage: async (image) => {
        seenImage.push(image);
        return { text: "Booking 4417 confirmed" };
      },
    },
    "files.read",
    { path: "Documents/scan.png" },
  )) as { readable: boolean; text?: string };
  assert.equal(read.readable, true);
  assert.equal(read.text, "Booking 4417 confirmed");
  assert.equal(seenImage[0]?.type, "image/png", "the file's own type travels with it");
  assert.equal(seenImage[0]?.data.length, png.length, "and its bytes");
});

test("a picture the sender labelled octet-stream is read as the JPEG it is", async () => {
  /*
   * The live failure this pins: a WhatsApp pack labelled every `.jpeg`
   * `application/octet-stream`, the provider refused each one as an unsupported
   * image, and the agent reported ten times that it could not see them.
   */
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  await writeBytesIntoVisibleFolder(
    ctx,
    accountId,
    "Documents",
    "WhatsApp Image 09.31.57.jpeg",
    jpeg,
    "application/octet-stream",
  );
  const seen: Array<{ type: string; data: Uint8Array }> = [];
  const read = (await runTool(
    READING_TOOLS,
    {
      ctx,
      accountId,
      run: plainRun(),
      readImage: async (image) => {
        seen.push(image);
        return { text: "seal 005073" };
      },
    },
    "files.read",
    { path: "Documents/WhatsApp Image 09.31.57.jpeg" },
  )) as { readable: boolean; text?: string };
  assert.equal(read.readable, true);
  assert.equal(read.text, "seal 005073");
  assert.equal(seen[0]?.type, "image/jpeg", "the bytes' own type reaches the model");
});

test("a picture in a format the model does not take is refused without a call", async () => {
  const bmp = new Uint8Array([0x42, 0x4d, 0x00, 0x00]);
  await writeBytesIntoVisibleFolder(
    ctx,
    accountId,
    "Documents",
    "photo.bmp",
    bmp,
    "application/octet-stream",
  );
  let asked = 0;
  const read = (await runTool(
    READING_TOOLS,
    {
      ctx,
      accountId,
      run: plainRun(),
      readImage: async () => {
        asked += 1;
        return { text: "" };
      },
    },
    "files.read",
    { path: "Documents/photo.bmp" },
  )) as { readable: boolean; problem?: string };
  assert.equal(read.readable, false);
  assert.match(read.problem ?? "", /not a format/);
  assert.equal(asked, 0, "the provider is not asked to refuse it");
});

test("a reply is drafted into the group's Drafts, addressed and threaded, and nothing is sent", async () => {
  /*
   * Drafting is the one mail write this catalogue takes without a person's word
   * (ADR 0028, `reversible`): it puts a message where somebody reads it and
   * sends nothing. Both halves are pinned here — the draft is in the account's
   * Drafts, marked `$draft`, addressed to the sender and carrying the thread,
   * and the submission methods were never called.
   */
  const delivered = await clientOf(ctx).call<{ created?: { c?: { id?: string } } }>(
    "Email/set",
    {
      accountId,
      create: {
        c: {
          subject: "Re: booking 4417",
          from: [{ email: "ops@shipper.example" }],
          to: [{ email: "demo@example.com" }, { email: "finance@shipper.example" }],
          cc: [{ email: "ops@shipper.example" }],
          references: ["earlier@shipper.example"],
          mailboxIds: { inbox: true },
        },
      },
    },
    [CAPABILITIES.mail],
  );
  const id = delivered.created?.c?.id;
  assert.ok(id, "the message to reply to is in the account");

  const submissions = mock.methodCalls["EmailSubmission/set"] ?? 0;
  const draft = await writeTool<{
    id: string;
    to: string[];
    cc: string[];
    subject: string;
    folder: string;
  }>("mail.draft", { id, text: "Booked on the 14th; the papers follow." });
  /*
   * Reply to all, which is the only reply the agent drafts: the sender answers
   * in To, and the people the message also reached are in Cc — with the
   * account's own address taken out of both and the sender not repeated in Cc.
   */
  assert.deepEqual(draft.to, ["ops@shipper.example"], "the sender answers in To");
  assert.deepEqual(
    draft.cc,
    ["finance@shipper.example"],
    "and the other recipient is in Cc, once",
  );
  assert.equal(
    draft.subject,
    "Re: booking 4417",
    "the thread's subject is kept rather than prefixed a second time",
  );
  assert.equal(draft.folder, "Drafts", "and it is filed in the account's Drafts");
  assert.equal(
    mock.methodCalls["EmailSubmission/set"] ?? 0,
    submissions,
    "nothing was sent: a draft is a message a person still has to send",
  );

  const held = await clientOf(ctx).call<{
    list?: Array<{
      mailboxIds?: Record<string, boolean>;
      keywords?: Record<string, boolean>;
      inReplyTo?: string[];
      references?: string[];
      to?: Array<{ email?: string }>;
      cc?: Array<{ email?: string }>;
      from?: Array<{ email?: string }>;
      bodyValues?: Record<string, { value?: string }>;
    }>;
  }>(
    "Email/get",
    {
      accountId,
      ids: [draft.id],
      properties: [
        "mailboxIds",
        "keywords",
        "inReplyTo",
        "references",
        "from",
        "to",
        "cc",
        "bodyValues",
      ],
    },
    [CAPABILITIES.mail],
  );
  const written = held.list?.[0];
  assert.ok(written, "the draft is in the account");
  assert.deepEqual(
    written.to,
    [{ email: "ops@shipper.example" }],
    "the draft carries the To it was created with",
  );
  assert.deepEqual(
    written.cc,
    [{ email: "finance@shipper.example" }],
    "and the Cc reply-all adds",
  );
  /*
   * A message's own id, as the account stores it: JMAP's `messageId` is a list,
   * and the mock makes it from the node's id, so the test reads it rather than
   * spelling one the server would not have written.
   */
  const answered = await clientOf(ctx).call<{
    list?: Array<{ messageId?: string[] }>;
  }>("Email/get", { accountId, ids: [id], properties: ["messageId"] }, [
    CAPABILITIES.mail,
  ]);
  const messageId = answered.list?.[0]?.messageId?.[0];
  assert.ok(messageId, "the message names itself");
  assert.deepEqual(written.inReplyTo, [messageId], "carrying the message it answers");
  assert.deepEqual(
    written.references,
    ["earlier@shipper.example", messageId],
    "and the thread before it",
  );
  assert.equal(written.keywords?.$draft, true, "marked a draft, never a sent message");
  const identity = await clientOf(ctx).call<{ list?: Array<{ email?: string }> }>(
    "Identity/get",
    { accountId, ids: null },
    [CAPABILITIES.mail, CAPABILITIES.submission],
  );
  assert.equal(
    written.from?.[0]?.email,
    identity.list?.[0]?.email,
    "from the account's own sending identity",
  );
  assert.equal(
    written.bodyValues?.text?.value,
    "Booked on the 14th; the papers follow.",
    "with the words the model wrote",
  );

  const boxes = await clientOf(ctx).call<{
    list?: Array<{ id?: string; role?: string }>;
  }>("Mailbox/get", { accountId, ids: null, properties: ["id", "role"] }, [
    CAPABILITIES.mail,
  ]);
  const drafts = boxes.list?.find((one) => one.role === "drafts")?.id;
  assert.ok(drafts, "the account has a Drafts folder");
  assert.deepEqual(
    written.mailboxIds,
    { [drafts]: true },
    "and the draft is in it and nowhere else",
  );
});

test("the agent settles a step of its group's workorder and signs it as the agent", async () => {
  /*
   * A step the agent settles goes through the same writer a person's check does
   * (`applyStep` in `workorderAdmin.ts`), so the same terminal refusal and the
   * same gate latch apply; what is different is the signature, which says the
   * agent did it and not a person (ADR 0024).
   */
  const at = new Date().toISOString();
  const uid = "wo-settle";
  await writeAppFileAt(
    ctx,
    accountId,
    `workorders/${uid}.json`,
    buildWorkorderDoc({
      uid,
      name: "Booking 2",
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

  const settled = await writeTool<{ state: string; by: string }>("workorder.settle", {
    uid,
    path: "intake.confirm",
    state: "done",
    note: "the booking is confirmed",
  });
  assert.equal(settled.state, "done");
  assert.equal(settled.by, "gilbert-agent", "the step says the agent settled it");

  const stored = JSON.parse(
    (await readAppFileAt(ctx, accountId, `workorders/${uid}.json`))?.text ?? "{}",
  ) as {
    checklist?: {
      steps?: Array<{ path?: string; state?: string; by?: string; note?: string }>;
    };
    updated?: { by?: string };
  };
  const step = stored.checklist?.steps?.find((one) => one.path === "intake.confirm");
  assert.equal(step?.state, "done", "the step is settled on the document");
  assert.equal(step?.by, "gilbert-agent", "with the agent's own signature");
  assert.equal(step?.note, "the booking is confirmed", "and the note the model gave");
  assert.equal(
    stored.updated?.by,
    "gilbert-agent",
    "the document says who last wrote it",
  );

  // A step that is not there is refused rather than invented, and the refusal
  // names the paths the checklist does hold: the corrected path is in the
  // answer, so the next step is a settle rather than a read.
  await assert.rejects(
    () => writeTool("workorder.settle", { uid, path: "intake.unknown", state: "done" }),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes('no step "intake.unknown"') &&
      err.message.includes("intake.confirm"),
    "a path the checklist does not hold is a refusal that names the steps it has",
  );

  /*
   * A closed workorder is the record of the work and keeps still: the state is
   * the root's, and the part this account holds carries none, so the rule is
   * read from the root before the write.
   */
  await writeAppFileAt(
    ctx,
    accountId,
    `workorders/wo-closed.json`,
    buildWorkorderDoc({
      uid: "wo-closed",
      name: "Booking 4",
      state: "completed",
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
  await assert.rejects(
    () =>
      writeTool("workorder.settle", {
        uid: "wo-closed",
        path: "intake.confirm",
        state: "done",
      }),
    /closed, so its checklist no longer changes/,
    "a closed workorder is not settled, however it is reached",
  );
});

test("the agent proposes a page's change into its draft, and nothing is in force", async () => {
  /*
   * A proposal is the draft: the page's own documents keep their tags and
   * checklist, the words the model wrote become the body, and approval — a
   * person's, ADR 0020 — is what would put anything in force.
   */
  const title = "Our intake";
  const before = "When a booking arrives, answer within a day.";
  await writeAppFileAt(
    ctx,
    accountId,
    `knowledge/${knowledgeFolderName(title)}/draft.json`,
    buildDraft({
      id: "k-propose",
      title,
      tags: ["intake"],
      blocks: blocksFromText(before),
      text: before,
      by: "a@example.com",
      at: new Date().toISOString(),
    }),
  );

  const proposed = await writeTool<{ title: string; revision: number | null }>(
    "knowledge.propose",
    { title, text: "Answer within two hours, and name the booking." },
  );
  assert.equal(proposed.title, title, "the page keeps its title");
  assert.equal(proposed.revision, null, "nothing is in force: a proposal is the draft");

  const page = await callTool<{ text: string; tags: string[] }>("knowledge.read", {
    title,
  });
  assert.equal(page.text, "Answer within two hours, and name the booking.");
  assert.deepEqual(page.tags, ["intake"], "the page's own tags are kept");

  await assert.rejects(
    () => writeTool("knowledge.propose", { title: "A page nobody wrote", text: "…" }),
    /no knowledge page/,
    "a page that is not there is not proposed to",
  );
});

test("the agent finds the workorders its account holds a part of, and reads one by uid", async () => {
  /*
   * What a group holds is a **part** — its own steps — and the name and the
   * state live on the Master's root. The listing is what tells an agent woken by
   * anything else that there is work at all, and the uid is what the read and the
   * settle take; the open count is what says whether the work is done.
   */
  const at = new Date().toISOString();
  const uid = "wo-list";
  await writeAppFileAt(
    ctx,
    accountId,
    `workorders/${uid}.json`,
    buildWorkorderDoc({
      uid,
      name: "Booking 3",
      state: "running",
      by: "a@example.com",
      at,
      checklist: buildChecklist({
        template: { accountId, id: "template-1", revision: "rev-1" },
        variants: {},
        items: {},
        stepPaths: ["intake.confirm", "intake.file"],
      }),
    }),
  );

  const listed = await callTool<{
    workorders: Array<{
      uid: string;
      name: string | null;
      state: string | null;
      open: number;
      steps: number;
    }>;
    truncated: boolean;
  }>("workorder.list", {});
  const row = listed.workorders.find((one) => one.uid === uid);
  assert.equal(row?.name, "Booking 3", "the listing names the workorder");
  assert.equal(row?.state, "running", "and says whether it is still worked");
  assert.equal(row?.open, 2, "and how much of this account's part is open");
  assert.equal(row?.steps, 2);
  assert.equal(listed.truncated, false, "a listing that fits says so");

  const read = await callTool<{
    name: string | null;
    state: string | null;
    steps: Array<{ path: string }>;
  }>("workorder.read", { uid });
  assert.equal(read.name, "Booking 3", "a read answers the workorder's own name");
  assert.equal(read.state, "running", "and its state");
  assert.equal(read.steps.length, 2, "with the steps this account holds");

  const limited = await callTool<{
    workorders: unknown[];
    total: number;
    truncated: boolean;
  }>("workorder.list", { limit: 1 });
  assert.equal(limited.workorders.length, 1, "the page is the limit it was asked for");
  assert.ok(limited.total >= 2, "and the answer says how much there is");
  assert.equal(limited.truncated, true, "and that the page is not the whole");

  await assert.rejects(
    () => callTool("workorder.read", { uid: "no-such-workorder" }),
    /no workorder "no-such-workorder"/,
    "an uid the account does not hold is a refusal, not an empty read",
  );
});

/**
 * A step's path is its identity and its label is the words a reader sees; the
 * words live in the template's revision, never in the part. An agent handed only
 * `intake.confirm` reasons about a path; one handed "Confirm the booking" knows
 * what it is settling — and the path is still there for the call.
 */
test("a workorder's steps carry the template's words beside their paths", async () => {
  const { buildRevision, buildState } = await import("../shared/knowledge.js");
  const at = new Date().toISOString();
  const templateId = "template-labels";
  const revision = "rev-labels";
  const checklist = {
    variants: [],
    sections: [
      {
        key: "intake",
        label: "Intake",
        group: accountId,
        steps: [{ key: "confirm", label: "Confirm the booking" }],
      },
    ],
  };
  const draft = buildDraft({
    id: templateId,
    title: "Intake template",
    tags: [],
    blocks: [],
    text: "",
    checklist,
    by: "a@example.com",
    at,
  });
  await writeAppFileAt(
    ctx,
    accountId,
    `knowledge/Intake template/state.json`,
    buildState({
      id: templateId,
      title: "Intake template",
      tags: [],
      by: "a@example.com",
      at,
      created: draft.created,
    }),
  );
  await writeAppFileAt(
    ctx,
    accountId,
    `knowledge/Intake template/revisions/${revision}.json`,
    buildRevision(draft, {
      revision,
      rev: 1,
      approvedBy: "a@example.com",
      approvedAt: at,
      effectiveAt: at,
      supersedes: null,
    }),
  );

  const uid = "wo-labels";
  await writeAppFileAt(
    ctx,
    accountId,
    `workorders/${uid}.json`,
    buildWorkorderDoc({
      uid,
      by: "a@example.com",
      at,
      checklist: buildChecklist({
        template: { accountId, id: templateId, revision },
        variants: {},
        items: {},
        stepPaths: ["intake.confirm"],
      }),
    }),
  );

  const read = await callTool<{ steps: Array<{ path: string; label: string }> }>(
    "workorder.read",
    { uid },
  );
  const step = read.steps.find((one) => one.path === "intake.confirm");
  assert.equal(step?.label, "Confirm the booking", "the words come from the template");
});

/**
 * The base can be paged and searched: a listing that answered `truncated` has an
 * `offset` that reaches the rest, and a subject is found by the words of the
 * pages rather than by listing them and reading them one at a time.
 */ test("several objects are opened by one call, and the answer says when it was cut", async () => {
  /*
   * R4's proof: a set of four known objects is opened by **one** call. The reading
   * values take `ids`, the job runs the endpoint once per id, and the answer is a list
   * with the count — bounded, and saying so when the call named more than it carries.
   */
  const ids: string[] = [];
  for (const text of ["first of the set", "second of the set", "third", "fourth"]) {
    const said = await writeTool<{ id: string }>("chat.say", { text });
    ids.push(said.id);
  }

  const opened = await callTool<{
    items: Array<{ message: { text: string } }>;
    total: number;
    truncated: boolean;
  }>("chat.read", { ids });

  assert.equal(opened.total, 4, "four objects, one call");
  assert.deepEqual(
    opened.items.map((one) => one.message.text),
    ["first of the set", "second of the set", "third", "fourth"],
    "each answer is the endpoint's own",
  );
  assert.equal(opened.truncated, false, "and nothing was left out");

  await assert.rejects(
    () => callTool("chat.read", { ids: [] }),
    /needs at least one id/,
    "a set that names nothing is refused, rather than answered empty",
  );
});

test("a brief with no model to read with says so, rather than hanging", async () => {
  /*
   * The reader is one model call in the account's own context (R2): with no model
   * there is nothing to read with, and the turn is told that instead of waiting for an
   * answer nobody was asked for. The tool writes nothing and spends no step.
   */
  const brief = TOOLS.find((tool) => tool.name === "open");
  assert.ok(brief);
  assert.ok(
    (brief.args.what?.values ?? []).includes("brief"),
    "the reading verb carries the reader",
  );
  await assert.rejects(
    () => callTool("open", { what: "brief", question: "What does the thread say?" }),
    /no model/i,
    "a brief without a model is refused, in the reader's own words",
  );
});

test("a message is printed as a real PDF in Files, and reads back", async () => {
  /*
   * The capability the agent lacked (ADR 0038): a mail as a page, filed where the
   * call names. The file is read back through `files.read`, which reads a PDF's text
   * layer — so the assertion is that a reader of the document gets the message, not
   * that some bytes were written.
   */
  const delivered = await clientOf(ctx).call<{ created?: { c?: { id?: string } } }>(
    "Email/set",
    {
      accountId,
      create: {
        c: {
          subject: "Booking 4417",
          from: [{ email: "ops@shipper.example" }],
          to: [{ email: "demo@example.com" }],
          mailboxIds: { inbox: true },
          bodyStructure: { partId: "text", type: "text/plain" },
          bodyValues: { text: { value: "Confermato: due container, Anversa." } },
        },
      },
    },
    [CAPABILITIES.mail],
  );
  const id = delivered.created?.c?.id;
  assert.ok(id, "the message to print is in the account");
  const printed = await writeTool<{ path: string; bytes: number }>("mail.print", {
    id,
    path: "Prints/booking-4417",
  });
  assert.equal(
    printed.path,
    "Prints/booking-4417.pdf",
    "the extension follows the format the tool prints",
  );
  assert.ok(printed.bytes > 0, "and the file carries the page");
  const read = await callTool<{ text?: string }>("files.read", { path: printed.path });
  assert.match(read.text ?? "", /Booking 4417/, "the page carries the subject");
  assert.match(read.text ?? "", /Confermato/, "and the message's words");
  await assert.rejects(
    () => writeTool("mail.print", { id, path: printed.path }),
    /already holds a document/,
    "a path already taken is refused, like every new document",
  );
});

test("the base is paged by offset and searched by the words of its pages", async () => {
  // Its own page, with words no other fixture carries: a search that leans on
  // another test's fixture is a test that reads the file's order.
  const title = "Searchable note";
  const body = "The customs seal goes on the second door of the container.";
  await writeAppFileAt(
    ctx,
    accountId,
    `knowledge/${knowledgeFolderName(title)}/draft.json`,
    buildDraft({
      id: "k-search",
      title,
      tags: [],
      blocks: blocksFromText(body),
      text: body,
      by: "a@example.com",
      at: new Date().toISOString(),
    }),
  );

  const first = await callTool<{
    pages: Array<{ folder: string }>;
    total: number;
    truncated: boolean;
  }>("knowledge.list", { limit: 2 });
  const next = await callTool<{ pages: Array<{ folder: string }>; truncated: boolean }>(
    "knowledge.list",
    { limit: 2, offset: 2 },
  );
  assert.equal(first.pages.length, 2, "a page is the limit it was asked for");
  assert.notDeepEqual(
    next.pages.map((one) => one.folder),
    first.pages.map((one) => one.folder),
    "and offset reads on rather than answering the same page",
  );
  assert.equal(
    next.truncated,
    first.total > 4,
    "the answer says whether there is a page after this one",
  );

  const found = await callTool<{
    pages: Array<{ folder: string; title: string; snippet?: string }>;
    total: number;
  }>("knowledge.search", { query: "customs seal" });
  const page = found.pages.find((one) => one.folder === title);
  assert.ok(page, "the page whose words name the subject is found");
  assert.match(
    page?.snippet ?? "",
    /customs seal/,
    "and the answer carries the line the words sit in",
  );
  assert.equal(found.total, 1, "with how many matched");

  const none = await callTool<{ pages: unknown[] }>("knowledge.search", {
    query: "nothing in this base says this",
  });
  assert.equal(none.pages.length, 0, "and nothing is found when nothing matches");
});

/**
 * A page inside a topic folder is named by its folder, not by its title: the
 * listing answers the path, and the tree walks it segment by segment. Read by
 * title, the page under `Policies` answers no page at all — the folder is the
 * page's own identity.
 */
test("a page inside a topic folder is read by the folder the listing answers", async () => {
  const title = "Returns";
  const body = "A return is booked against its original order.";
  await writeAppFileAt(
    ctx,
    accountId,
    `knowledge/Policies/${knowledgeFolderName(title)}/draft.json`,
    buildDraft({
      id: "k-nested",
      title,
      tags: ["policy"],
      blocks: blocksFromText(body),
      text: body,
      by: "a@example.com",
      at: new Date().toISOString(),
    }),
  );

  const listed = await callTool<{
    pages: Array<{ title: string; folder: string }>;
  }>("knowledge.list", {});
  const page = listed.pages.find((one) => one.title === title);
  assert.equal(page?.folder, "Policies/Returns", "the listing names the path");

  const read = await callTool<{ text: string; folder: string }>("knowledge.read", {
    folder: page?.folder,
  });
  assert.equal(read.text, body, "and the path reads the page");
  assert.equal(read.folder, "Policies/Returns");

  await assert.rejects(
    () => callTool("knowledge.read", { title }),
    /no knowledge page/,
    "the bare title does not reach a page that lives in a topic folder",
  );
});

/**
 * A page is a controlled document and can be long, and the answer travels into
 * a prompt paid for by the token: the read bounds its own text and says how
 * much there is, so `offset` reaches the rest — rather than the prompt cutting
 * the JSON a model then cannot read.
 */
test("a page longer than one read carries is answered in bounded parts", async () => {
  const { KNOWLEDGE_TEXT_MAX } = await import("./tools/knowledge.js");
  const title = "A long procedure";
  const body = "s".repeat(KNOWLEDGE_TEXT_MAX + 100);
  await writeAppFileAt(
    ctx,
    accountId,
    `knowledge/${knowledgeFolderName(title)}/draft.json`,
    buildDraft({
      id: "k-long",
      title,
      tags: [],
      blocks: blocksFromText(body),
      text: body,
      by: "a@example.com",
      at: new Date().toISOString(),
    }),
  );

  const first = await callTool<{
    text: string;
    textLength: number;
    offset: number;
    truncated: boolean;
  }>("knowledge.read", { title });
  assert.equal(first.text.length, KNOWLEDGE_TEXT_MAX, "one read carries its bound");
  assert.equal(first.textLength, body.length, "and says how long the page is");
  assert.equal(first.truncated, true, "and that it is not the whole page");

  const rest = await callTool<{ text: string; truncated: boolean }>("knowledge.read", {
    title,
    offset: KNOWLEDGE_TEXT_MAX,
  });
  assert.equal(rest.text, body.slice(KNOWLEDGE_TEXT_MAX), "offset reads on");
  assert.equal(rest.truncated, false, "and the last part says it is the last");
});
