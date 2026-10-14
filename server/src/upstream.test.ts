import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchAccountIntrospection,
  fetchUpstreamSession,
  UpstreamError,
} from "./upstream.js";

/**
 * A refusal of the account is not a wrong password.
 *
 * The mail server answers 403 for a permission, a suspension or a policy
 * block; folding that into a 401 tells the browser the credentials were bad,
 * and the browser turns any 401 outside the login path into a full sign-out —
 * a reader asked for a password that was never the problem. Both helpers keep
 * the status instead, so `upstreamFailure` answers `forbidden`.
 */

/** Answer every fetch with one status, until the returned restore runs. */
function refusing(status: number): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("a 403 from the session endpoint is a 403, not a 401", async () => {
  const restore = refusing(403);
  try {
    await assert.rejects(
      fetchUpstreamSession("Basic x"),
      (err: unknown) => err instanceof UpstreamError && err.status === 403,
    );
  } finally {
    restore();
  }
});

test("a 403 from introspection is a 403, not a 401", async () => {
  const restore = refusing(403);
  try {
    await assert.rejects(
      fetchAccountIntrospection("Basic x"),
      (err: unknown) => err instanceof UpstreamError && err.status === 403,
    );
  } finally {
    restore();
  }
});

test("a 401 from either helper is still the bad-credential 401", async () => {
  const restore = refusing(401);
  try {
    for (const call of [
      () => fetchUpstreamSession("Basic x"),
      () => fetchAccountIntrospection("Basic x"),
    ]) {
      await assert.rejects(
        call(),
        (err: unknown) => err instanceof UpstreamError && err.status === 401,
      );
    }
  } finally {
    restore();
  }
});
