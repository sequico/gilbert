/**
 * The model client and the decision turn, against a stub OpenAI-compatible
 * endpoint (ADR 0031).
 *
 * What is asserted here is the contract a turn's answer is read against: the
 * zero-retention opt-out on every request, a JSON answer shape and a ceiling on
 * the answer, and — the parts that matter for what the agent may do — a private
 * provider that the operator has not allowed is refused before the key leaves,
 * an installation with no model is refused in the same coded shape, an answer
 * that is not the demanded shape is refused rather than guessed at, an answer can
 * carry no authority and can name no tool that writes, and the prose a turn
 * carries is the record's three levels in the record's order. Every block of
 * somebody else's text in the prompt — the change, a candidate rule's
 * instruction, a reading — is fenced as data, under a token drawn per call.
 *
 * The four ways a call or a turn can fail without an answer are pinned too: a
 * body that is not JSON, a provider past the call's time bound, a body over the
 * ceiling a call reads, and a turn that has spent all its lookups.
 *
 * The reading tools are real: the turn's lookups run against the mock Stalwart,
 * so "it may look something up" is asked rather than assumed.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";
import type { RuleDoc } from "./rule.js";

const MOCK_PORT = await freePort();
process.env.MOCK_PORT = String(MOCK_PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.APP_SECRET = "test-secret-for-model";

const mock = await import("../mock/index.js");
const { filesAccountId } = await import("../appFolder.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { appendStep, recordStep, startRun } = await import("../shared/run.js");
const { RULE_VERSION } = await import("./rule.js");
const { TOOLS } = await import("./tools.js");
const {
  assertUsableProvider,
  baseUrlProblem,
  callModel,
  chooseStep,
  decideEvent,
  modelAccess,
  ModelError,
  parseAnswerDetailed,
  parseStepAnswerDetailed,
  requireModelAccess,
  MODEL_MAX_OUTPUT_DEFAULT,
  MODEL_RESPONSE_BYTES_MAX,
  OUTCOME_IN_PROMPT_MAX,
} = await import("./model.js");
const { parseInstallationDocumentDetailed } = await import("../shared/installation.js");

/* ------------------------------------------------------------------ */
/* The stub provider                                                   */
/* ------------------------------------------------------------------ */

interface Seen {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

let seen: Seen[] = [];
let answers: string[] = [];
/** A body to answer with verbatim, rather than a chat completion. */
let rawBody: string | null = null;
/** How long the stub waits before answering, so the call's own time bound is asked. */
let answerDelayMs = 0;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const PROVIDER_PORT = await freePort();
const stub = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // A client that has given up is not an error to report: the timeout test
  // below walks away from a request this handler is still holding.
  res.on("error", () => undefined);
  const raw = await readBody(req);
  seen.push({
    url: req.url ?? "",
    headers: req.headers,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  });
  if (answerDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, answerDelayMs));
    if (res.destroyed) return;
  }
  if (rawBody !== null) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(rawBody);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { content: answers.shift() ?? "{}" } }],
    }),
  );
});

/** Answer the next call with this content, as a chat completion carries it. */
function answerWith(value: unknown): void {
  answers.push(JSON.stringify(value));
}

/**
 * The installation's model, as its own document states it: the document is
 * where the choice lives (ADR 0011), and `modelAccess` is the one place it is
 * read.
 */
const installation = parseInstallationDocumentDetailed(
  JSON.stringify({
    agent: {
      provider: {
        provider: "ollama",
        model: "a-small-model",
        baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
        apiKey: "sk-a-key",
      },
    },
    secret: "an-installation-secret-long-enough-to-seal-a-session-with",
  }),
);
assert.ok("doc" in installation, "the installation document under test is readable");
const model = modelAccess(installation.doc, true)?.model;
assert.ok(model, "the document chose a model");

const MESSAGE = (index: number): string => {
  const messages = seen[index]?.body.messages as Array<{ content: string }>;
  return messages[1]?.content ?? "";
};

const SYSTEM = (index: number): string => {
  const messages = seen[index]?.body.messages as Array<{ content: string }>;
  return messages[0]?.content ?? "";
};

