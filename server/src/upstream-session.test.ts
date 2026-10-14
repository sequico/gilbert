import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

process.env.STALWART_URL = "https://default.example";

const { sessionUpstream, upstreamFor } = await import("./upstream.js");
const { config } = await import("./config.js");

/**
 * Which Stalwart a session of ours is asked (#238).
 *
 * `sessionUpstream` exists because fourteen call sites wrote the same three
 * arguments by hand and one of them — `accountCtx`, which eighteen endpoints
 * read behind it — left the base out, so on an installation with more than one
 * Stalwart those endpoints asked the default server for an account living on
 * another one. This asks the question the call sites used to: with a mapped
 * domain in place, is the base the account's own server?
 *
 * `fetchUpstreamSession` is stubbed through the network rather than the module,
 * because the module is the thing under test: a wrong base arrives as a request
 * to the wrong host, which is exactly what the original defect did.
 */

type Seen = { base: string; authorization: string };

describe("sessionUpstream", () => {
  const seen: Seen[] = [];
  const realFetch = globalThis.fetch;

  before(() => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const at = typeof url === "string" ? url : url.toString();
      seen.push({
        base: new URL(at).origin,
        authorization: (init?.headers as Record<string, string>)?.authorization ?? "",
      });
      return new Response(
        JSON.stringify({ apiUrl: new URL("/jmap", at).toString(), capabilities: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  it("asks the account's own Stalwart when its domain is mapped", async () => {
    config.stalwartServers["mapped.test"] = "https://mail.mapped.test";
    try {
      seen.length = 0;
      const upstream = await sessionUpstream({
        id: "session-1",
        authorization: "Basic mapped",
        username: "someone@mapped.test",
      });
      assert.deepEqual(
        seen.map((s) => s.base),
        ["https://mail.mapped.test"],
      );
      assert.equal(upstream.apiUrl, "https://mail.mapped.test/jmap");
    } finally {
      delete config.stalwartServers["mapped.test"];
    }
  });

  it("asks the default when the domain is not mapped", async () => {
    seen.length = 0;
    await sessionUpstream({
      id: "session-2",
      authorization: "Basic plain",
      username: "someone@anything.test",
    });
    assert.deepEqual(
      seen.map((s) => s.base),
      ["https://default.example"],
    );
  });

  it("passes the session's own credential, whoever answered the previous one", async () => {
    config.stalwartServers["mapped.test"] = "https://mail.mapped.test";
    try {
      seen.length = 0;
      await sessionUpstream({
        id: "session-3",
        authorization: "Basic second",
        username: "someone@mapped.test",
      });
      assert.equal(seen[0]?.authorization, "Basic second");
    } finally {
      delete config.stalwartServers["mapped.test"];
    }
  });

  it("resolves the same server the username rule resolves", async () => {
    config.stalwartServers["mapped.test"] = "https://mail.mapped.test";
    try {
      seen.length = 0;
      await sessionUpstream({
        id: "session-4",
        authorization: "Basic check",
        username: "someone@mapped.test",
      });
      assert.equal(seen[0]?.base, upstreamFor("someone@mapped.test"));
    } finally {
      delete config.stalwartServers["mapped.test"];
    }
  });
});
