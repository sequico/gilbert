import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { getConnInfo } from "@hono/node-server/conninfo";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
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
  readGroupLabels,
  revokeAppPassword,
  type SecurityState,
  setPasswordChangeDirective,
  writeGroupLabels,
} from "./account.js";
import { administrationAllowed, gateAdministration } from "./adminGate.js";
import {
  EMPTY_POLICY,
  type PolicyDocument,
  parsePolicyDocumentDetailed,
  policyDocumentText,
  readAccountPolicy,
  readPublishJob,
  refusalCodeFor,
  writeAccountPolicy,
  writePublishJob,
} from "./adminPolicy.js";
import {
  deleteSystemSieveScript,
  getSystemSieveScript,
  listSystemSieveScripts,
  SystemSieveError,
  saveSystemSieveScript,
  setSystemSieveScriptActive,
} from "./adminSieve.js";
import { agentRuleJsonSchema } from "./agent/documents.js";
import type { AgentGroupAnswer } from "./agent/views.js";
import {
  AgentAdminError,
  addAgentLabels,
  agentStatus,
  emptyGroupDocuments,
  groupAgentView,
  groupAuditExport,
  impersonateAs,
  memberAgentView,
  memberGroupMembers,
  pendingApprovals,
  readDraft,
  readGroupInstruction,
  readGroupNotebook,
  readProviders,
  readRules,
  resolveGroupAccess,
  runRuleNow,
  saveGroupInstruction,
  saveGroupNotebook,
  saveRules,
  writeProviders,
} from "./agentAdmin.js";
import {
  appFolderState,
  type Ctx,
  ensureAppFolder,
  filesAccountId,
  readAppFileAt,
  writeAppFileAt,
} from "./appFolder.js";
import { isTrustedProxy, rateLimitKey, resolveClientIp } from "./clientip.js";
import { agentAddress, config } from "./config.js";
import { safeEqual } from "./crypto.js";
import { icsProxyHandler } from "./icsproxy.js";
import {
  groupIdentity,
  IdentityAdminError,
  identityAddress,
  identityLockedForSession,
  memberGroupAssignment,
  personIdentities,
  removePersonIdentity,
  setPersonDefaultIdentity,
  setUserIdentityLock,
  storeSignatureHtml,
  writeGroupIdentity,
  writePersonIdentity,
} from "./identityAdmin.js";
import { imageProxyHandler } from "./imageproxy.js";
import {
  type InstallationRefused,
  publishInstallation,
  readInstallationForAdmin,
} from "./installationAdmin.js";
import {
  MAX_PUSH_BODY_BYTES,
  attach as pushAttach,
  attachRelay as pushAttachRelay,
  prepare as pushPrepare,
  receive as pushReceive,
  pushStatus,
} from "./push.js";
import { RateLimiter } from "./ratelimit.js";
import {
  accountKey,
  impersonationAuthorization,
  type LiveSession,
  normalizeUsername,
  SESSION_DOCUMENT_NAME,
  type SessionBackend,
  type SessionDocumentIo,
  SessionStore,
  type SessionTtls,
} from "./sessions.js";
import { CAPABILITIES } from "./shared/capabilities.js";
import type { PublishJob, PublishUnreached } from "./shared/publishJob.js";
import type { SystemSieveScriptWrite } from "./shared/sieveViews.js";
import { staticHandler } from "./static.js";
import {
  type AccountInfo,
  absoluteUpstream,
  expandTemplate,
  fetchAccountIntrospection,
  fetchDirectoryGroups,
  fetchDirectoryUsers,
  fetchUpstreamSession,
  forgetUpstreamSession,
  getAccountInfo,
  getUpstreamSession,
  hasStalwartRegistry,
  isStalwartAdmin,
  localizeSession,
  outranks,
  UpstreamError,
  type UpstreamSession,
  upstreamFor,
} from "./upstream.js";

type Env = { Variables: { session: LiveSession; adminPermissions: readonly string[] } };

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
 * What guarantees the replacement now is `createApp` itself, in two halves. A
 * process that names a Master (`GILBERT_AGENT_ADDRESS`: the account
 * `bootstrap.ts` signs in as, whose own app folder holds the installation's
 * documents, this one included) is a deployment, and a deployment's sessions
 * live in that account's own document or the deployment does not come up --
 * so `createApp` refuses to build an app for one whose store is not durable
 * instead of serving sessions out of memory. A process that names no Master
 * has nowhere durable to put them, and gets the in-memory store bound there,
 * from the configuration that process is really running on.
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
let store: SessionBackend | null = null;

/** The bound store, or a refusal that names what binds one. */
function bound(): SessionBackend {
  if (!store)
    throw new Error(
      "No session store has been bound in this process: `createApp` binds the in-memory store for a " +
        "process that names no Master, and `useDurableSessions` installs the installation's own before a " +
        "deployment builds its app.",
    );
  return store;
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
let durable = false;
let loginLimiterInstance: RateLimiter | null = null;
/*
 * Built on first use rather than at import: the ceiling comes from the
 * installation's own configuration, which a deployment replaces at boot
 * (`useConfiguration`). A module-scope instance would keep whatever the
 * environment said before anything had been read.
 */
const loginLimiter = () =>
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
let loginFloodLimiterInstance: RateLimiter | null = null;
/*
 * Built on first use rather than at import: the ceiling comes from the
 * installation's own configuration, which a deployment replaces at boot
 * (`useConfiguration`). A module-scope instance would keep whatever the
 * environment said before anything had been read.
 */
const loginFloodLimiter = () =>
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
const accountLimiter = new RateLimiter(20, 15 * 60_000);
let apiLimiterInstance: RateLimiter | null = null;
/*
 * Built on first use rather than at import: the ceiling comes from the
 * installation's own configuration, which a deployment replaces at boot
 * (`useConfiguration`). A module-scope instance would keep whatever the
 * environment said before anything had been read.
 */
const apiLimiter = () =>
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
const loginBody = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.json({ error: "too_large" }, 413),
});
const smallBodies: MiddlewareHandler<Env> = (c, next) =>
  DATA_PATH.test(c.req.path) ? next() : limitSmallBody(c, next);

