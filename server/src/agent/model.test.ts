/**
 * The model client and the decision turn, against a stub OpenAI-compatible
 * endpoint (ADR 0038).
 *
 * What is asserted here is the contract a turn's answer is read against: the
 * zero-retention opt-out on every request, a JSON answer shape and a ceiling on
 * the answer, and — the parts that matter for what the agent may do — a private
 * provider that the operator has not allowed is refused before the key leaves,
 * an installation with no model is refused in the same coded shape, an answer
 * that is not the demanded shape is refused rather than guessed at, an answer can
 * carry no authority and can name no tool that writes, and the prose a turn
 * carries is the record's two levels in the record's order. Every block of
 * somebody else's text in the prompt — the change, the group's instruction, a
 * reading, the facts the installation's memory recalled — is
 * fenced as data, under a token drawn per call.
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
import { isRecord } from "../shared/json.js";
import type { FactView } from "../shared/memory.js";
import { freePort, waitForPort } from "../testkit.js";

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
const { entityIdFor, MEMORY_VERSION, MEMORY_FACT_MAX } = await import(
  "../shared/memory.js"
);
const { TOOLS } = await import("./tools.js");
const {
  assertUsableProvider,
  baseUrlProblem,
  callModel,
  chooseStep,
  decideEvent,
  judgeRun,
  modelAccess,
  ModelError,
  parseAnswerDetailed,
  parseStepAnswerDetailed,
  readAnswerAuthority,
  readImage,
  requireModelAccess,
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
/**
 * A native tool call the next answer carries, in the provider's own shape, for
 * the model that answers `deepseek-flash`'s way.
 */
let nativeCalls: Array<{ function: { name: string; arguments: string } }> | null = null;
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
  let content = "{}";
  let toolCalls: unknown = null;
  if (nativeCalls) {
    toolCalls = nativeCalls;
    nativeCalls = null;
  } else {
    content = answers.shift() ?? "{}";
  }
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
        },
      ],
    }),
  );
});

/**
 * Answer the next call with this value, as the new protocol carries it
 * (ADR 0038): a `calls` answer is the provider's own tool calls, a `done`
 * answer is the sentence that ends the run, and anything else is the structured
 * JSON a decision turn is asked for.
 */
function answerWith(value: unknown): void {
  if (isRecord(value) && Array.isArray(value.calls)) {
    nativeCalls = value.calls.map((call, at) => ({
      index: at,
      id: `call-${at}`,
      type: "function",
      function: {
        name: (call as { name: string }).name,
        arguments: JSON.stringify((call as { arguments?: unknown }).arguments ?? {}),
      },
    }));
    answers.push("");
    return;
  }
  if (isRecord(value) && typeof value.done === "string") {
    answers.push(value.done);
    return;
  }
  answers.push(JSON.stringify(value));
}

/**
 * The installation's model, as its own document states it: the document is
 * where the choice lives (ADR 0009), and `modelAccess` is the one place it is
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
  nativeCalls = null;
  rawBody = null;
  answerDelayMs = 0;
});

/** The change in the group's own account that the decision turn is asked about. */
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
      startedBy: { woke: "mail created: m-1" },
    }),
  };
}

/* ------------------------------------------------------------------ */

test("one call carries the zero-retention opt-out, a JSON answer shape and a ceiling", async () => {
  answerWith({ facts: { shipper: "Maersk" } });
  const answer = await callModel(
    { model, allowPrivateProvider: true },
    { system: "the group's rules", user: "the change" },
  );
  assert.deepEqual(answer, { facts: { shipper: "Maersk" } });

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
  assert.equal(
    request?.body.max_tokens,
    16384,
    "a ceiling is always stated — a reasoning model spends an absent one before writing",
  );
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

  answerWith({ facts: {} });
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: false },
        { event: mailEvent, prose },
        toolCall(),
      ),
    (err: unknown) => err instanceof ModelError && err.code === "model_address_refused",
    "and the decision turn makes no call at all",
  );
  assert.equal(seen.length, 0, "the key never left the process");

  answerWith({ facts: {} });
  await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, prose },
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
    [{ summary: "I decided something" }, "exactly one of"],
    [{ rules: ["shipper-answer"] }, 'exactly one of "facts", "read", "reply" or "lines"'],
    [{ facts: { shipper: 42 } }, "values are text"],
    // An answer cannot produce an authorisation: naming a writing tool, or a
    // capability, is refused as the shape it is not.
    [{ facts: {}, authority: "outward" }, "what may be done is never the model's to say"],
    [{ facts: {}, actions: [{ do: "mail.send" }] }, "never the model's to say"],
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

  answerWith({ facts: {}, authority: "outward" });
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: true },
        { event: mailEvent, prose },
        toolCall(),
      ),
    (err: unknown) => err instanceof ModelError && err.code === "model_answer_malformed",
    "the turn refuses the answer rather than acting on what it could not read",
  );
});

