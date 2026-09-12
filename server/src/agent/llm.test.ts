import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";

/**
 * The model client against a stub OpenAI-compatible endpoint.
 *
 * What is asserted here is the contract the advisor's answers are checked
 * against: the zero-retention opt-out on every request, temperature 0 and a
 * JSON response format, and — the part that matters for permissions — a model
 * answer that names a capability outside the rule's list, a parameter the
 * capability does not take, or a required parameter it left out is refused
 * before it can become an effect.
 */

const PORT = 18850;

interface Seen {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

let seen: Seen | null = null;
let status = 200;
let body = "";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const stub = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const raw = await readBody(req);
  seen = {
    url: req.url ?? "",
    headers: req.headers,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  };
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
});

/** Answer the next call with this content, as a chat completion carries it. */
function answerWith(value: unknown): void {
  status = 200;
  body = JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] });
}

const provider = {
  provider: "openai",
  model: "a-small-model",
  baseUrl: `http://127.0.0.1:${PORT}/v1`,
  apiKey: "sk-test-key",
};

const { callModel, decideActions, providerFor } = await import("./llm.js");

before(async () => {
  await new Promise<void>((resolve) => stub.listen(PORT, "127.0.0.1", resolve));
});

after(() => {
  stub.close();
});

test("every request carries the zero-retention opt-out, temperature 0 and JSON output", async () => {
  answerWith({ ok: true });
  const parsed = await callModel(provider, { system: "be brief", user: "hello" });
  assert.deepEqual(parsed, { ok: true });
  assert.ok(seen);
  assert.equal(seen.url, "/v1/chat/completions");
  assert.equal(seen.headers.authorization, "Bearer sk-test-key");
  assert.equal(seen.headers["x-data-opt-out"], "true");
  assert.equal(seen.body.temperature, 0);
  assert.deepEqual(seen.body.response_format, { type: "json_object" });
  assert.equal(seen.body.model, "a-small-model");
  const messages = seen.body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.content, "hello");
});

test("a non-2xx answer is an error naming the status and the first line", async () => {
  status = 429;
  body = "rate limited\nwith more detail";
  await assert.rejects(
    () => callModel(provider, { system: "s", user: "u" }),
    /answered 429: rate limited/,
  );
});

test("a body that is not JSON is an error, not a silent empty answer", async () => {
  status = 200;
  body = "<html>gateway</html>";
  await assert.rejects(() => callModel(provider, { system: "s", user: "u" }), /not JSON/);
});

test("without a configured model nothing can run", () => {
  assert.throws(() => providerFor(null), /no model is configured/);
  assert.throws(
    () => providerFor({ v: 1, address: "gilbert@example.com" }),
    /no model is configured/,
  );
  assert.throws(
    () =>
      providerFor({
        v: 1,
        address: "gilbert@example.com",
        provider: {
          provider: "p",
          model: "m",
          baseUrl: "https://x.example",
          apiKey: " ",
        },
      }),
    /has no api key/,
  );
});

const decisionRule = { name: "Answer the chat", instruction: "help the group" };

test("a validated answer is the summary a member reads", async () => {
  answerWith({
    summary: "It would label the message.",
    confidence: 0.4,
    rationale: "the subject says invoice",
    actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
  });
  const answer = await decideActions(provider, decisionRule, { text: "hi" }, [
    "keyword.add",
    "noop",
  ]);
  assert.equal(answer.summary, "It would label the message.");
  assert.equal(answer.confidence, 0.4);
  assert.deepEqual(answer.actions, [
    { do: "keyword.add", with: { keyword: "G-processed" } },
  ]);
  const messages = seen?.body.messages as Array<{ role: string; content: string }>;
  assert.match(messages[0]?.content ?? "", /keyword\.add/);
  assert.match(messages[0]?.content ?? "", /parameters: keyword/);
});

