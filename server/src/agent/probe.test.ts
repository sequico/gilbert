import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { type ModelAccess, probeModel } from "./model.js";

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

test("a reachable model is identified by the name it answers under", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ model: "gpt-5-2026-08-01" }), {
      status: 200,
    })) as typeof fetch;
  assert.deepEqual(await probeModel(access()), {
    ok: true,
    identity: "openai/gpt-5-2026-08-01",
  });
});

test("the key, the address and the wire are told apart", async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  assert.deepEqual(await probeModel(access()), { ok: false, reason: "unauthorized" });

  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  assert.deepEqual(await probeModel(access()), { ok: false, reason: "not_found" });

  globalThis.fetch = (async () => {
    throw new Error("down");
  }) as typeof fetch;
  assert.deepEqual(await probeModel(access()), { ok: false, reason: "unreachable" });
});
