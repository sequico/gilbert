/**
 * What the server answers about an account's own security, and what the client
 * reads from it.
 *
 * Two routes, four shapes: `/api/auth/sessions` reports the sessions signed in
 * as the account (`SessionSummary`, plus the caller's own id beside the list),
 * and `/api/account/security` reports 2FA and the standing app passwords
 * (`SecurityState`). Both answers are built by `server/src/sessions.ts` and
 * `server/src/account.ts` and rendered by one page, the client's
 * `views/settings/SecuritySettings.tsx`.
 *
 * They are contracts between the tiers, so they are defined once. The client
 * reads these answers through a cast — `apiFetch<SecurityState>` checks nothing
 * at runtime — so a field the server stopped sending is a row that renders
 * blank rather than an error anybody sees. One definition makes the reader and
 * the writer move together; `server/src/account.test.ts` pins the field lists
 * the routes actually answer with.
 *
 * `MASKED` sits beside the shapes rather than in a tier: it is Stalwart's own
 * placeholder for a secret, so the module that writes credentials and the mock
 * that answers as Stalwart would must spell it the same way.
 */

/**
 * What Stalwart returns in place of a stored secret; echo it back to leave the
 * secret unchanged.
 */
export const MASKED = "[********]";

/** What `/api/auth/sessions` reports about a session, with nothing secret in it. */
export interface SessionSummary {
  id: string;
  username: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  remember: boolean;
  userAgent: string;
  ip: string;
}

/** The answer to `/api/auth/sessions`: the list, and which entry is the asker. */
export interface SessionList {
  current: string;
  sessions: SessionSummary[];
}

/** One standing app password, as Stalwart reports it (no secret in it). */
export interface AppPasswordRow {
  id: string;
  description: string;
  createdAt: string | null;
  expiresAt: string | null;
}

/** The answer to `/api/account/security`. */
export interface SecurityState {
  otpEnabled: boolean;
  appPasswords: AppPasswordRow[];
}
