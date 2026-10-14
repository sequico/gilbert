/**
 * One definition of the helpers every route group reads.
 *
 * What every route needs and none of them owns: the session store and its
 * readers, the rate limiters, the CSRF and body guards, the
 * forced-password-change door and the administrator gate, the HTTP facts a
 * request is judged by, and the failure every route answers an upstream
 * refusal with. The route modules under `server/src/routes/` and `app.ts`
 * itself read them from here, so there is one definition and no copy of it.
 *
 * Nothing here decides a path or a method: `app.ts` builds the app, wires the
 * middleware in order, and hands each route module the Hono instance to
 * register on.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { getConnInfo } from "@hono/node-server/conninfo";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { getCookie, setCookie } from "hono/cookie";
import { AccountError, isPasswordChangeForced } from "../account.js";
import { administrationAllowed } from "../adminGate.js";
import {
  AppFolderError,
  type Ctx,
  filesAccountId,
  readAppFileAt,
  writeAppFileAt,
} from "../appFolder.js";
import { isTrustedProxy, resolveClientIp } from "../clientip.js";
import { agentAddress, config } from "../config.js";
import { safeEqual } from "../crypto.js";
import { agentSession, identityLockedForSession } from "../identityAdmin.js";
import { attachRelay as pushAttachRelay } from "../push.js";
import { RateLimiter } from "../ratelimit.js";
import {
  impersonationAuthorization,
  type LiveSession,
  normalizeUsername,
  SESSION_DOCUMENT_NAME,
  type SessionBackend,
  type SessionDocumentIo,
  SessionStore,
  type SessionTtls,
} from "../sessions.js";
import { GENERIC_TYPES, mediaType } from "../shared/media.js";
import type { PublishJob } from "../shared/publishJob.js";
import {
  type AccountInfo,
  fetchAccountIntrospection,
  fetchUpstreamSession,
  forgetUpstreamSession,
  getUpstreamSession,
  isStalwartAdmin,
  UpstreamError,
  type UpstreamSession,
  upstreamFor,
} from "../upstream.js";

export type Env = {
  Variables: { session: LiveSession; adminPermissions: readonly string[] };
};

/**
 * Where sessions live between requests.
 *
 * Bound by `createApp` -- the one function that builds something to serve --
 * and by `useDurableSessions`, which is what a boot calls before it builds one.
 * There is deliberately no store here at module scope: a memory-only
 * `SessionStore` bound at import takes its lifetime from whichever
 * configuration was read first, and an app that serves it ends sessions at the
 * next restart with nothing saying so.
 *
 * What guarantees the replacement now is `bindSessions` itself, in two halves.
 * A process that names a Master (`GILBERT_AGENT_ADDRESS`: the account
 * `bootstrap.ts` signs in as, whose own app folder holds the installation's
 * documents, this one included) is a deployment, and a deployment's sessions
 * live in that account's own document or the deployment does not come up --
 * so `bindSessions` refuses to serve one whose store is not durable instead of
 * serving sessions out of memory. A process that names no Master has nowhere
 * durable to put them, and gets the in-memory store bound there, from the
 * configuration that process is really running on.
 *
 * `sessions` is therefore a name for whatever store is bound -- never a store
 * of its own -- and it refuses out loud before anything has bound one. The
 * only app that answers a request is one `createApp` built, and that does not
 * return until a store is bound.
 */
export const sessions: SessionBackend = {
  init: () => bound().init(),
  close: () => bound().close(),
  create: (params) => bound().create(params),
  resolve: (cookie) => bound().resolve(cookie),
  reseal: (cookie, password, appPassword) =>
    bound().reseal(cookie, password, appPassword),
  destroy: (id) => bound().destroy(id),
  destroyAllForUser: (username, exceptId) =>
    bound().destroyAllForUser(username, exceptId),
  destroyAllExcept: (exceptId) => bound().destroyAllExcept(exceptId),
  listForUser: (username) => bound().listForUser(username),
};

/** The store actually holding sessions, or null until `createApp`/the boot binds one. */
export let store: SessionBackend | null = null;

