/**
 * The session, sign-in and self-service credential routes.
 *
 * What a browser needs before it can talk to Stalwart at all: the liveness and
 * policy answers the sign-in page reads, the sign-in the door turns on, the
 * session it refreshes, and the account's own credentials — password, app
 * passwords and two-factor.
 */

import type { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import {
  assertEnrolmentCode,
  beginOtpEnrolment,
  changePassword,
  clearPasswordChangeDirective,
  createAppPassword,
  disableOtp,
  enableOtp,
  getState,
  revokeAppPassword,
} from "../account.js";
import { EMPTY_POLICY, readAccountPolicy } from "../adminPolicy.js";
import { filesAccountId } from "../appFolder.js";
import { rateLimitKey } from "../clientip.js";
import { config } from "../config.js";
import { prepare as pushPrepare, pushStatus } from "../push.js";
import { accountKey, normalizeUsername } from "../sessions.js";
import { CAPABILITIES, STALWART_MIN_VERSION } from "../shared/capabilities.js";
import {
  fetchUpstreamSession,
  forgetUpstreamSession,
  getAccountInfo,
  getUpstreamSession,
  hasStalwartRegistry,
  localizeSession,
  UpstreamError,
  upstreamFor,
} from "../upstream.js";
import type { Env } from "./shared.js";
import {
  accountCtx,
  accountFailure,
  appPasswordName,
  clientIp,
  confirmsPassword,
  cookiePath,
  directiveCache,
  guarded,
  loginBody,
  loginFloodLimiter,
  loginLimiter,
  pushOrigin,
  readJson,
  refundCredentialAttempt,
  requireSession,
  resolveAdminState,
  resolveInstallationAccount,
  sessionExtras,
  sessionForcedState,
  sessionIdentityLockState,
  sessions,
  setSessionCookie,
  upstreamFailure,
} from "./shared.js";

export function registerAccountRoutes(api: Hono<Env>): void {
  /*
   * Liveness, and -- for a caller that holds a session -- what the push fan-out
   * is doing. The counts are anyone's business; the failure reasons name the
   * accounts that are not on the fast path, which is an operator's rather than
   * an anonymous visitor's, so they ride only on a request carrying a live
   * session. The endpoint stays public because the sign-in page reads it before
   * anybody has signed in.
   */
  api.get("/health", (c) => {
    const status = pushStatus();
    const session = c.get("session") ?? sessions.resolve(getCookie(c, config.cookieName));
    return c.json({
      ok: true,
      name: config.appName,
      version: config.version,
      push: session
        ? status
        : { mode: status.mode, accounts: status.accounts, tabs: status.tabs },
    });
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
            message: `Your credentials are fine, but this mail server is older than Stalwart ${STALWART_MIN_VERSION}, which Gilbert needs. Upgrade the server, or run the release tagged stalwart-0.15-support.`,
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
            await resolveInstallationAccount(session),
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
            await resolveInstallationAccount(session),
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
      refundCredentialAttempt(c, err);
      return accountFailure(c, err);
    }
    // The old password is now dead: re-seal this session with the new one and
    // drop the others, whose sealed copies would fail on their next call. A
    // re-seal can fail -- no cookie, or a session already gone -- and the
    // session would then keep the credential the server just invalidated, so
    // it is ended here and the cookie cleared rather than left to fail on the
    // client's next request.
    const otpCode = body.otpCode?.trim();
    const sessionKept = sessions.reseal(
      getCookie(c, config.cookieName),
      otpCode ? `${next}$${otpCode}` : next,
    );
    if (sessionKept) forgetUpstreamSession(session.id);
    else {
      sessions.destroy(session.id);
      deleteCookie(c, config.cookieName, { path: cookiePath() });
    }
    const revoked = sessions.destroyAllForUser(session.account, session.id);
    directiveCache.delete(normalizeUsername(session.username));
    // Was this user forced? The answer must be judged after the change, with
    // the freshly resealed credential: the door cache may still hold the
    // pre-force answer, and the old credential is dead the moment the change
    // lands upstream. Password changes are rare, so a fresh read is cheap.
    if (sessionKept) {
      const fresh = sessions.resolve(getCookie(c, config.cookieName));
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
    }
    return c.json({ ok: true, sessionKept, revokedSessions: revoked });
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
      refundCredentialAttempt(c, err, "app-password");
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
      refundCredentialAttempt(c, err, "app-password");
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
      refundCredentialAttempt(c, err);
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
    let ctx: Awaited<ReturnType<typeof accountCtx>>;
    try {
      ctx = await accountCtx(c);
    } catch (err) {
      refundCredentialAttempt(c, err);
      return accountFailure(c, err);
    }
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
      refundCredentialAttempt(c, err);
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
      refundCredentialAttempt(c, err);
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
      refundCredentialAttempt(c, err);
      return accountFailure(c, err);
    }
    // This session may be running on the app password minted when 2FA went on;
    // the plain password works again now, so put it back. A re-seal that fails
    // (no cookie, or a session already gone) leaves the stored credential as it
    // was, so the answer says the session was not kept rather than pretending
    // the move happened.
    const sessionKept = sessions.reseal(
      getCookie(c, config.cookieName),
      body.current,
      false,
    );
    if (sessionKept) forgetUpstreamSession(session.id);
    return c.json({ ok: true, sessionKept });
  });
}
