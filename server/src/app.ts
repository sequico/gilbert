import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { getConnInfo } from "@hono/node-server/conninfo";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  AccountError,
  assertEnrolmentCode,
  beginOtpEnrolment,
  changePassword,
  clearPasswordChangeDirective,
  createAppPassword,
  disableOtp,
  enableOtp,
  getState,
  isPasswordChangeForced,
  revokeAppPassword,
  type SecurityState,
  setPasswordChangeDirective,
} from "./account.js";
import {
  parsePolicyDocumentDetailed,
  persistPolicyFile,
  policyDocumentText,
} from "./adminPolicy.js";
import { resolveClientIp } from "./clientip.js";
import { config } from "./config.js";
import { icsProxyHandler } from "./icsproxy.js";
import { imageProxyHandler } from "./imageproxy.js";
import {
  attach as pushAttach,
  attachRelay as pushAttachRelay,
  prepare as pushPrepare,
  receive as pushReceive,
  pushStatus,
} from "./push.js";
import { RateLimiter } from "./ratelimit.js";
import {
  impersonationAuthorization,
  type LiveSession,
  type SessionBackend,
  SessionStore,
} from "./sessions.js";
import { staticHandler } from "./static.js";
import {
  type AccountInfo,
  ADMIN_GROUP_LOCAL,
  absoluteUpstream,
  expandTemplate,
  fetchDirectoryUsers,
  fetchUpstreamSession,
  forgetUpstreamSession,
  getAccountInfo,
  getUpstreamSession,
  hasStalwartRegistry,
  isAdminSession,
  localizeSession,
  UpstreamError,
  type UpstreamSession,
  upstreamFor,
} from "./upstream.js";

type Env = { Variables: { session: LiveSession } };

export const sessions: SessionBackend = new SessionStore(config.sessionFile, (id) =>
  forgetUpstreamSession(id),
);
const loginLimiter = new RateLimiter(config.loginRateLimit, 15 * 60_000);
/*
 * The backstop that is never refunded.
 *
 * `loginLimiter` guards password guessing and gives its attempts back when the
 * upstream never judged the password (#239) -- otherwise retrying through an
 * outage locks somebody out until after it has ended. But "not counted" cannot
 * mean "unlimited": each attempt still costs Gilbert an outbound connection
 * that may sit there until `UPSTREAM_TIMEOUT`, so a flood during an outage is
 * the one moment the endpoint is cheapest to abuse.
 *
 * Hence a second ceiling, per address, twenty times looser and refunded never.
 * A person retrying an outage will not come near it; something hammering will.
 */
const loginFloodLimiter = new RateLimiter(config.loginRateLimit * 20, 15 * 60_000);
/**
 * Credential changes verify the current password upstream, and Stalwart's
 * fail2ban counts those failures against the *caller's* IP — which for a proxy
 * is shared by every user. Keep our own lid on it so one person guessing
 * cannot get the whole deployment banned.
 */
const accountLimiter = new RateLimiter(10, 15 * 60_000);
const apiLimiter = new RateLimiter(config.apiRateLimit, 60_000);

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

/*
 * What a request body may weigh before any of it is buffered.
 *
 * The login payload is a username and a password — the checks on both come
 * after the parse — and the endpoint is the one place in the app that reads a
 * body from somebody not yet signed in, so it gets the tightest cap. The
 * account JSON posts (password / app-password / 2FA operations) are equally
 * small; 64 KiB is twenty times their real size and a hard stop for the
 * multi-hundred-MB body that would otherwise sit in heap. The data path
 * (/jmap, /upload) is exempt on purpose: it carries real mail and is capped
 * and streamed where it is sent on.
 */
const loginBody = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.json({ error: "too_large" }, 413),
});
const accountBody = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => c.json({ error: "too_large" }, 413),
});

/** Per-session budget on the data path. See config.apiRateLimit. */
const apiRateLimited: MiddlewareHandler<Env> = async (c, next) => {
  if (config.apiRateLimit > 0) {
    const session = c.get("session");
    if (session && !apiLimiter.check(session.id)) {
      c.header("Retry-After", String(apiLimiter.retryAfterSeconds(session.id)));
      return c.json({ error: "rate_limited" }, 429);
    }
  }
  await next();
};

/* ------------------------------------------------------------------ */
/* The forced-password-change directive (ADR 0005)                     */
/* ------------------------------------------------------------------ */

interface DirectiveCheck {
  forced: boolean;
  checkedAt: number;
}

/**
 * Short-TTL in-memory cache of the directive's presence, keyed by username.
 *
 * The door judges every data request against this, so a user forced while
 * already signed in is stopped at their next request without every request
 * paying for a FileNode read of their own account. Admin set/clear and the
 * clear-on-change delete the entry, so their effect is immediate; the TTL
 * bounds how long a directive written behind the server's back (another
 * instance, a direct JMAP write) takes to land.
 */
const directiveCache = new Map<string, DirectiveCheck>();
const DIRECTIVE_CACHE_TTL_MS = 30_000;

/**
 * Whether this session's user is currently forced to change their password.
 *
 * App-password sessions are never forced (ADR 0005): the wall needs the
 * current account password, and accounts with two-factor authentication on
 * can only sign in with an app password.
 */
