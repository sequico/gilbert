import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Context, Handler } from "hono";
import { stripBasePath } from "../../scripts/basePath.mjs";

/*
 * Files that must not be served from anybody's cache, the way index.html is
 * not.
 *
 * Sending them with `max-age=3600` looks harmless -- they are neither hashed
 * assets nor HTML -- and it is not, for two of them, with a CDN in front making
 * it worse: on a deploy the origin serves the new build while the edge goes on
 * handing out the previous `sw.js`, `cf-cache-status: HIT`, on an edge TTL of
 * its own that is longer than what was asked for.
 *
 * What that costs is specific rather than general. The service worker is the
 * app's whole update mechanism: a stale one keeps serving the shell it knows
 * and never learns there is a newer build, so the deploy simply does not
 * arrive. And a manifest and a worker that disagree is worse than either being
 * old -- a fresh manifest advertising a share target to the operating system,
 * answered by a worker that has never heard of one, sends the share to the
 * server for a 405.
 *
 * `no-cache` does not mean "do not store": the browser and the CDN may both
 * keep it and revalidate, which is a 304 and costs nothing. It means neither
 * gets to serve it without asking first, which is the whole requirement.
 */
function isNeverStale(rel: string, ext: string): boolean {
  return ext === ".webmanifest" || rel === "/sw.js" || rel === "sw.js";
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * Content Security Policy for the app shell. Inline styles are required because
 * sanitized HTML email carries style attributes; everything else is strict.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

/*
 * The shell's `Cache-Control`, and why `no-transform` is part of it.
 *
 * The policy above admits no inline and no third-party script. A transforming
 * proxy in front of the app answers that by injecting its own scripts into the
 * HTML anyway -- Cloudflare adds its Web Analytics beacon and its Bot Fight
 * Mode loader -- and the browser blocks both and reports them as violations.
 * An origin that says `no-transform` is the documented way to keep the edge's
 * hands off the body, so the policy stays strict instead of being widened to
 * admit what the proxy adds. `no-cache` beside it keeps the shell revalidated
 * on every load.
 */
const HTML_CACHE_CONTROL = "no-cache, no-transform";

/**
 * What a file is, for the purpose of "has it changed".
 *
 * The shell and the never-stale files are revalidated on every load, and with no
 * validator to send back, every revalidation downloaded the whole file again.
 * Size and mtime rather than a hash: a build writes a new file, and hashing the
 * bundle on every request would cost more than the download it saves.
 */
function etagOf(size: number, mtimeMs: number): string {
  return `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
}

function notModified(c: Context, etag: string): boolean {
  const sent = c.req.header("if-none-match");
  return Boolean(sent?.split(",").some((t) => t.trim() === etag || t.trim() === "*"));
}

/**
 * The encodings a build carries beside a file, best first.
 *
 * Written by `scripts/precompress.mjs` at build time, because Brotli at the
 * quality worth using is far too slow to run per request -- which is why the
 * bundle was only ever gzipped, and gzipped again on every request.
 */
const PRECOMPRESSED: Array<{ token: string; suffix: string; encoding: string }> = [
  { token: "br", suffix: ".br", encoding: "br" },
  { token: "gzip", suffix: ".gz", encoding: "gzip" },
];

/** Whether the request's `Accept-Encoding` takes this token, with `q=0` meaning it does not. */
function accepts(c: Context, token: string): boolean {
  const header = c.req.header("accept-encoding") ?? "";
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().split(";");
    if (name?.trim().toLowerCase() !== token) return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}
export function staticHandler(root: string, basePath = ""): Handler {
  const absRoot = resolve(root);
  let indexCache: { body: string; mtime: number; etag: string } | null = null;
  /** Which precompressed copies exist, per file and modification time. */
  const variants = new Map<string, { mtime: number; found: Map<string, number> }>();
  let mismatchWarned = false;

  /**
   * The precompressed copies of a file that are worth serving.
   *
   * A copy older than the file it was made from describes something else, so it
   * is ignored rather than served -- a build that rewrote a file without
   * precompressing it must not hand out the previous one's bytes.
   */
  async function variantsOf(
    filePath: string,
    mtime: number,
  ): Promise<Map<string, number>> {
    const known = variants.get(filePath);
    if (known && known.mtime === mtime) return known.found;
    const found = new Map<string, number>();
    for (const v of PRECOMPRESSED) {
      try {
        const st = await stat(filePath + v.suffix);
        if (st.isFile() && st.mtimeMs >= mtime) found.set(v.suffix, st.size);
      } catch {
        /* not there: the file is served as it is */
      }
    }
    variants.set(filePath, { mtime, found });
    return found;
  }

  /**
   * A build that does not know the prefix loads nothing under it, and says so
   * with a blank page and a 404 in a console nobody has open. The shell is
   * already being read here, so checking what it asks for costs one substring
   * search per rebuild and turns a mystery into a line in the log.
   *
   * A warning rather than a refusal: this reads a built artefact to guess at a
   * misconfiguration, and a wrong guess that stops the server from starting is
   * worse than the problem it is describing.
   */
  function warnOnBaseMismatch(body: string) {
    if (mismatchWarned || !basePath) return;
    if (body.includes(`src="${basePath}/assets/`)) return;
    mismatchWarned = true;
    console.warn(
      `[gilbert] BASE_PATH is ${basePath}, but the web build in ${absRoot} references its assets elsewhere. ` +
        `The prefix is baked in at build time: rebuild with BASE_PATH=${basePath} set, or the app will not load.`,
    );
  }

  async function serveIndex(c: Context) {
    try {
      const p = join(absRoot, "index.html");
      const st = await stat(p);
      if (!indexCache || indexCache.mtime !== st.mtimeMs) {
        const body = await readFile(p, "utf8");
        indexCache = {
          body,
          mtime: st.mtimeMs,
          // Hashed rather than taken from the file's own metadata: this one is
          // small, read once and cached, and its bytes are what the ETag is
          // about -- the shell is the file whose `no-cache` makes every load
          // ask again.
          etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`,
        };
        mismatchWarned = false;
      }
      warnOnBaseMismatch(indexCache.body);
      c.header("Content-Type", "text/html; charset=utf-8");
      c.header("Cache-Control", HTML_CACHE_CONTROL);
      c.header("Content-Security-Policy", APP_CSP);
      c.header("ETag", indexCache.etag);
      if (notModified(c, indexCache.etag)) return c.body(null, 304);
      return c.body(indexCache.body);
    } catch {
      c.header("Content-Type", "text/plain; charset=utf-8");
      return c.body("Gilbert: web build not found. Run `npm run build` first.", 503);
    }
  }

  return async (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD")
      return c.text("Method Not Allowed", 405);
    /*
     * Everything below works in paths relative to the mount, so the prefix
     * comes off once, here. Anything outside it is a 404 and not the app
     * shell: under `/mail` this process shares a hostname with whatever else
     * the proxy serves, and answering `/` or `/other-app/thing` with our
     * index would shadow a neighbour rather than let it 404 honestly.
     */
    const fullPath = decodeURIComponent(new URL(c.req.url).pathname);
    const urlPath = stripBasePath(basePath, fullPath);
    if (urlPath === null) return c.text("Not Found", 404);
    if (urlPath === "/" || urlPath === "/index.html") return serveIndex(c);
    const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(absRoot, rel);
    if (!filePath.startsWith(absRoot + sep)) return serveIndex(c);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) return serveIndex(c);
      const ext = extname(filePath).toLowerCase();
      c.header("Content-Type", MIME[ext] ?? "application/octet-stream");
      const etag = etagOf(st.size, st.mtimeMs);
      c.header("ETag", etag);
      if (rel.startsWith("/assets/") || rel.startsWith("assets/")) {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      } else if (ext === ".html") {
        c.header("Cache-Control", HTML_CACHE_CONTROL);
        c.header("Content-Security-Policy", APP_CSP);
      } else if (isNeverStale(rel, ext)) {
        c.header("Cache-Control", "no-cache");
        c.header("Content-Security-Policy", APP_CSP);
      } else {
        c.header("Cache-Control", "public, max-age=3600");
      }
      /*
       * A 304 carries no body, so it is answered before any copy is chosen:
       * the validator is about the file, and which encoding it would have been
       * sent in is not what the browser asked.
       */
      if (notModified(c, etag)) return c.body(null, 304);
      // The best copy the browser accepts, when the build made one.
      let servePath = filePath;
      let size = st.size;
      const found = await variantsOf(filePath, st.mtimeMs);
      if (found.size) {
        // Which bytes came back depends on the header, so anything caching this
        // has to key on it as well as on the URL.
        c.header("Vary", "Accept-Encoding");
        const pick = PRECOMPRESSED.find(
          (v) => found.has(v.suffix) && accepts(c, v.token),
        );
        if (pick) {
          servePath = filePath + pick.suffix;
          size = found.get(pick.suffix)!;
          c.header("Content-Encoding", pick.encoding);
        }
      }
      c.header("Content-Length", String(size));
      if (c.req.method === "HEAD") return c.body(null);
      const stream = Readable.toWeb(createReadStream(servePath)) as ReadableStream;
      return c.body(stream);
    } catch {
      // SPA fallback for client-side routes (no file extension) only.
      if (!extname(rel)) return serveIndex(c);
      return c.text("Not Found", 404);
    }
  };
}