test("the turn may look the group's own state up with the reading tools, and not with anything else", async () => {
  /*
   * A name the reading catalogue does not hold is refused **and told back**: the turn
   * goes on with the refusal as that lookup's answer, so a model that names a writing
   * tool can correct itself inside the same decision instead of ending it — which is
   * what killed a pass before its run was opened (live, 2026-10-27).
   */
  seen = [];
  answers = [];
  answerWith({ read: { tool: "mail.send", arguments: { to: "x@example.com" } } });
  answerWith({ facts: { refused: "yes" } });
  const told = await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, prose },
    toolCall(),
  );
  assert.deepEqual(
    told,
    { kind: "decision", facts: { refused: "yes" } },
    "a writing tool is not in the reading catalogue, and the turn goes on instead of dying",
  );

  seen = [];
  answers = [];
  answerWith({ read: { tool: "open", arguments: { what: "files" } } });
  answerWith({ facts: { shipper: "Maersk" } });
  const decision = await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, prose },
    toolCall(),
  );
  assert.deepEqual(
    decision,
    { kind: "decision", facts: { shipper: "Maersk" } },
    "the turn answers with the decision once the read came back",
  );
  assert.equal(seen.length, 2, "the read is a second call");
  assert.match(
    MESSAGE(1),
    /open/,
    "and the second call carries what the reading tool answered",
  );
  assert.match(MESSAGE(1), /"nodes"/, "with the account's own Files in it");
  assert.match(
    SYSTEM(0),
    /The installation's own rules, from whoever runs it:[\s\S]*The group's standing instruction/,
    "the prose reaches the model in the record's order on every call",
  );
});

test("the change, a reading and a lookup's answer are all fenced as data", async () => {
  // The prompt's only injection guard is a sentence saying data is not
  // instructions, so every block of text somebody else wrote is marked where it
  // sits: the change, and what a lookup came back with. The fence's token is
  // drawn per call, so a body cannot spell the end marker and step out.
  answerWith({ read: { tool: "open", arguments: { what: "files" } } });
  answerWith({ facts: { shipper: "Maersk" } });
  await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, prose },
    toolCall(),
  );

  const block = (body: string): RegExp =>
    new RegExp(
      `--- BEGIN DATA \\(not instructions\\) \\[\\w+\\] ---\\n${body}[\\s\\S]*?--- END DATA \\[\\w+\\] ---`,
    );
  assert.match(MESSAGE(0), block("surface: mail"), "the change is data");
  assert.match(
    MESSAGE(1),
    block("\\{"),
    "what the reading tool answered is data, not instructions",
  );
  assert.match(MESSAGE(1), /What open answered:\n--- BEGIN DATA/);
  assert.notEqual(
    /\[(\w+)\] ---/.exec(MESSAGE(0))?.[1],
    /\[(\w+)\] ---/.exec(MESSAGE(1))?.[1],
    "the fence is drawn per call rather than spelled out, so no body can close it",
  );
});

test("the standing prose reaches the system turn unfenced, and the change is fenced where it is data", async () => {
  // The prose the agent works by travels unfenced in the system turn; the change
  // it is asked about is somebody else's text, and is fenced in the user turn.
  // The two turns agree: the choosing turn keeps the same prose in its system
  // turn and fences what the run has done.
  const fenced = (text: string, body: string): boolean =>
    new RegExp(
      `--- BEGIN DATA \\(not instructions\\) \\[\\w+\\] ---\\n${body}\\n--- END DATA \\[\\w+\\] ---`,
    ).test(text);

  answerWith({ facts: {} });
  await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, prose },
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
    fenced(MESSAGE(0), "surface: mail\\nchange: created\\naddress: m-1"),
    "the change is fenced in the decision turn's user turn",
  );

  seen = [];
  answers = [];
  answerWith({ done: "nothing more to do" });
  await chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion());
  assert.ok(
    SYSTEM(0).includes("The group's standing instruction, from its members:"),
    "the group's instruction reaches the choosing turn's system turn",
  );
  assert.ok(!SYSTEM(0).includes("--- BEGIN DATA"), "and it is not fenced there either");
  assert.ok(
    fenced(MESSAGE(0), "mail created: m-1"),
    "while the run's own data — the change and the plan — is fenced in the user turn",
  );
});

/**
 * The catalogue carries each tool's arguments **with their shape**, so the turn
 * that fills them in reads the bound the parser checks instead of learning it
 * from a refusal: the reported failures were a value one character too long and
 * a field named `text` where the tool takes `fact`.
 */
test("the catalogue travels as the definitions alone, and the turn says what the verbs are", async () => {
  /*
   * It once travelled twice — the provider's own `tools`, and a line per tool
   * spelling out its arguments — because a model had invented `mail.search` and
   * `mail.threads` from a catalogue it had not read (260 refused steps over 94 runs,
   * 55%). Four verbs with intent-shaped values carry what those lines carried: a
   * value is in the schema's own `enum`, and there is no second list to keep in step
   * (R4). What the turn says instead is what the verbs are.
   */
  seen = [];
  answers = [];
  answerWith({ done: "nothing to do" });
  await chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion());
  const system = SYSTEM(0);

  const act = TOOLS.find((tool) => tool.name === "act");
  assert.ok(act, "the catalogue holds the tool this test reads");
  assert.ok(
    !system.includes(`- ${act.name}(`),
    "the arguments are not paid for twice: the definitions carry them",
  );
  assert.ok(
    system.includes("`open` reads what the account holds, `act` changes it"),
    "and the turn names the four verbs it may choose among",
  );
  const values = act.args.what?.values ?? [];
  for (const value of values)
    assert.ok(
      JSON.stringify(seen[0]?.body.tools ?? []).includes(`"${value}"`),
      `the schema itself names "${value}", with no second list to drift from it`,
    );
});