const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
let ctx: Ctx;
let accountId: string;

before(async () => {
  await new Promise<void>((resolve) => stub.listen(PROVIDER_PORT, "127.0.0.1", resolve));
  await waitForPort(`http://127.0.0.1:${MOCK_PORT}`, AUTH);
  const session = await fetchUpstreamSession(AUTH, `http://127.0.0.1:${MOCK_PORT}`);
  ctx = { authorization: AUTH, session, username: "demo@example.com" };
  accountId = filesAccountId(ctx);
  assert.ok(accountId, "the demo account owns Files");
});

after(() => {
  stub.close();
  (mock as { server?: { close(): void } }).server?.close();
});

/** Each test starts with no request seen, no answer queued and no stub behaviour set. */
beforeEach(() => {
  seen = [];
  answers = [];
  rawBody = null;
  answerDelayMs = 0;
});

/** The group's rule, and the change in its account that wakes it. */
const shipperRule: RuleDoc = {
  v: RULE_VERSION,
  id: "shipper-answer",
  watches: ["mail"],
  instruction: "A shipper's message is answered within the day.",
  sends: false,
};
const mailEvent = { source: "mail", change: "created", where: "m-1" } as const;

const prose = {
  installation: "Never write as a person.",
  group: "Answer in the group's own language.",
};

function toolCall(): { ctx: Ctx; accountId: string; run: ReturnType<typeof startRun> } {
  return {
    ctx,
    accountId,
    run: startRun({
      id: "r-1",
      startedBy: { rule: "shipper-answer", instruction: null, woke: "mail created: m-1" },
    }),
  };
}

/* ------------------------------------------------------------------ */

test("one call carries the zero-retention opt-out, a JSON answer shape and a ceiling", async () => {
  answerWith({ rules: ["shipper-answer"], facts: { shipper: "Maersk" } });
  const answer = await callModel(
    { model, allowPrivateProvider: true },
    { system: "the group's rules", user: "the change" },
  );
  assert.deepEqual(answer, { rules: ["shipper-answer"], facts: { shipper: "Maersk" } });

  const request = seen[0];
  assert.equal(request?.url, "/v1/chat/completions", "one call, to the chat endpoint");
  assert.equal(
    request?.headers["x-data-opt-out"],
    "true",
    "every request opts out of training",
  );
  assert.equal(request?.headers.authorization, "Bearer sk-a-key", "and carries the key");
  assert.equal(request?.body.temperature, 0);
  assert.deepEqual(request?.body.response_format, { type: "json_object" });
  assert.equal(request?.body.max_tokens, MODEL_MAX_OUTPUT_DEFAULT, "with a ceiling");
});

test("a private provider is refused unless the operator's switch allows it (the key never leaves)", async () => {
  // The address is the one the name answers with, not the name's spelling: a
  // literal, a name that resolves into the network, and a name that resolves to
  // nothing are all refused, while a public literal passes.
  assert.equal(await baseUrlProblem("https://93.184.216.34/v1"), null);
  assert.equal(await baseUrlProblem("http://models.example.com/v1"), "not an https URL");
  assert.equal(await baseUrlProblem("https://localhost/v1"), "a private address");
  assert.equal(await baseUrlProblem("https://[::1]/v1"), "a private address");
  assert.equal(await baseUrlProblem("https://10.0.0.5/v1"), "a private address");
  assert.equal(
    await baseUrlProblem("https://no-such-provider.invalid/v1"),
    "a name that does not resolve",
    '".invalid" is reserved and never resolves',
  );
  assert.equal(await baseUrlProblem("not a url"), "not an absolute URL");

  await assert.rejects(
    () => assertUsableProvider({ model, allowPrivateProvider: false }),
    (err: unknown) => err instanceof ModelError && err.code === "model_address_refused",
    "a model inside the deployment's own network is refused without the operator's word",
  );

  answerWith({ rules: [], facts: {} });
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: false },
        { event: mailEvent, rules: [shipperRule], prose },
        toolCall(),
      ),
    (err: unknown) => err instanceof ModelError && err.code === "model_address_refused",
    "and the decision turn makes no call at all",
  );
  assert.equal(seen.length, 0, "the key never left the process");

  answerWith({ rules: [], facts: {} });
  await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, rules: [shipperRule], prose },
    toolCall(),
  );
  assert.equal(
    seen.length,
    1,
    "a local model is reached when the operator has said it may be",
  );
});

