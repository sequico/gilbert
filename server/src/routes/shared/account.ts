/**
 * The signed-in session's own account, and the credential it holds.
 *
 * The account context a route acts with, what the session payload states
 * (including the installation's own account, ADR 0028), whether a candidate is
 * the account's password, and the name an app password is minted under.
 */

import type { Context } from "hono";
import { administrationAllowed } from "../../adminGate.js";
import { type Ctx, filesAccountId } from "../../appFolder.js";
import { config, masterAddress } from "../../config.js";
import { safeEqual } from "../../crypto.js";
import { agentSession } from "../../identityAdmin.js";
import type { LiveSession } from "../../sessions.js";
import {
  type AccountInfo,
  fetchUpstreamSession,
  sessionUpstream,
  UpstreamError,
  upstreamFor,
} from "../../upstream.js";
import type { Env } from "./sessions.js";

export const accountCtx = async (c: Context<Env>) => {
  const session = c.get("session");
  const upstream = await sessionUpstream(session);
  return {
    authorization: session.authorization,
    session: upstream,
    username: session.username,
  };
};

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
interface InstallationAccount {
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
  const address = masterAddress();
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