test("the choosing turn offers the catalogue as tools, from the same argument specs", async () => {
  /*
   * A model writing a plan by hand guesses at each argument's kind, and one bad
   * argument refuses the whole answer: 110 refused answers on the live
   * installation. The same definition travels as the provider's own `tools`,
   * rendered from the specs the parser checks, and the answer is not forced into
   * JSON — a `json_object` response cannot carry a tool call.
   */
  seen = [];
  answers = [];
  answerWith({ done: "nothing to do" });
  await chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion());

  const body = seen[0]?.body as {
    response_format?: unknown;
    tools?: Array<{
      type: string;
      function: {
        name: string;
        parameters: {
          type: string;
          properties?: Record<string, Record<string, unknown>>;
          oneOf?: Array<Record<string, unknown>>;
          additionalProperties?: boolean;
        };
      };
    }>;
  };
  assert.equal(
    body.response_format,
    undefined,
    "a tool-calling answer is not forced into JSON",
  );
  const tools = body.tools ?? [];
  assert.equal(
    tools.length,
    TOOLS.length,
    "every tool of the catalogue is offered, once",
  );
  const act = tools.find((one) => one.function.name === "act");
  assert.ok(act, "the catalogue's own tools are the ones offered");
  assert.equal(act.function.parameters.type, "object");
  /*
   * One branch per value (ADR 0038): the fact branch carries the bound the
   * parser checks, so a provider refuses an over-long fact before the step is
   * paid for.
   */
  const branches = (act.function.parameters.oneOf ?? []) as Array<{
    properties: Record<string, Record<string, unknown>>;
    additionalProperties: boolean;
  }>;
  const values = branches.map((one) => one.properties.what?.enum);
  const fact = branches.find(
    (_one, at) => Array.isArray(values[at]) && (values[at] as unknown[])[0] === "fact",
  );
  assert.ok(fact);
  assert.equal(fact.properties.fact?.maxLength, MEMORY_FACT_MAX);
  assert.equal(fact.additionalProperties, false);
});

/**
 * The run's surface matrix is what refuses a write at the door (ADR 0038), so
 * the turn is told it in advance: a model that has to learn it from a refused
 * step has spent a step and a call on a lesson one line teaches.
 */
test("the surfaces a run's areas keep off are said, and nothing off says nothing", async () => {
  const surfaces = {
    chat: "watch" as const,
    mail: "watch" as const,
    files: "ondemand" as const,
    knowledge: "off" as const,
    workorder: "off" as const,
    calendar: "off" as const,
  };

  seen = [];
  answerWith({ done: "nothing to do" });
  await chooseStep(
    TOOLS,
    { model, allowPrivateProvider: true },
    {
      ...stepQuestion(),
      surfaces,
    },
  );
  assert.match(
    SYSTEM(0),
    /areas keep knowledge, workorder, calendar off: a step that writes one of them is refused/,
    "what is off is named, in the editor's order",
  );
  assert.ok(!SYSTEM(0).includes("areas keep chat off"), "and what is watched is not");

  seen = [];
  answers = [];
  answerWith({ done: "nothing to do" });
  await chooseStep(
    TOOLS,
    { model, allowPrivateProvider: true },
    {
      ...stepQuestion(),
      surfaces: {
        ...surfaces,
        knowledge: "watch",
        workorder: "watch",
        calendar: "watch",
      },
    },
  );
  assert.ok(
    !SYSTEM(0).includes("is refused, so do not propose one"),
    "a matrix with nothing off adds no line",
  );

  seen = [];
  answers = [];
  answerWith({ done: "nothing to do" });
  await chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion());
  assert.ok(
    !SYSTEM(0).includes("is refused, so do not propose one"),
    "and a run whose record carries no matrix is told nothing it cannot know",
  );
});

/**
 * A run has no budget of its own (ADR 0038), so no turn is told about one: the only
 * ceiling left is the provider's, and a prompt that leaves no room for an answer is
 * refused with the window named rather than sent to fail upstream.
 */
test("a turn says nothing about a run's budget, because a run has none", async () => {
  seen = [];
  answers = [];
  answerWith({ done: "nothing to do" });
  await chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion());
  assert.ok(
    !SYSTEM(0).includes("tokens are left"),
    "no budget line: a run ends done, waiting, stopped or failed, never on a counter",
  );
});

test("a prompt larger than the ceiling is refused with the window named", async () => {
  await assert.rejects(
    () =>
      chooseStep(
        TOOLS,
        { model, allowPrivateProvider: true },
        {
          ...stepQuestion(),
          woke: "mail created: m-1 ".repeat(60_000),
        },
      ),
    (err: unknown) =>
      err instanceof ModelError &&
      err.code === "model_prompt_over_window" &&
      /declares a ceiling/.test(err.message),
    "the refusal names the window rather than a budget",
  );
});

test("an installation that has chosen no model has no agent", () => {
  const none = parseInstallationDocumentDetailed(JSON.stringify({ secret: "a-secret" }));
  assert.ok("doc" in none, "an empty document is readable");
  assert.equal(
    modelAccess(none.doc, true),
    null,
    "there is no default provider nobody chose: an installation with no model has no agent (ADR 0038)",
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
  answerWith({ read: { tool: "open", arguments: { what: "files" } } });
  answerWith({ read: { tool: "open", arguments: { what: "files" } } });
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: true },
        { event: mailEvent, prose },
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
    prose,
    facts: { shipper: "Maersk" },
  };
}

