import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The directory gate closed (ADR 0001, the admin Users surface): when the
 * server refuses the Principal query — a Gilbert administrator who is not a
 * Stalwart server administrator hits Stalwart's `allow_directory_query`
 * gate — fetchDirectoryUsers degrades to { denied } instead of failing the
 * whole surface.
 */

const { fetchDirectoryUsers } = await import("./upstream.js");

const SESSION = {
  apiUrl: "https://mail.example.com/api/jmap",
  accounts: {
    a1: {
      isPersonal: true,
      accountCapabilities: { "urn:ietf:params:jmap:principals": {} },
    },
  },
} as never;

test("a refused directory query degrades to denied, not to an error", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
  try {
    const result = await fetchDirectoryUsers("Basic dGVzdDp0ZXN0", SESSION);
    assert.ok("denied" in result, "the gate is reported as denied");
    assert.ok(!("users" in result), "no partial user list is claimed");
  } finally {
    globalThis.fetch = real;
  }
});

/**
 * The directory is read from the server that issued the session.
 *
 * Same rule as the locale read beside it (#238): a domain mapped to its own
 * Stalwart is asked there, because the default server holds a different
 * installation's accounts.
 */
test("the directory is read from the server that issued the session", async () => {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input instanceof Request ? input.url : input));
    return new Response("{}", { status: 403 });
  }) as typeof fetch;
  try {
    await fetchDirectoryUsers("Basic dGVzdDp0ZXN0", {
      ...(SESSION as Record<string, unknown>),
      apiUrl: "https://mail.mapped.test/api/jmap",
      baseUrl: "https://mail.mapped.test",
    } as never);
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(seen.length >= 1, "the directory read reached the wire");
  for (const url of seen) {
    assert.ok(
      url.startsWith("https://mail.mapped.test/"),
      `${url} went to the default server rather than the session's own`,
    );
  }
});