/** The bound store, or a refusal that names what binds one. */
export function bound(): SessionBackend {
  if (!store)
    throw new Error(
      "No session store has been bound in this process: `bindSessions` binds the in-memory store for a " +
        "process that names no Master, and `useDurableSessions` installs the installation's own before a " +
        "deployment builds its app.",
    );
  return store;
}

/**
 * Bind the store this process serves with, before a route exists.
 *
 * A boot has already installed the durable store by the time it builds an app;
 * a process that names a Master (see the comment above) but has not installed
 * one is a deployment that would lose every session at its next restart, and
 * it refuses to serve rather than doing that quietly. A process that names no
 * Master has nowhere durable to put sessions and gets the in-memory store,
 * built from the configuration that process is really running on.
 */
export function bindSessions(): void {
  if (durable) return;
  if (agentAddress())
    throw new Error(
      "This process names a Master (GILBERT_AGENT_ADDRESS), so this installation's sessions live in " +
        "that account's own document -- but no durable session store was installed, and an app that " +
        "served in-memory sessions would end every one of them at the next restart. A deployment calls " +
        "useDurableSessions before it builds its app (server/src/index.ts does); a process that wants " +
        "sessions in memory runs without GILBERT_AGENT_ADDRESS.",
    );
  // One store per process: a second call has nothing to bind, and its sweep is
  // already armed below.
  if (store) return;
  store = new SessionStore(
    undefined,
    {
      ttlSeconds: config.sessionTtl,
      rememberTtlSeconds: config.sessionRememberTtl,
    },
    (id: string) => forgetUpstreamSession(id),
  );
  /*
   * Armed where the store is created and nowhere else: `init` starts the
   * 60-second expiry sweep, and a second call on a store that already has one
   * would start a second interval. A store nobody initialised kept an expired
   * record until its cookie was presented again -- and the hook above, which
   * releases the upstream session and info caches, never ran for that record.
   */
  void store.init();
}

/**
 * The installation's session document, as the store reaches it: one read and
 * one write in the Master account's `gilbert` app folder, and the store owns
 * everything else (the shape, the expiry, the cache).
 */
export function sessionDocumentIo(ctx: Ctx, accountId: string): SessionDocumentIo {
  return {
    read: async () => {
      const found = await readAppFileAt(ctx, accountId, SESSION_DOCUMENT_NAME);
      if (!found) return null;
      /*
       * Parsed here rather than through `readAppJsonAt`, which answers `null`
       * for a document that does not parse: the store distinguishes a document
       * that is absent (which it may replace) from one it could not read
       * (which it may not), and that difference is the whole of `flush`.
       */
      return JSON.parse(found.text) as unknown;
    },
    write: (value) => writeAppFileAt(ctx, accountId, SESSION_DOCUMENT_NAME, value),
  };
}

/**
 * Point the session store at the installation's own document, before serving.
 *
 * The boot calls this once, and it is the only code that has the Master's
 * session and the account the document lives in. Called twice it would leave
 * the store it replaces unclosed and holding a document nobody reads, so the
 * second call is refused rather than silently leaking one.
 */
export async function useDurableSessions(
  io: SessionDocumentIo,
  ttls: SessionTtls,
): Promise<void> {
  if (durable) throw new Error("sessions are already durable");
  durable = true;
  // A store `createApp` bound before this ran -- a process that built an app
  // and then signed in as the Master -- is closed rather than left running
  // beside the durable one, with whatever in-memory sessions it had.
  if (store) await store.close();
  store = new SessionStore(io, ttls, (id: string) => forgetUpstreamSession(id));
  await store.init();
}

/** Whether `useDurableSessions` has already replaced the in-memory store. */
export let durable = false;
export let loginLimiterInstance: RateLimiter | null = null;
/*
 * Built on first use rather than at import: the ceiling comes from the
 * installation's own configuration, which a deployment replaces at boot
 * (`useConfiguration`). A module-scope instance would keep whatever the
 * environment said before anything had been read.
 */
