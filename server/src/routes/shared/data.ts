/**
 * The data path: what may pass through it, at what size, and as what type.
 *
 * The gated reads and their budgets, the per-session events-stream slots, the
 * raw push relay, the passthrough headers, the upstream content-length that
 * only survives when it describes the bytes we forward, and the content type
 * a blob is served as.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { Context } from "hono";
import { attachRelay as pushAttachRelay, followAccount } from "../../push.js";
import {
  GENERIC_TYPES,
  isPdfType,
  mediaType,
  PDF_TYPE,
  typeFromName,
} from "../../shared/media.js";
import type { Env } from "./sessions.js";

/*
 * How many /api/events streams one session may hold open at once.
 *
 * In relay mode each such stream is an upstream connection to Stalwart that
 * lives as long as the tab (measured at ~81 KiB of TLS state, see push.ts),
 * so without a bound one account could pin hundreds of upstream sockets by
 * opening tabs. Fan-out streams hold nothing upstream, but they are still a
 * live response each, so the same cap applies to every branch of the route.
 * The browser's EventSource retries a refused stream on its own schedule, so
 * a tab beyond the cap reconnects when an earlier one closes.
 */
export const EVENTS_STREAMS_LIMIT = 8;

const eventsStreamCounts = new Map<string, number>();

/**
 * Reserve one of the session's /api/events slots, or return null when the
 * session is at EVENTS_STREAMS_LIMIT. The returned release() must run when
 * the stream ends; every branch of the route registers it on response close
 * and on request abort, and it is idempotent because both can fire for one
 * stream. Exported so the counting is testable without a live session.
 */
export function acquireEventsStreamSlot(sessionId: string): (() => void) | null {
  const open = eventsStreamCounts.get(sessionId) ?? 0;
  if (open >= EVENTS_STREAMS_LIMIT) return null;
  eventsStreamCounts.set(sessionId, open + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = eventsStreamCounts.get(sessionId);
    if (n === undefined) return;
    if (n <= 1) eventsStreamCounts.delete(sessionId);
    else eventsStreamCounts.set(sessionId, n - 1);
  };
}

export const MAX_GATED_REQUEST = 4 * 1024 * 1024;
/**
 * How many checked requests one session may have in flight at once. Matches the
 * `maxConcurrentRequests` Stalwart advertises by default, which the client
 * already stays within.
 */
export const MAX_GATED_PER_SESSION = 4;
/**
 * The bytes all checked requests together may hold at once. Counted as they
 * arrive rather than reserved up front, so a slow body that has sent little
 * holds little, and a burst of large ones is turned away with a 503 instead of
 * taking the process down.
 */
export const GATED_BUDGET = 32 * 1024 * 1024;
export const gatedReads = new Map<string, number>();
export let gatedBytes = 0;

export class GatedBudgetError extends Error {}

/** A checked request body larger than `MAX_GATED_REQUEST`. */
export class GatedSizeError extends Error {}

/** Read a checked request body, counting it against the two budgets as it arrives. */
export async function readGated(stream: ReadableStream<Uint8Array>): Promise<string> {
  let mine = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      mine += chunk.byteLength;
      gatedBytes += chunk.byteLength;
      if (mine > MAX_GATED_REQUEST)
        controller.error(new GatedSizeError("request too large"));
      else if (gatedBytes > GATED_BUDGET)
        controller.error(new GatedBudgetError("gated read budget spent"));
      else controller.enqueue(chunk);
    },
  });
  try {
    return await new Response(stream.pipeThrough(counted)).text();
  } finally {
    gatedBytes -= mine;
  }
}

/** Fail a stream that runs past `max` bytes, whatever its headers claimed. */
export function byteCap(max: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) controller.error(new Error("upload too large"));
      else controller.enqueue(chunk);
    },
  });
}

/**
 * Headers worth relaying from the mail server. An allowlist rather than a
 * denylist: everything else it might set — cookies, auth challenges, CORS
 * grants — would be landing on *our* origin, where it means something else.
 */
const PASSTHROUGH_HEADERS = new Set([
  "content-type",
  "content-disposition",
  "content-language",
  "etag",
  "last-modified",
  "retry-after",
]);

/**
 * Hold a push stream open with the least machinery that will do it.
 *
 * The fetch() version above builds an undici Response, a web ReadableStream,
 * a reader, and Hono's stream-to-Node bridge for every tab, and keeps all of
 * it alive for as long as the tab is open. Measured against a real Stalwart
 * that is about 44 KiB of JavaScript heap per tab -- twelve times what the
 * session itself costs -- and a signed-in tab is otherwise nothing but this
 * one held connection. Here the upstream socket is piped straight into the
 * Node response, so what stays resident per tab is two sockets and their
 * small IncomingMessage/ServerResponse pair.
 *
 * Returns a Response Hono treats as already sent: the raw bindings are
 * written to directly, and the returned value is never serialised.
 */
export const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