test("an answer that is not a plan or a done is refused, never guessed at", () => {
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
    // A step waits on a step the answer already carries, and on nothing else:
    // a name it has not defined, its own name, or a repeated id all refuse the
    // whole answer rather than making a step that could never follow.
    [
      {
        calls: [
          { name: "mail.find", arguments: {}, needs: { step: "nowhere", when: "done" } },
        ],
      },
      "which no earlier step of the answer carries",
    ],
    [
      {
        calls: [
          {
            id: "a",
            name: "mail.find",
            arguments: {},
            needs: { step: "a", when: "done" },
          },
        ],
      },
      "which no earlier step of the answer carries",
    ],
    [
      {
        calls: [
          { id: "a", name: "mail.find", arguments: {} },
          { id: "a", name: "mail.read", arguments: {} },
        ],
      },
      "an id names one step",
    ],
    // A branch names an outcome a step can end with, and nothing else.
    [
      {
        calls: [
          { id: "a", name: "mail.find", arguments: {} },
          { name: "mail.read", arguments: {}, needs: { step: "a", when: "maybe" } },
        ],
      },
      "no outcome can reach that branch",
    ],
    [
      { calls: [{ name: "mail.find", arguments: {}, needs: "a" }] },
      'A call\'s "needs" must be an object',
    ],
    [
      {
        calls: [
          { id: "a", name: "mail.find", arguments: {} },
          {
            name: "mail.read",
            arguments: {},
            needs: { step: "a", when: "done", else: "x" },
          },
        ],
      },
      'A call\'s "needs" carries a "step" and its "when" and nothing else',
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

  // The two shapes that are the whole of what an answer can be: a plan of one
  // or more steps, and a done.
  assert.deepEqual(
    parseStepAnswerDetailed({
      calls: [{ name: "mail.find", arguments: { query: "from:x" } }],
    }),
    {
      choice: {
        kind: "plan",
        calls: [{ name: "mail.find", args: { query: "from:x" }, needs: null }],
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
        kind: "plan",
        calls: [
          { name: "chat.read", args: { id: "c-1" }, needs: null },
          { name: "chat.read", args: { id: "c-2" }, needs: null },
        ],
      },
    },
    "the same tool may be called more than once in one answer",
  );
  assert.deepEqual(
    parseStepAnswerDetailed({ calls: [{ name: "files.list" }] }),
    {
      choice: {
        kind: "plan",
        calls: [{ name: "files.list", args: {}, needs: null }],
      },
    },
    "a tool that takes no arguments is called without any",
  );
  // A step that waits on an earlier step of the same answer names it by its id,
  // and the parser resolves that id to the step's place in the answer.
  assert.deepEqual(
    parseStepAnswerDetailed({
      calls: [
        { id: "file", name: "mail.file", arguments: { id: "m-1", folder: "Archive" } },
        {
          name: "chat.say",
          arguments: { text: "filed it" },
          needs: { step: "file", when: "done" },
        },
        {
          name: "chat.say",
          arguments: { text: "I could not file it" },
          needs: { step: "file", when: "failed" },
        },
      ],
    }),
    {
      choice: {
        kind: "plan",
        calls: [
          {
            name: "mail.file",
            args: { id: "m-1", folder: "Archive" },
            needs: null,
          },
          {
            name: "chat.say",
            args: { text: "filed it" },
            needs: { step: 0, when: "done" },
          },
          {
            name: "chat.say",
            args: { text: "I could not file it" },
            needs: { step: 0, when: "failed" },
          },
        ],
      },
    },
    "a step waits on an earlier step by its id, and the branch names the outcome it needs",
  );
  assert.deepEqual(parseStepAnswerDetailed({ done: "  the filing is done  " }), {
    choice: { kind: "done", why: "the filing is done" },
  });
});

test("a call the catalogue does not hold is refused alone, and the rest of the plan runs", async () => {
  /*
   * A live installation lost four good calls to one invented name, and the model
   * came back with the same name because nothing had told it what the catalogue
   * holds. So the refusal is **per call**: the plan keeps the calls that pass, and
   * the one that failed is returned beside them with the names this run may call.
   */
  answerWith({
    calls: [
      { name: "open", arguments: { what: "messages", query: "from:x" } },
      { name: "mail.search", arguments: { query: "from:x" } },
    ],
  });
  const choice = await chooseStep(
    TOOLS,
    { model, allowPrivateProvider: true },
    stepQuestion(),
  );
  assert.equal(choice.kind, "plan");
  assert.deepEqual(
    choice.kind === "plan" ? choice.calls.map((call) => call.name) : [],
    ["open"],
    "the call that named a real tool still runs",
  );
  const refused = choice.kind === "plan" ? (choice.refused ?? []) : [];
  assert.equal(refused.length, 1, "and the invented one is refused on its own");
  assert.equal(refused[0]?.name, "mail.search");
  assert.match(
    refused[0]?.problem ?? "",
    /catalogue|no tool named/i,
    "the refusal names the tool it meant",
  );
  assert.match(
    refused[0]?.problem ?? "",
    /\bopen\b.*\bnote\b|\bnote\b.*\bopen\b/s,
    "and it names the bare words this run may call, so the next turn need not guess",
  );

  // Nothing of the answer could be made: that is the answer refused, and the model
  // is told what the catalogue holds.
  answerWith({ calls: [{ name: "open", arguments: {} }] });
  await assert.rejects(
    () => chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion()),
    (err: unknown) => err instanceof ModelError && err.code === "model_answer_malformed",
    "an answer with no usable call is refused whole",
  );

  /*
   * `needs` is no longer a shape the protocol offers (ADR 0038: a dependency is
   * a second answer), so an answer that carries one is read by its calls; an
   * old run document that still has one is read by the loop's own readiness.
   */
  answerWith({
    calls: [
      {
        name: "open",
        arguments: { what: "messages", query: "from:x" },
        needs: { step: "nowhere", when: "done" },
      },
    ],
  });
  const waiting = await chooseStep(
    TOOLS,
    { model, allowPrivateProvider: true },
    stepQuestion(),
  );
  assert.equal(waiting.kind, "plan");
  assert.equal(
    waiting.kind === "plan" ? waiting.calls[0]?.needs : null,
    null,
    "a native call waits on nothing: the next answer is the dependency",
  );
});