/** Per-session budget on the data path. See config.apiRateLimit. */
const apiRateLimited: MiddlewareHandler<Env> = async (c, next) => {
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
 * App-password sessions are never forced (ADR 0001): the wall needs the
 * current account password, and accounts with two-factor authentication on
 * can only sign in with an app password.
 */
async function sessionForcedState(
  session: LiveSession,
  upstream?: UpstreamSession,
): Promise<boolean> {
  if (session.appPassword) return false;
  const key = normalizeUsername(session.username);
  const hit = directiveCache.get(key);
  if (hit && Date.now() - hit.checkedAt < DIRECTIVE_CACHE_TTL_MS) return hit.forced;
  // A stale entry is dropped, not overwritten in place: the map would
  // otherwise keep one entry per user ever checked for the life of the
  // process, with nothing ever deleting the ones that stop requesting.
  if (hit) directiveCache.delete(key);
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
  directiveCache.set(key, { forced, checkedAt: Date.now() });
  return forced;
}

/* ------------------------------------------------------------------ */
/* The identity lock (ADR 0007, ADR 0001)                           */
/* ------------------------------------------------------------------ */

interface LockCheck {
  locked: boolean;
  checkedAt: number;
}

/**
 * Short-TTL cache of a session's own lock state, the same shape as
 * `directiveCache` above and for the same reason: every session refresh would
 * otherwise pay for a FileNode read of the account's own app folder. The
 * lock endpoint deletes the entry it just changed, so applying or releasing
 * one is immediate; the TTL bounds how long a lock written behind the
 * server's back takes to land.
 */
const identityLockCache = new Map<string, LockCheck>();
const IDENTITY_LOCK_CACHE_TTL_MS = 30_000;

/** Whether the signed-in session's own account is currently locked. */
async function sessionIdentityLockState(
  session: LiveSession,
  upstream?: UpstreamSession,
): Promise<boolean> {
  const key = normalizeUsername(session.username);
  const hit = identityLockCache.get(key);
  if (hit && Date.now() - hit.checkedAt < IDENTITY_LOCK_CACHE_TTL_MS) return hit.locked;
  if (hit) identityLockCache.delete(key);
  let locked = false;
  try {
    const up =
      upstream ??
      (await getUpstreamSession(
        session.id,
        session.authorization,
        upstreamFor(session.username),
      ));
    locked = await identityLockedForSession({
      authorization: session.authorization,
      session: up,
      username: session.username,
    });
  } catch (err) {
    console.warn(
      `[gilbert] could not check the identity lock for ${session.username}:`,
      (err as Error).message,
    );
  }
  identityLockCache.set(key, { locked, checkedAt: Date.now() });
  return locked;
}

/** Batched: whether each listed account currently carries the directive (ADR 0001). */
async function forcedFlagsFor(
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
function isDoorPath(rel: string): boolean {
  if (rel.startsWith("/auth/") || rel.startsWith("/admin/")) return false;
  return rel !== "/config" && rel !== "/health" && rel !== "/account/password";
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
  if (config.trustProxy) {
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
function pushOrigin(c: Context): string | null {
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
/** The path the session cookie is scoped to: the prefix this instance answers on. */
const cookiePath = () => config.basePath || "/";

function setSessionCookie(c: Context, value: string, remember: boolean) {
  setCookie(c, config.cookieName, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    path: cookiePath(),
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
 * What a publish reports is the job it recorded.
 *
 * One document, two names: the route answers it as the outcome of the run it
 * just made, and the same document is what the account holds, so the
 * administration surface reads the identical answer back after a restart
 * (`PublishJob`, `server/src/adminPolicy.ts`).
 */
export type PublishOutcome = PublishJob;

/**
 * `basePath` is a parameter rather than read straight from the config so the
 * tests can mount the same app twice, at the root and under a prefix, without
 * re-importing the module to change one environment variable.
 */
export function createApp(basePath = config.basePath): Hono<Env> {
  /*
   * The store this app will serve with, bound before a single route exists --
   * the whole of what makes the in-memory default impossible to reach without
   * asking for it (see `sessions` above). A boot has already installed the
   * durable store by the time it builds an app; a process that names a Master
   * but has not installed one is a deployment that would lose every session at
   * its next restart, and it refuses to serve rather than doing that quietly.
   */
  if (!durable) {
    if (agentAddress())
      throw new Error(
        "This process names a Master (GILBERT_AGENT_ADDRESS), so this installation's sessions live in " +
          "that account's own document -- but no durable session store was installed, and an app that " +
          "served in-memory sessions would end every one of them at the next restart. A deployment calls " +
          "useDurableSessions before it builds its app (server/src/index.ts does); a process that wants " +
          "sessions in memory runs without GILBERT_AGENT_ADDRESS.",
      );
    if (!store)
      store = new SessionStore(
        undefined,
        {
          ttlSeconds: config.sessionTtl,
          rememberTtlSeconds: config.sessionRememberTtl,
        },
        (id: string) => forgetUpstreamSession(id),
      );
  }
  const app = new Hono<Env>();
  app.use("*", securityHeaders);
  app.use("*", compressResponses(basePath));

  const api = new Hono<Env>();
  api.use("*", csrfGuard);
  api.use("*", smallBodies);

  /*
   * The forced-password-change door (ADR 0001).
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
    // The declared length is the cheap first refusal; `pushReceive` bounds what
    // it is handed, and the two share one number so they cannot drift.
    const len = Number(c.req.header("content-length") ?? "0");
    if (!len || len > MAX_PUSH_BODY_BYTES) return c.body(null, 413);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.body(null, 400);
    }
    return c.body(
      null,
      (await pushReceive(c.req.param("token"), body)) as 200 | 400 | 404 | 413 | 500,
    );
  });

  api.get("/config", (c) =>
    c.json({
      appName: config.appName,
      sourceUrl: config.sourceUrl,
      imageProxy: config.imageProxy,
      maxUploadBytes: config.maxUploadBytes,
    }),
  );

  /**
   * A signed-in account's own copy of the installation's settings policy
   * (ADR 0001): what the last publish wrote into this account's own app
   * folder, or the empty policy when no publish has reached it — an account
   * that carries nothing follows the product's own defaults. Authenticated:
   * the policy is a fact about one account, not something a visitor reads
   * before signing in.
   */
  api.get("/account/policy", requireSession, async (c) => {
    const session = c.get("session");
    try {
      const upstream = await getUpstreamSession(
        session.id,
        session.authorization,
        upstreamFor(session.username),
      );
      const ctx = {
        authorization: session.authorization,
        session: upstream,
        username: session.username,
      };
      const accountId = filesAccountId(ctx);
      /*
       * An account no publish has reached carries no document: it follows the
       * product's own defaults, which is what the empty policy says. There is
       * no installation-wide copy behind it — the policy lives in each
       * account's own storage, and nowhere else (ADR 0001).
       */
      const doc =
        (accountId ? await readAccountPolicy(ctx, accountId) : null) ?? EMPTY_POLICY;
      return c.json({
        policy: { defaults: doc.defaults, enforced: doc.enforced, changes: doc.changes },
      });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- Auth ----------
  api.post("/auth/login", loginBody, async (c) => {
    const ip = clientIp(c);
    // What the limits count under: the address, or its /64 for IPv6.
    const rateIp = rateLimitKey(ip);
    // The flood ceiling needs nothing from the body, so it goes before one is read.
    if (!loginFloodLimiter().check(rateIp)) {
      c.header("Retry-After", String(loginFloodLimiter().retryAfterSeconds(rateIp)));
      return c.json(
        {
          error: "rate_limited",
          message: "Too many login attempts. Please wait and try again.",
        },
        429,
      );
    }
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
     * `limitKey` is this username from this address, and `rateIp` is any
     * username from it -- both guard guessing, and both are given back when the
     * upstream never got as far as judging the password. Refunding only the
     * first would not fix #239: ten retries through an outage would still spend
     * the address budget, and behind one office NAT that budget belongs to the
     * whole building.
     *
     * The flood ceiling is the one that is never refunded, and it is the reason
     * the other two safely can be. It has already been answered above, before
     * the body was read.
     */
    const limitKey = `${rateIp}|${username.toLowerCase()}`;
    if (!loginLimiter().check(limitKey) || !loginLimiter().check(rateIp)) {
      c.header("Retry-After", String(loginLimiter().retryAfterSeconds(limitKey)));
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
        loginLimiter().refund(limitKey);
        loginLimiter().refund(rateIp);
        return c.json(
          {
            error: "unsupported_server",
            message:
              "Your credentials are fine, but this mail server is older than Stalwart 0.16, which Gilbert needs. Upgrade the server, or run the release tagged stalwart-0.15-support.",
          },
          501,
        );
      }
      loginLimiter().reset(limitKey);
      const { cookie, session } = sessions.create({
        username,
        account: accountKey(upstreamFor(username), upstream.username || username),
        password: effectivePassword,
        remember: Boolean(body.remember),
        userAgent: c.req.header("user-agent") ?? "",
        ip,
        // Whether the presented secret was an app password decides whether the
        // forced-password-change wall can ever apply to this session (ADR 0001).
        appPassword: upstream.authType === "app-password",
      });
      setSessionCookie(c, cookie, session.remember);
      // Start the account's push subscription now, so it is usually verified
      // by the time the browser opens its stream. See push.ts.
      const mailAccount = upstream.primaryAccounts?.[CAPABILITIES.mail];
      if (mailAccount)
        pushPrepare(session.username, mailAccount, session.authorization, pushOrigin(c));
      const info = await getAccountInfo(session.id, session.authorization, upstream);
      return c.json(
        localizeSession(
          upstream,
          sessionExtras(
            session,
            info,
            await resolveAdminState(session),
            // The session document was just fetched; hand it over instead of
            // making the directive check fetch it again.
            await sessionForcedState(session, upstream),
            await sessionIdentityLockState(session, upstream),
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
        loginLimiter().refund(limitKey);
        loginLimiter().refund(rateIp);
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
            await resolveAdminState(session),
            await sessionForcedState(session),
            await sessionIdentityLockState(session),
          ),
        ),
      );
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 401) {
        sessions.destroy(session.id);
        // destroy() already forgets the upstream caches through the store
        // hook; the explicit call keeps this branch self-contained.
        forgetUpstreamSession(session.id);
        deleteCookie(c, config.cookieName, { path: cookiePath() });
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
    deleteCookie(c, config.cookieName, { path: cookiePath() });
    return c.json({ ok: true });
  });

  api.get("/auth/sessions", requireSession, (c) => {
    const session = c.get("session");
    return c.json({
      current: session.id,
      sessions: sessions.listForUser(session.account),
    });
  });

  api.post("/auth/sessions/revoke-others", requireSession, (c) => {
    const session = c.get("session");
    const n = sessions.destroyAllForUser(session.account, session.id);
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
  const guarded = (c: Context<Env>, scope = "account"): Response | null => {
    const key = `${scope}|${c.get("session").username.toLowerCase()}`;
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
    const revoked = sessions.destroyAllForUser(session.account, session.id);
    // Was this user forced? The answer must be judged after the change, with
    // the freshly resealed credential: the door cache may still hold the
    // pre-force answer, and the old credential is dead the moment the change
    // lands upstream. Password changes are rare, so a fresh read is cheap.
    const fresh = sessions.resolve(getCookie(c, config.cookieName));
    directiveCache.delete(normalizeUsername(session.username));
    if (fresh && (await sessionForcedState(fresh))) {
      // ADR 0001: a successful change clears the directive in the user's own
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
      directiveCache.delete(normalizeUsername(session.username));
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
    // Minting a standing credential that skips 2FA and outlives a plain
    // password change is exactly what a hijacked session must not be able to
    // do silently in one call: it is guarded against brute-forcing like every
    // other credential-mutating endpoint here, and it re-asks the account's
    // own password first, the same way disabling 2FA does.
    //
    // A budget of its own, because this check is answered without Stalwart
    // (see `confirmsPassword`): the shared one would let a wrong guess here
    // spend the attempts the password change and the 2FA switch need.
    const limited = guarded(c, "app-password");
    if (limited) return limited;
    const session = c.get("session");
    const body = await readJson<{ description?: string; current?: string }>(c);
    if (!body) return c.json({ error: "bad_request" }, 400);
    const description = (body.description ?? "").trim().slice(0, 120);
    if (!description)
      return c.json(
        { error: "missing_fields", message: "Give the app password a name." },
        400,
      );
    const current = body.current ?? "";
    if (!current)
      return c.json(
        { error: "missing_fields", message: "Enter your current password." },
        400,
      );
    // `x:AppPassword/set` carries no `currentSecret` field to delegate this
    // check to (unlike `x:AccountPassword/set`), so it is verified here.
    let confirmed: boolean;
    try {
      confirmed = await confirmsPassword(session, current);
    } catch (err) {
      return accountFailure(c, err);
    }
    if (!confirmed)
      return c.json(
        { error: "wrong_password", message: "That password is not correct." },
        401,
      );
    try {
      return c.json(await createAppPassword(await accountCtx(c), { description }));
    } catch (err) {
      return accountFailure(c, err);
    }
  });

  api.post("/account/app-passwords/revoke", requireSession, async (c) => {
    const limited = guarded(c);
    if (limited) return limited;
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
    const revoked = sessions.destroyAllForUser(session.account, session.id);
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

  // ---------- Administration (ADR 0001, ADR 0017) ----------
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
   */
  const adminAllows = (session: LiveSession) =>
    administrationAllowed(
      config.administration,
      config.administrationNeedsOwnDevice,
      session.remember,
    );
  const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
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
    } catch (err) {
      return upstreamFailure(c, err);
    }
    await next();
  };

  /**
   * Whether this session's credential currently resolves as a Stalwart admin,
   * for the client's `isAdmin` flag (ADR 0001). Fail-closed and never fatal:
   * an unreadable introspection reads as non-admin, so the shield is a
   * cosmetic mirror of the enforcement in `requireAdmin`, which stays the
   * authority.
   */
  const resolveAdminState = async (session: LiveSession): Promise<boolean> => {
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

  /**
   * Set or clear the forced-password-change directive for a user (ADR 0001).
   *
   * The write authenticates to Stalwart as the composite `{target}%{admin}`
   * — impersonation with the administrator's own credentials rebuilt from
   * their sealed session — and performs ordinary JMAP FileNode/blob
   * operations on the target's own `gilbert` app folder, creating it when
   * the target has no app folder yet. The acting administrator must hold
   * Stalwart's `Impersonate` permission, granted by the operator on the
   * Stalwart side; there is no second secret and no Management API.
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
    const imp = await impersonateAs(admin, target);
    if (!imp.ok) {
      const error =
        imp.status === 404
          ? "target_not_found"
          : imp.status === 403
            ? "forbidden"
            : "upstream";
      return c.json({ error, message: imp.message }, imp.status);
    }
    const ctx = imp.ctx;
    // An administrator cannot force another administrator: resolve the
    // target's own admin state through the impersonated session, the same
    // way the acting admin's was resolved at sign-in (ADR 0001). This also
    // covers the acting admin themselves (master == target degrades to a
    // plain login upstream). A failure to introspect is an upstream failure
    // — the same composite credential just fetched the target's JMAP
    // session, so a refusal here is the server failing the introspection,
    // never the credential: report that rather than a misleading 401.
    try {
      const targetIntro = await fetchAccountIntrospection(
        ctx.authorization,
        upstreamFor(target),
      );
      if (isStalwartAdmin(targetIntro.permissions)) {
        return c.json(
          {
            error: "target_is_admin",
            message:
              "That account is also a Gilbert administrator; administrators cannot force one another's password.",
          },
          403,
        );
      }
      /*
       * The marker is one permission; it does not say whether the target holds
       * more than the acting administrator does. Stalwart does not re-check
       * that for every write (see `outranks`), so an account allowed to act on
       * others could reach into one carrying a richer custom role and force a
       * change on it. Refused here, on the two lists the server just resolved.
       */
      if (outranks(c.get("adminPermissions"), targetIntro.permissions)) {
        return c.json(
          {
            error: "target_outranks",
            message:
              "That account holds permissions this one does not; administrators cannot force a change on an account that outranks them.",
          },
          403,
        );
      }
    } catch (err) {
      return c.json(
        {
          error: "upstream_error",
          message: `Could not verify the target's administrator state: ${(err as Error).message}`,
        },
        502,
      );
    }
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
        } catch {
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
    directiveCache.delete(normalizeUsername(target));
    return c.json({ ok: true });
  });

  /**
   * The installation-wide settings policy (ADR 0001, ADR 0001, ADR 0001).
   *
   * GET reads the signed-in administrator's own account — the last publish
   * wrote there like everywhere else, so the editor's next load shows exactly
   * what it just saved — and answers the job that publish recorded in the same
   * account, so the surface says what the last publish did even when this
   * process never made one. POST validates the document and writes it into
   * every individual account the directory lists (fetchDirectoryUsers), the
   * publishing administrator's own account included, by impersonation — there
   * is no other shared copy to swap. One account's refusal does not stop the
   * rest; the response names how many were reached and which were not. Every
   * other signed-in session is kicked so the enforcement it is already holding
   * is dropped at once rather than waiting for that account's own next load to
   * refetch it.
   */
  api.get("/admin/policy", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      const upstream = await getUpstreamSession(
        session.id,
        session.authorization,
        upstreamFor(session.username),
      );
      const ctx = {
        authorization: session.authorization,
        session: upstream,
        username: session.username,
      };
      const accountId = filesAccountId(ctx);
      const doc =
        (accountId ? await readAccountPolicy(ctx, accountId) : null) ?? EMPTY_POLICY;
      // The last publish this account recorded, read from the account itself:
      // the answer does not depend on which instance made it, or on whether
      // this one ever did.
      const job = accountId ? await readPublishJob(ctx, accountId) : null;
      return c.json({ policy: policyDocumentText(doc), job });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  /**
   * Write the policy into every individual account the directory lists, by
   * impersonation — the administrator's own account included — and record the
   * publish as a job in the administrator's own app folder.
   *
   * What comes back is that job: the id this publish minted (the copies carry
   * it), when it started, who published, the population the directory listed,
   * whether that list was the whole directory, the accounts the policy reached
   * and the ones it did not with the reason for each. It is the same document
   * the account now holds, so the surface reads the same answer back after
   * this process is gone.
   *
   * A publish that could not read the directory, or read part of it, says so
   * here rather than letting a count of successes stand for the whole
   * installation: "eight accounts were reached" and "the installation carries
   * this policy" are different claims, and only the second is what an
   * administrator is being asked to believe.
   */
  async function publishAccountPolicy(
    admin: LiveSession,
    doc: PolicyDocument,
  ): Promise<PublishJob> {
    /*
     * One id for the whole publish, minted before the first copy goes out: the
     * copies carry it (`PolicyPublished`), so any account an administrator
     * looks into says which publish reached it, and the job recorded below
     * carries the same id.
     */
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    /*
     * Every copy this publish writes carries the job it came from: the id and
     * the moment, so any account an administrator looks into says which publish
     * reached it, and whether the copy it holds is the one this job made.
     */
    const copy: PolicyDocument = { ...doc, published: { id, at: startedAt } };
    const reached: string[] = [];
    const unreached: PublishUnreached[] = [];
    const upstream = await getUpstreamSession(
      admin.id,
      admin.authorization,
      upstreamFor(admin.username),
    );
    const own = {
      authorization: admin.authorization,
      session: upstream,
      username: admin.username,
    };
    const ownAccountId = filesAccountId(own);

    /**
     * One account's copy, written conditionally against that account's own
     * folder.
     *
     * The state token is read after the app folder is known to exist: creating
     * that folder moves the account's own state, and a token read before it
     * would make the conditional write lose a race with this very call (the
     * reason `AgentStore.provision` runs before a worker's first conditional
     * write). A refusal — the folder moved between the read and the write —
     * leaves the account with the document it already had, is named as its own
     * code rather than counted as reached, and never overwrites a copy this
     * publish did not see.
     */
    const deliver = async (
      address: string,
      ctx: Ctx,
      accountId: string,
    ): Promise<void> => {
      try {
        await ensureAppFolder(ctx, accountId);
        const state = await appFolderState(ctx, accountId);
        /*
         * No token means no way to tell a folder that moved from one that did
         * not, and a write without one would be counted as reached while it
         * could have overwritten a copy this publish never saw. The account is
         * named instead.
         */
        if (!state) throw new Error("the account would not state its file state");
        await writeAccountPolicy(ctx, accountId, copy, { ifInState: state });
        reached.push(address);
      } catch (err) {
        unreached.push({
          address,
          code: refusalCodeFor(err),
          message: (err as Error).message,
        });
      }
    };

    if (!ownAccountId) {
      unreached.push({
        address: admin.username,
        code: "no-files-account",
        message: "this account has no Files account to hold the policy",
      });
    } else {
      await deliver(admin.username, own, ownAccountId);
    }

    // The rest of the directory, one impersonated write per account. A failure
    // here does not undo the write just made to the publisher's own account --
    // there is no shared document for it to be undone against.
    const directory = await fetchDirectoryUsers(admin.authorization, upstream);
    let population: PublishJob["population"] = { read: 0, complete: false, total: null };
    let carrying = false;
    let refusal: string | undefined;
    if ("denied" in directory) {
      refusal = directory.denied;
    } else {
      for (const user of directory.users) {
        if (normalizeUsername(user.name) === normalizeUsername(admin.username)) continue;
        const imp = await impersonateAs(admin, user.name);
        if (!imp.ok) {
          unreached.push({
            address: user.name,
            code: "impersonation-refused",
            message: imp.message,
          });
          continue;
        }
        const accountId = filesAccountId(imp.ctx);
        if (!accountId) {
          unreached.push({
            address: user.name,
            code: "no-files-account",
            message: "this account has no Files account to hold the policy",
          });
          continue;
        }
        await deliver(user.name, imp.ctx, accountId);
      }
      population = {
        read: directory.users.length,
        complete: directory.complete,
        total: directory.total,
      };
      // The installation carries the policy when every account the directory
      // lists received it -- and the directory was the whole directory.
      carrying = directory.complete && unreached.length === 0;
    }

    const job: PublishJob = {
      v: 1,
      id,
      startedAt,
      by: admin.username,
      population,
      reached,
      unreached,
      complete: carrying,
      ...(refusal ? { directory: refusal } : {}),
    };
    /*
     * The record, in the publishing administrator's own app folder. A publish
     * whose record cannot be written fails loudly rather than answering a job
     * no later read can find: what makes this answer worth anything is that
     * the account holds it, not that this process remembers it. An account
     * with no Files account at all has nowhere to keep it, and that is already
     * named in `unreached`.
     */
    if (ownAccountId) {
      /*
       * The record is what makes this answer worth anything later, so a write
       * that fails is said rather than swallowed -- but it is not the publish:
       * every copy is already in its account, and the report of what was
       * reached must not be thrown away because the note about it was.
       */
      try {
        await writePublishJob(own, ownAccountId, job);
      } catch (err) {
        job.record = "failed";
        job.recordMessage = (err as Error).message;
      }
    }
    return job;
  }

  api.post("/admin/policy", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const raw = await c.req.text();
    const parsed = parsePolicyDocumentDetailed(raw);
    if ("problem" in parsed) {
      return c.json({ error: "invalid_policy", message: parsed.problem }, 400);
    }
    /*
     * The publisher's own account is written in the same pass as the rest, so
     * one answer describes the whole attempt: what the directory held, what was
     * reached, and what the installation therefore is now. The outcome and the
     * job are one document — the run's report is the record the account keeps,
     * under the same id the copies carry — answered under both names because
     * the editor reads the outcome and a later read of this surface returns
     * the job.
     */
    let job: PublishJob;
    try {
      job = await publishAccountPolicy(session, parsed.doc);
    } catch (err) {
      return upstreamFailure(c, err);
    }
    const kicked = sessions.destroyAllExcept(session.id);
    return c.json({ outcome: job, job, kicked });
  });

  /**
   * The admin Users surface (ADR 0001): every individual
   * account on this server, plus whether this session may act on accounts at
   * all.
   *
   * `impersonation` probes the right the way the actions themselves use it —
   * impersonating a real account (`{user}%{admin}`) — and the probe answers
   * only what Stalwart's `Impersonate` permission allows: the acting
   * session's own permission list decides, not membership of any Gilbert
   * group. Acting checks are only meaningful on the accounts a force would
   * target. When the directory cannot be listed there is nobody to probe
   * with and the state is "unknown": no warning, the server still refuses at
   * action time. Roles are not consulted — Stalwart does not expose them
   * over JMAP.
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
      const enumeration = !("denied" in directory);
      const users = enumeration ? directory.users : [];
      const self = session.username.trim().toLowerCase();
      const probeName = users.find((u) => u.name !== self)?.name ?? null;
      let impersonation: "ok" | "denied" | "unknown" = "unknown";
      if (probeName) {
        const probeAuth = impersonationAuthorization(session, probeName);
        if (!probeAuth)
          impersonation = "denied"; // an app-password session
        else {
          try {
            await fetchUpstreamSession(probeAuth, upstreamFor(probeName));
            impersonation = "ok";
          } catch (err) {
            impersonation =
              err instanceof UpstreamError && err.status === 401 ? "denied" : "unknown";
          }
        }
      }
      const flagged =
        impersonation === "ok" && users.length
          ? await forcedFlagsFor(users, session)
          : users.map((u) => ({ ...u, forced: false }));
      return c.json({
        users: flagged,
        enumeration,
        enumerationMessage: "denied" in directory ? directory.denied : null,
        impersonation,
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

  /**
   * The group label catalog surface (ADR 0005): list group mailboxes and read
   * or replace the labels.json in a group's own Files. The catalog is the
   * agent's, and so is the door: it is read and written as the installation's
   * agent — the deployment's own credential when it holds one, otherwise
   * impersonation from the administrator's session, which an app-password
   * sign-in cannot do.
   *
   * The agent's own door is defined once, in `agentAdmin.ts`, and shared with
   * the agent surfaces (ADR 0003).
   */
  api.get("/admin/groups", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      const upstream = await getUpstreamSession(
        session.id,
        session.authorization,
        upstreamFor(session.username),
        true,
      );
      const directory = await fetchDirectoryGroups(session.authorization, upstream);
      if ("denied" in directory)
        return c.json({
          groups: [],
          enumeration: false,
          enumerationMessage: directory.denied,
        });
      return c.json({ groups: directory.groups, enumeration: true });
    } catch (err) {
      if (err instanceof UpstreamError) return upstreamFailure(c, err);
      console.error("[gilbert] directory groups query failed:", err);
      return c.json(
        { error: "directory_unavailable", message: (err as Error).message },
        502,
      );
    }
  });

  api.get("/admin/groups/:name/labels", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    try {
      const access = await resolveGroupAccess(session, name, { need: "labels" });
      if (!access.ok) {
        return c.json({ error: access.error, need: access.need }, 403);
      }
      const labels = await readGroupLabels(access.ctx, access.accountId);
      /* A catalog the validator refuses reads as no catalog: the surface shows
         what it can render, and a write over one is refused where it is made. */
      return c.json({ labels: labels.state === "catalog" ? labels.labels : [] });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.post("/admin/groups/:name/labels", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    const body = await readJson<{ labels?: unknown }>(c);
    if (!body || !Array.isArray(body.labels))
      return c.json({ error: "bad_request", message: "labels must be an array" }, 400);
    try {
      const access = await resolveGroupAccess(session, name, { need: "labels" });
      if (!access.ok) {
        return c.json({ error: access.error, need: access.need }, 403);
      }
      await writeGroupLabels(access.ctx, access.accountId, body.labels);
      return c.json({ ok: true });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  // ---------- The agent worker fleet (ADR 0003) ----------
  /**
   * The agent surfaces (ADR 0003): the installation's one agent, the groups
   * that have granted it, the agents running for it, its model,
   * its app password, and the group documents the fleet works from.
   *
   * Membership is not written here — the operator grants the agent in
   * Stalwart's own administration and these routes verify it — and a
   * deployment with no agent answers plainly instead of failing.
   */
  const agentFailure = (c: Context, err: unknown) => {
    // Hono types a status as a union of literals; the class carries the number
    // its own code chose (400 for a refusal, 401/403 for a boundary, 502 for an
    // upstream one), so it is narrowed to that type rather than asserted as one
    // particular value.
    if (err instanceof AgentAdminError) {
      // The reason travels flat beside its code — `{ error, ...params }`, the
      // shape a group refusal already answers with — so the surface composes
      // the sentence from the catalogue in force and no English is put on the
      // wire for it to fall back on.
      const { code, ...params } = err.reason;
      return c.json({ error: code, ...params }, err.status as ContentfulStatusCode);
    }
    return upstreamFailure(c, err);
  };

  /**
   * The published schema of a rule document (ADR 0003 resolution 2).
   *
   * What the admin surface authors, in the standard form anything outside this
   * codebase validates against — and the same catalogue the runtime reads, so
   * the two cannot drift. Reading it needs no more than the admin shield.
   */
  api.get("/admin/agent/rule-schema", requireSession, requireAdmin, (c) =>
    c.json(agentRuleJsonSchema()),
  );

  api.get("/admin/agents", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      return c.json(await agentStatus(session));
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  /**
   * A group's agent surface. A group the agent does not hold answers 200 with
   * the refusal and empty documents rather than 403: "the agent is not granted
   * here" is a state of the surface, not a failed request — the documents are
   * the agent's, so a group it cannot reach has nothing to show — and the
   * surface names the section a person was standing at instead of failing at
   * the door.
   */
  api.get("/admin/groups/:name/agent", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    const identity = agentAddress();
    try {
      const access = await resolveGroupAccess(session, name, {
        need: "agent documents",
      });
      if (!access.ok)
        return c.json({
          group: name,
          granted: false,
          agentAddress: identity,
          error: access.error,
          need: access.need,
          ...emptyGroupDocuments(),
        } satisfies AgentGroupAnswer);
      const view = await groupAgentView(access, access.accountId);
      return c.json({
        group: name,
        agentAddress: identity,
        ...view,
      } satisfies AgentGroupAnswer);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  /**
   * A group's audit trail, month by month, for an administrator to keep.
   *
   * The months are the declared retention's window — the same one
   * `pruneAudit` (executor.ts) drops a document at a time — so this is the
   * copy the retention decision promises before the oldest month goes.
   */
  api.get("/admin/groups/:name/agent/audit", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    try {
      const access = await resolveGroupAccess(session, name, {
        need: "agent documents",
      });
      if (!access.ok) return c.json({ error: access.error, need: access.need }, 403);
      return c.json(await groupAuditExport(access, access.accountId, name));
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.get("/admin/groups/:name/agent/rules", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    try {
      const access = await resolveGroupAccess(session, name, { need: "automations" });
      if (!access.ok) return c.json({ error: access.error, need: access.need }, 403);
      return c.json({ rules: await readRules(access, access.accountId) });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.post("/admin/groups/:name/agent/rules", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    const body = await readJson<{ rules?: unknown }>(c);
    if (!body || !Array.isArray(body.rules))
      return c.json({ error: "bad_request", message: "rules must be an array" }, 400);
    try {
      const access = await resolveGroupAccess(session, name, { need: "automations" });
      if (!access.ok) return c.json({ error: access.error, need: access.need }, 403);
      const rules = await saveRules(
        access,
        access.accountId,
        body.rules,
        session.username,
      );
      return c.json({ ok: true, rules });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  /*
   * Run one of a group's automations now, on a message a person names (ADR 0003). The answer is the job, which the worker holding the group's claim
   * picks up on its next pass: the surface can say when it was asked for and
   * the run's own record says what came of it.
   */
  api.post("/admin/groups/:name/agent/run", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    const body = await readJson<{ ruleId?: unknown; emailId?: unknown }>(c);
    if (!body || typeof body.ruleId !== "string")
      return c.json({ error: "bad_request", message: "ruleId must be a string" }, 400);
    try {
      const access = await resolveGroupAccess(session, name, { need: "automations" });
      if (!access.ok) return c.json({ error: access.error, need: access.need }, 403);
      return c.json({
        ok: true,
        job: await runRuleNow(
          access,
          access.accountId,
          {
            ruleId: body.ruleId,
            emailId: body.emailId,
          },
          session.username,
        ),
      });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.get("/admin/agent/providers", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      return c.json(await readProviders(session));
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.post("/admin/agent/providers", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const body = await readJson<{ provider?: unknown }>(c);
    if (!body)
      return c.json({ error: "bad_request", message: "provider is required" }, 400);
    try {
      await writeProviders(session, body);
      return c.json({ ok: true });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.post(
    "/admin/groups/:name/agent/labels",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      try {
        const access = await resolveGroupAccess(session, name, { need: "labels" });
        if (!access.ok) return c.json({ error: access.error, need: access.need }, 403);
        const { added } = await addAgentLabels(access, access.accountId);
        return c.json({ ok: true, added });
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  /**
   * The group's notebook: the facts its agent holds in every call (ADR 0003).
   * Administrator-only, like the standing instruction beside it — memory the
   * model is given on every run is configuration, and members read it rather
   * than write it.
   */
  api.get(
    "/admin/groups/:name/agent/notebook",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      try {
        const access = await resolveGroupAccess(session, name, { need: "notebook" });
        if (!access.ok) return c.json({ error: access.error, need: access.need }, 403);
        return c.json(await readGroupNotebook(access));
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  api.post(
    "/admin/groups/:name/agent/notebook",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      try {
        const body = await readJson<{ facts?: unknown }>(c);
        const access = await resolveGroupAccess(session, name, { need: "notebook" });
        if (!access.ok) return c.json({ error: access.error, need: access.need }, 403);
        return c.json(await saveGroupNotebook(access, body, session.username));
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  /**
   * The group's standing instruction: the house rules its agent carries into
   * every model call (ADR 0003 resolution 17). Administrator-only, like the
   * rules document beside it — a text the model is told to follow is
   * configuration, and members read the rules rather than write them.
   */
  api.get(
    "/admin/groups/:name/agent/instruction",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      try {
        const access = await resolveGroupAccess(session, name, {
          need: "standing instruction",
        });
        if (!access.ok) return c.json({ error: access.error, need: access.need }, 403);
        return c.json(await readGroupInstruction(access));
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  api.post(
    "/admin/groups/:name/agent/instruction",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      try {
        const body = await readJson<{ text?: string; notes?: string }>(c);
        const text = typeof body?.text === "string" ? body.text : "";
        const notes = typeof body?.notes === "string" ? body.notes : "";
        const access = await resolveGroupAccess(session, name, {
          need: "standing instruction",
        });
        if (!access.ok) return c.json({ error: access.error, need: access.need }, 403);
        return c.json(await saveGroupInstruction(access, text, session.username, notes));
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  /**
   * An author's reading (ADR 0003): the draft, the envelope it belongs to, the
   * group's instruction and the group's notebook go to the installation's
   * model, which answers in words about the gaps.
   *
   * Not a run: nothing is compiled, no document is produced, and its tokens are
   * counted in the Master's account as authoring. The answer is model prose
   * shown as prose — unlike a refusal, which travels as a code the surface
   * composes a sentence from.
   */
  api.post(
    "/admin/groups/:name/agent/reading",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      const body = await readJson<{
        about?: unknown;
        draft?: unknown;
        envelope?: unknown;
      }>(c);
      const draft = typeof body?.draft === "string" ? body.draft.trim() : "";
      if (!draft)
        return c.json({ error: "bad_request", message: "draft must be a string" }, 400);
      try {
        const access = await resolveGroupAccess(session, name, {
          need: "standing instruction",
        });
        if (!access.ok) return c.json({ error: access.error, need: access.need }, 403);
        return c.json(
          await readDraft(session, {
            access,
            about: typeof body?.about === "string" ? body.about : "a draft",
            draft,
            ...(typeof body?.envelope === "string" ? { envelope: body.envelope } : {}),
          }),
        );
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  api.get("/admin/agent/approvals", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      // The queue's own answer: the list, and the reach it was built from.
      return c.json(await pendingApprovals(session));
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  /**
   * The member's view of a group's agent — `requireSession` and nothing more,
   * because a member is not an administrator and this surface exists for
   * exactly them (ADR 0003, "Members see, never change"). It reads the group's
   * own documents — its automations and the standing instruction the agent
   * carries into every model call — and writes nothing, ever.
   */
  api.get("/agent/group/:name", requireSession, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    try {
      const view = await memberAgentView(session, name);
      if ("ok" in view) return c.json({ error: view.error, need: view.need }, 403);
      return c.json(view);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  /**
   * A group's members, for the `@` picker beside the chat.
   *
   * Its own route rather than a field of the view above, because the picker
   * asks it when a mention begins and nothing else needs it: the chat opens
   * without this read, and a reader who never mentions anybody never causes
   * one. The answer is the installation's own roster read — made as the
   * Master, the one principal that may ask Stalwart's registry (ADR 0003) —
   * and `members` is null when nobody could read it, which the surface renders
   * as the transcript it already has.
   */
  api.get("/agent/group/:name/members", requireSession, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    try {
      const view = await memberGroupMembers(session, name);
      if ("ok" in view) return c.json({ error: view.error, need: view.need }, 403);
      return c.json(view);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  // ---------- Identities an administrator sets (ADR 0007) ----------

  /** A refusal from these surfaces: the code and the sentence, or upstream's. */
  function identityFailure(c: Context, err: unknown) {
    if (err instanceof IdentityAdminError)
      return c.json({ error: err.code, message: err.message }, err.status as 400);
    return upstreamFailure(c, err);
  }

  /**
   * A person's identities, and the one write that reaches them.
   *
   * The write is an impersonation of that person from the administrator's own
   * session: no new credential, and Stalwart's permission model stays the whole
   * of the gate. `impersonation: "denied"` is an answer, not a failure — an
   * app-password session cannot impersonate at all, and the surface says so
   * instead of showing an account with no identities.
   */
  api.get("/admin/identities/user", requireSession, requireAdmin, async (c) => {
    try {
      return c.json(
        await personIdentities(c.get("session"), c.req.query("address") ?? ""),
      );
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  api.post("/admin/identities/user", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ address?: unknown; id?: unknown; patch?: unknown }>(c);
    try {
      const written = await writePersonIdentity(
        c.get("session"),
        typeof body?.address === "string" ? body.address : "",
        typeof body?.id === "string" && body.id ? body.id : null,
        body?.patch,
      );
      return c.json({ ok: true, id: written.id });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  api.post("/admin/identities/user/delete", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ address?: unknown; id?: unknown }>(c);
    try {
      await removePersonIdentity(
        c.get("session"),
        typeof body?.address === "string" ? body.address : "",
        typeof body?.id === "string" ? body.id : "",
      );
      return c.json({ ok: true });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  /**
   * The lock an administrator applies to a person's identity (ADR 0007,
   * ADR 0001).
   *
   * Recorded in that account's own app folder, by impersonation — the same
   * door `setPersonDefaultIdentity` writes through. Applying one ends
   * nothing: a lock is a rule about what the product offers, so the session
   * that writes one sees it at once (ADR 0007, the cache below is cleared
   * for exactly that) and a session already open sees it the next time it
   * reads its own.
   */
  api.post("/admin/identities/user/lock", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ address?: unknown; locked?: unknown }>(c);
    try {
      const address = identityAddress(
        typeof body?.address === "string" ? body.address : "",
      );
      const locked = body?.locked === true;
      await setUserIdentityLock(c.get("session"), address, locked);
      identityLockCache.delete(normalizeUsername(address));
      return c.json({ ok: true, locked });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  /**
   * The identity an account sends from by default (ADR 0007).
   *
   * Not a Stalwart property: it is one key of the client's own settings
   * document, in that account's app folder, so the administrator and the
   * account's own Identities & signatures section read and write one value
   * rather than two that can disagree. `identityId: null` clears it, which is
   * the same state as never having chosen.
   */
  api.post("/admin/identities/user/default", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ address?: unknown; identityId?: unknown }>(c);
    try {
      const identityId =
        typeof body?.identityId === "string" && body.identityId ? body.identityId : null;
      const written = await setPersonDefaultIdentity(
        c.get("session"),
        typeof body?.address === "string" ? body.address : "",
        identityId,
      );
      return c.json({ ok: true, identityId: written });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  /**
   * A group's identities, its roster, and the assignment that binds a member to
   * one of them (ADR 0007).
   *
   * Written as the installation's agent, always: Stalwart refuses to impersonate
   * a group mailbox, and the agent is the principal that exists for this. Where
   * the agent is not a member of the group, `granted: false` says so and names
   * the grant that is missing rather than a permission error that would read as
   * a bug.
   *
   * A group holds **one identity per member** — the group's own address, each
   * member's own display name and signature — and `assignments` says which
   * member sends as which of them: the binding is a record, not a display name
   * compared on both sides. A member absent from it sends as the group's own
   * identity, `groupSenderId`. `members` is the roster those identities belong
   * to: `null` when the registry could not be read, which is an answer rather
   * than a failure. The POST writes one identity **and assigns it** — `member`
   * names the address, `id` the identity to write, `null` meaning "the one this
   * member already holds, else a new one".
   */
  api.get("/admin/identities/group", requireSession, requireAdmin, async (c) => {
    try {
      return c.json(await groupIdentity(c.get("session"), c.req.query("name") ?? ""));
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  api.post("/admin/identities/group", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{
      name?: unknown;
      member?: unknown;
      id?: unknown;
      patch?: unknown;
    }>(c);
    try {
      const written = await writeGroupIdentity(
        c.get("session"),
        typeof body?.name === "string" ? body.name : "",
        typeof body?.member === "string" ? body.member : "",
        typeof body?.id === "string" && body.id ? body.id : null,
        body?.patch,
      );
      return c.json({ ok: true, id: written.id });
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  /**
   * The identity the signed-in member sends as in one group (ADR 0007).
   *
   * The composer's own question, answered as the member rather than as an
   * administrator: `assignedId` is the identity the administration assigned
   * them, an id of the group's account that the caller resolves against the list
   * it already holds. The group's **own** identity — what an unassigned member
   * sends as — is not answered here: it is step 2 of the cascade, a rule the
   * client derives from the address the session calls the account, by the one
   * function both tiers import (`@gilbert/shared/identityAssignment`), so it
   * cannot be spelt differently on either side of the wire.
   *
   * Read through the agent, because it is the group's own document: a member
   * reaches the group's Files through the group surfaces and never by reading
   * another account directly.
   */
  api.get("/identities/assignment", requireSession, async (c) => {
    try {
      const view = await memberGroupAssignment(
        c.get("session"),
        c.req.query("group") ?? "",
      );
      if ("ok" in view) return c.json({ error: view.error, need: view.need }, 403);
      return c.json(view);
    } catch (err) {
      return identityFailure(c, err);
    }
  });

  /**
   * The full HTML of an over-sized signature, kept in the account's own Files.
   *
   * The account whose identity it is owns the copy — the person's or the
   * group's — because that is where their own client looks for it when it reads
   * the marker back. The client builds the marker; this only stores the file.
   */
  api.post(
    "/admin/identities/signature-html",
    requireSession,
    requireAdmin,
    async (c) => {
      const body = await readJson<{ kind?: unknown; target?: unknown; html?: unknown }>(
        c,
      );
      try {
        const kind = body?.kind === "group" ? "group" : "user";
        const blobId = await storeSignatureHtml(
          c.get("session"),
          kind,
          typeof body?.target === "string" ? body.target : "",
          typeof body?.html === "string" ? body.html : "",
        );
        return c.json({ blobId });
      } catch (err) {
        return identityFailure(c, err);
      }
    },
  );

  /**
   * The installation's own document: the one the boot reads (`bootstrap.ts`,
   * whose store and rules are `installation.ts` and `shared/installation.ts`).
   *
   * Both halves of this door open onto **the Master's** account, reached by the
   * same impersonation the policy publish above uses: `GILBERT_AGENT_ADDRESS`
   * names the account `bootstrap.ts` signs in as, and the document a boot runs
   * on is that account's own `gilbert` app folder. An administrator whose own
   * account is somewhere else administers *that* document rather than
   * publishing into their own Files -- the difference between a surface called
   * "Installation" and one that only looks like it.
   *
   * GET answers the text as that account holds it, and whether there is one at
   * all — including a document this build cannot read, which is the one a
   * person has come here to repair. POST validates the text with the boot's own
   * validator and writes it with the boot's own writer -- conditionally, and
   * from the stored epoch rather than the submitted one (`installationAdmin.ts`
   * says why) -- so a publish cannot store a document this build would refuse
   * to start from, cannot move a document somebody else just wrote, and cannot
   * move the stored epoch backwards. Text that is not a document is refused
   * before anything is written.
   *
   * A deployment that names no Master has no account a boot reads from, and
   * that is a refusal the read and the publish both answer with -- as a value,
   * with its own code, rather than by opening the door onto whoever is asking.
   *
   * The answer says when the document applies, because it is not now: the
   * running process keeps the configuration it booted with and the next boot
   * reads what was just written. Nothing is reloaded and no session is kicked
   * — nothing about the running process changed.
   */
  const installationRefusal = (c: Context, refused: InstallationRefused) =>
    c.json({ error: refused.error, message: refused.message }, refused.status);

  /**
   * The Master's own context, or the reason this session does not get one.
   *
   * `impersonateAs` is the one door onto another account (see the policy
   * publish above): it rebuilds the composite credential from this
   * administrator's sealed session, and Stalwart refuses an app-password
   * session for it. Both of its refusals — an app password, and a composite
   * the server will not accept — are answers this surface can show, so they
   * come back as values with the server's own words.
   */
  const installationMaster = async (
    session: LiveSession,
  ): Promise<{ ctx: Ctx } | { refused: InstallationRefused }> => {
    const master = agentAddress();
    if (!master)
      return {
        refused: {
          status: 409,
          error: "no_master",
          message:
            "This deployment names no Master (GILBERT_AGENT_ADDRESS), so there is no account whose own " +
            "app folder a boot reads the installation's document from, and nothing for this surface to " +
            "read or publish. A process that is not a deployment administers no installation.",
        },
      };
    const imp = await impersonateAs(session, master);
    if (!imp.ok)
      return {
        refused: {
          status: imp.status,
          error:
            imp.status === 403
              ? "forbidden"
              : imp.status === 404
                ? "master_not_found"
                : "upstream_error",
          message: imp.message,
        },
      };
    return { ctx: imp.ctx };
  };

  api.get("/admin/installation", requireSession, requireAdmin, async (c) => {
    try {
      const door = await installationMaster(c.get("session"));
      if ("refused" in door) return installationRefusal(c, door.refused);
      const result = await readInstallationForAdmin(door.ctx);
      if ("refused" in result) return installationRefusal(c, result.refused);
      return c.json({ installation: result.view });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  api.post("/admin/installation", requireSession, requireAdmin, async (c) => {
    const raw = await c.req.text();
    try {
      const door = await installationMaster(c.get("session"));
      if ("refused" in door) return installationRefusal(c, door.refused);
      const result = await publishInstallation(door.ctx, raw);
      if ("refused" in result) return installationRefusal(c, result.refused);
      return c.json({ outcome: result.published });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- System Sieve scripts (ADR 0008) ----------

  /** A refusal from this surface: the code and the sentence, or upstream's. */
  function systemSieveFailure(c: Context, err: unknown) {
    if (err instanceof SystemSieveError)
      return c.json({ error: err.code, message: err.message }, err.status as 400);
    return upstreamFailure(c, err);
  }

  /**
   * The body of a System Sieve write, validated into the shape both tiers name
   * (`@gilbert/shared/sieveViews`) rather than into a second declaration of it:
   * a field added to the surface's write and forgotten here is a field this
   * route silently drops.
   */
  function readSystemSieveBody(body: unknown): SystemSieveScriptWrite | null {
    const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const contents = typeof raw.contents === "string" ? raw.contents : null;
    if (!name || contents === null) return null;
    const description =
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim()
        : null;
    const state = typeof raw.state === "string" && raw.state ? raw.state : undefined;
    return { name, description, contents, activate: Boolean(raw.activate), state };
  }

  api.get("/admin/sieve/system", requireSession, requireAdmin, async (c) => {
    try {
      const ctx = await accountCtx(c);
      return c.json(await listSystemSieveScripts(ctx));
    } catch (err) {
      return systemSieveFailure(c, err);
    }
  });

  api.get("/admin/sieve/system/:id", requireSession, requireAdmin, async (c) => {
    try {
      const ctx = await accountCtx(c);
      return c.json(await getSystemSieveScript(ctx, c.req.param("id")));
    } catch (err) {
      return systemSieveFailure(c, err);
    }
  });

  api.post("/admin/sieve/system", requireSession, requireAdmin, async (c) => {
    const parsed = readSystemSieveBody(await readJson<unknown>(c));
    if (!parsed) return c.json({ error: "bad_request" }, 400);
    try {
      const ctx = await accountCtx(c);
      /* A create has no prior read to lose, and the write ignores a `state`. */
      const id = await saveSystemSieveScript(ctx, null, parsed);
      return c.json({ id });
    } catch (err) {
      return systemSieveFailure(c, err);
    }
  });

  api.put("/admin/sieve/system/:id", requireSession, requireAdmin, async (c) => {
    const parsed = readSystemSieveBody(await readJson<unknown>(c));
    if (!parsed) return c.json({ error: "bad_request" }, 400);
    try {
      const ctx = await accountCtx(c);
      const id = await saveSystemSieveScript(ctx, c.req.param("id"), parsed);
      return c.json({ id });
    } catch (err) {
      return systemSieveFailure(c, err);
    }
  });

  api.post("/admin/sieve/system/:id/active", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ active?: unknown; state?: unknown }>(c);
    const state = typeof body?.state === "string" && body.state ? body.state : undefined;
    try {
      const ctx = await accountCtx(c);
      await setSystemSieveScriptActive(
        ctx,
        c.req.param("id"),
        Boolean(body?.active),
        state,
      );
      return c.json({ ok: true });
    } catch (err) {
      return systemSieveFailure(c, err);
    }
  });

  api.delete("/admin/sieve/system/:id", requireSession, requireAdmin, async (c) => {
    const body = await readJson<{ state?: unknown }>(c);
    const state = typeof body?.state === "string" && body.state ? body.state : undefined;
    try {
      const ctx = await accountCtx(c);
      await deleteSystemSieveScript(ctx, c.req.param("id"), state);
      return c.json({ ok: true });
    } catch (err) {
      return systemSieveFailure(c, err);
    }
  });

  // ---------- JMAP API proxy ----------
  api.post("/jmap", requireSession, apiRateLimited, async (c) => {
    const session = c.get("session");
    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) {
      return c.json({ error: "unsupported_media_type" }, 415);
    }
    /*
     * For a session that may not administer -- administration switched off on
     * this installation, or a device not marked as the person's own -- the body
     * is read and checked before it goes anywhere (ADR 0017). A session that may
     * administer streams straight through as it always has, and pays nothing for
     * this.
     */
    let body: ReadableStream<Uint8Array> | string | null = c.req.raw.body;
    if (!adminAllows(session)) {
      /*
       * Bounded three ways, because a body that is read is a body held: at most
       * this many checked reads per session at once, at most
       * `MAX_GATED_REQUEST` each, and at most `GATED_BUDGET` across everyone.
       * The third is what makes a burst cheap to refuse -- a 503 says try
       * again, where letting it through costs the process.
       */
      const held = gatedReads.get(session.id) ?? 0;
      if (held >= MAX_GATED_PER_SESSION) {
        c.header("Retry-After", "1");
        return c.json({ error: "rate_limited" }, 429);
      }
      gatedReads.set(session.id, held + 1);
      let raw: string;
      try {
        if (Number(c.req.header("content-length") ?? "0") > MAX_GATED_REQUEST)
          return c.json({ error: "too_large" }, 413);
        // Counted as it arrives: a chunked body carries no length to refuse up front.
        raw = c.req.raw.body ? await readGated(c.req.raw.body) : "";
      } catch (err) {
        if (err instanceof GatedBudgetError) {
          c.header("Retry-After", "1");
          return c.json({ error: "busy" }, 503);
        }
        return c.json({ error: "too_large" }, 413);
      } finally {
        const left = (gatedReads.get(session.id) ?? 1) - 1;
        if (left > 0) gatedReads.set(session.id, left);
        else gatedReads.delete(session.id);
      }
      const gate = gateAdministration(raw);
      if (!gate.ok) {
        if (!gate.method)
          return c.json({ error: "bad_request", message: "Not a JMAP request." }, 400);
        return administrationRefusal(c, config.administration, gate.method);
      }
      body = gate.body;
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
        body,
        duplex: "half",
        signal: AbortSignal.timeout(config.upstreamTimeout),
      });
      if (res.status === 401) {
        sessions.destroy(session.id);
        forgetUpstreamSession(session.id);
        deleteCookie(c, config.cookieName, { path: cookiePath() });
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
      const type = blobContentType(res.headers.get("content-type"), accept);
      headers.set("Content-Type", type);
      const cl = forwardedContentLength(res.headers);
      if (cl) headers.set("Content-Length", cl);
      const safeInline = inline && isInlineSafe(type);
      headers.set(
        "Content-Disposition",
        `${safeInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(withoutBidiControls(name))}`,
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
      // Kept out of the browser's disk cache on a device that is not the
      // person's own: signing out wipes what the app stores, not that.
      headers.set(
        "Cache-Control",
        session.remember ? "private, max-age=3600" : "no-store",
      );
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
      const accountId = upstream.primaryAccounts?.[CAPABILITIES.mail];
      if (
        accountId &&
        pushAttach(session.username, accountId, session.authorization, out, pushOrigin(c))
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

/**
 * The largest JMAP request read into memory for the administration check.
 *
 * Only sessions that may not administer come this way, and what the client
 * sends is small: attachments and pasted images go through `/upload`, and the
 * composer turns inline images into uploads before a draft is saved. Stalwart
 * would take up to its own `maxSizeRequest` (10 MB by default), but a request
 * is held here as a string, parsed and serialized again, so each one costs
 * several times its size; 4 MB is far past anything the client sends.
 */
const MAX_GATED_REQUEST = 4 * 1024 * 1024;
/**
 * How many checked requests one session may have in flight at once. Matches the
 * `maxConcurrentRequests` Stalwart advertises by default, which the client
 * already stays within.
 */
const MAX_GATED_PER_SESSION = 4;
/**
 * The bytes all checked requests together may hold at once. Counted as they
 * arrive rather than reserved up front, so a slow body that has sent little
 * holds little, and a burst of large ones is turned away with a 503 instead of
 * taking the process down.
 */
const GATED_BUDGET = 32 * 1024 * 1024;
const gatedReads = new Map<string, number>();
let gatedBytes = 0;

class GatedBudgetError extends Error {}

/** Read a checked request body, counting it against the two budgets as it arrives. */
async function readGated(stream: ReadableStream<Uint8Array>): Promise<string> {
  let mine = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      mine += chunk.byteLength;
      gatedBytes += chunk.byteLength;
      if (mine > MAX_GATED_REQUEST) controller.error(new Error("request too large"));
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
function administrationRefusal(c: Context<Env>, enabled: boolean, method?: string) {
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
async function confirmsPassword(
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

/**
 * Direction overrides and isolates, which can make `Invoice_\u202Efdp.exe`
 * read as a PDF in the downloads list. A filename has no honest use for them.
 */
function withoutBidiControls(name: string): string {
  return name.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
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
  identityLocked = false,
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
 * Whether a content type says nothing about the file.
 *
 * The set the client's `previewKind` treats as no evidence, for the same
 * reason: an uploader with no guess, or a store that kept none, leaves one of
 * these behind, and `application/octet-stream` is not a claim that a file is a
 * binary blob rather than, say, a PDF.
 */
function isGenericType(ct: string): boolean {
  return (
    ct === "" ||
    ct === "application/octet-stream" ||
    ct === "binary/octet-stream" ||
    ct === "application/unknown" ||
    ct === "unknown/unknown"
  );
}

/**
 * What a blob is served as.
 *
 * Upstream's type decides, with one exception: where it says nothing about the
 * file, the type the client declared is the only evidence left, and it is the
 * type the app is already showing the file as. Either way the answer goes
 * through `sanitizeContentType`, so nothing that must not render gets a type
 * that renders, and `isInlineSafe` still decides whether anything is served
 * inline at all. Exported so the choice is testable without an upstream.
 */
export function blobContentType(upstreamType: string | null, declared: string): string {
  const up = (upstreamType ?? "").split(";")[0]!.trim().toLowerCase();
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