export function relayPushRaw(
  c: Context<Env>,
  url: string,
  authorization: string,
  username?: string,
  installation?: { id: string; username: string; authorization: string } | null,
  origin?: string | null,
): Response {
  const out = (c.env as { outgoing: import("node:http").ServerResponse }).outgoing;
  const target = new URL(url);
  const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
    method: "GET",
    headers: { authorization, accept: "text/event-stream" },
  });
  const signal = c.req.raw.signal;
  const abort = () => req.destroy();
  signal.addEventListener("abort", abort);
  out.on("close", abort);
  const fail = () => {
    if (!out.headersSent) {
      out.writeHead(502, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      out.end(JSON.stringify({ error: "upstream_error" }));
    } else {
      out.end();
    }
  };
  /*
   * Once this account's subscription verifies, the upstream request goes and
   * the browser stream below is served by fan-out instead. Three things have
   * to be true for that to be seamless: the browser must already have its
   * headers (verification can beat the upstream response); nothing may treat
   * the torn-down upstream as an error; and nothing may keep a reference to
   * it -- the request, its response and this handler's context are exactly
   * the per-tab weight the subscription exists to shed.
   */
  let migrated = false;
  const migrate = () => {
    migrated = true;
    if (!out.headersSent) {
      out.writeHead(200, SSE_HEADERS);
      out.flushHeaders();
    }
    signal.removeEventListener("abort", abort);
    out.removeListener("close", abort);
    req.removeAllListeners();
    req.on("error", () => {});
    req.destroy();
  };
  if (username) pushAttachRelay(username, out, migrate);
  /*
   * The installation's own account is followed here too: the tab holding this
   * relay is the first after a start, and a follow that waited for the fan-out
   * would leave it hearing no installation change until it reconnected. The
   * same hook drops the relay when either subscription verifies.
   */
  if (installation)
    followAccount(
      installation.username,
      installation.id,
      installation.authorization,
      out,
      origin ?? null,
      migrate,
    );
  req.on("response", (res) => {
    if (migrated) {
      res.destroy();
      return;
    }
    if (res.statusCode !== 200) {
      res.resume();
      fail();
      return;
    }
    if (!out.headersSent) {
      out.writeHead(200, SSE_HEADERS);
      out.flushHeaders();
    }
    // end: false -- the browser stream outlives the upstream if we migrate.
    res.pipe(out, { end: false });
    res.on("end", () => {
      if (!migrated) out.end();
    });
    res.on("error", () => {
      if (!migrated) out.end();
    });
  });
  req.on("error", () => {
    if (!migrated) fail();
  });
  req.end();
  // Tells @hono/node-server the raw ServerResponse has been written to and
  // must be left alone.
  return RESPONSE_ALREADY_SENT;
}

export function passthrough(res: Response): Response {
  const headers = new Headers();
  res.headers.forEach((v, k) => {
    if (PASSTHROUGH_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  });
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers });
}

/**
 * The upstream content-length, but only when it describes the bytes we are
 * about to forward.
 *
 * A compressed response is decompressed for us before we ever see the body --
 * undici does it transparently -- while the content-length header is left
 * describing the *compressed* length. Copying it onto the longer body we then
 * send makes the browser stop reading exactly that many bytes in and call the
 * download complete, so the file arrives silently truncated.
 *
 * That is the second half of issue #76. A hop in front of Stalwart compressed
 * responses over 1 KiB, so a Sieve script stayed intact until the third rule
 * pushed it past the threshold and it came back cut off mid-rule. Nothing
 * reported an error: the script parsed, just with rules missing, and saving
 * wrote that shortened version back over the real one.
 *
 * We ask for `identity` above so the usual case still carries a length the
 * browser can show progress against; this is the guard for a hop that
 * compresses anyway.
 */
export function forwardedContentLength(headers: Headers): string | null {
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") return null;
  return headers.get("content-length");
}

export function sanitizeContentType(ct: string): string {
  const lower = mediaType(ct);
  // Never let the browser render HTML/SVG/XML/JS served from the blob endpoint.
  if (
    lower === "text/html" ||
    lower === "application/xhtml+xml" ||
    lower === "image/svg+xml" ||
    lower.includes("javascript") ||
    lower === "text/xml" ||
    lower === "application/xml"
  ) {
    return "application/octet-stream";
  }
  if (lower.startsWith("text/")) return `${lower}; charset=utf-8`;
  return lower || "application/octet-stream";
}

/**
 * Whether a content type says nothing about the file.
 *
 * The set is `@gilbert/shared/media`'s `GENERIC_TYPES`, which the client asks
 * too: if the two disagreed, the type the server served a file as and the type
 * the client previewed it as would come from different evidence.
 */
function isGenericType(ct: string): boolean {
  return GENERIC_TYPES.has(mediaType(ct));
}

/**
 * What a blob is served as.
 *
 * Upstream's type decides, with one exception: where it says nothing about the
 * file, the type the client declared is the only evidence left, and it is the
 * type the app is already showing the file as. Either way the answer goes
 * through `sanitizeContentType`, so nothing that must not render gets a type
 * that renders, and `isInlineSafe` (`@gilbert/shared/media`, which the client
 * asks before it offers "open in a new tab") still decides whether anything is
 * served inline at all. Exported so the choice is testable without an upstream.
 */
export function blobContentType(
  upstreamType: string | null,
  declared: string,
  name?: string | null,
): string {
  const up = mediaType(upstreamType);
  const resolved = isGenericType(up) ? declared : up;
  // The last evidence left when both the store and the sender said nothing:
  // a booking-confirmation PDF arrives as octet-stream, and octet-stream is
  // never rendered, however right the preview would be.
  const named = isGenericType(resolved) ? typeFromName(name) : null;
  const type = named ?? resolved;
  return sanitizeContentType(isPdfType(type) ? PDF_TYPE : type);
}

/**
 * What X-Frame-Options a blob response carries. Exported so the rule is
 * testable without standing up an upstream: a PDF served inline may be framed
 * by us and nothing else may be framed at all.
 */
export function securityHeadersFor(
  type: string,
  safeInline: boolean,
): "SAMEORIGIN" | "DENY" {
  return safeInline && isPdfType(type) ? "SAMEORIGIN" : "DENY";
}