test("an answer that is not the demanded shape is refused, never guessed at", async () => {
  const cases: Array<[unknown, string]> = [
    ["not an object", "must be a JSON object"],
    [{ summary: "I decided something" }, 'carry "rules" and "facts"'],
    [{ rules: ["shipper-answer"] }, '"facts" must be an object'],
    [{ rules: "shipper-answer", facts: {} }, '"rules" must be a list of rule names'],
    [
      { rules: ["shipper-answer", ""], facts: {} },
      '"rules" must be a list of rule names',
    ],
    [{ rules: [42], facts: {} }, '"rules" must be a list of rule names'],
    [{ rules: [], facts: { shipper: 42 } }, "values are text"],
    [
      { rules: ["shipper-answer", "shipper-answer"], facts: {} },
      '"rules" must name each rule at most once',
    ],
    // A rule named is not a rule run twice: the answer is refused rather than
    // read as a second run over the same change.
    [
      { rules: ["shipper-answer"], facts: {}, authority: "outward" },
      "what may be done is never the model's to say",
    ],
    // An answer cannot produce an authorisation either: naming a writing tool,
    // or a capability, is refused as the shape it is not.
    [
      { rules: ["shipper-answer"], facts: {}, actions: [{ do: "mail.send" }] },
      "never the model's to say",
    ],
    [
      { read: { tool: "files.list" }, capability: "mail.send" },
      "An answer that reads carries nothing beside",
    ],
  ];
  for (const [bad, expected] of cases) {
    const parsed = parseAnswerDetailed(bad);
    assert.ok("problem" in parsed, `should refuse: ${JSON.stringify(bad)}`);
    assert.ok(
      parsed.problem.includes(expected),
      `should say: ${expected} — got: ${parsed.problem}`,
    );
  }

  answerWith({ rules: ["shipper-answer"], facts: {}, authority: "outward" });
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: true },
        { event: mailEvent, rules: [shipperRule], prose },
        toolCall(),
      ),
    (err: unknown) => err instanceof ModelError && err.code === "model_answer_malformed",
    "the turn refuses the answer rather than acting on what it could not read",
  );

  answerWith({ rules: ["a-rule-the-group-never-wrote"], facts: {} });
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: true },
        { event: mailEvent, rules: [shipperRule], prose },
        toolCall(),
      ),
    (err: unknown) => err instanceof ModelError && err.code === "model_answer_malformed",
    "and an answer naming a rule the group did not write is refused too",
  );

  // One name among several that is not the group's refuses the whole answer: a
  // rule it did not write is not dropped from the list and acted on beside the
  // names it did.
  answerWith({
    rules: ["shipper-answer", "a-rule-the-group-never-wrote"],
    facts: {},
  });
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: true },
        { event: mailEvent, rules: [shipperRule], prose },
        toolCall(),
      ),
    (err: unknown) => err instanceof ModelError && err.code === "model_answer_malformed",
    "and the whole answer is refused, not the one bad name",
  );
});

test("the turn may look the group's own state up with the reading tools, and not with anything else", async () => {
  answerWith({ read: { tool: "mail.send", arguments: { to: "x@example.com" } } });
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: true },
        { event: mailEvent, rules: [shipperRule], prose },
        toolCall(),
      ),
    /There is no tool named "mail.send"/,
    "a tool that writes is not in the reading catalogue to be named",
  );

  seen = [];
  answers = [];
  answerWith({ read: { tool: "files.list", arguments: {} } });
  answerWith({ rules: ["shipper-answer"], facts: { shipper: "Maersk" } });
  const decision = await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, rules: [shipperRule], prose },
    toolCall(),
  );
  assert.deepEqual(
    decision,
    { kind: "decision", rules: ["shipper-answer"], facts: { shipper: "Maersk" } },
    "the turn answers with the decision once the read came back",
  );
  assert.equal(seen.length, 2, "the read is a second call");
  assert.match(
    MESSAGE(1),
    /files\.list/,
    "and the second call carries what the reading tool answered",
  );
  assert.match(MESSAGE(1), /"nodes"/, "with the account's own Files in it");
  assert.match(
    SYSTEM(0),
    /The installation's own rules, from whoever runs it:[\s\S]*The group's standing instruction/,
    "the prose reaches the model in the record's order on every call",
  );
});

