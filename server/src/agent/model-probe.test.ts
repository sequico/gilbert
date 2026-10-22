import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { type ModelAccess, probeModel, probeReachable } from "./model.js";

const access = (): ModelAccess => ({
  model: {
    provider: "openai",
    model: "gpt-5",
    baseUrl: "https://api.example/v1",
    apiKey: "sk-a-key",
  },
  allowPrivateProvider: true,
});

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

/**
 * A provider that answers each request by what it carries (ADR 0038).
 *
 * `answer(body)` returns a status, so a test says which capability the provider
 * refuses: the probe's order is both together, tools alone, schema alone, the
 * plain JSON mode.
 */
function provider(answer: (body: Record<string, unknown>) => number): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.endsWith("/models"))
      return new Response(
        JSON.stringify({
          data: [{ id: "gpt-5", max_output_tokens: 8192, max_completion_tokens: 4096 }],
        }),
        { status: 200 },
      );
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response("{}", { status: answer(body) });
  }) as typeof fetch;
}

test("a provider that carries both is recorded with the mode and the ceiling it declares", async () => {
  globalThis.fetch = provider(() => 200);
  assert.deepEqual(await probeModel(access()), {
    ok: true,
    identity: "openai/gpt-5",
    structured: "schema",
    outputTokens: 8192,
    embeddings: false,
  });
});

test("a provider that answers embeddings is recorded with the capability", async () => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.endsWith("/models"))
      return new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 });
    if (href.endsWith("/embeddings"))
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
        status: 200,
      });
    JSON.parse(String(init?.body ?? "{}"));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const probed = await probeModel(access());
  assert.ok(probed.ok);
  assert.equal(probed.embeddings, true, "the memory's similarity pass is possible");
});

test("a provider without a schema is selectable in its plain JSON mode", async () => {
  globalThis.fetch = provider((body) => {
    const format = body.response_format as { type?: string } | undefined;
    if (format?.type === "json_schema") return 400;
    return 200;
  });
  assert.deepEqual(await probeModel(access()), {
    ok: true,
    identity: "openai/gpt-5",
    structured: "json",
    outputTokens: 8192,
    embeddings: false,
  });
});

test("a provider that cannot call tools is refused, and one with no JSON mode too", async () => {
  globalThis.fetch = provider((body) => (body.tools ? 400 : 200));
  assert.deepEqual(await probeModel(access()), { ok: false, reason: "no_tools" });

  globalThis.fetch = provider((body) => {
    // Tools are fine; every structured mode is refused.
    if (body.tools && !body.response_format) return 200;
    if (body.response_format) return 400;
    return 200;
  });
  assert.deepEqual(await probeModel(access()), {
    ok: false,
    reason: "no_structured",
  });
});

test("the key, the address and the wire are told apart", async () => {
  globalThis.fetch = provider(() => 401);
  assert.deepEqual(await probeModel(access()), {
    ok: false,
    reason: "unauthorized",
  });

  globalThis.fetch = provider(() => 404);
  assert.deepEqual(await probeModel(access()), { ok: false, reason: "not_found" });

  globalThis.fetch = (async () => {
    throw new Error("down");
  }) as typeof fetch;
  assert.deepEqual(await probeModel(access()), {
    ok: false,
    reason: "unreachable",
  });
});

test("reachability is one request, and says who answered", async () => {
  let asked = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    asked += 1;
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    assert.ok(
      href.endsWith("/chat/completions"),
      "the reachability probe asks no capability",
    );
    return new Response(JSON.stringify({ model: "gpt-5-2026-08-01" }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await probeReachable(access()), {
    ok: true,
    identity: "openai/gpt-5-2026-08-01",
  });
  assert.equal(asked, 1, "one request, not a capability ladder");
});