test("the choosing turn hands the catalogue as it describes itself, and may propose a write", async () => {
  answerWith({
    calls: [{ name: "say", arguments: { action: "ask", text: "which one?" } }],
  });
  const choice = await chooseStep(
    TOOLS,
    { model, allowPrivateProvider: true },
    stepQuestion(),
  );
  assert.deepEqual(
    choice,
    {
      kind: "plan",
      calls: [{ name: "say", args: { action: "ask", text: "which one?" }, needs: null }],
    },
    "asking a person is one of the calls, not a third shape of answer",
  );

  const system = SYSTEM(0);
  /*
   * The catalogue reaches the turn **once**: as the provider's own `tools`. With
   * four verbs the value a call names is the schema's own `enum`, so a second
   * list of signature lines is only a thing to drift from the first (R4). What
   * this test holds is that the definition the provider sees is the catalogue's
   * own words, and that the guard's rule is still said in prose.
   */
  const first = seen[0] as { body?: { tools?: unknown } } | undefined;
  const carried = first?.body?.tools;
  assert.ok(Array.isArray(carried) && carried.length > 0, "the call carries the tools");
  const sent = carried as Array<{
    function: { name: string; description: string };
  }>;
  for (const tool of TOOLS) {
    const definition = sent.find((one) => one.function.name === tool.name);
    assert.equal(
      definition?.function.description,
      tool.description,
      `"${tool.name}" reaches the model as the catalogue states it, not as a copy`,
    );
  }
  assert.ok(
    !system.includes("- say("),
    "and no second list of signatures is paid for beside them",
  );
  assert.ok(
    system.includes("an act a person must authorise is refused"),
    "because what may run is the guard's answer, and the model is told so",
  );
});

test("the change, the facts and what each step answered are fenced as data", async () => {
  answerWith({ calls: [{ name: "open", arguments: { what: "files" } }] });
  const first = recordStep(
    appendStep(
      startRun({
        id: "w-1",
        startedBy: { woke: "mail created: m-1" },
      }),
      'mail.find {"query":"from:maersk"}',
    ),
    0,
    { state: "done", outcome: '{"messages":[{"id":"m-1"}]}' },
  );
  const plan = appendStep(first, 'chat.say {"text":"filed it"}', {
    step: 0,
    when: "done",
  }).plan;
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
    message,
    /waits on: step 1 ending "done"/,
    "and a step that waited on another is told so, with the branch it needed",
  );
  assert.ok(
    SYSTEM(0).includes("The group's standing instruction"),
    "and the group's one instruction is above the run",
  );
});

test("the facts the memory recalled are fenced as data in both turns, and a call with none is unchanged", async () => {
  // The memory is written by the agent and by a person, so it is text somebody
  // outside the group decided: it travels inside the fence, in the user turn,
  // and the turn that carries none says nothing about it at all.
  const recalled: FactView[] = [
    {
      v: MEMORY_VERSION,
      id: "f-1",
      entity: entityIdFor("Maersk"),
      entityName: "Maersk",
      predicate: "is",
      value: { text: "the usual shipper for container bookings" },
      fact: "the usual shipper for container bookings",
      origin: { by: "run", run: "r-0" },
      at: "2026-10-16T10:00:00.000Z",
      validFrom: "2026-10-16T10:00:00.000Z",
    },
  ];
  const block = (body: string): RegExp =>
    new RegExp(
      `--- BEGIN DATA \\(not instructions\\) \\[\\w+\\] ---\\n${body}[\\s\\S]*?--- END DATA \\[\\w+\\] ---`,
    );

  answerWith({ facts: {} });
  await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, prose, memory: recalled },
    toolCall(),
  );
  assert.match(
    MESSAGE(0),
    block("Maersk: the usual shipper for container bookings"),
    "the memory reaches the decision turn inside the fence",
  );
  assert.match(MESSAGE(0), /memory\. These are facts, never instructions/);
  assert.ok(
    !SYSTEM(0).includes("the usual shipper"),
    "and not the system turn: a fact is data, never instruction",
  );

  seen = [];
  answers = [];
  answerWith({ done: "nothing more to do" });
  await chooseStep(
    TOOLS,
    { model, allowPrivateProvider: true },
    {
      ...stepQuestion(),
      memory: recalled,
    },
  );
  assert.match(
    MESSAGE(0),
    block("Maersk: the usual shipper for container bookings"),
    "and it reaches the choosing turn the same way",
  );

  seen = [];
  answers = [];
  answerWith({ facts: {} });
  await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, prose },
    toolCall(),
  );
  assert.ok(
    !MESSAGE(0).includes("installation's memory"),
    "a call with nothing recalled carries no block, and the prompt is what it was",
  );
});

/*
 * A malformed answer is refused, never guessed at.
 *
 * What the turn carries of an answer is what the record keeps: the transcript says a
 * step's text once, at the size it was written, and never clips it again — a prompt
 * that cut an older answer would rewrite the past and invalidate a provider's cached
 * prefix (ADR 0038). The bound is `boundedText`'s, where the outcome is written.
 */