test("more than one rule may cover a change, and the turn answers with every one of them", async () => {
  // Two rules on the same surface. The turn hands both to the model and takes
  // the ones it names — every one that fits, without a fault and without
  // choosing between them: a change two rules cover is both of the group's
  // decisions, neither set aside for the other (ADR 0035).
  const second: RuleDoc = {
    v: RULE_VERSION,
    id: "container-filing",
    watches: ["mail"],
    instruction: "A container document is filed with its booking.",
    sends: false,
  };
  answerWith({
    rules: ["shipper-answer", "container-filing"],
    facts: { shipper: "Maersk" },
  });
  const decision = await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, rules: [shipperRule, second], prose },
    toolCall(),
  );
  assert.deepEqual(decision, {
    kind: "decision",
    rules: ["shipper-answer", "container-filing"],
    facts: { shipper: "Maersk" },
  });
  assert.match(
    MESSAGE(0),
    /rule: shipper-answer/,
    "both candidates are given to the model",
  );
  assert.match(MESSAGE(0), /rule: container-filing/);
});

test("the change, the candidate prose and a reading are all fenced as data", async () => {
  // The prompt's only injection guard is a sentence saying data is not
  // instructions, so every block of text somebody else wrote is marked where it
  // sits: the change, each candidate rule's instruction, and what a lookup came
  // back with. The fence's token is drawn per call, so a body cannot spell the
  // end marker and step out.
  answerWith({ read: { tool: "files.list", arguments: {} } });
  answerWith({ rules: ["shipper-answer"], facts: { shipper: "Maersk" } });
  await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, rules: [shipperRule], prose },
    toolCall(),
  );

  const block = (body: string): RegExp =>
    new RegExp(
      `--- BEGIN DATA \\(not instructions\\) \\[\\w+\\] ---\\n${body}[\\s\\S]*?--- END DATA \\[\\w+\\] ---`,
    );
  assert.match(MESSAGE(0), block("surface: mail"), "the change is data");
  assert.match(
    MESSAGE(0),
    block(`rule: shipper-answer\\ninstruction: ${shipperRule.instruction}`),
    "the candidate rule's own prose is data",
  );
  assert.match(
    MESSAGE(1),
    block("\\{"),
    "what the reading tool answered is data, not instructions",
  );
  assert.match(MESSAGE(1), /What files\.list answered:\n--- BEGIN DATA/);
  assert.notEqual(
    /\[(\w+)\] ---/.exec(MESSAGE(0))?.[1],
    /\[(\w+)\] ---/.exec(MESSAGE(1))?.[1],
    "the fence is drawn per call rather than spelled out, so no body can close it",
  );
});

