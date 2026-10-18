/**
 * Where sessions live between requests, and the ceilings that bound an
 * attempt.
 *
 * The store is bound by `createApp` or by the boot and never at import (see the
 * comment on `sessions`), and the limiters are built on first use for the same
 * reason: their ceilings come from an installation configuration a deployment
 * replaces at boot.
 */

import type { Context } from "hono";
import { isOwnRefusal } from "../../account.js";
import { type Ctx, readAppFileAt, writeAppFileAt } from "../../appFolder.js";
import { config, masterAddress } from "../../config.js";
import { RateLimiter } from "../../ratelimit.js";
import {
  type LiveSession,
  SESSION_DOCUMENT_NAME,
  type SessionBackend,
  type SessionDocumentIo,
  SessionStore,
  type SessionTtls,
} from "../../sessions.js";
import { forgetUpstreamSession, UpstreamError } from "../../upstream.js";

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
  if (masterAddress())
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
const accountLimiter = new RateLimiter(20, 15 * 60_000);
export let apiLimiterInstance: RateLimiter | null = null;
/*
 * Built on first use rather than at import: the ceiling comes from the
 * installation's own configuration, which a deployment replaces at boot
 * (`useConfiguration`). A module-scope instance would keep whatever the
 * environment said before anything had been read.
 */
export const apiLimiter = () =>
  (apiLimiterInstance ??= new RateLimiter(config.apiRateLimit, 60_000));

/** The limiter key one credential endpoint's attempts are counted under. */
const credentialLimitKey = (c: Context<Env>, scope: string) =>
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
    isOwnRefusal(err) || (err instanceof UpstreamError && err.status === 401);
  if (!judged) accountLimiter.refund(credentialLimitKey(c, scope));
};