async function sessionForcedState(
  session: LiveSession,
  upstream?: UpstreamSession,
): Promise<boolean> {
  if (session.appPassword) return false;
  const hit = directiveCache.get(session.username);
  if (hit && Date.now() - hit.checkedAt < DIRECTIVE_CACHE_TTL_MS) return hit.forced;
  // A stale entry is dropped, not overwritten in place: the map would
  // otherwise keep one entry per user ever checked for the life of the
  // process, with nothing ever deleting the ones that stop requesting.
  if (hit) directiveCache.delete(session.username);
  let forced = false;
  try {
    const up =
      upstream ??
      (await getUpstreamSession(
        session.id,
        session.authorization,
        upstreamFor(session.username),
      ));
    forced = await isPasswordChangeForced({
      authorization: session.authorization,
      session: up,
      username: session.username,
    });
  } catch (err) {
    // An unreadable directive reads as absent: refusing the data path on an
    // upstream hiccup would be a new failure mode, and the proxied call
    // itself fails with its own error when the upstream is genuinely down.
    console.warn(
      `[gilbert] could not check the forced-password-change directive for ${session.username}:`,
      (err as Error).message,
    );
  }
  directiveCache.set(session.username, { forced, checkedAt: Date.now() });
  return forced;
}

/**
 * Whether a mount-relative `/api` path is a data route the door covers.
 *
 * The list is ADR 0005's: the JMAP proxy, uploads, blobs, the image and
 * calendar proxies, the push stream and every `/account/*` route except the
 * password change itself (the wall's one way out). Auth, config, health and
 * the admin endpoints stay open.
 */
function isDoorPath(rel: string): boolean {
  if (rel === "/jmap" || rel === "/image" || rel === "/ics" || rel === "/events")
    return true;
  if (rel.startsWith("/upload/") || rel.startsWith("/blob/")) return true;
  return rel.startsWith("/account/") && rel !== "/account/password";
}

const _HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

export function clientIp(c: Context): string {
  let peer = "unknown";
  try {
    peer = getConnInfo(c).remote.address ?? "unknown";
  } catch {
    /* no socket information available */
  }
  return resolveClientIp(
    peer,
    { forwardedFor: c.req.header("x-forwarded-for"), realIp: c.req.header("x-real-ip") },
    config,
  );
}

function isSecureRequest(c: Context): boolean {
  if (config.secureCookies === "1" || config.secureCookies === "true") return true;
  if (config.secureCookies === "0" || config.secureCookies === "false") return false;
  if (config.trustProxy) {
    const proto = c.req.header("x-forwarded-proto");
    if (proto) return proto.split(",")[0]!.trim() === "https";
  }
  return new URL(c.req.url).protocol === "https:";
}

/** Security headers for every response. */
const securityHeaders: MiddlewareHandler = async (c, next) => {
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
function compressResponses(basePath: string): MiddlewareHandler {
  const inner = compress({ threshold: 1024 });
  const skip = UNCOMPRESSED_ROUTES.map((r) => `${basePath}${r}`);
  if (!config.compressJmap) skip.push(`${basePath}/api/jmap`);
  const offersEncoding = /\b(gzip|deflate)\b/i;
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
    return inner(c, next);
  };
}

const csrfGuard: MiddlewareHandler = async (c, next) => {
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

const requireSession: MiddlewareHandler<Env> = async (c, next) => {
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
const cookiePath = config.basePath || "/";

function setSessionCookie(c: Context, value: string, remember: boolean) {
  setCookie(c, config.cookieName, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    path: cookiePath,
    ...(remember ? { maxAge: config.sessionRememberTtl } : {}),
  });
}

function upstreamFailure(c: Context, err: unknown) {
  if (err instanceof UpstreamError) {
    return c.json(
      {
        error: err.status === 401 ? "invalid_credentials" : "upstream_error",
        message: err.message,
      },
      err.status as 401 | 502,
    );
  }
  const name = (err as Error)?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") {
    return c.json(
      {
        error: "upstream_timeout",
        message:
          "The mail server did not respond in time. This is not a problem with your password.",
      },
      504,
    );
  }
  console.error("[gilbert] upstream failure:", err);
  return c.json(
    {
      error: "upstream_error",
      message:
        "Could not reach the mail server. This is not a problem with your password.",
    },
    502,
  );
}

/**
 * `basePath` is a parameter rather than read straight from the config so the
 * tests can mount the same app twice, at the root and under a prefix, without
 * re-importing the module to change one environment variable.
 */