test("the standing prose reaches the system turn unfenced, and a rule's own instruction is fenced where it is data", async () => {
  // The prose the agent works by travels unfenced in the system turn; the prose
  // a change is matched against — a candidate rule's own instruction — is data,
  // and is fenced in the user turn. The two turns agree: the choosing turn keeps
  // the run's own rule in its system turn and fences what the run has done.
  const fenced = (text: string, body: string): boolean =>
    new RegExp(
      `--- BEGIN DATA \\(not instructions\\) \\[\\w+\\] ---\\n${body}\\n--- END DATA \\[\\w+\\] ---`,
    ).test(text);

  answerWith({ rules: ["shipper-answer"], facts: {} });
  await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, rules: [shipperRule], prose },
    toolCall(),
  );
  assert.ok(
    SYSTEM(0).includes(prose.installation) && SYSTEM(0).includes(prose.group),
    "the installation's line and the group's standing instruction reach the system turn",
  );
  assert.ok(
    !SYSTEM(0).includes("--- BEGIN DATA"),
    "and they are not fenced there: they are what the agent works by, not data",
  );
  assert.ok(
    fenced(
      MESSAGE(0),
      "rule: shipper-answer\\ninstruction: A shipper's message is answered within the day\\.",
    ),
    "a rule's own instruction is fenced in the decision turn's user turn",
  );

  seen = [];
  answers = [];
  answerWith({ done: "nothing more to do" });
  await chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion());
  assert.ok(
    SYSTEM(0).includes("The rule's own instruction:"),
    "the run's own rule reaches the choosing turn's system turn",
  );
  assert.ok(!SYSTEM(0).includes("--- BEGIN DATA"), "and it is not fenced there either");
  assert.ok(
    fenced(MESSAGE(0), "mail created: m-1"),
    "while the run's own data — the change and the plan — is fenced in the user turn",
  );
});

test("a change no rule watches is decided without a call, and without a bill", async () => {
  const decision = await decideEvent(
    { model, allowPrivateProvider: true },
    {
      event: { source: "files", change: "created", where: "Documents/a.pdf" },
      rules: [shipperRule],
      prose,
    },
    toolCall(),
  );
  assert.deepEqual(decision, { kind: "decision", rules: [], facts: {} });
  assert.equal(
    seen.length,
    0,
    "the watch a rule declares is enforced before the model is asked",
  );
});

test("an installation that has chosen no model has no agent", () => {
  const none = parseInstallationDocumentDetailed(JSON.stringify({ secret: "a-secret" }));
  assert.ok("doc" in none, "an empty document is readable");
  assert.equal(
    modelAccess(none.doc, true),
    null,
    "there is no default provider nobody chose: an installation with no model has no agent (ADR 0031)",
  );
  // Absence is refused in the same shape a provider the operator has not
  // allowed is refused in: a code, so a surface says it to a person instead of
  // handing them a `null` to interpret.
  assert.throws(
    () => requireModelAccess(none.doc, true),
    (err: unknown) => err instanceof ModelError && err.code === "model_absent",
    "and a caller that needs a model is given a refusal it can compose a sentence from",
  );
});

/* ------------------------------------------------------------------ */
/* The ways a provider can fail                                        */
/* ------------------------------------------------------------------ */

test("a provider that answers with a body that is not JSON is refused with its own words", async () => {
  rawBody = "<html><body>502 Bad Gateway</body></html>";
  await assert.rejects(
    () => callModel({ model, allowPrivateProvider: true }, { system: "s", user: "u" }),
    (err: unknown) =>
      err instanceof ModelError &&
      err.code === "model_call_failed" &&
      err.message.includes("not JSON") &&
      err.message.includes("502 Bad Gateway"),
    "a gateway's error page reads like one, rather than surfacing a parse error",
  );
});

test("a provider that does not answer inside the call's time is abandoned", async () => {
  answerDelayMs = 300;
  await assert.rejects(
    () =>
      callModel(
        { model, allowPrivateProvider: true },
        { system: "s", user: "u", timeoutMs: 20 },
      ),
    (err: unknown) => err instanceof ModelError && err.code === "model_call_failed",
    "the call's own time bound ends it, as a coded failure rather than a platform abort",
  );
});

test("an answer past the ceiling a call reads is refused, and the read is abandoned", async () => {
  rawBody = "x".repeat(MODEL_RESPONSE_BYTES_MAX + 1);
  await assert.rejects(
    () => callModel({ model, allowPrivateProvider: true }, { system: "s", user: "u" }),
    (err: unknown) =>
      err instanceof ModelError &&
      err.code === "model_call_failed" &&
      err.message.includes(`${MODEL_RESPONSE_BYTES_MAX} bytes`),
    "a body over the ceiling is not held, however long the provider streams",
  );
});

