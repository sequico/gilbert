/**
 * The agent's tools (ADR 0031) — the shape, the guard, and both halves.
 *
 * Six properties are pinned here, and each of them is a mechanism rather than a
 * run of the code: a tool's arguments are validated **before** its executor
 * runs, a tool that writes is unreachable through the reading half, every
 * surface has a reading tool that reaches it, the guard asks the authority class
 * the tool **declares** and the act that authority is for, a read spends nothing
 * of the run's budget, and a question leaves the run waiting on a person with no
 * date. Beside them is the one write that leaves the group's account entirely —
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
import type { RunDoc, RunWait } from "../shared/run.js";
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
const { MEMORY_FACT_MAX, MEMORY_VERSION, parseFactDocumentDetailed } = await import(
  "../shared/memory.js"
);
const { spendRun, startRun, takeAuthorisation } = await import("../shared/run.js");
const { buildChecklist, buildWorkorderDoc } = await import("../shared/workorder.js");
const { createRun } = await import("./runs.js");
const { factPath, listFacts } = await import("./memory.js");
const {
  defineTool,
  mayRun,
  READING_TOOLS,
  readingTools,
  readMessageForAnswer,
  runTool,
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
  // (ADR 0037), so the one write that reaches it is against this reading.
  return (await runTool(
    TOOLS,
    {
      ctx,
      accountId,
      run: plainRun(),
      memory: await listFacts(ctx, accountId),
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
  // budget, which is what makes reading free and acting cost.
  const writers = TOOLS.filter((tool) => tool.writes);
  assert.ok(writers.length > 0, "the catalogue has acts that change the account");
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

test("every surface the agent works on has a reading tool that reaches it", () => {
  const doors: Record<string, readonly string[]> = {
    chat: ["chat.read", "chat.find"],
    mail: ["mail.find", "mail.read", "mail.folders"],
    kb: ["knowledge.read"],
    workorder: ["workorder.read"],
    runs: ["run.read"],
    files: ["files.list", "files.read"],
    calendar: ["calendar.list", "calendar.find", "calendar.read"],
  };
  for (const [surface, names] of Object.entries(doors)) {
    assert.ok(
      names.some((name) => READING_TOOLS.some((tool) => tool.name === name)),
      `the ${surface} surface has a reading tool that reaches it`,
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

test("a mail answer is its sender's word only on the server's record of the submission", async () => {
  const created = await clientOf(ctx).call<{ created?: { c?: { id?: string } } }>(
    "Email/set",
    {
      accountId,
      create: {
        c: {
          subject: "Re: something",
          from: [{ email: "person@example.org" }],
          mailboxIds: { inbox: true },
          bodyStructure: { partId: "text", type: "text/plain" },
          bodyValues: { text: { value: "yes" } },
        },
      },
    },
    [CAPABILITIES.mail],
  );
  const id = created.created?.c?.id;
  assert.ok(id, "the mock created the reply");
  const asker = { own: ctx.username, known: ["person@example.org"] };

  const noRecord = await readMessageForAnswer(ctx, accountId, id, asker);
  assert.equal(noRecord?.word, false, "no arrival record is nobody's word");

  await clientOf(ctx).call(
    "Email/set",
    {
      accountId,
      update: {
        [id]: {
          "header:Received:asText:all": [
            "from [10.0.0.9] (localhost [127.0.0.1]) by mx.example.org with ESMTPSA id x1 (Authenticated sender: person@example.org)",
          ],
        },
      },
    },
    [CAPABILITIES.mail],
  );
  const recorded = await readMessageForAnswer(ctx, accountId, id, asker);
  assert.equal(
    recorded?.word,
    true,
    "the submission names the account, which is the sender",
  );
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

test("a rule that declares it sends is the authority an outward act asks for", () => {
  /*
   * ADR 0032's class 3, carried by a rule (ADR 0035): the group wrote the rule,
   * its instruction says what to send, and the declaration travels on the run
   * that rule opened. It answers for outward acts and nothing else.
   */
  const send = TOOLS.find((tool) => tool.name === "mail.send");
  assert.ok(send, "the catalogue sends mail");
  const args = { to: "shipper@example.org", subject: "Booking 4417", text: "Confirmed." };

  const sending = startRun({
    id: "sending",
    startedBy: {
      rule: "shipper",
      instruction: null,
      woke: "mail created: m-1",
      sends: true,
    },
  });
  assert.equal(mayRun(send, sending, args), true, "the rule's declaration is enough");

  const quiet = startRun({
    id: "quiet",
    startedBy: { rule: "shipper", instruction: null, woke: "mail created: m-1" },
  });
  assert.equal(
    mayRun(send, quiet, args),
    false,
    "a rule that says nothing sends nothing",
  );
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

