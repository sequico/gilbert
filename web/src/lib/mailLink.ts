/**
 * The link a mail notification opens, and the account it belongs to.
 *
 * A route carries a folder id and a thread id, and neither of them says which
 * account owns them -- so a link built for one account can be *captured* by
 * another: the store resolves a bare folder id against the account on screen
 * first (`accountOfMailbox`), and a folder id that happens to exist in another
 * account's tree resolves there, where the conversation does not exist. A
 * notified link is therefore built with the account it was made for, and the
 * reader honours it: the link means the account that wrote it, whatever the
 * device happens to be showing.
 *
 * The worker builds its own links (`web/public/sw.js`, copied to the build
 * rather than bundled, so it cannot import this) and names the same parameter;
 * a test holds the two together (`__tests__/swPushRules.test.ts`).
 */
export const MAIL_ACCOUNT_PARAM = "a";

/** The query that names an account, or `""` when there is none to name. */
export function mailAccountQuery(accountId: string | null | undefined): string {
  return accountId ? `?${MAIL_ACCOUNT_PARAM}=${encodeURIComponent(accountId)}` : "";
}

/**
 * Where a mail notification opens: the folder, the conversation when it names
 * one, and the account it was built for.
 */
export function mailLink(opts: {
  mailboxId: string;
  threadId?: string | null;
  accountId?: string | null;
}): string {
  const thread = opts.threadId ? `/${encodeURIComponent(opts.threadId)}` : "";
  return `/mail/${encodeURIComponent(opts.mailboxId)}${thread}${mailAccountQuery(opts.accountId)}`;
}

/** The account a link named, or `null` when it named none. */
export function mailAccountOf(search: string): string | null {
  return new URLSearchParams(search).get(MAIL_ACCOUNT_PARAM);
}

/**
 * The account a route should open, from the hint it carries and what the
 * session holds.
 *
 * A route names its account because a folder id does not say whose it is, and a
 * link with no folder to name -- a notification for a mailbox this device has no
 * Inbox id for -- still means the account it was built for rather than the one
 * on screen. The account on screen answers a route that names none; a hint this
 * session does not hold is ignored rather than obeyed, so a link from another
 * installation opens this one instead of nothing.
 *
 * This is the one reading of a hint: `accountOfMailbox` asks it for a route that
 * names a folder, and the mail route asks it for one that names only an account.
 */
export function mailRouteAccount(opts: {
  hint: string | null;
  active: string | null;
  accounts: ReadonlyArray<{ accountId: string }>;
}): string | null {
  if (!opts.hint) return opts.active;
  if (opts.hint === opts.active) return opts.hint;
  return opts.accounts.some((a) => a.accountId === opts.hint) ? opts.hint : null;
}