test("a turn that has spent all its lookups and asks for another is refused", async () => {
  answerWith({ read: { tool: "files.list", arguments: {} } });
  answerWith({ read: { tool: "files.list", arguments: {} } });
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: true },
        { event: mailEvent, rules: [shipperRule], prose },
        toolCall(),
        { maxReads: 1 },
      ),
    (err: unknown) =>
      err instanceof ModelError &&
      err.code === "model_answer_malformed" &&
      err.message.includes("1 lookups spent"),
    "the cap ends the turn rather than looping for as long as the model asks",
  );
  assert.equal(seen.length, 2, "the first lookup ran; the second was refused");
});

/* ------------------------------------------------------------------ */
/* The choosing turn                                                   */
/* ------------------------------------------------------------------ */

/** What a choosing turn is told: the change and the plan so far. */
function stepQuestion(
  plan: ReturnType<typeof startRun>["plan"] = [],
): Parameters<typeof chooseStep>[2] {
  return {
    woke: "mail created: m-1",
    plan,
    prose: { rule: shipperRule.instruction },
    facts: { shipper: "Maersk" },
  };
}

test("an answer that is not a batch or a done is refused, never guessed at", () => {
  const cases: Array<[unknown, string]> = [
    ["not an object", "must be a JSON object"],
    [{}, 'must carry "calls"'],
    [{ calls: [], done: "nothing more" }, "and never both"],
    [{ done: "   " }, '"done" must say what is finished'],
    [{ done: "over", authority: "outward" }, "carries nothing beside"],
    [{ calls: [] }, "list of at least one call"],
    [{ calls: ["mail.find"] }, "must be a JSON object"],
    [{ calls: [{ arguments: {} }] }, "names one of the tools you are given"],
    [{ calls: [{ name: "mail.find", arguments: "none" }] }, "must be an object"],
    [
      { calls: [{ name: "mail.find", arguments: {}, capability: "mail.send" }] },
      "what may be done is never the model's to say",
    ],
    [
      { calls: [{ name: "mail.find", arguments: {} }], authority: "outward" },
      "and nothing else",
    ],
  ];
  for (const [bad, expected] of cases) {
    const parsed = parseStepAnswerDetailed(bad);
    assert.ok("problem" in parsed, `should refuse: ${JSON.stringify(bad)}`);
    assert.ok(
      parsed.problem.includes(expected),
      `should say: ${expected} — got: ${parsed.problem}`,
    );
  }

  // The two shapes that are the whole of what a step can be: a batch of one or
  // more calls, and a done.
  assert.deepEqual(
    parseStepAnswerDetailed({
      calls: [{ name: "mail.find", arguments: { query: "from:x" } }],
    }),
    {
      choice: {
        kind: "batch",
        calls: [{ name: "mail.find", args: { query: "from:x" } }],
      },
    },
  );
  assert.deepEqual(
    parseStepAnswerDetailed({
      calls: [
        { name: "chat.read", arguments: { id: "c-1" } },
        { name: "chat.read", arguments: { id: "c-2" } },
      ],
    }),
    {
      choice: {
        kind: "batch",
        calls: [
          { name: "chat.read", args: { id: "c-1" } },
          { name: "chat.read", args: { id: "c-2" } },
        ],
      },
    },
    "the same tool may be called more than once in one answer",
  );
  assert.deepEqual(
    parseStepAnswerDetailed({ calls: [{ name: "files.list" }] }),
    { choice: { kind: "batch", calls: [{ name: "files.list", args: {} }] } },
    "a tool that takes no arguments is called without any",
  );
  assert.deepEqual(parseStepAnswerDetailed({ done: "  the filing is done  " }), {
    choice: { kind: "done", why: "the filing is done" },
  });
});

test("a batch naming a tool the catalogue does not hold, or arguments a tool cannot use, is refused whole", async () => {
  answerWith({
    calls: [
      { name: "mail.find", arguments: { query: "from:x" } },
      { name: "mail.send", arguments: { to: "x@example.com" } },
    ],
  });
  await assert.rejects(
    () => chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion()),
    (err: unknown) => err instanceof ModelError && err.code === "model_answer_malformed",
    "one unknown tool refuses the whole answer, not only the call that named it",
  );

  answerWith({ calls: [{ name: "mail.find", arguments: {} }] });
  await assert.rejects(
    () => chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion()),
    (err: unknown) => err instanceof ModelError && err.code === "model_answer_malformed",
    "and arguments a tool cannot use refuse the whole answer too",
  );
});