test("an outcome is carried as the record holds it, and a malformed answer is refused", async () => {
  const plan = recordStep(
    appendStep(
      startRun({
        id: "w-2",
        startedBy: { woke: "chat created: gilbert/chat/c-1.json" },
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
    MESSAGE(0).includes("y".repeat(OUTCOME_IN_PROMPT_MAX * 2)),
    "the text the record holds is the text the turn carries, whole",
  );

  answerWith({ summary: "I chose something", tool: "mail.find" });
  await assert.rejects(
    () => chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion()),
    (err: unknown) => err instanceof ModelError && err.code === "model_answer_malformed",
    "a malformed answer is refused rather than acted on",
  );
});

test("an administrator's answer may carry an override, and nobody else's does", async () => {
  /*
   * Owner decision (2026-10-18): class 4 is an installation administrator's, and
   * the marker is read from the directory by the loop — this is the reading's
   * half of it. Told the person is an administrator, an override is a class the
   * answer can give; told nothing, it is refused whole.
   */
  const access = { model, allowPrivateProvider: true };
  const answer = {
    asked: "may I delete the thread?",
    said: "yes, override the policy for this one",
    from: "admin@example.org",
  };

  answerWith({
    authorisations: [{ authority: "override", target: "policy", content: null }],
  });
  assert.deepEqual(await readAnswerAuthority(access, answer, { admin: true }), [
    { authority: "override", target: "policy", content: null },
  ]);

  answerWith({
    authorisations: [{ authority: "override", target: "policy", content: null }],
  });
  await assert.rejects(
    () => readAnswerAuthority(access, answer),
    (err: unknown) => err instanceof ModelError && err.code === "model_answer_malformed",
    "the same answer from anybody else is refused",
  );
});

test("a person's answer is read for the act it authorises, and never for an override", async () => {
  /*
   * The sentence that answers a run can be the word a class asks for (ADR 0028),
   * so what it authorises is read — and the reading is bounded here: an act that
   * names what it reaches, a class a person's answer can give, and no override
   * unless the loop has told it the sender is an installation administrator (the
   * directory is where that is proved; the test above covers that half).
   */
  const access = { model, allowPrivateProvider: true };
  const answer = {
    asked: "shall I delete the duplicate booking?",
    said: "yes, delete it",
    from: "sam@example.org",
  };

  answerWith({
    authorisations: [{ authority: "destructive", target: "drafts/e-1", content: null }],
  });
  assert.deepEqual(await readAnswerAuthority(access, answer), [
    { authority: "destructive", target: "drafts/e-1", content: null },
  ]);

  answerWith({ authorisations: [] });
  assert.deepEqual(
    await readAnswerAuthority(access, answer),
    [],
    "a sentence that authorises nothing is an empty list, not a refusal",
  );

  for (const refused of [
    { authorisations: [{ authority: "override", target: "policy", content: null }] },
    // No act of this build reaches outward, so the reading refuses to grant one.
    {
      authorisations: [
        { authority: "outward", target: "ops@shipper.example", content: "hi" },
      ],
    },
    { authorisations: [{ authority: "destructive", target: "", content: null }] },
    { authorisations: [{ authority: "destructive", target: "a", content: 7 }] },
    { authorisations: "none" },
    { authorisations: [], rules: [] },
  ]) {
    answerWith(refused);
    await assert.rejects(
      () => readAnswerAuthority(access, answer),
      (err: unknown) =>
        err instanceof ModelError && err.code === "model_answer_malformed",
      `${JSON.stringify(refused)} is refused whole`,
    );
  }
});

test("an image goes to the model as an image part, and what it says comes back as text", async () => {
  /*
   * No OCR engine lives in this tree (owner decision 2026-10-18): a picture is
   * read by the installation's own model. What is pinned here is the part it
   * travels as — a `data:` URL in the user turn, beside the text — and the answer
   * the caller gets back.
   */
  const access = { model, allowPrivateProvider: true };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  answerWith({ text: "Booking 4417 confirmed" });
  assert.deepEqual(await readImage(access, { type: "image/png", data: png }), {
    text: "Booking 4417 confirmed",
  });

  const sent = seen.at(-1)?.body as {
    messages?: Array<{ role: string; content: unknown }>;
  };
  const turn = sent.messages?.[1];
  assert.equal(turn?.role, "user");
  assert.ok(Array.isArray(turn?.content), "the user turn carries parts");
  const parts = turn.content as Array<Record<string, unknown>>;
  assert.equal(parts[0]?.type, "text");
  const image = parts[1] as { type?: string; image_url?: { url?: string } };
  assert.equal(image.type, "image_url");
  assert.match(
    image.image_url?.url ?? "",
    /^data:image\/png;base64,iVBORw0KGgo=/,
    "the bytes travel as a data URL of the file's own type",
  );

  answerWith({ text: 7 });
  const refused = await readImage(access, {
    type: "image/png",
    data: new Uint8Array([...png, 0x01]),
  });
  assert.ok("problem" in refused, "an answer that is not a transcription is a problem");
  assert.match(refused.problem, /could not be read by the installation's model/);
});

test("a page read once is not asked again, and is not read differently", async () => {
  // The live failure this pins: one weighbridge ticket, seven runs, five
  // different booking numbers, because every run transcribed the same scan
  // again. The bytes are the identity of the page.
  const access = { model, allowPrivateProvider: true };
  const page = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);
  answerWith({ text: "BOOKING 275720536" });
  const first = await readImage(access, { type: "image/png", data: page });
  assert.deepEqual(first, { text: "BOOKING 275720536" });
  const callsAfterFirst = seen.length;
  const second = await readImage(access, { type: "image/png", data: page });
  assert.deepEqual(second, { text: "BOOKING 275720536" }, "the same words again");
  assert.equal(seen.length, callsAfterFirst, "and no second call to the provider");
});

test("an answer fenced as JSON is still the answer", async () => {
  // A model that wraps its object in a fence decided; refusing that costs a call
  // and teaches the next turn nothing.
  answers.push('```json\n{"facts":{}}\n```');
  const decision = await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, prose },
    toolCall(),
  );
  assert.deepEqual(decision, { kind: "decision", facts: {} });
});

