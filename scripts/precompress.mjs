#!/usr/bin/env node
/*
 * Write a Brotli and a gzip copy beside every compressible file in a web build.
 *
 * The server gzipped the bundle again on every request that asked for it, at a
 * level chosen for speed. These are made once, at the level chosen for size,
 * and `server/src/static.ts` hands one out when the browser accepts it: Brotli
 * at 11 is around 15% smaller than gzip for this bundle and far too slow to run
 * per request, which is why it was never offered at all.
 *
 *   node scripts/precompress.mjs web/dist
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** What is worth compressing, by extension: text, and the one binary that is. */
const COMPRESSIBLE = new Set([
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".svg",
  ".json",
  ".webmanifest",
  ".txt",
  ".wasm",
]);

/** Below this the encoding costs more bytes than it saves. */
const MIN_BYTES = 1024;

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else yield p;
  }
}

const root = process.argv[2];
if (!root) {
  console.error("usage: precompress.mjs <dir>");
  process.exit(2);
}

let count = 0;
let before = 0;
let brotli = 0;
let gzipped = 0;
for (const p of files(root)) {
  if (!COMPRESSIBLE.has(extname(p)) || statSync(p).size < MIN_BYTES) continue;
  const data = readFileSync(p);
  const br = brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
  const gz = gzipSync(data, { level: 9 });
  writeFileSync(`${p}.br`, br);
  writeFileSync(`${p}.gz`, gz);
  count++;
  before += data.length;
  brotli += br.length;
  gzipped += gz.length;
}

const kb = (n) => (n / 1024).toFixed(0);
console.log(
  `precompressed ${count} file(s): ${kb(before)} KB raw -> ${kb(brotli)} KB brotli, ${kb(gzipped)} KB gzip`,
);