test("the choosing turn hands the catalogue as it describes itself, and may propose a write", async () => {
  answerWith({ calls: [{ name: "chat.ask", arguments: { text: "which one?" } }] });
  const choice = await chooseStep(
    TOOLS,
    { model, allowPrivateProvider: true },
    stepQuestion(),
  );
  assert.deepEqual(
    choice,
    { kind: "batch", calls: [{ name: "chat.ask", args: { text: "which one?" } }] },
    "asking a person is one of the calls, not a third shape of answer",
  );

  const system = SYSTEM(0);
  const chatSay = TOOLS.find((tool) => tool.name === "chat.say");
  assert.ok(chatSay, "the catalogue holds the tool");
  assert.ok(
    system.includes(`- chat.say: ${chatSay.description}`),
    "the description reaches the model as the catalogue states it, not as a copy",
  );
  assert.ok(
    system.includes("chat.ask"),
    "and the tool that writes is among them: the model may always propose an act",
  );
  assert.ok(
    system.includes("refused rather than run"),
    "because what may run is the guard's answer, and the model is told so",
  );
});

test("the change, the facts and what each step answered are fenced as data", async () => {
  answerWith({ calls: [{ name: "files.list", arguments: {} }] });
  const plan = recordStep(
    appendStep(
      startRun({
        id: "w-1",
        startedBy: {
          rule: "shipper-answer",
          instruction: null,
          woke: "mail created: m-1",
        },
      }),
      'mail.find {"query":"from:maersk"}',
    ),
    0,
    { state: "done", outcome: '{"messages":[{"id":"m-1"}]}' },
  ).plan;
  await chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion(plan));

  const message = MESSAGE(0);
  const block = (body: string): RegExp =>
    new RegExp(
      `--- BEGIN DATA \\(not instructions\\) \\[\\w+\\] ---\\n${body}[\\s\\S]*?--- END DATA \\[\\w+\\] ---`,
    );
  assert.match(message, block("mail created: m-1"), "the change is data");
  assert.match(message, block("shipper: Maersk"), "the facts are data");
  assert.match(
    message,
    block("step 1: mail\\.find"),
    "and what a step answered is data, never instructions",
  );
  assert.match(message, /state: done/);
  assert.match(
    SYSTEM(0),
    /The rule's own instruction:\nA shipper's message is answered within the day\./,
    "the prose the turn carries is the record's own level",
  );
});

test("an outcome is bounded for the prompt, and a malformed answer is refused", async () => {
  const plan = recordStep(
    appendStep(
      startRun({
        id: "w-2",
        startedBy: {
          rule: "r",
          instruction: null,
          woke: "chat created: gilbert/chat/c-1.json",
        },
      }),
      "x",
    ),
    0,
    { state: "done", outcome: "y".repeat(OUTCOME_IN_PROMPT_MAX * 2) },
  ).plan;
  answerWith({ done: "nothing more to do" });
  const choice = await chooseStep(
    TOOLS,
    { model, allowPrivateProvider: true },
    stepQuestion(plan),
  );
  assert.deepEqual(choice, { kind: "done", why: "nothing more to do" });
  assert.ok(
    MESSAGE(0).includes(`${"y".repeat(OUTCOME_IN_PROMPT_MAX)}…`),
    "an outcome longer than the ceiling is cut where the record's own text is cut",
  );
  assert.ok(
    !MESSAGE(0).includes("y".repeat(OUTCOME_IN_PROMPT_MAX + 1)),
    "and the call is not handed the rest of it",
  );

  answerWith({ summary: "I chose something", tool: "mail.find" });
  await assert.rejects(
    () => chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion()),
    (err: unknown) => err instanceof ModelError && err.code === "model_answer_malformed",
    "a malformed answer is refused rather than acted on",
  );
});
