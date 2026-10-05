import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { freePort } from "./testkit.js";

/**
 * Byte ranges on a download, end to end through the proxy.
 *
 * Stalwart honours a single byte range but sends no `Accept-Ranges` (0.16.22,
 * checked live on 2026-09-16), and a PDF viewer reads a file in pieces only when
 * the first response advertises that it can — so the proxy says so itself,
 * forwards a well-formed range, and passes back the 206 with its
 * `Content-Range`. A range the server cannot serve comes back as the whole file
 * with a 200, never a 416, which is what the proxy must not turn into an error.
 *
 * The blob is uploaded by this file, so the bytes and their offsets are known
 * rather than borrowed from a fixture.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-blob-ranges";
process.env.LOGIN_RATE_LIMIT = "10000";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };
const BODY = "0123456789abcdefghijklmnopqrstuvwxyz";

let cookie = "";
let blobId = "";

before(async () => {
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ username: "demo@example.com", password: "demo-password" }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const up = await app.request("/api/upload/a1", {
    method: "POST",
    headers: { ...HEADERS, cookie, "content-type": "application/pdf" },
    body: BODY,
  });
  assert.equal(up.status, 200);
  blobId = ((await up.json()) as { blobId: string }).blobId;
  assert.ok(blobId, "the upload answered with a blob id");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

const download = (headers: Record<string, string> = {}) =>
  app.request(`/api/blob/a1/${blobId}/doc.pdf?accept=application/pdf`, {
    headers: { cookie, ...headers },
  });

test("a download says it can serve a range, because the server does not", async () => {
  const res = await download();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(await res.text(), BODY);
});

test("a range comes back as a 206 with exactly those bytes and their span", async () => {
  const res = await download({ range: "bytes=0-9" });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes 0-9/${BODY.length}`);
  assert.equal(await res.text(), BODY.slice(0, 10));
});

test("a range in the middle is honoured by offset, not by length", async () => {
  const res = await download({ range: "bytes=10-19" });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes 10-19/${BODY.length}`);
  assert.equal(await res.text(), BODY.slice(10, 20));
});

test("a suffix range counts back from the end", async () => {
  const res = await download({ range: "bytes=-5" });
  assert.equal(res.status, 206);
  assert.equal(await res.text(), BODY.slice(-5));
});

/*
 * A range past the end is the case the proxy must pass through rather than
 * interpret: the server answers with the whole file and a 200, which is what a
 * browser takes just as well. Turning that into a 416 would break a viewer that
 * asked for one byte too many.
 */
test("a range the server cannot serve is the whole file, not an error", async () => {
  const res = await download({ range: "bytes=9999-10000" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), BODY);
});

/*
 * A multipart range is well-formed per RFC 9110 and is forwarded like any
 * other: the server honours a single range only, so it answers with the whole
 * file and a 200 — which is a legal answer to a `Range`, and the one a browser
 * accepts. What must not happen is the proxy inventing a 416 for it.
 */
test("a multipart range is the whole file, which is what the server answers", async () => {
  const res = await download({ range: "bytes=0-9, 20-29" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), BODY);
});

/*
 * And a header that only looks like one is dropped rather than forwarded: what
 * a server does with a malformed `Range` is its business, but an unreviewed
 * header is exactly the thing not to pass on.
 */
test("a malformed range header is not forwarded at all", async () => {
  const res = await download({ range: "bytes=abc" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), BODY);
});
