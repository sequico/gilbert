/**
 * Verdicts about a session, and the door that acts on one.
 *
 * The forced-password-change directive (ADR 0001), the identity lock (ADR 0005)
 * and the middleware that stops a data request while either holds: each verdict
 * is a short-TTL cache over a document read, keyed by user, so the door does not
 * pay for a read on every request.
 */

import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { isPasswordChangeForced } from "../../account.js";
import { config } from "../../config.js";
import { identityLockedForSession } from "../../identityAdmin.js";
import {
  impersonationAuthorization,
  type LiveSession,
  normalizeUsername,
} from "../../sessions.js";
import { errorMessage } from "../../shared/errors.js";
import {
  fetchUpstreamSession,
  sessionUpstream,
  type UpstreamSession,
  upstreamFor,
} from "../../upstream.js";
import { type Env, sessions } from "./sessions.js";

/**
 * A verdict about a session, and when it was read.
 *
 * One shape for both verdicts below, because they are one mechanism: a map keyed
 * by user, one window, and the same expiry rule.
 */
/** The upstream session for a live one, asked the same way by both verdicts. */
function upstreamForSession(session: LiveSession): Promise<UpstreamSession> {
  return sessionUpstream(session);
}

interface SessionVerdict<T> {
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
const SESSION_VERDICT_TTL_MS = 30_000;

/**
 * A verdict about a session, remembered for the window.
 *
 * A stale entry is dropped rather than overwritten in place: the map would
 * otherwise keep one entry per user ever checked for the life of the process,
 * with nothing ever deleting the ones that stop requesting.
 */
async function cachedVerdict<T>(
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
        errorMessage(err),
      );
      return false;
    }
  });
}

/* ------------------------------------------------------------------ */
/* The identity lock (ADR 0005, ADR 0001)                           */
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
          errorMessage(err),
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
            errorMessage(err),
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