test("the calendar is read and changed through its own tools", async () => {
  const listed = await callTool<{
    calendars: Array<{ id: string; name: string; mayWrite: boolean }>;
  }>("calendar.list", {});
  const personal = listed.calendars.find((one) => one.name === "Personal");
  assert.ok(personal?.mayWrite, "the account's own calendar is writable");

  const created = await writeTool<{ id: string }>("calendar.save", {
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

  await writeTool("calendar.save", {
    id: created.id,
    title: "Container 12 has arrived",
  });
  const changed = await callTool<{ event: Record<string, unknown> }>("calendar.read", {
    id: created.id,
  });
  assert.equal(changed.event.title, "Container 12 has arrived");

  await writeTool("calendar.delete", { id: created.id });
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
  const edited = await writeTool<{ id: string; replaced: string }>("mail.editDraft", {
    id: draft.id,
    text: "second words",
    subject: "Re: an answer",
  });
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
  const asked = await writeTool<{ id: string }>("chat.ask", {
    text: "Is @sq@greensley.company happy with that?",
  });
  const question = await callTool<{ message: { text: string } }>("chat.read", {
    id: asked.id,
  });
  assert.equal(question.message.text, "Is @sq happy with that?");
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
    "the agent writes as itself (ADR 0033)",
  );

  const question = "@sam@example.com is the delivery confirmed?";
  const asked = await writeTool<{ id: string; wait: RunWait }>("chat.ask", {
    text: question,
  });
  assert.deepEqual(
    asked.wait,
    {
      // A mention is the local part, as the conversation reads it; the wait
      // carries the question exactly as it was written.
      what: "@sam is the delivery confirmed?",
      asked: { channel: "chat", id: asked.id },
      until: null,
    },
    "a question is a run waiting on a person, with no date (ADR 0034)",
  );
  const askedBack = await writeTool<{ message: { text: string } }>("chat.read", {
    id: asked.id,
  });
  assert.equal(
    askedBack.message.text,
    "@sam is the delivery confirmed?",
    "and the question is in the conversation, the mention by its local part",
  );
});

test("the memory tool records a fact where the installation keeps them", async () => {
  // The one tool that writes outside the group's account (ADR 0037): the fact
  // lands in the Master's own memory, and the whole store reads it back.
  const recorded = await writeTool<{ id: string; subject: string }>("memory.remember", {
    subject: "Bologna Express",
    fact: "the shipper the office books containers with",
    standing: true,
  });
  assert.equal(recorded.subject, "Bologna Express");
  const sheet = await readAppFileAt(ctx, accountId, factPath(recorded.id));
  assert.ok(sheet, "the fact is one sheet in the memory");
  const parsed = parseFactDocumentDetailed(sheet.text);
  assert.ok("fact" in parsed, "and it is the shape this build writes");
  assert.deepEqual(
    parsed.fact.origin,
    { by: "run", run: "r1" },
    "with the run that recorded it",
  );
  assert.equal(parsed.fact.standing, true, "and what the group keeps standing");
  assert.equal(
    parsed.fact.group,
    accountId,
    "and the group it is about: the account the run lives in (ADR 0037)",
  );
  assert.ok(
    (await listFacts(ctx, accountId)).facts.some((fact) => fact.id === recorded.id),
    "the store answers the whole memory, so a selection can be made from it",
  );

  // A fact a person wrote is in force: the tool writes the agent's conclusion
  // beside it as a proposal and says so, and the person's sentence is untouched.
  await writeAppFileAt(ctx, accountId, factPath("person-2"), {
    v: MEMORY_VERSION,
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
    "the sheet keeps its sentence",
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
      writeTool("memory.remember", { subject: "shipper", fact: "y", standing: "yes" }),
    /"standing" must be true or false/,
  );
  await assert.rejects(
    () => writeTool("memory.remember", { subject: "", fact: "y" }),
    /"subject" must be text/,
  );
  await assert.rejects(
    // A subject shorter than a few characters is one nearly every change
    // carries, so the catalogue refuses it where the write is asked for
    // (`subjectProblem`, ADR 0037).
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

  for (const id of [recorded.id, "person-2"]) {
    const found = await readAppFileAt(ctx, accountId, factPath(id));
    const nodeId = found?.file.id;
    if (typeof nodeId === "string") await destroyAppNode(ctx, accountId, nodeId, {});
  }
});

test("a message outward is refused until a person's words license exactly it", async () => {
  /*
   * The act that reaches somebody (ADR 0032, class 3). The guard asks for a word
   * bound to the act — the address and the words — and a word for one message
   * reaches no other, which is what `mail.send`'s `act` declares.
   */
  const submissions = mock.methodCalls["EmailSubmission/set"] ?? 0;
  await assert.rejects(
    () =>
      writeTool("mail.send", {
        to: "ops@shipper.example",
        subject: "the slot",
        text: "the slot is Thursday",
      }),
    (err: unknown) => (err as { code?: string }).code === "needs_authority",
    "with no word, nothing leaves",
  );
  assert.equal(
    mock.methodCalls["EmailSubmission/set"] ?? 0,
    submissions,
    "and no submission was made",
  );

  const authorised = takeAuthorisation(plainRun(), {
    what: "yes, tell the shipper the slot is Thursday",
    authority: "outward",
    act: { target: "ops@shipper.example", content: "the slot is Thursday" },
    by: "sam@example.org",
    at: new Date().toISOString(),
    from: { channel: "chat", id: "m-1" },
  });
  const sent = (await runTool(
    TOOLS,
    { ctx, accountId, run: authorised, memory: await listFacts(ctx, accountId) },
    "mail.send",
    { to: "ops@shipper.example", subject: "the slot", text: "the slot is Thursday" },
  )) as { id: string; to: string };
  assert.equal(sent.to, "ops@shipper.example");
  assert.ok(sent.id, "the message is written and submitted");
  assert.ok(
    (mock.methodCalls["EmailSubmission/set"] ?? 0) > submissions,
    "and the mail server was asked to send it",
  );

  await assert.rejects(
    () =>
      runTool(
        TOOLS,
        { ctx, accountId, run: authorised, memory: undefined },
        "mail.send",
        {
          to: "ops@shipper.example",
          subject: "the slot",
          text: "a different message for the same address",
        },
      ),
    (err: unknown) => (err as { code?: string }).code === "needs_authority",
    "the same address with other words is another act, and is refused",
  );
});

test("an attachment of a message is read inside, by the same reader as a document in Files", async () => {
  /*
   * The document that matters usually arrives attached: a purchase order, a
   * price list. Nothing is downloaded to disk and nothing is asked of the
   * browser — the blob is read through the same format readers a file in Files
   * goes through (ADR 0031).
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

test("a picture is read by the model's eyes when the caller has them, and says so when it has not", async () => {
  /*
   * A scan or a photograph has no text a reader can take (ADR 0031): the model
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

test("a reply is drafted into the group's Drafts, addressed and threaded, and nothing is sent", async () => {
  /*
   * Drafting is the one mail write this catalogue takes without a person's word
   * (ADR 0032, `reversible`): it puts a message where somebody reads it and
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
   * agent did it and not a person (ADR 0028).
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

  // A step that is not there is refused rather than invented.
  await assert.rejects(
    () => writeTool("workorder.settle", { uid, path: "intake.unknown", state: "done" }),
    /no step "intake.unknown"/,
    "a path the checklist does not hold is a refusal",
  );
});

test("the agent proposes a page's change into its draft, and nothing is in force", async () => {
  /*
   * A proposal is the draft: the page's own documents keep their tags and
   * checklist, the words the model wrote become the body, and approval — a
   * person's, ADR 0024 — is what would put anything in force.
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
    /no knowledge page titled/,
    "a page that is not there is not proposed to",
  );
});