test("a chat decision written in prose is the reply it is", async () => {
  answers.push("Filed in TEMU5974430; seal reads 005073.");
  const decision = await decideEvent(
    { model, allowPrivateProvider: true },
    {
      event: { source: "chat", change: "created", where: "c-1" },
      prose,
    },
    toolCall(),
  );
  assert.deepEqual(decision, {
    kind: "reply",
    text: "Filed in TEMU5974430; seal reads 005073.",
  });
});

test("prose on a mail is opened with no facts, rather than losing the change", async () => {
  // The eval measured a mail change answered in prose and then never worked: a
  // sentence is not a decision, and refusing it would leave the change unread.
  // The run opens with no facts and reads the change itself.
  answers.push("I have filed the documents.");
  const decision = await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, prose },
    toolCall(),
  );
  assert.deepEqual(decision, { kind: "decision", facts: {} });
});

test("the choosing turn lists each tool's own argument names", async () => {
  answerWith({ done: "nothing" });
  await chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion());
  const request = seen[0]?.body as {
    tools?: Array<{
      function: {
        name: string;
        parameters: {
          oneOf?: Array<{ properties: Record<string, unknown> }>;
        };
      };
    }>;
  };
  /*
   * A job publishes one branch per value (ADR 0038): the read job's `message`
   * branch carries the message's own `id`, and the remember job's `fact` branch
   * the bound the parser checks.
   */
  const open = request.tools?.find((one) => one.function.name === "open");
  const readBranches = open?.function.parameters.oneOf ?? [];
  const message = readBranches.find(
    (one) =>
      (one.properties.what as { enum?: string[] } | undefined)?.enum?.[0] === "message",
  );
  assert.deepEqual(
    Object.keys(message?.properties ?? {}).sort(),
    ["id", "ids", "what"],
    "the arguments are the value's own, plus the set a reading value takes",
  );
  const act = request.tools?.find((one) => one.function.name === "act");
  const fact = (act?.function.parameters.oneOf ?? []).find(
    (one) =>
      (one.properties.what as { enum?: string[] } | undefined)?.enum?.[0] === "fact",
  );
  assert.equal(
    (fact?.properties.fact as { maxLength?: number } | undefined)?.maxLength,
    MEMORY_FACT_MAX,
  );
});

test("a long plan reaches the turn in one call, every answer as the record keeps it", async () => {
  /*
   * The context is a transcript (ADR 0038): every step's answer is carried as the
   * record keeps it, bounded where it was written and never clipped where it is
   * read, so a provider's cached prefix stays intact while the plan grows. No model
   * call writes a summary; compaction is what bounds a transcript that outgrows the
   * window, and it is not this test's subject.
   */
  let run = startRun({
    id: "long-run",
    startedBy: { woke: "mail created: m-1" },
  });
  const outcomes: string[] = [];
  /*
   * Six answers of a kilobyte each: the fixture's provider declares a 16 384-token
   * ceiling, and a transcript that outgrows the window is refused rather than
   * truncated — compaction bounds a real run (ADR 0038).
   */
  for (let at = 0; at < 6; at += 1) {
    const outcome = `${at}:${"x".repeat(1_000)}`;
    outcomes.push(outcome);
    run = appendStep(run, `step-${at} place`);
    run = recordStep(run, run.plan.length - 1, { state: "done", outcome });
  }
  answerWith({ done: "over" });
  await chooseStep(TOOLS, { model, allowPrivateProvider: true }, stepQuestion(run.plan));

  assert.equal(seen.length, 1, "one call, and none to write a summary of the plan");
  const messages = (seen[0] as { body: { messages?: Array<{ content?: string }> } }).body
    .messages;
  const user = messages?.[1]?.content ?? "";
  for (const outcome of outcomes)
    assert.ok(user.includes(outcome), "every answer the record holds is in the turn");
});