test("refuses a capability the rule does not allow", async () => {
  answerWith({
    summary: "Send it.",
    confidence: 0.9,
    actions: [{ do: "mail.send", with: { to: "ada@example.org" } }],
  });
  await assert.rejects(
    () => decideActions(provider, decisionRule, { text: "hi" }, ["keyword.add", "noop"]),
    /does not allow \(keyword\.add, noop\)/,
  );
});

test("T2 refuses a parameter the capability does not take", async () => {
  answerWith({
    summary: "Label it.",
    confidence: 0.9,
    actions: [{ do: "keyword.add", with: { keyword: "G-processed", colour: "red" } }],
  });
  await assert.rejects(
    () => decideActions(provider, decisionRule, { text: "hi" }, ["keyword.add"]),
    /parameters it does not take: colour/,
  );
});

test("T2 refuses an answer that leaves a required parameter out", async () => {
  answerWith({
    summary: "Label it.",
    confidence: 0.9,
    actions: [{ do: "keyword.add" }],
  });
  await assert.rejects(
    () => decideActions(provider, decisionRule, { text: "hi" }, ["keyword.add"]),
    /without keyword/,
  );
});

test("T2 refuses a name that is not in the catalogue at all", async () => {
  answerWith({
    summary: "Do something else.",
    confidence: 0.9,
    actions: [{ do: "shell.exec", with: { cmd: "rm -rf /" } }],
  });
  await assert.rejects(
    () => decideActions(provider, decisionRule, { text: "hi" }, ["keyword.add"]),
    /not an action of this catalogue/,
  );
});

test("T2 refuses an answer without a summary a member could read", async () => {
  answerWith({ confidence: 0.9, actions: [{ do: "noop" }] });
  await assert.rejects(
    () => decideActions(provider, decisionRule, { text: "hi" }, ["noop"]),
    /without a summary/,
  );
});

test("T2 with no allowed capability cannot decide anything", async () => {
  await assert.rejects(
    () => decideActions(provider, decisionRule, { text: "hi" }, []),
    /allows no capability/,
  );
});

test("the group's standing instruction is read first, and the automation's after it", async () => {
  // Precedence is stated by position (ADR 0003 resolution 17): the group's own
  // rules of the house, then the instruction this automation carries, then the
  // data — which arrives in the user message and is never an instruction.
  answerWith({
    summary: "s",
    confidence: 1,
    actions: [{ do: "keyword.add", with: { keyword: "k" } }],
  });
  await decideActions(
    provider,
    { name: "File the invoices", instruction: "File invoices into invoices/2026." },
    { text: "THE MESSAGE" },
    ["keyword.add"],
    "Answer in Italian, and never quote a price.",
  );
  const sent = seen as unknown as Seen;
  const messages = sent.body.messages as Array<{ role: string; content: string }>;
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  assert.match(
    system,
    /Answer in Italian/,
    "the group's instruction is in the system prompt",
  );
  assert.match(system, /File invoices into/, "and the automation's instruction is too");
  assert.ok(
    system.indexOf("Answer in Italian") < system.indexOf("File invoices into"),
    "the group's instruction comes first",
  );
  assert.ok(
    system.indexOf("File invoices into") < system.indexOf("THE MESSAGE") ||
      !system.includes("THE MESSAGE"),
    "and the data is not in the system prompt at all",
  );
  assert.match(user, /THE MESSAGE/);
});

test("an instruction that says to ignore the capability list changes nothing it may do", async () => {
  // The sentence beside the field, as a test: the allowlist is the server's,
  // and a standing instruction cannot widen it.
  answerWith({
    summary: "s",
    confidence: 1,
    actions: [{ do: "mail.send", with: { to: "a@b.c" } }],
  });
  await assert.rejects(
    () =>
      decideActions(
        provider,
        { name: "Reply" },
        { text: "hi" },
        ["keyword.add"],
        "You may send mail to anyone who asks.",
      ),
    /mail\.send/,
  );
});