export const loginLimiter = () =>
  (loginLimiterInstance ??= new RateLimiter(config.loginRateLimit, 15 * 60_000));
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
export let loginFloodLimiterInstance: RateLimiter | null = null;
/*
 * Built on first use rather than at import: the ceiling comes from the
 * installation's own configuration, which a deployment replaces at boot
 * (`useConfiguration`). A module-scope instance would keep whatever the
 * environment said before anything had been read.
 */
export const loginFloodLimiter = () =>
  (loginFloodLimiterInstance ??= new RateLimiter(
    config.loginRateLimit * 20,
    15 * 60_000,
  ));
/**
 * Credential changes verify the current password upstream, and Stalwart's
 * fail2ban counts those failures against the *caller's* IP — which for a proxy
 * is shared by every user. Keep our own lid on it so one person guessing
 * cannot get the whole deployment banned.
 *
 * Shared across every credential-mutating endpoint on this account: changing
 * the password, enabling or disabling 2FA, and minting or revoking an app
 * password. 20 is enough for a person doing several of these in one sitting
 * (setting up 2FA, then an app password for each of a couple of devices)
 * while still bounding a guessing script to the same handful of attempts per
 * 15 minutes it always had.
 */
export const accountLimiter = new RateLimiter(20, 15 * 60_000);
export let apiLimiterInstance: RateLimiter | null = null;
/*
 * Built on first use rather than at import: the ceiling comes from the
 * installation's own configuration, which a deployment replaces at boot
 * (`useConfiguration`). A module-scope instance would keep whatever the
 * environment said before anything had been read.
 */
export const apiLimiter = () =>
  (apiLimiterInstance ??= new RateLimiter(config.apiRateLimit, 60_000));

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

