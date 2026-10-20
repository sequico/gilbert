/**
 * What every response and every request passes through.
 *
 * The security headers, compression and its exemptions, the CSRF guard, the
 * body ceilings, the session cookie, the session itself, and the HTTP facts a
 * request is judged by -- the peer address, the client IP behind a trusted
 * proxy, the scheme it arrived on and the origin Stalwart may reach us at.
 */

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { getCookie, setCookie } from "hono/cookie";
import { isTrustedProxy, resolveClientIp } from "../../clientip.js";
import { config } from "../../config.js";
import { apiLimiter, type Env, sessions } from "./sessions.js";

/** The socket's own address -- the one part of a request nobody downstream can forge. */
function peerAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    /* no socket information available */
    return "unknown";
  }
}

export function clientIp(c: Context): string {
  return resolveClientIp(
    peerAddress(c),
    { forwardedFor: c.req.header("x-forwarded-for"), realIp: c.req.header("x-real-ip") },
    config,
  );
}

/** The scheme a request arrived on; `X-Forwarded-Proto` is believed only from a proxy we run. */
function requestProto(c: Context): "http" | "https" {
  if (config.trustProxy && isTrustedProxy(peerAddress(c), config)) {
    const proto = c.req.header("x-forwarded-proto");
    if (proto)
      return proto.split(",")[0]!.trim().toLowerCase() === "https" ? "https" : "http";
  }
  return new URL(c.req.url).protocol === "https:" ? "https" : "http";
}

function isSecureRequest(c: Context): boolean {
  if (config.secureCookies === "1" || config.secureCookies === "true") return true;
  if (config.secureCookies === "0" || config.secureCookies === "false") return false;
  return requestProto(c) === "https";
}

/** A host that can go into a URL: a name, IPv4, or a bracketed IPv6, with an optional port. */
const PUSH_HOST_RE =
  /^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)(?::\d{1,5})?$/;

/**
 * The https origin Stalwart can reach this installation at, read off the
 * request that carried the session (ADR 0007).
 *
 * Upstream POSTs back only to what the subscription named, and RFC 8620
 * requires https there, so this answers `null` -- leaving the account on the
 * per-tab relay -- unless every part of it is believable: the peer is a proxy
 * we run, that proxy says the request arrived over https, and what is left is
 * a syntactically valid host. A peer we do not run cannot name our origin, and
 * a client cannot smuggle one through the headers because its own socket
 * address is not trusted.
 */
export function pushOrigin(c: Context): string | null {
  if (!config.trustProxy || !isTrustedProxy(peerAddress(c), config)) return null;
  if (requestProto(c) !== "https") return null;
  // Rightmost-first would be wrong here: a proxy appends to X-Forwarded-Host,
  // so the first entry is the one our own proxy observed.
  const host =
    c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ||
    c.req.header("host")?.trim() ||
    "";
  return PUSH_HOST_RE.test(host) ? `https://${host}` : null;
}

/** Security headers for every response. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  /* A route that must be framable says so; everything else is DENY. The blob
     route is the only one, and only for PDFs -- see the note there. */
  if (!h.has("X-Frame-Options")) h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "no-referrer");
  h.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  if (isSecureRequest(c))
    h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
};

/** CSRF: require our custom header on all API calls; reject cross-site fetches. */
/**
 * Routes that forward somebody else's bytes rather than producing our own.
 *
 * Compression is right for the app shell, the bundle and our JSON; it is not
 * worth the risk on the proxy paths. Those carry a content-length copied from
 * upstream under the rules in `forwardedContentLength`, and issue #76 was a
 * silent truncation caused by exactly that header disagreeing with the body.
 * Re-encoding them would be safe in principle -- the length is dropped and the
 * response goes out chunked -- but the payloads are attachments, images and
 * calendar data that are already compressed or too small to matter, so there
 * is nothing to win and a scar to respect.
 *
 * `/api/events` needs no entry here: Hono skips `text/event-stream` by content
 * type. It is listed anyway, because a future change to that route's type
 * should not quietly start buffering the push stream.
 */
const UNCOMPRESSED_ROUTES = [
  "/api/blob/",
  "/api/image",
  "/api/ics",
  "/api/upload/",
  "/api/events",
  /*
   * The liveness probe, which is small enough that gzip makes it bigger: 53
   * bytes becomes 73. Hono's size threshold cannot catch this on its own,
   * because it only applies when the response carries a content-length and
   * `c.json()` does not set one. Every other JSON route is left compressed --
   * a JMAP response can run to hundreds of kilobytes and its length is just as
   * unknown -- so this is the one place worth naming.
   */
  "/api/health",
];

/**
 * gzip for what we generate.
 *
 * The bundle ships uncompressed otherwise: 915 KB on the wire where 307 KB
 * would do, on every first load. `Caddyfile.example` and
 * `nginx.example.conf` both compress at the proxy, but that only helps the
 * deployments that use them, and the default should not depend on reading the
 * examples.
 *
 * Hono's middleware declines anything already carrying `Content-Encoding` or
 * `Transfer-Encoding`, so a proxy compressing in front of us wins and we do
 * not double-encode.
 */