export function createApp(basePath = config.basePath): Hono<Env> {
  const app = new Hono<Env>();
  app.use("*", securityHeaders);
  app.use("*", compressResponses(basePath));

  const api = new Hono<Env>();
  api.use("*", csrfGuard);
  api.use("/account/*", accountBody);
  api.use("/admin/*", accountBody);

  /*
   * The forced-password-change door (ADR 0005).
   *
   * Answers 403 { error: "password_change_required" } on the data routes
   * while the session's user carries the directive in their own app folder.
   * /auth/login, /auth/logout, /auth/session, /api/config, /api/health,
   * /api/account/password and the admin endpoints stay open — the wall needs
   * the session and the change endpoint to exist. The directive is judged per
   * request against the short-TTL cache above, so a user forced while already
   * signed in is stopped at their next request; admin set/clear and the
   * clear-on-change invalidate the entry at once.
   *
   * Enforcement lives here, not in the client: a browser that never renders
   * the wall still cannot reach a data byte through the proxy.
   */
  const forcedPasswordDoor: MiddlewareHandler<Env> = async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const prefix = `${basePath}/api`;
    const rel = path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;
    if (!isDoorPath(rel)) return next();
    const cookie = getCookie(c, config.cookieName);
    const session = c.get("session") ?? sessions.resolve(cookie);
    if (!session) return next(); // the route's own requireSession answers 401
    c.set("session", session);
    if (await sessionForcedState(session)) {
      return c.json(
        {
          error: "password_change_required",
          message:
            "Your administrator requires you to change your password before you can continue.",
        },
        403,
      );
    }
    await next();
  };
  api.use("*", forcedPasswordDoor);

  api.get("/health", (c) =>
    c.json({
      ok: true,
      name: config.appName,
      version: config.version,
      push: pushStatus(),
    }),
  );

  /*
   * Stalwart's push delivery. Authenticated by the token in the path -- 32
   * random bytes, one per account, known only to us and to Stalwart -- and by
   * nothing else, since Stalwart carries no credential when it POSTs. An
   * unknown token is a 404 that looks like any other. See push.ts.
   */
  app.post(`${basePath}/api/push/:token`, async (c) => {
    if (
      !(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")
    )
      return c.body(null, 415);
    const len = Number(c.req.header("content-length") ?? "0");
    if (!len || len > 64 * 1024) return c.body(null, 413);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.body(null, 400);
    }
    return c.body(
      null,
      (await pushReceive(c.req.param("token"), body)) as 200 | 400 | 404 | 500,
    );
  });

  api.get("/config", (c) =>
    c.json({
      appName: config.appName,
      sourceUrl: config.sourceUrl,
      imageProxy: config.imageProxy,
      maxUploadBytes: config.maxUploadBytes,
      /* Sent before sign-in like the rest of this: it says what the
         installation has decided, not anything about who is asking. */
      settingsPolicy: config.settingsPolicy,
    }),
  );

  // ---------- Auth ----------
  api.post("/auth/login", loginBody, async (c) => {
    const ip = clientIp(c);
    let body: { username?: string; password?: string; totp?: string; remember?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    const username = (body.username ?? "").trim();
    const password = body.password ?? "";
    const totp = (body.totp ?? "").trim();
    if (!username || !password) return c.json({ error: "missing_credentials" }, 400);
    if (username.length > 320 || password.length > 1024)
      return c.json({ error: "bad_request" }, 400);

    /*
     * Three checks, answering different questions.
     *
     * `limitKey` is this username from this address, and `ip` is any username
     * from it -- both guard guessing, and both are given back when the upstream
     * never got as far as judging the password. Refunding only the first would
     * not fix #239: ten retries through an outage would still spend the address
     * budget, and behind one office NAT that budget belongs to the whole
     * building.
     *
     * The flood ceiling is the one that is never refunded, and it is the reason
     * the other two safely can be.
     */
    const limitKey = `${ip}|${username.toLowerCase()}`;
    if (!loginFloodLimiter.check(ip)) {
      c.header("Retry-After", String(loginFloodLimiter.retryAfterSeconds(ip)));
      return c.json(
        {
          error: "rate_limited",
          message: "Too many login attempts. Please wait and try again.",
        },
        429,
      );
    }
    if (!loginLimiter.check(limitKey) || !loginLimiter.check(ip)) {
      c.header("Retry-After", String(loginLimiter.retryAfterSeconds(limitKey)));
      return c.json(
        {
          error: "rate_limited",
          message: "Too many login attempts. Please wait and try again.",
        },
        429,
      );
    }

    // Stalwart accepts TOTP codes appended to the password as "password$123456".
    const effectivePassword = totp ? `${password}$${totp}` : password;
    const authorization = `Basic ${Buffer.from(`${username}:${effectivePassword}`, "utf8").toString("base64")}`;
    try {
      const upstream = await fetchUpstreamSession(authorization, upstreamFor(username));
      // Gilbert requires Stalwart 0.16 or newer. Refuse here, once and
      // clearly, rather than signing someone in and letting Files, the account
      // locale and self-service credentials each fail in their own way with
      // nothing to connect them. The credentials were good, so say so.
      if (!hasStalwartRegistry(upstream)) {
        // The credentials were accepted; only the server is too old. Not an
        // attempt worth counting against them.
        loginLimiter.refund(limitKey);
        loginLimiter.refund(ip);
        return c.json(
          {
            error: "unsupported_server",
            message:
              "Your credentials are fine, but this mail server is older than Stalwart 0.16, which Gilbert needs. Upgrade the server, or run the release tagged stalwart-0.15-support.",
          },
          501,
        );
      }
      loginLimiter.reset(limitKey);
      const { cookie, session } = sessions.create({
        username,
        password: effectivePassword,
        remember: Boolean(body.remember),
        userAgent: c.req.header("user-agent") ?? "",
        ip,
        // Whether the presented secret was an app password decides whether the
        // forced-password-change wall can ever apply to this session (ADR 0005).
        appPassword: upstream.authType === "app-password",
      });
      setSessionCookie(c, cookie, session.remember);
      // Start the account's push subscription now, so it is usually verified
      // by the time the browser opens its stream. See push.ts.
      const mailAccount = upstream.primaryAccounts?.["urn:ietf:params:jmap:mail"];
      if (mailAccount) pushPrepare(session.username, mailAccount, session.authorization);
      const info = await getAccountInfo(session.id, session.authorization, upstream);
      return c.json(
        localizeSession(
          upstream,
          sessionExtras(
            session,
            info,
            isAdminSession(upstream),
            // The session document was just fetched; hand it over instead of
            // making the directive check fetch it again.
            await sessionForcedState(session, upstream),
          ),
        ),
      );
    } catch (err) {
      // A rejected sign-in that carried a two-factor code is worth explaining
      // rather than calling "invalid credentials", because the credentials are
      // very likely fine.
      //
      // Stalwart accepts a TOTP code only through an OAuth flow -- its own web
      // interface is an OAuth client, which is why signing in there works. It
      // offers no password grant, so a client holding a username and password
      // cannot exchange them plus a code for a token, and the concatenated
      // `password$code` form Gilbert sent is not a route the server has. Its
      // documented answer for clients like this one is an app password, which
      // bypasses TOTP entirely.
      //
      // Gilbert already relies on that elsewhere: turning 2FA *on* mints an
      // app password and moves the session onto it, precisely because a plain
      // password stops working from that moment. The sign-in page was the one
      // place still pretending otherwise.
      if (totp && err instanceof UpstreamError && err.status === 401) {
        return c.json(
          {
            error: "totp_unsupported",
            message:
              "This mail server does not accept two-factor codes from webmail. Sign in with an app password instead — create one in Stalwart's own settings, under app passwords. Your password and code are probably fine.",
          },
          401,
        );
      }
      /*
       * A 401 is a judgement about the password and stays counted. Anything
       * else -- refused, timed out, DNS, TLS -- is the upstream failing to
       * answer, which says nothing about the credentials and must not spend
       * somebody's attempts while they wait for it to come back (#239).
       */
      if (!(err instanceof UpstreamError && err.status === 401)) {
        loginLimiter.refund(limitKey);
        loginLimiter.refund(ip);
      }
      return upstreamFailure(c, err);
    }
  });

  api.get("/auth/session", requireSession, async (c) => {
    const session = c.get("session");
    try {
      const upstream = await getUpstreamSession(
        session.id,
        session.authorization,
        upstreamFor(session.username),
        c.req.query("refresh") === "1",
      );
      const info = await getAccountInfo(session.id, session.authorization, upstream);
      return c.json(
        localizeSession(
          upstream,
          sessionExtras(
            session,
            info,
            isAdminSession(upstream),
            await sessionForcedState(session),
          ),
        ),
      );
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 401) {
        sessions.destroy(session.id);
        // destroy() already forgets the upstream caches through the store
        // hook; the explicit call keeps this branch self-contained.
        forgetUpstreamSession(session.id);
        deleteCookie(c, config.cookieName, { path: cookiePath });
      }
      return upstreamFailure(c, err);
    }
  });

  api.post("/auth/logout", async (c) => {
    const cookie = getCookie(c, config.cookieName);
    const session = sessions.resolve(cookie);
    if (session) {
      sessions.destroy(session.id);
      forgetUpstreamSession(session.id);
    }
    deleteCookie(c, config.cookieName, { path: cookiePath });
    return c.json({ ok: true });
  });

  api.get("/auth/sessions", requireSession, (c) => {
    const session = c.get("session");
    return c.json({
      current: session.id,
      sessions: sessions.listForUser(session.username),
    });
  });

  api.post("/auth/sessions/revoke-others", requireSession, (c) => {
    const session = c.get("session");
    const n = sessions.destroyAllForUser(session.username, session.id);
    return c.json({ revoked: n });
  });

  // ---------- Self-service credentials ----------
  /**
   * Password, app passwords and 2FA. These live on the server rather than in
   * the browser because changing a credential means re-sealing the session
   * cookie that holds it, and because the browser only ever sees /api/jmap.
   */
  const accountCtx = async (c: Context<Env>) => {
    const session = c.get("session");
    const upstream = await getUpstreamSession(session.id, session.authorization);
    return {
      authorization: session.authorization,
      session: upstream,
      username: session.username,
    };
  };

  const accountFailure = (c: Context, err: unknown) => {
    if (err instanceof AccountError) {
      return c.json({ error: err.code, message: err.message }, err.status as 400);
    }
    return upstreamFailure(c, err);
  };

  /** Guard the endpoints that check a password against brute-forcing. */
  const guarded = (c: Context<Env>): Response | null => {
    const key = `account|${c.get("session").username.toLowerCase()}`;
    if (accountLimiter.check(key)) return null;
    c.header("Retry-After", String(accountLimiter.retryAfterSeconds(key)));
    return c.json(
      { error: "rate_limited", message: "Too many attempts. Please wait and try again." },
      429,
    );
  };

  api.get("/account/security", requireSession, async (c) => {
    const _session = c.get("session");
    try {
      return c.json(await getState(await accountCtx(c)));
    } catch (err) {
      return accountFailure(c, err);
    }
  });

  api.post("/account/password", requireSession, async (c) => {
    const limited = guarded(c);
    if (limited) return limited;
    const session = c.get("session");
    const body = await readJson<{ current?: string; next?: string; otpCode?: string }>(c);
    if (!body) return c.json({ error: "bad_request" }, 400);
    const current = body.current ?? "";
    const next = body.next ?? "";
    if (!current || !next)
      return c.json(
        { error: "missing_fields", message: "Both passwords are required." },
        400,
      );
    if (next.length > 1024) return c.json({ error: "bad_request" }, 400);
    if (next === current) {
      return c.json(
        { error: "unchanged", message: "The new password matches the old one." },
        400,
      );
    }
    try {
      await changePassword(await accountCtx(c), {
        current,
        next,
        otpCode: body.otpCode?.trim() || undefined,
      });
    } catch (err) {
      return accountFailure(c, err);
    }
    // The old password is now dead: re-seal this session with the new one and
    // drop the others, whose sealed copies would fail on their next call.
    const otpCode = body.otpCode?.trim();
    sessions.reseal(
      getCookie(c, config.cookieName),
      otpCode ? `${next}$${otpCode}` : next,
    );
    forgetUpstreamSession(session.id);
    const revoked = sessions.destroyAllForUser(session.username, session.id);
    // Was this user forced? The answer must be judged after the change, with
    // the freshly resealed credential: the door cache may still hold the
    // pre-force answer, and the old credential is dead the moment the change
    // lands upstream. Password changes are rare, so a fresh read is cheap.
    const fresh = sessions.resolve(getCookie(c, config.cookieName));
    directiveCache.delete(session.username);
    if (fresh && (await sessionForcedState(fresh))) {
      // ADR 0005: a successful change clears the directive in the user's own
      // folder. The user's own (freshly resealed) session is enough — no
      // impersonation needed for the clear.
      try {
        const upstream = await getUpstreamSession(
          fresh.id,
          fresh.authorization,
          upstreamFor(fresh.username),
        );
        await clearPasswordChangeDirective({
          authorization: fresh.authorization,
          session: upstream,
          username: fresh.username,
        });
      } catch (err) {
        // The password change itself succeeded; the clear is a convenience and
        // must not turn success into failure.
        console.warn(
          "[gilbert] password changed but the directive could not be cleared:",
          (err as Error).message,
        );
      }
      // The read above cached "forced"; the file is gone now, so the door
      // must not answer from that entry.
      directiveCache.delete(session.username);
    }
    return c.json({ ok: true, revokedSessions: revoked });
  });

  api.get("/account/app-passwords", requireSession, async (c) => {
    const _session = c.get("session");
    try {
      const state = await getState(await accountCtx(c));
      return c.json({ appPasswords: state.appPasswords });
    } catch (err) {
      return accountFailure(c, err);
    }
  });

  api.post("/account/app-passwords", requireSession, async (c) => {
    const _session = c.get("session");
    const body = await readJson<{ description?: string }>(c);
    if (!body) return c.json({ error: "bad_request" }, 400);
    const description = (body.description ?? "").trim().slice(0, 120);
    if (!description)
      return c.json(
        { error: "missing_fields", message: "Give the app password a name." },
        400,
      );
    try {
      return c.json(await createAppPassword(await accountCtx(c), { description }));
    } catch (err) {
      return accountFailure(c, err);
    }
  });

  api.post("/account/app-passwords/revoke", requireSession, async (c) => {
    const _session = c.get("session");
    const body = await readJson<{ id?: string }>(c);
    if (!body?.id) return c.json({ error: "bad_request" }, 400);
    try {
      await revokeAppPassword(await accountCtx(c), body.id);
      return c.json({ ok: true });
    } catch (err) {
      return accountFailure(c, err);
    }
  });

  api.post("/account/2fa/begin", requireSession, async (c) => {
    try {
      // Nothing is stored yet; the client hands the URL back to confirm.
      return c.json(beginOtpEnrolment(await accountCtx(c)));
    } catch (err) {
      return accountFailure(c, err);
    }
  });

  api.post("/account/2fa/enable", requireSession, async (c) => {
    const limited = guarded(c);
    if (limited) return limited;
    const session = c.get("session");
    const body = await readJson<{ url?: string; code?: string; current?: string }>(c);
    if (!body?.url || !body.code || !body.current)
      return c.json({ error: "bad_request" }, 400);
    const ctx = await accountCtx(c);
    const code = body.code.trim();
    /*
     * Every proxied call re-authenticates with the stored password, and once
     * 2FA is on the server wants a fresh TOTP code alongside it — which we
     * cannot produce between requests. An app password authenticates without
     * one, so the session moves onto a dedicated app password rather than
     * being signed out the moment 2FA is switched on.
     *
     * Order matters: mint it while the current credential still works, since
     * the moment 2FA is enabled this session can no longer authenticate at all.
     */
    try {
      assertEnrolmentCode(body.url, code);
    } catch (err) {
      return accountFailure(c, err);
    }
    let app: { id: string; secret: string } | null = null;
    try {
      app = await createAppPassword(ctx, { description: appPasswordName(c) });
    } catch (err) {
      // Out of app-password quota, say. 2FA is still worth having; the user
      // just has to sign in again afterwards.
      console.warn(
        "[gilbert] could not mint a session app password:",
        (err as Error).message,
      );
    }
    try {
      await enableOtp(ctx, { url: body.url, code, current: body.current });
    } catch (err) {
      if (app) {
        // Don't leave a credential behind for a change that never happened.
        await revokeAppPassword(ctx, app.id).catch(() => {});
      }
      return accountFailure(c, err);
    }
    let sessionKept = false;
    if (app) {
      sessionKept = sessions.reseal(getCookie(c, config.cookieName), app.secret, true);
      if (sessionKept) forgetUpstreamSession(session.id);
    }
    // Other sessions still hold the bare password and will be refused.
    const revoked = sessions.destroyAllForUser(session.username, session.id);
    return c.json({ ok: true, sessionKept, revokedSessions: revoked });
  });

  api.post("/account/2fa/disable", requireSession, async (c) => {
    const limited = guarded(c);
    if (limited) return limited;
    const session = c.get("session");
    const body = await readJson<{ current?: string; code?: string }>(c);
    if (!body?.current || !body.code) return c.json({ error: "bad_request" }, 400);
    try {
      await disableOtp(await accountCtx(c), {
        current: body.current,
        code: body.code.trim(),
      });
    } catch (err) {
      return accountFailure(c, err);
    }
    // This session may be running on the app password minted when 2FA went on;
    // the plain password works again now, so put it back.
    sessions.reseal(getCookie(c, config.cookieName), body.current, false);
    forgetUpstreamSession(session.id);
    return c.json({ ok: true });
  });

  // ---------- Administration (ADR 0001) ----------
  /**
   * Membership of the `gilbert-admin@…` group, re-checked on every privileged
   * call. The refetch is forced past the upstream-session cache so a demotion
   * really lands on the next call of an open session, as the ADR promises.
   */
  const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
    const session = c.get("session");
    try {
      const upstream = await getUpstreamSession(
        session.id,
        session.authorization,
        upstreamFor(session.username),
        true,
      );
      if (!isAdminSession(upstream)) {
        return c.json(
          {
            error: "forbidden",
            message: "This needs membership of the gilbert-admin@… group.",
          },
          403,
        );
      }
    } catch (err) {
      return upstreamFailure(c, err);
    }
    await next();
  };

  /**
   * Set or clear the forced-password-change directive for a user (ADR 0005).
   *
   * The write authenticates to Stalwart as the composite `{target}%{admin}`
   * — impersonation with the administrator's own credentials rebuilt from
   * their sealed session — and performs ordinary JMAP FileNode/blob
   * operations on the target's own `gilbert` app folder, creating it when
   * the target has no app folder yet. The impersonation right on the admin
   * group is the grant; there is no second secret and no Management API.
   */
  api.post("/admin/force-password-change", requireSession, requireAdmin, async (c) => {
    const admin = c.get("session");
    const body = await readJson<{ target?: string; clear?: boolean }>(c);
    if (!body) return c.json({ error: "bad_request" }, 400);
    const target = (body.target ?? "").trim();
    // A '%' would change who the composite `{target}%{admin}` names, and a
    // ':' can confuse the credential parse; both fail closed today, but with
    // a misleading 404, so they are refused at the boundary instead.
    if (!target || target.length > 320 || target.includes("%") || target.includes(":"))
      return c.json({ error: "bad_request" }, 400);
    // The admin group itself is a principal (impersonation probes name it),
    // but it is not an account to force a password on.
    if (target.toLowerCase().split("@")[0] === ADMIN_GROUP_LOCAL)
      return c.json(
        { error: "bad_request", message: "The admin group is not an account to force." },
        400,
      );
    const targetAuth = impersonationAuthorization(admin, target);
    if (!targetAuth) {
      // An admin signed in with an app password cannot impersonate: Stalwart
      // refuses app passwords for impersonation (authentication.rs, checked
      // 2026-09-07; still to be re-verified against a live 0.16 server with a
      // dated comment per repo convention). A 2FA account can only sign in
      // with an app password, so administering accounts is not available to
      // such sessions until that is re-examined.
      return c.json(
        {
          error: "forbidden",
          message:
            "This admin session uses an app password, which Stalwart refuses for impersonation. Sign in with your password to administer accounts.",
        },
        403,
      );
    }
    let upstream: UpstreamSession;
    try {
      upstream = await fetchUpstreamSession(targetAuth, upstreamFor(target));
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 401) {
        // The composite credential either does not resolve to an account or
        // the impersonation right is missing.
        return c.json(
          {
            error: "target_not_found",
            message: "No such account, or it cannot be administered by you.",
          },
          404,
        );
      }
      return accountFailure(c, err);
    }
    // An administrator cannot force another administrator: the target's
    // impersonated session is their own, so membership of the admin group
    // shows up there the same way it does in any member's session. This also
    // covers the acting admin themselves (master == target degrades to a
    // plain login upstream).
    if (isAdminSession(upstream)) {
      return c.json(
        {
          error: "target_is_admin",
          message:
            "That account is also a Gilbert administrator; administrators cannot force one another's password.",
        },
        403,
      );
    }
    const ctx = {
      authorization: targetAuth,
      session: upstream,
      username: target,
    };
    try {
      if (body.clear === true) await clearPasswordChangeDirective(ctx);
      else {
        /*
         * A forced 2FA account would have no way out of the wall: the change
         * endpoint validates the current account password, and a 2FA account
         * can only ever present an app password (which the wall does not
         * accept and Stalwart refuses for impersonation). Refuse to force
         * such an account, reading its security state as the target through
         * the impersonated session. The real 0.16 session resource does not
         * say how a session authenticated (checked 2026-09-07; re-verify
         * live), so this guard is also what keeps app-password users from
         * being walled behind a door they cannot open.
         */
        let state: SecurityState;
        try {
          state = await getState(ctx);
        } catch (err) {
          return c.json(
            {
              error: "bad_request",
              message:
                "Could not read the account's security state; refusing to force until it can be checked.",
            },
            400,
          );
        }
        if (state.otpEnabled)
          return c.json(
            {
              error: "account_has_two_factor",
              message:
                "This account uses two-factor authentication and cannot be forced: it has no password-only way out of the change wall.",
            },
            400,
          );
        await setPasswordChangeDirective(ctx, admin.username);
      }
    } catch (err) {
      return accountFailure(c, err);
    }
    // The door's cache must not answer from before the change.
    directiveCache.delete(target);
    return c.json({ ok: true });
  });

  /**
   * The installation-wide settings policy (ADR 0001 §4, ADR 0004 §2).
   *
   * GET returns the current policy as the JSON document the editor shows;
   * POST replaces it. Publishing validates with the same rules the boot path
   * applies (invalid → 400), rewrites `SETTINGS_POLICY_FILE` when one is
   * configured and writable (failure → 500, nothing changes), swaps the
   * running copy — effective immediately, no restart — and kicks every other
   * session so the next sign-in applies the new policy at boot.
   */
  api.get("/admin/policy", requireSession, requireAdmin, (c) =>
    c.json({ policy: policyDocumentText(config.settingsPolicy) }),
  );

  api.post("/admin/policy", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const raw = await c.req.text();
    const parsed = parsePolicyDocumentDetailed(raw);
    if ("problem" in parsed) {
      return c.json({ error: "invalid_policy", message: parsed.problem }, 400);
    }
    const file = process.env.SETTINGS_POLICY_FILE;
    if (file) {
      try {
        await persistPolicyFile(file, raw);
      } catch (err) {
        console.error("[gilbert] could not persist the settings policy:", err);
        return c.json(
          {
            error: "policy_not_persisted",
            message:
              "SETTINGS_POLICY_FILE is set but could not be written; the policy was not changed.",
          },
          500,
        );
      }
    }
    config.settingsPolicy = parsed.doc;
    const kicked = sessions.destroyAllExcept(session.id);
    return c.json({ ok: true, kicked });
  });

  /**
   * The admin Users surface (ADR 0001 §5): every individual account on this
   * server, plus whether this session may act on accounts at all.
   *
   * `canImpersonate` probes the impersonation right by asking to act as the
   * admin group itself (`{gilbert-admin@…}%{admin}`): a session that cannot
   * (an app-password session, or a member without the directory right) gets a
   * false here and the client shows a warning instead of dead buttons. Roles
   * are not consulted — Stalwart does not expose them over JMAP.
   */
  api.get("/admin/users", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      const upstream = await getUpstreamSession(
        session.id,
        session.authorization,
        upstreamFor(session.username),
        true,
      );
      const directory = await fetchDirectoryUsers(session.authorization, upstream);
      const at = session.username.lastIndexOf("@");
      const domain = at > 0 ? session.username.slice(at + 1) : "";
      const group = domain ? `gilbert-admin@${domain}` : null;
      let canImpersonate = false;
      let reason: string | null = null;
      if (!group) {
        reason = "no_group";
      } else {
        const groupAuth = impersonationAuthorization(session, group);
        if (!groupAuth) reason = "app_password";
        else {
          try {
            await fetchUpstreamSession(groupAuth, upstreamFor(group));
            canImpersonate = true;
          } catch (err) {
            reason =
              err instanceof UpstreamError && err.status === 401
                ? "no_right"
                : "unavailable";
          }
        }
      }
      const users = "denied" in directory ? [] : directory.users;
      return c.json({
        users,
        enumeration: !("denied" in directory),
        enumerationMessage: "denied" in directory ? directory.denied : null,
        canImpersonate,
        reason,
      });
    } catch (err) {
      if (err instanceof UpstreamError) return upstreamFailure(c, err);
      console.error("[gilbert] directory users query failed:", err);
      return c.json(
        { error: "directory_unavailable", message: (err as Error).message },
        502,
      );
    }
  });

  // ---------- JMAP API proxy ----------
  api.post("/jmap", requireSession, apiRateLimited, async (c) => {
    const session = c.get("session");
    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) {
      return c.json({ error: "unsupported_media_type" }, 415);
    }
    try {
      const upstream = await getUpstreamSession(
        session.id,
        session.authorization,
        upstreamFor(session.username),
      );
      const res = await fetch(absoluteUpstream(upstream.apiUrl, upstream.baseUrl), {
        method: "POST",
        headers: {
          authorization: session.authorization,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: c.req.raw.body,
        duplex: "half",
        signal: AbortSignal.timeout(config.upstreamTimeout),
      });
      if (res.status === 401) {
        sessions.destroy(session.id);
        forgetUpstreamSession(session.id);
        deleteCookie(c, config.cookieName, { path: cookiePath });
        return c.json({ error: "unauthenticated" }, 401);
      }
      return passthrough(res);
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- Blob upload ----------
  api.post("/upload/:accountId", requireSession, async (c) => {
    const session = c.get("session");
    const accountId = c.req.param("accountId");
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > config.maxUploadBytes) return c.json({ error: "too_large" }, 413);
    // content-length is absent on a chunked request, so the header alone is a
    // suggestion; count the bytes as they go past.
    const body = c.req.raw.body
      ? c.req.raw.body.pipeThrough(byteCap(config.maxUploadBytes))
      : null;
    try {
      const upstream = await getUpstreamSession(
        session.id,
        session.authorization,
        upstreamFor(session.username),
      );
      const url = absoluteUpstream(
        expandTemplate(upstream.uploadUrl, { accountId }),
        upstream.baseUrl,
      );
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: session.authorization,
          "content-type": c.req.header("content-type") ?? "application/octet-stream",
          accept: "application/json",
        },
        body,
        duplex: "half",
        signal: AbortSignal.timeout(Math.max(config.upstreamTimeout, 5 * 60_000)),
      });
      return passthrough(res);
    } catch (err) {
      // The cap fired mid-stream (no content-length, or one that lied): that
      // is an oversized upload, not an unreachable mail server.
      if (err instanceof Error && err.message === "upload too large")
        return c.json({ error: "too_large" }, 413);
      return upstreamFailure(c, err);
    }
  });

  // ---------- Blob download ----------
  api.get("/blob/:accountId/:blobId/:name", requireSession, apiRateLimited, async (c) => {
    const session = c.get("session");
    const { accountId, blobId, name } = c.req.param();
    const accept = c.req.query("accept") ?? "application/octet-stream";
    const inline = c.req.query("inline") === "1";
    try {
      const upstream = await getUpstreamSession(
        session.id,
        session.authorization,
        upstreamFor(session.username),
      );
      const url = absoluteUpstream(
        expandTemplate(upstream.downloadUrl, { accountId, blobId, name, type: accept }),
        upstream.baseUrl,
      );
      const res = await fetch(url, {
        // Ask for the bytes as they are. undici would otherwise negotiate gzip
        // on our behalf and hand back a decompressed body whose content-length
        // header still describes the compressed one -- see forwardedContentLength.
        headers: { authorization: session.authorization, "accept-encoding": "identity" },
        signal: AbortSignal.timeout(Math.max(config.upstreamTimeout, 5 * 60_000)),
      });
      if (!res.ok) return c.json({ error: "not_found" }, res.status === 404 ? 404 : 502);
      const headers = new Headers();
      const type = sanitizeContentType(res.headers.get("content-type") ?? accept);
      headers.set("Content-Type", type);
      const cl = forwardedContentLength(res.headers);
      if (cl) headers.set("Content-Length", cl);
      const safeInline = inline && isInlineSafe(type);
      headers.set(
        "Content-Disposition",
        `${safeInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      headers.set("X-Content-Type-Options", "nosniff");
      // Sandbox everything except the browser's built-in PDF viewer (which needs scripts to render).
      if (securityHeadersFor(type, safeInline) === "SAMEORIGIN") {
        /*
         * The one response on the server that may be framed.
         *
         * A PDF is shown in an iframe -- it is its own document and the app
         * cannot lay it out -- and the blanket X-Frame-Options: DENY above
         * blocked that, so the preview showed Chrome's "refused to connect"
         * instead of the file. SAMEORIGIN, not a relaxation to any site: the
         * frame is ours, on our origin, and the app's own CSP already says
         * frame-src 'self'. Nothing else here is framed, so nothing else asks.
         */
        headers.set("X-Frame-Options", "SAMEORIGIN");
      } else {
        headers.set(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        );
      }
      headers.set("Cache-Control", "private, max-age=3600");
      return new Response(res.body, { status: 200, headers });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- Push (Server-Sent Events) ----------
  api.get("/events", requireSession, async (c) => {
    const session = c.get("session");
    // One session may hold only EVENTS_STREAMS_LIMIT streams; counting every
    // branch (fan-out, raw relay, direct relay) keeps the upstream sockets a
    // session can pin bounded. The slot is released when the response ends or
    // the request aborts, whichever comes first.
    const release = acquireEventsStreamSlot(session.id);
    if (!release) return c.json({ error: "too_many_streams" }, 429);
    const out = (c.env as { outgoing: import("node:http").ServerResponse }).outgoing;
    out.once("close", release);
    c.req.raw.signal.addEventListener("abort", release, { once: true });
    const types = c.req.query("types") ?? "*";
    const closeafter = c.req.query("closeafter") ?? "no";
    const ping = c.req.query("ping") ?? "30";
    try {
      const upstream = await getUpstreamSession(
        session.id,
        session.authorization,
        upstreamFor(session.username),
      );
      const url = absoluteUpstream(
        expandTemplate(upstream.eventSourceUrl, { types, closeafter, ping }),
        upstream.baseUrl,
      );
      // Subscribe mode: if this account's subscription is verified, the tab is
      // served by fan-out and holds nothing upstream. Otherwise it gets its own
      // relay, and is moved to fan-out the moment the account verifies.
      const accountId = upstream.primaryAccounts?.["urn:ietf:params:jmap:mail"];
      if (
        accountId &&
        pushAttach(session.username, accountId, session.authorization, out)
      ) {
        out.writeHead(200, SSE_HEADERS);
        out.flushHeaders();
        out.write(": subscribed\n\n");
        return RESPONSE_ALREADY_SENT;
      }
      if (config.rawPushRelay)
        return relayPushRaw(c, url, session.authorization, session.username);
      const controller = new AbortController();
      c.req.raw.signal.addEventListener("abort", () => controller.abort());
      const res = await fetch(url, {
        headers: { authorization: session.authorization, accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return c.json({ error: "upstream_error" }, 502);
      const headers = new Headers({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      return new Response(res.body, { status: 200, headers });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- Remote image privacy proxy ----------
  api.get("/image", requireSession, apiRateLimited, imageProxyHandler);
  // Behind the session for the same reason the image proxy is: an open fetcher
  // on someone else's server is a gift to whoever finds it.
  api.get("/ics", requireSession, apiRateLimited, icsProxyHandler);

  api.notFound((c) => c.json({ error: "not_found" }, 404));
  api.onError((err, c) => {
    console.error("[gilbert] api error:", err);
    return c.json({ error: "internal_error" }, 500);
  });

  app.route(`${basePath}/api`, api);

  // ---------- Static SPA ----------
  app.get("*", staticHandler(config.staticDir, basePath));
  return app;
}

/** Fail a stream that runs past `max` bytes, whatever its headers claimed. */
function byteCap(max: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) controller.error(new Error("upload too large"));
      else controller.enqueue(chunk);
    },
  });
}

async function readJson<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

/** Name the app password after the browser it will live in. */
function appPasswordName(c: Context): string {
  const ua = c.req.header("user-agent") ?? "";
  const browser = /Firefox\//.test(ua)
    ? "Firefox"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "browser";
  return `${config.appName} (${browser})`;
}

function sessionExtras(
  session: LiveSession,
  info: AccountInfo = { locale: null, edition: null },
  isAdmin = false,
  mustChangePassword = false,
) {
  return {
    gilbert: {
      appName: config.appName,
      sourceUrl: config.sourceUrl,
      imageProxy: config.imageProxy,
      maxUploadBytes: config.maxUploadBytes,
      sessionId: session.id,
      loginName: session.username,
      remember: session.remember,
      /** Membership of the `gilbert-admin@…` group: enables the admin surface. */
      isAdmin,
      /**
       * ADR 0005: the account must change its password before any data route
       * will serve it. The wall is the middleware, not this flag — the flag
       * only tells the client which screen to show.
       */
      mustChangePassword,
      /** Locale configured for the account in Stalwart's directory, if readable. */
      userLocale: info.locale,
      /** What the upstream server would tell us about itself. */
      server: { edition: info.edition },
    },
  };
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
const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

function relayPushRaw(
  c: Context<Env>,
  url: string,
  authorization: string,
  username?: string,
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

function passthrough(res: Response): Response {
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

function sanitizeContentType(ct: string): string {
  const lower = ct.split(";")[0]!.trim().toLowerCase();
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
 * What X-Frame-Options a blob response carries. Exported so the rule is
 * testable without standing up an upstream: a PDF served inline may be framed
 * by us and nothing else may be framed at all.
 */
export function securityHeadersFor(
  type: string,
  safeInline: boolean,
): "SAMEORIGIN" | "DENY" {
  return safeInline && type.split(";")[0]!.trim() === "application/pdf"
    ? "SAMEORIGIN"
    : "DENY";
}

function isInlineSafe(type: string): boolean {
  const t = type.split(";")[0]!.trim();
  return (
    (t.startsWith("image/") && t !== "image/svg+xml") ||
    t.startsWith("video/") ||
    t.startsWith("audio/") ||
    t === "application/pdf" ||
    t === "text/plain" ||
    t === "text/calendar" ||
    t === "text/vcard"
  );
}