export const eventsStreamCounts = new Map<string, number>();

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
export const MAX_SMALL_BODY = 64 * 1024;
export const DATA_PATH = /\/api\/(jmap$|upload\/)/;
export const limitSmallBody = bodyLimit({
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

/* ------------------------------------------------------------------ */
/* The forced-password-change directive (ADR 0001)                     */
/* ------------------------------------------------------------------ */

/**
 * A verdict about a session, and when it was read.
 *
 * One shape for both verdicts below, because they are one mechanism: a map keyed
 * by user, one window, and the same expiry rule.
 */
/** The upstream session for a live one, asked the same way by both verdicts. */
function upstreamForSession(session: LiveSession): Promise<UpstreamSession> {
  return getUpstreamSession(
    session.id,
    session.authorization,
    upstreamFor(session.username),
  );
}

export interface SessionVerdict<T> {
  value: T;
  checkedAt: number;
}

/**
 * How long a session verdict may be believed.
 *
 * Admin set/clear deletes the entry it changed, so its effect is immediate, and
 * this bounds how long a fact written behind the server's back -- another
 * instance, a direct JMAP write -- takes to land. One window for the same rule
 * in two places.
 */
export const SESSION_VERDICT_TTL_MS = 30_000;

/**
 * A verdict about a session, remembered for the window.
 *
 * A stale entry is dropped rather than overwritten in place: the map would
 * otherwise keep one entry per user ever checked for the life of the process,
 * with nothing ever deleting the ones that stop requesting.
 */
export async function cachedVerdict<T>(
  cache: Map<string, SessionVerdict<T>>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.checkedAt < SESSION_VERDICT_TTL_MS) return hit.value;
  if (hit) cache.delete(key);
  const value = await read();
  cache.set(key, { value, checkedAt: Date.now() });
  return value;
}

/**
 * Short-TTL in-memory cache of the directive's presence, keyed by username.
 *
 * The door judges every data request against this, so a user forced while
 * already signed in is stopped at their next request without every request
 * paying for a FileNode read of their own account.
 */
export const directiveCache = new Map<string, SessionVerdict<boolean>>();

/**
 * Whether this session's user is currently forced to change their password.
 *
 * App-password sessions are never forced (ADR 0001): the wall needs the
 * current account password, and accounts with two-factor authentication on
 * can only sign in with an app password.
 */
export async function sessionForcedState(
  session: LiveSession,
  upstream?: UpstreamSession,
): Promise<boolean> {
  if (session.appPassword) return false;
  return cachedVerdict(directiveCache, normalizeUsername(session.username), async () => {
    try {
      return await isPasswordChangeForced({
        authorization: session.authorization,
        session: upstream ?? (await upstreamForSession(session)),
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
      return false;
    }
  });
}

/* ------------------------------------------------------------------ */
/* The identity lock (ADR 0007, ADR 0001)                           */
/* ------------------------------------------------------------------ */

/**
 * Short-TTL cache of a session's own lock state, the same mechanism as
 * `directiveCache` above and for the same reason: every session refresh would
 * otherwise pay for a FileNode read of the account's own app folder.
 */
export const identityLockCache = new Map<string, SessionVerdict<boolean>>();

/** Whether the signed-in session's own account is currently locked. */
export async function sessionIdentityLockState(
  session: LiveSession,
  upstream?: UpstreamSession,
): Promise<boolean> {
  return cachedVerdict(
    identityLockCache,
    normalizeUsername(session.username),
    async () => {
      try {
        return await identityLockedForSession({
          authorization: session.authorization,
          session: upstream ?? (await upstreamForSession(session)),
          username: session.username,
        });
      } catch (err) {
        console.warn(
          `[gilbert] could not check the identity lock for ${session.username}:`,
          (err as Error).message,
        );
        return false;
      }
    },
  );
}

/** Batched: whether each listed account currently carries the directive (ADR 0001). */
export async function forcedFlagsFor(
  users: Array<{ id: string; name: string }>,
  admin: LiveSession,
): Promise<Array<{ id: string; name: string; forced: boolean }>> {
  const out: Array<{ id: string; name: string; forced: boolean }> = [];
  const BATCH = 4;
  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH);
    const flags = await Promise.all(
      batch.map(async (u) => {
        try {
          const auth = impersonationAuthorization(admin, u.name);
          if (!auth) return false;
          const up = await fetchUpstreamSession(auth, upstreamFor(u.name));
          return isPasswordChangeForced({
            authorization: auth,
            session: up,
            username: u.name,
          });
        } catch (err) {
          console.warn(
            `[gilbert] could not read the forced-password-change directive for ${u.name}:`,
            (err as Error).message,
          );
          return false;
        }
      }),
    );
    batch.forEach((u, idx) => out.push({ ...u, forced: flags[idx] ?? false }));
  }
  return out;
}

/**
 * Whether a mount-relative `/api` path is a data route the door covers.
 *
 * The exemptions are named rather than the data routes, so a route that is not
 * here is behind the wall: a new `/api/*` surface is born closed, and opening
 * one is a deliberate edit to this list. ADR 0001's own list is what is open —
 * signing in, signing out, the session the wall reads, the password change that
 * clears the directive, the config and health the sign-in page reads before it
 * has a session, and the admin endpoints, which answer for an administrator
 * acting on somebody else's account rather than for the account being forced.
 */
export function isDoorPath(rel: string): boolean {
  if (rel.startsWith("/auth/") || rel.startsWith("/admin/")) return false;
  return rel !== "/config" && rel !== "/health" && rel !== "/account/password";
}

/** The socket's own address -- the one part of a request nobody downstream can forge. */
export function peerAddress(c: Context): string {
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
export function requestProto(c: Context): "http" | "https" {
  if (config.trustProxy && isTrustedProxy(peerAddress(c), config)) {
    const proto = c.req.header("x-forwarded-proto");
    if (proto)
      return proto.split(",")[0]!.trim().toLowerCase() === "https" ? "https" : "http";
  }
  return new URL(c.req.url).protocol === "https:" ? "https" : "http";
}

export function isSecureRequest(c: Context): boolean {
  if (config.secureCookies === "1" || config.secureCookies === "true") return true;
  if (config.secureCookies === "0" || config.secureCookies === "false") return false;
  return requestProto(c) === "https";
}

/** A host that can go into a URL: a name, IPv4, or a bracketed IPv6, with an optional port. */
export const PUSH_HOST_RE =
  /^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)(?::\d{1,5})?$/;

/**
 * The https origin Stalwart can reach this installation at, read off the
 * request that carried the session (ADR 0009).
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
export const UNCOMPRESSED_ROUTES = [
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

/**
 * The fixed sentence an upstream failure carries, one per machine code.
 *
 * `upstreamFailure` answers every authenticated caller, so it never repeats the
 * mail server's own message: the `error` code says which kind of failure it was
 * and this says it in words, while the detail is logged server-side.
 */
export function upstreamFailureMessage(error: string): string {
  switch (error) {
    case "invalid_credentials":
      return "The mail server rejected these credentials.";
    case "forbidden":
      return "The mail server refused this request for this account.";
    case "not_found":
      return "The mail server has nothing at that address.";
    default:
      return "The mail server could not complete the request. This is not a problem with your password.";
  }
}

/**
 * The answer to a failure talking to the mail server: the machine `error` code
 * is the contract the client reads, and the sentence beside it is fixed (see
 * `upstreamFailureMessage`) rather than the mail server's own message. The one
 * exception is a 4xx this server raised about a path — an `AppFolderError`
 * carries its own code and sentence, both ours — which is answered as it
 * stands.
 */
export function upstreamFailure(c: Context, err: unknown) {
  /*
   * This server's own refusal about a path is not an upstream failure: an
   * `AppFolderError` carries its own code and status (`bad_path`, 400), and
   * answering it as 502 both misnames the cause and tells the caller to retry
   * something that will never work. Only the 4xx half is taken here — a 5xx
   * from the same class is an upstream failure wearing it, and keeps the fixed
   * sentence every other upstream failure gets, with the detail in the log.
   */
  if (err instanceof AppFolderError && err.status >= 400 && err.status < 500)
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  if (err instanceof UpstreamError) {
    // A 403 is a permission and a 404 a missing object: the code keeps the
    // reason the mail server distinguished, rather than collapsing both into a
    // generic upstream failure.
    const status =
      err.status === 401 || err.status === 403 || err.status === 404 ? err.status : 502;
    const error =
      status === 401
        ? "invalid_credentials"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not_found"
            : "upstream_error";
    // The message can carry a refusal detail read from the mail server's own
    // answer; it belongs in the log, not in the response.
    console.error(`[gilbert] upstream failure (${status}):`, err.message);
    return c.json({ error, message: upstreamFailureMessage(error) }, status);
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
 * What a publish reports is the job it recorded.
 *
 * One document, two names: the route answers it as the outcome of the run it
 * just made, and the same document is what the account holds, so the
 * administration surface reads the identical answer back after a restart
 * (`PublishJob`, `server/src/adminPolicy.ts`).
 */
export type PublishOutcome = PublishJob;

/**
 * The forced-password-change door (ADR 0001).
 *
 * It answers 403 `{ error: "password_change_required" }` on the data routes
 * while the session's user carries the directive in their own app folder.
 * `/auth/login`, `/auth/logout`, `/auth/session`, `/api/config`,
 * `/api/health`, `/api/account/password` and the admin endpoints stay open —
 * the wall needs the session and the change endpoint to exist. The directive
 * is judged per request against the short-TTL cache above, so a user forced
 * while already signed in is stopped at their next request; admin set/clear
 * and the clear-on-change invalidate the entry at once.
 *
 * Enforcement lives here, not in the client: a browser that never renders the
 * wall still cannot reach a data byte through the proxy.
 *
 * `basePath` is a parameter rather than read straight from the config so the
 * tests can mount the same app twice, at the root and under a prefix, without
 * re-importing the module to change one environment variable.
 */
export const forcedPasswordDoor =
  (basePath: string): MiddlewareHandler<Env> =>
  async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const prefix = `${basePath}/api`;
    // Only the API mount is judged: the static shell is not a data route, and
    // it is reached without a session at all.
    if (!path.startsWith(prefix)) return next();
    const rel = path.slice(prefix.length) || "/";
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

export const accountCtx = async (c: Context<Env>) => {
  const session = c.get("session");
  const upstream = await getUpstreamSession(session.id, session.authorization);
  return {
    authorization: session.authorization,
    session: upstream,
    username: session.username,
  };
};

export const accountFailure = (c: Context, err: unknown) => {
  if (err instanceof AccountError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  }
  return upstreamFailure(c, err);
};

/** The limiter key one credential endpoint's attempts are counted under. */
export const credentialLimitKey = (c: Context<Env>, scope: string) =>
  `${scope}|${c.get("session").username.toLowerCase()}`;

/** Guard the endpoints that check a password against brute-forcing. */
export const guarded = (c: Context<Env>, scope = "account"): Response | null => {
  const key = credentialLimitKey(c, scope);
  if (accountLimiter.check(key)) return null;
  c.header("Retry-After", String(accountLimiter.retryAfterSeconds(key)));
  return c.json(
    { error: "rate_limited", message: "Too many attempts. Please wait and try again." },
    429,
  );
};

/**
 * Give the attempt back when the failure is not a judgement on the password.
 *
 * A 401 -- or a refusal the mail server itself phrased (`AccountError`) -- is
 * about the credential and stays counted; anything else is the upstream
 * failing to answer, which says nothing about the password and must not spend
 * somebody's attempts while they wait for it to come back (#239, the login
 * path's own rule). Only endpoints that passed `guarded` have an attempt to
 * give back, so a refund past one is harmless.
 */
export const refundCredentialAttempt = (
  c: Context<Env>,
  err: unknown,
  scope = "account",
): void => {
  const judged =
    err instanceof UpstreamError
      ? err.status === 401
      : err instanceof AccountError && err.status < 500;
  if (!judged) accountLimiter.refund(credentialLimitKey(c, scope));
};

/**
 * Stalwart admin is the Gilbert admin: the session's own `/api/account`
 * permission list, read freshly on every privileged call so a demotion
 * really lands on the next call of an open session. Fails closed — an
 * unreachable introspection is an upstream failure, a list without the
 * admin marker is a plain 403.
 *
 * Two conditions on top of that marker bound every admin route as well as
 * the JMAP proxy (ADR 0017): the installation still offers administration
 * (`server.administration`), and this session was signed in on a device
 * marked as its owner's. An operator who turned administration off means it
 * of every door — this is the second one, and the version of the product that
 * only hid the menu would leave every one of these routes open to a browser
 * console.
 *
 * It bounds **writes**, and only writes: what a session may *read* is decided by
 * the rules of the surface it reads — a workorder's visibility is competence
 * (ADR 0028) — so neither condition here ever changes what a member or an
 * administrator sees.
 */
export const adminAllows = (session: LiveSession) =>
  administrationAllowed(
    config.administration,
    config.administrationNeedsOwnDevice,
    session.remember,
  );

/**
 * The administrator door, in one place: the checks `requireAdmin` performs,
 * and the same checks a route needs when only one tier of a shared write is
 * an administration's. It answers a refusal response, or null when the
 * session may act, and hands the caller's own permission list on for
 * `outranks`.
 */
export const enforceAdmin = async (c: Context<Env>): Promise<Response | null> => {
  try {
    // Registered behind requireSession everywhere; the deref sits inside
    // the try so a mis-registration fails as a controlled response, not a
    // 500 out of the accessor.
    const session = c.get("session");
    const intro = await fetchAccountIntrospection(
      session.authorization,
      upstreamFor(session.username),
    );
    if (!isStalwartAdmin(intro.permissions)) {
      return c.json(
        {
          error: "forbidden",
          message: "This needs Stalwart server-administrator privileges.",
        },
        403,
      );
    }
    if (!adminAllows(session)) {
      return administrationRefusal(c, config.administration);
    }
    // Handed on rather than fetched again: a route that acts on another
    // account has to compare the two permission lists (see `outranks`), and
    // this is the caller's own, read fresh a moment ago.
    c.set("adminPermissions", intro.permissions);
    return null;
  } catch (err) {
    return upstreamFailure(c, err);
  }
};

export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  const refusal = await enforceAdmin(c);
  if (refusal) return refusal;
  await next();
};

/**
 * Whether this session's credential currently resolves as a Stalwart admin,
 * for the client's `isAdmin` flag (ADR 0001). Fail-closed and never fatal:
 * an unreadable introspection reads as non-admin, so the shield is a
 * cosmetic mirror of the enforcement in `requireAdmin`, which stays the
 * authority.
 */
export const resolveAdminState = async (session: LiveSession): Promise<boolean> => {
  try {
    const intro = await fetchAccountIntrospection(
      session.authorization,
      upstreamFor(session.username),
    );
    return isStalwartAdmin(intro.permissions);
  } catch (err) {
    console.warn(
      `[gilbert] admin introspection failed for ${session.username}:`,
      (err as Error).message,
    );
    return false;
  }
};

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

/**
 * Why an administrative route is unavailable, as one refusal (ADR 0017). The
 * two causes are told apart because they are fixed differently: one by the
 * operator, one by signing in again on your own device. `method` names what was
 * refused, where a request had a name to give.
 */
export function administrationRefusal(
  c: Context<Env>,
  enabled: boolean,
  method?: string,
) {
  const suffix = method ? ` (${method})` : "";
  /*
   * Two causes, told apart because they are fixed differently — one by the
   * operator's configuration, the other by signing in again on your own device.
   * `enabled` false is the installation's own switch; reaching here with it true
   * means the only rule left is the device one, so that is what is reported.
   */
  return !enabled
    ? c.json(
        {
          error: "administration_disabled",
          message: `Administration is turned off on this installation${suffix}.`,
        },
        403,
      )
    : c.json(
        {
          error: "administration_needs_own_device",
          message: `Administration is only available when signed in on a device marked as your own${suffix}.`,
        },
        403,
      );
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

export async function readJson<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Is `candidate` the password of the account this session is signed in to?
 *
 * Compared with the credential the session holds first, which costs nothing
 * and tells Stalwart nothing: its auto-ban counts failures against the proxy's
 * address, which every user of this installation shares, and fail2ban reads
 * the same log. That credential is the password, with a TOTP code after a `$`
 * when one was given at sign-in. A session that turning on 2FA moved onto an
 * app password (Stalwart's secrets start `$app$`) holds something else, and
 * only then is the candidate put to the server -- where an answer that is not
 * a refusal is a failed installation rather than a wrong password, and is
 * thrown rather than reported as one (`accountFailure` answers it).
 */
export async function confirmsPassword(
  session: LiveSession,
  candidate: string,
): Promise<boolean> {
  const raw = session.authorization.startsWith("Basic ")
    ? session.authorization.slice("Basic ".length)
    : "";
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  const held = sep < 0 ? "" : decoded.slice(sep + 1);
  if (safeEqual(held, candidate)) return true;
  const withoutCode = held.replace(/\$\d{6,8}$/, "");
  if (withoutCode !== held && safeEqual(withoutCode, candidate)) return true;
  // Holding the password, the comparison above is the answer, and a wrong
  // guess never reaches the server's auto-ban.
  if (!held.startsWith("$app$")) return false;
  try {
    const authorization = `Basic ${Buffer.from(`${session.username}:${candidate}`, "utf8").toString("base64")}`;
    await fetchUpstreamSession(authorization, upstreamFor(session.username));
    return true;
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 401) return false;
    throw err;
  }
}

/** Name the app password after the browser it will live in. */
export function appPasswordName(c: Context): string {
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

/** The installation's own account, once this process has resolved it. */
let installationAccount: {
  /** The agent address it was resolved from: a change of configuration re-resolves. */
  address: string;
  account: InstallationAccount;
} | null = null;

/** The installation's own account, with the session that reaches it. */
export interface InstallationAccount {
  id: string;
  /** The Master's own context: the credential the deployment holds. */
  master: Ctx;
}

/**
 * Stalwart's id for the installation's own account, and the session that reaches
 * it, or null when there is none.
 *
 * The account is the Master's, and it is the whole reason the client cannot
 * find this fact on its own: no member's session is a member of it, so its id
 * is on no list the session holds, and a FileNode change naming it would mean
 * nothing to a reader (ADR 0028, `followAccount` in push.ts). Resolved through
 * the identity door with the credential the deployment holds, and remembered
 * once it answers — the id *and* the session, because both callers need the
 * session to act on the account: the session payload states the id, and the
 * push rail subscribes with it. A change of configuration re-resolves rather
 * than serving the earlier installation's account, and a failure is not
 * remembered — a credential that could not be used yet gets another look rather
 * than leaving the fact untrue for the life of the process.
 */
export async function resolveInstallationAccount(
  session: LiveSession,
): Promise<InstallationAccount | null> {
  const address = agentAddress();
  if (!address) return null;
  if (installationAccount?.address === address) return installationAccount.account;
  try {
    const master = await agentSession(session);
    const id = filesAccountId(master);
    if (!id) return null;
    installationAccount = { address, account: { id, master } };
    return installationAccount.account;
  } catch {
    // No agent named, or one that cannot be used: there is no installation
    // account to name, and this session follows none.
  }
  return null;
}

export function sessionExtras(
  session: LiveSession,
  info: AccountInfo = { locale: null, edition: null },
  isAdmin = false,
  mustChangePassword = false,
  identityLocked = false,
  installationAccount: string | null = null,
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
      /** Stalwart-admin state resolved at sign-in (ADR 0001): enables the admin surface. */
      isAdmin,
      /**
       * ADR 0017: whether this session may administer at all. The menu follows
       * it, and the JMAP proxy is the door that enforces it: a false here also
       * means every `x:` method beyond the account's own is refused. False when
       * the installation offers no administration, and when it asked for the
       * own-device rule and this session was not signed in on one.
       */
      administration: administrationAllowed(
        config.administration,
        config.administrationNeedsOwnDevice,
        session.remember,
      ),
      /**
       * An administrator whom the own-device rule stopped, so the menu can say
       * why rather than lose the entry without a word. Says only that the
       * account administers, never what it may do. Always false where the
       * installation did not ask for the rule.
       */
      administrationNeedsOwnDevice:
        config.administration &&
        config.administrationNeedsOwnDevice &&
        !session.remember &&
        isAdmin,
      /**
       * ADR 0001: the account must change its password before any data route
       * will serve it. The wall is the middleware, not this flag — the flag
       * only tells the client which screen to show.
       */
      mustChangePassword,
      /** Locale configured for the account in Stalwart's directory, if readable. */
      userLocale: info.locale,
      /** What the upstream server would tell us about itself. */
      server: { edition: info.edition },
      /**
       * ADR 0007, ADR 0001: an administrator has taken this account's
       * identity over, so the product offers it no Identities & signatures
       * section at all. Read from the account's own app folder (the caller
       * resolves it, since that is an async lookup); it is a rule about the
       * surface, and the section is all it removes.
       */
      identityLocked,
      /**
       * ADR 0028: Stalwart's id for the installation's own account — the
       * Master's, where the global checklist and the registry live. No member's
       * session is a member of it, so the id cannot be read off the session's
       * own accounts, and a FileNode change naming it would mean nothing to the
       * client without this fact. `null` when there is no installation account
       * to name, and the client then follows none rather than guessing one.
       */
      installationAccount,
    },
  };
}

/**
 * Headers worth relaying from the mail server. An allowlist rather than a
 * denylist: everything else it might set — cookies, auth challenges, CORS
 * grants — would be landing on *our* origin, where it means something else.
 */
export const PASSTHROUGH_HEADERS = new Set([
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
export function isGenericType(ct: string): boolean {
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
export function blobContentType(upstreamType: string | null, declared: string): string {
  const up = mediaType(upstreamType);
  return sanitizeContentType(isGenericType(up) ? declared : up);
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
  return safeInline && mediaType(type) === "application/pdf" ? "SAMEORIGIN" : "DENY";
}