export function compressResponses(basePath: string): MiddlewareHandler {
  const inner = compress({ threshold: 1024 });
  const skip = UNCOMPRESSED_ROUTES.map((r) => `${basePath}${r}`);
  if (!config.compressJmap) skip.push(`${basePath}/api/jmap`);
  const offersEncoding = /\b(gzip|deflate)\b/i;
  const noTransform = /(?:^|,)\s*?no-transform\s*?(?:,|$)/i;
  return async (c, next) => {
    /*
     * A client that did not ask for an encoding must not pay for one. Hono's
     * middleware still inspects and re-labels every compressible response it
     * declines -- setting Vary forces a streamed passthrough to be rebuilt off
     * its fast path -- and that was measured at 1.2 ms per JMAP call, on a
     * 1.9 ms operation, for a request that never sent Accept-Encoding.
     */
    if (!offersEncoding.test(c.req.header("accept-encoding") ?? "")) return next();
    const path = new URL(c.req.url).pathname;
    if (skip.some((prefix) => path.startsWith(prefix))) return next();
    /*
     * The app shell carries `no-transform` so a transforming edge leaves the
     * HTML alone -- its CSP forbids the scripts that edge would inject. Hono's
     * compressor declines a body that carries the directive, and it should not
     * here: `no-transform` is aimed at a proxy, not a reason to stop gzipping
     * our own shell. Hide it while the compressor decides, and put it back on
     * the response that leaves.
     */
    let directive: string | null = null;
    await inner(c, async () => {
      await next();
      const cc = c.res.headers.get("Cache-Control");
      if (!cc || !noTransform.test(cc)) return;
      directive = cc;
      const rest = cc
        .split(",")
        .map((part) => part.trim())
        .filter((part) => !/^no-transform$/i.test(part))
        .join(", ");
      if (rest) c.res.headers.set("Cache-Control", rest);
      else c.res.headers.delete("Cache-Control");
    });
    if (directive) c.res.headers.set("Cache-Control", directive);
  };
}

export const csrfGuard: MiddlewareHandler = async (c, next) => {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return c.json({ error: "cross_site_request" }, 403);
  }
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    if (c.req.header("x-requested-with") !== "gilbert") {
      return c.json({ error: "missing_csrf_header" }, 403);
    }
  }
  await next();
};

export const requireSession: MiddlewareHandler<Env> = async (c, next) => {
  // A middleware that ran before us (the forced-password-change door) may
  // already have resolved the cookie; one resolve per request is enough.
  if (c.get("session")) return next();
  const cookie = getCookie(c, config.cookieName);
  const session = sessions.resolve(cookie);
  if (!session) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  c.set("session", session);
  await next();
};

/**
 * Scope the session cookie to the mount, not the whole host.
 *
 * Under a prefix the browser is talking to a hostname that other applications
 * share, and a cookie at `/` would be sent to every one of them. Path scoping
 * is not a security boundary -- anything on the origin can reach the cookie
 * jar -- but it keeps the credential out of requests that have no business
 * carrying it, and it lets two Gilbert instances live at `/mail` and
 * `/mail2` on one host without signing each other out, which a shared cookie
 * name at `/` would do.
 *
 * `/` for the root case: an empty Path is not the same thing and browsers
 * would fall back to the directory of the request that set it.
 */
/** The path the session cookie is scoped to: the prefix this instance answers on. */
export const cookiePath = () => config.basePath || "/";

export function setSessionCookie(c: Context, value: string, remember: boolean) {
  setCookie(c, config.cookieName, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    path: cookiePath(),
    ...(remember ? { maxAge: config.sessionRememberTtl } : {}),
  });
}

/*
 * What a request body may weigh before any of it is buffered.
 *
 * Hono reads a JSON body whole, so a route that takes one takes it bounded or
 * not at all: a handful of unauthenticated sign-in attempts carrying hundreds
 * of megabytes each would otherwise run the process out of memory, and a
 * restart signs everybody out. What these routes receive is a username and a
 * password, a code, or a couple of settings — 64 KiB is twenty times the
 * largest of them and a hard stop for the body that would otherwise sit in
 * heap.
 *
 * The data path (`/jmap`, `/upload`) is exempt on purpose: it carries real
 * mail and is capped and streamed where it is sent on, and the push callback
 * has its own limit ahead of this one. Sign-in is capped tighter still,
 * because it is the one endpoint that reads a body from somebody not yet
 * signed in — the checks on both fields come after the parse.
 */
const MAX_SMALL_BODY = 64 * 1024;
const DATA_PATH = /\/api\/(jmap$|upload\/)/;
const limitSmallBody = bodyLimit({
  maxSize: MAX_SMALL_BODY,
  onError: (c) => c.json({ error: "too_large" }, 413),
});
export const loginBody = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.json({ error: "too_large" }, 413),
});
export const smallBodies: MiddlewareHandler<Env> = (c, next) =>
  DATA_PATH.test(c.req.path) ? next() : limitSmallBody(c, next);

/** Per-session budget on the data path. See config.apiRateLimit. */
export const apiRateLimited: MiddlewareHandler<Env> = async (c, next) => {
  if (config.apiRateLimit > 0) {
    const session = c.get("session");
    if (session && !apiLimiter().check(session.id)) {
      c.header("Retry-After", String(apiLimiter().retryAfterSeconds(session.id)));
      return c.json({ error: "rate_limited" }, 429);
    }
  }
  await next();
};

export async function readJson<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}
