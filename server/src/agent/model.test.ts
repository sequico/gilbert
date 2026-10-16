/**
 * The model client and the decision turn, against a stub OpenAI-compatible
 * endpoint (ADR 0031).
 *
 * What is asserted here is the contract a turn's answer is read against: the
 * zero-retention opt-out on every request, a JSON answer shape and a ceiling on
 * the answer, and — the parts that matter for what the agent may do — a private
 * provider that the operator has not allowed is refused before the key leaves,
 * an answer that is not the demanded shape is refused rather than guessed at, an
 * answer can carry no authority and can name no tool that writes, and the prose
 * a turn carries is the record's three levels in the record's order.
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
const { startRun } = await import("../shared/run.js");
const { RULE_VERSION } = await import("./rule.js");
const {
  assertUsableProvider,
  baseUrlProblem,
  callModel,
  decideEvent,
  modelAccess,
  ModelError,
  parseAnswerDetailed,
  MODEL_MAX_OUTPUT_DEFAULT,
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const PROVIDER_PORT = await freePort();
const stub = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const raw = await readBody(req);
  seen.push({
    url: req.url ?? "",
    headers: req.headers,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  });
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

/** Each test starts with no request seen and no answer queued. */
beforeEach(() => {
  seen = [];
  answers = [];
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
      startedBy: { rule: "shipper-answer", instruction: null },
    }),
  };
}

/* ------------------------------------------------------------------ */

test("one call carries the zero-retention opt-out, a JSON answer shape and a ceiling", async () => {
  answerWith({ rule: "shipper-answer", facts: { shipper: "Maersk" } });
  const answer = await callModel(
    { model, allowPrivateProvider: true },
    { system: "the group's rules", user: "the change" },
  );
  assert.deepEqual(answer, { rule: "shipper-answer", facts: { shipper: "Maersk" } });

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
  assert.equal(baseUrlProblem("https://models.example.com/v1"), null);
  assert.equal(baseUrlProblem("http://models.example.com/v1"), "not an https URL");
  assert.equal(baseUrlProblem("https://localhost/v1"), "a private address");
  assert.equal(baseUrlProblem("https://[::1]/v1"), "a private address");
  assert.equal(baseUrlProblem("https://10.0.0.5/v1"), "a private address");
  assert.equal(baseUrlProblem("not a url"), "not an absolute URL");

  assert.throws(
    () => assertUsableProvider({ model, allowPrivateProvider: false }),
    (err: unknown) => err instanceof ModelError && err.code === "model_address_refused",
    "a model inside the deployment's own network is refused without the operator's word",
  );

  answerWith({ rule: null, facts: {} });
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

  answerWith({ rule: null, facts: {} });
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
    [{ summary: "I decided something" }, 'carry "rule" and "facts"'],
    [{ rule: "shipper-answer" }, '"facts" must be an object'],
    [{ rule: "", facts: {} }, '"rule" must be the name of a rule'],
    [{ rule: "shipper-answer", facts: "none" }, '"facts" must be an object'],
    [{ rule: "shipper-answer", facts: { shipper: 42 } }, "values are text"],
    [
      { rule: "shipper-answer", facts: {}, authority: "outward" },
      "what may be done is never the model's to say",
    ],
    // An answer cannot produce an authorisation either: naming a writing tool,
    // or a capability, is refused as the shape it is not.
    [
      { rule: "shipper-answer", facts: {}, actions: [{ do: "mail.send" }] },
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

  answerWith({ rule: "shipper-answer", facts: {}, authority: "outward" });
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

  answerWith({ rule: "a-rule-the-group-never-wrote", facts: {} });
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
  answerWith({ rule: "shipper-answer", facts: { shipper: "Maersk" } });
  const decision = await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, rules: [shipperRule], prose },
    toolCall(),
  );
  assert.deepEqual(
    decision,
    { kind: "decision", rule: "shipper-answer", facts: { shipper: "Maersk" } },
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
  assert.deepEqual(decision, { kind: "decision", rule: null, facts: {} });
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
});
