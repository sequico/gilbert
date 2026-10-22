/**
 * The agent's measures, in the OTLP shape (ADR 0038).
 *
 * What is pinned here is the shape a collector reads — the GenAI attributes, the
 * resource, the log-record encoding — and the one failure mode that matters: an
 * endpoint that refuses is a thrown error the pass reports as its gap, never a
 * run failing.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { after, before, test } from "node:test";
import { freePort } from "../testkit.js";

const { emitMeasures, otlpBody } = await import("./otlp.js");

interface Received {
  url: string;
  type: string;
  body: Record<string, unknown>;
}

const received: Received[] = [];
let refuse = false;
const PORT = await freePort();
const collector = createServer((req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    received.push({
      url: req.url ?? "",
      type: String(req.headers["content-type"] ?? ""),
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
    });
    res.writeHead(refuse ? 503 : 200, { "content-type": "application/json" });
    res.end(refuse ? '{"error":"no storage here"}' : "{}");
  });
});

before(async () => {
  await new Promise<void>((resolve) => collector.listen(PORT, "127.0.0.1", resolve));
});
after(() => collector.close());

/** One measure, as the loop builds them. */
const run = {
  kind: "run" as const,
  at: "2026-10-22T10:00:00.000Z",
  model: {
    provider: "deepseek",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.example/v1",
    apiKey: "sk-a-key",
    structured: "json" as const,
    outputTokens: 4096,
  },
  tokens: 900,
  promptTokens: 700,
  completionTokens: 200,
  ms: 4_500,
  steps: 3,
  calls: 2,
  refusals: 1,
  ending: "done",
};

/** The log records one body carries. */
function recordsOf(body: Record<string, unknown>): Array<{
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
}> {
  const resourceLogs = body.resourceLogs as Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
    scopeLogs: Array<{ logRecords: unknown[] }>;
  }>;
  return (resourceLogs[0]?.scopeLogs[0]?.logRecords ?? []) as never;
}

/** One attribute of a record, as text. */
function attribute(
  record: {
    attributes: Array<{
      key: string;
      value: { stringValue?: string; intValue?: string };
    }>;
  },
  key: string,
): string | undefined {
  const found = record.attributes.find((one) => one.key === key);
  return found?.value.stringValue ?? found?.value.intValue;
}

test("a run's measure carries the GenAI shape to /v1/logs", async () => {
  received.length = 0;
  await emitMeasures(`http://127.0.0.1:${PORT}`, [run]);

  assert.equal(received.length, 1, "one request for the batch");
  assert.equal(received[0]?.url, "/v1/logs", "the OTLP/HTTP logs path");
  assert.match(received[0]?.type ?? "", /application\/json/);
  const records = recordsOf(received[0]?.body ?? {});
  assert.equal(records.length, 1);
  const record = records[0] as never;
  assert.equal(attribute(record, "gen_ai.operation.name"), "agent.run");
  assert.equal(attribute(record, "gen_ai.request.model"), "deepseek-flash");
  assert.equal(attribute(record, "gen_ai.usage.input_tokens"), "700");
  assert.equal(attribute(record, "gen_ai.usage.output_tokens"), "200");
  assert.equal(attribute(record, "gilbert.agent.steps"), "3");
  assert.equal(attribute(record, "gilbert.agent.calls"), "2");
  assert.equal(attribute(record, "gilbert.agent.refusals"), "1");
  assert.equal(attribute(record, "gilbert.agent.ending"), "done");
  assert.equal(attribute(record, "gilbert.agent.ms"), "4500");
});

test("a pass's measure carries what a pass knows, and invents no split", () => {
  const body = otlpBody([
    {
      kind: "pass",
      at: run.at,
      model: null,
      tokens: 1_200,
      ms: 800,
      steps: 0,
      calls: 0,
      refusals: 0,
      ending: "pass",
      gaps: 2,
    },
  ]);
  const record = recordsOf(body)[0] as never;
  assert.equal(attribute(record, "gen_ai.operation.name"), "agent.pass");
  assert.equal(attribute(record, "gilbert.agent.tokens"), "1200");
  assert.equal(attribute(record, "gilbert.agent.gaps"), "2");
  assert.equal(
    attribute(record, "gen_ai.usage.input_tokens"),
    undefined,
    "no split is invented",
  );
  const system = (
    body.resourceLogs as never as Array<{
      resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
    }>
  )[0];
  assert.deepEqual(
    system?.resource.attributes.map((one) => `${one.key}=${one.value.stringValue}`),
    ["service.name=gilbert"],
    "a measure with no model names the service and no provider",
  );
});

test("an endpoint that refuses is a thrown error with the collector's words", async () => {
  refuse = true;
  try {
    await assert.rejects(
      () => emitMeasures(`http://127.0.0.1:${PORT}`, [run]),
      /answered 503/,
      "the refusal names the status",
    );
  } finally {
    refuse = false;
  }
});
