import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync } from "node:zlib";

/*
 * The two things a static file can say about itself: whether it changed, and in
 * what encoding it may be sent.
 *
 * Neither is a preference. The shell and the never-stale files are revalidated
 * on every load — that is what `no-cache` asks for — and with no validator to
 * answer with, every one of those revalidations downloaded the whole file
 * again. And the bundle was gzipped on every request that accepted gzip,
 * because Brotli at the quality worth using is far too slow to run per request;
 * `scripts/precompress.mjs` writes the copies at build time instead.
 *
 * A static root of our own, since CI runs the tests before the build and
 * `web/dist` does not exist yet.
 */
const root = mkdtempSync(join(tmpdir(), "gilbert-static-"));
mkdirSync(join(root, "assets"));

const shell = "<!doctype html><title>Gilbert</title>";
const bundle = `console.log("${"x".repeat(4096)}")\n`;
writeFileSync(join(root, "index.html"), shell);
writeFileSync(join(root, "assets", "app-a1b2c3.js"), bundle);
writeFileSync(
  join(root, "assets", "app-a1b2c3.js.br"),
  brotliCompressSync(Buffer.from(bundle), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }),
);
writeFileSync(
  join(root, "assets", "app-a1b2c3.js.gz"),
  gzipSync(Buffer.from(bundle), { level: 9 }),
);
// A copy older than its file describes something else, and must not be served.
const stale = join(root, "assets", "plain-a1b2c3.js");
writeFileSync(stale, bundle);
writeFileSync(`${stale}.br`, brotliCompressSync(Buffer.from(bundle)));
utimesSync(`${stale}.br`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

process.env.STATIC_DIR = root;
process.env.STALWART_URL = "http://127.0.0.1:1";
const { createApp } = await import("./app.js");

const get = (path: string, headers: Record<string, string> = {}) =>
  createApp().request(path, { headers });

test("the shell carries a validator, and a matching one gets a 304", async () => {
  const first = await get("/");
  const etag = first.headers.get("etag");
  assert.ok(etag, "index.html should come back with an ETag");
  const again = await get("/", { "if-none-match": etag });
  assert.equal(again.status, 304, "the same shell is not downloaded twice");
  // A 304 carries no body: revalidating costs headers, not the file.
  assert.equal(await again.text(), "");
});

test("so does a plain file, whose validator is its size and mtime", async () => {
  const first = await get("/assets/plain-a1b2c3.js");
  const etag = first.headers.get("etag");
  assert.ok(etag);
  assert.equal(
    (await get("/assets/plain-a1b2c3.js", { "if-none-match": etag })).status,
    304,
  );
});

test("a validator that does not match still gets the file", async () => {
  const res = await get("/assets/plain-a1b2c3.js", { "if-none-match": 'W/"nope"' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), bundle);
});

test("a precompressed copy is served when the browser takes it", async () => {
  const br = await get("/assets/app-a1b2c3.js", { "accept-encoding": "br, gzip" });
  assert.equal(br.headers.get("content-encoding"), "br");
  assert.equal(
    br.headers.get("vary"),
    "Accept-Encoding",
    "the cache must key on the encoding",
  );
  /*
   * The bytes on the wire are the compressed ones — the test client decodes
   * nothing, so this is what a browser would have to decode — and they decode
   * to exactly the file. That also proves nobody compressed it twice: a second
   * pass over already-encoded bytes would not come back as this source.
   */
  const raw = Buffer.from(await br.arrayBuffer());
  assert.equal(brotliDecompressSync(raw).toString(), bundle);
  assert.equal(Number(br.headers.get("content-length")), raw.length);
  assert.ok(raw.length < bundle.length, "and it is smaller than the file");
});

test("gzip is used when Brotli is not offered, and nothing when neither is", async () => {
  const gz = await get("/assets/app-a1b2c3.js", { "accept-encoding": "gzip" });
  assert.equal(gz.headers.get("content-encoding"), "gzip");
  const plain = await get("/assets/app-a1b2c3.js");
  assert.equal(plain.headers.get("content-encoding"), null);
  assert.equal(Number(plain.headers.get("content-length")), bundle.length);
});

test("q=0 means the browser does not accept it", async () => {
  const res = await get("/assets/app-a1b2c3.js", { "accept-encoding": "br;q=0, gzip" });
  assert.equal(res.headers.get("content-encoding"), "gzip");
});

test("a copy older than the file it came from is not served", async () => {
  // The file was rewritten without precompressing it again, so the .br beside
  // it describes the previous one. Serving those bytes would be serving a
  // different file.
  const res = await get("/assets/plain-a1b2c3.js", { "accept-encoding": "br" });
  assert.equal(res.headers.get("content-encoding"), null);
  assert.equal(await res.text(), bundle);
});

test("a HEAD asks the same question and gets no body", async () => {
  const res = await createApp().request("/assets/app-a1b2c3.js", {
    method: "HEAD",
    headers: { "accept-encoding": "br" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "br");
  assert.ok(res.headers.get("content-length"));
  assert.equal(await res.text(), "");
});