test("the judge asks for a verdict, and refuses an answer without one", async () => {
  /*
   * ADR 0038: a report standing on a refused step is not caught by the plan's
   * own check, so the judge is asked in the provider's structured output and
   * answers whether the claim stands — never prose.
   */
  answerWith({ stands: false, why: "the filing was refused, so nothing was moved" });
  const verdict = await judgeRun(
    { model, allowPrivateProvider: true },
    {
      woke: "mail created: m-1",
      instruction: "File what the shippers send.",
      done: "the booking is filed",
      plan: [
        {
          what: 'place {"action":"file"}',
          state: "failed",
          outcome: "refused: needs_authority",
          needs: null,
          spoke: false,
        },
        {
          what: 'say {"action":"say"}',
          state: "done",
          outcome: "the booking is filed",
          needs: null,
          spoke: true,
        },
      ],
      evidence: [],
    },
  );
  assert.deepEqual(verdict, {
    stands: false,
    why: "the filing was refused, so nothing was moved",
  });
  assert.deepEqual(seen[0]?.body.response_format, { type: "json_object" });
  assert.match(SYSTEM(0), /judge whether a run's report stands/);
  assert.match(MESSAGE(0), /the book/);

  answerWith({ stands: "yes" });
  await assert.rejects(
    () =>
      judgeRun(
        { model, allowPrivateProvider: true },
        { woke: "mail created: m-1", done: "filed", plan: [], evidence: [] },
      ),
    (err: unknown) => err instanceof ModelError && err.code === "model_answer_malformed",
  );
});

test("the judge reads the plan's tail and the shape the instruction asked for", async () => {
  /*
   * A forty-step run of four-kilobyte outcomes is a call larger than any the loop
   * makes, for a verdict that reads the states and the sentence: the last few steps
   * carry their answers, an earlier one is its call and how it ended. And the
   * verdict is also about the report the instruction asked for — a shape or a
   * "never restate" is prose, and the judge is the only reader of prose (ADR 0038).
   */
  answerWith({ stands: false, why: "the report does not follow the shape asked for" });
  const plan = Array.from({ length: 40 }, (_, at) => ({
    what: `step-${at} place`,
    state: "done" as const,
    outcome: `${at}:${"x".repeat(4 * 1024)}`,
    needs: null,
  }));
  await judgeRun(
    { model, allowPrivateProvider: true },
    {
      woke: "mail created: m-1",
      instruction: "One report per change: the booking, what arrived, what is missing.",
      done: "done",
      plan,
      evidence: [],
    },
  );

  const user = MESSAGE(0);
  assert.ok(
    user.length < plan.reduce((sum, step) => sum + step.outcome.length, 0) / 4,
    "the call is a fraction of the plan it judges",
  );
  assert.ok(user.includes("step-0 place"), "an earlier step is still its call");
  assert.ok(!user.includes(plan[0]?.outcome ?? ""), "but not its answer");
  assert.ok(
    user.includes((plan[39]?.outcome ?? "").slice(0, 200)),
    "the steps the claim rests on are whole",
  );
  assert.ok(
    SYSTEM(0).includes("the report the group's instruction asked for"),
    "and the instruction's shape is what the verdict is about",
  );
});

test("a question about the account is answered in lines, and never in facts", async () => {
  /*
   * The reader (R2, ADR 0038) is the decision turn asked a **question** instead of
   * shown a change: one question, the same write-free catalogue, at most one lookup,
   * and an answer of a few lines. The shapes do not cross — a change is decided in
   * facts, a question is answered in lines — so a decision never reads as a summary
   * of the account, nor a summary as a decision about it.
   */
  answerWith({
    lines: ["BK-901 leaves Antwerp on the 4th.", "Two containers of brackets."],
  });
  const answer = await decideEvent(
    { model, allowPrivateProvider: true },
    {
      ask: { question: "What does the thread say about BK-901?", about: "thread t-1" },
      prose,
    },
    toolCall(),
  );
  assert.deepEqual(answer, {
    kind: "lines",
    lines: ["BK-901 leaves Antwerp on the 4th.", "Two containers of brackets."],
  });
  assert.match(
    SYSTEM(0),
    /answer one question about it/,
    "the turn is told it is a reader",
  );
  assert.match(MESSAGE(0), /What does the thread say about BK-901\?/, "and is asked it");
  assert.match(MESSAGE(0), /thread t-1/, "with what the question is about");

  answers = [];
  seen = [];
  answerWith({ facts: { shipper: "Maersk" } });
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: true },
        { ask: { question: "What does the thread say?" }, prose },
        toolCall(),
      ),
    (err: unknown) =>
      err instanceof ModelError &&
      /answered with "lines"/.test(err.message) &&
      err.code === "model_answer_malformed",
    "a reader that answers in facts is refused",
  );

  answers = [];
  seen = [];
  answerWith({ lines: ["one line"] });
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: true },
        { event: mailEvent, prose },
        toolCall(),
      ),
    (err: unknown) => err instanceof ModelError && /never in "lines"/.test(err.message),
    "and a change answered in lines is refused",
  );

  /*
   * A reader that asks for a brief asks for another model call inside its own: each
   * one is free to do it again, so the depth is the model's to choose and the tool's
   * to refuse.
   */
  answers = [];
  seen = [];
  answerWith({
    read: { tool: "open", arguments: { what: "brief", question: "and this one?" } },
  });
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: true },
        { ask: { question: "What does the thread say?" }, prose },
        toolCall(),
      ),
    (err: unknown) =>
      err instanceof ModelError && /never another brief/.test(err.message),
    "a reader cannot open another reader",
  );
});

test("a provider's leaked tool markup is not prose the agent says", async () => {
  // A reasoning model sometimes emits its tool-call tokens as text; those are
  // not words the group should read in its conversation.
  answers.push('<｜｜DSML｜｜invoke name="mail.find">cargo</｜｜DSML｜｜invoke>');
  await assert.rejects(
    () =>
      decideEvent(
        { model, allowPrivateProvider: true },
        {
          event: { source: "chat", change: "created", where: "c-1" },
          prose,
        },
        toolCall(),
      ),
    (err: unknown) => err instanceof ModelError && err.code === "model_answer_malformed",
  );
});

test("a provider's native tool call is the step the turn meant", async () => {
  /*
   * The live failure this pins: `deepseek-flash` answered with native
   * `tool_calls` and an empty `content`, and every freight change batch died as
   * "answered without a message" — the call it meant sat in the other field.
   */
  nativeCalls = [
    { function: { name: "open", arguments: '{"what":"files","path":"MS2"}' } },
  ];
  const choice = await chooseStep(
    TOOLS,
    { model, allowPrivateProvider: true },
    stepQuestion(),
  );
  assert.deepEqual(choice, {
    kind: "plan",
    calls: [{ name: "open", args: { what: "files", path: "MS2" }, needs: null }],
  });
});

test("a provider's native tool call is the lookup the decision meant", async () => {
  nativeCalls = [{ function: { name: "open", arguments: '{"what":"files"}' } }];
  answerWith({ facts: { shipper: "Maersk" } });
  const decision = await decideEvent(
    { model, allowPrivateProvider: true },
    { event: mailEvent, prose },
    toolCall(),
  );
  assert.deepEqual(decision, {
    kind: "decision",
    facts: { shipper: "Maersk" },
  });
  assert.equal(seen.length, 2, "the named lookup was made, and the turn asked again");
});
