/**
 * Which accounts carry a mailbox the reader can open.
 *
 * The session lists every account this user may reach. Their own is the
 * primary mail account; the rest are accounts that shared something with them
 * -- a calendar, an address book, files -- and, when the server is set up that
 * way, the group (team) mailboxes whose members they are.
 *
 * Stalwart advertises the *same* capability set on every account it lists,
 * whatever was actually shared, so capabilities cannot tell a group mailbox
 * from a folder share. Mail is the one thing per-folder sharing cannot reach
 * (mail folder sharing is withdrawn -- the server stores the share and never
 * delivers it), so a non-personal account that answers `Mailbox/get` with a
 * folder tree is a whole-account grant: a group mailbox. The store probes the
 * candidates this module names and keeps only the ones that answer.
 */
import { CAP } from "@/jmap/client";
import { ownAccountForCapability } from "./accountRouting";

export interface MailAccountInfo {
  accountId: string;
  /** What the session calls the account: an address for a group mailbox. */
  name: string;
  kind: "own" | "group";
}

interface MailAccountLike {
  name: string;
  isPersonal: boolean;
  accountCapabilities?: Record<string, unknown>;
}

export interface MailSessionLike {
  accounts: Record<string, MailAccountLike>;
  primaryAccounts: Record<string, string>;
}

const advertises = (account: MailAccountLike | undefined, cap: string): boolean =>
  Boolean(account && cap in (account.accountCapabilities ?? {}));

/**
 * The accounts worth probing for a mailbox tree: the reader's own first, then
 * every non-personal account that advertises mail, in session order. The
 * caller probes each "group" candidate with `Mailbox/get` and keeps the ones
 * that answer with a tree. Since ADR 0001 there is no product-admin group to
 * exclude: a non-personal mail account is a group mailbox, full stop.
 */
export function mailAccountCandidates(
  session: MailSessionLike | null,
): MailAccountInfo[] {
  if (!session) return [];
  const own = ownAccountForCapability(session, CAP.mail);
  const out: MailAccountInfo[] = [];
  if (own) {
    const account = session.accounts[own];
    out.push({ accountId: own, name: account?.name ?? "", kind: "own" });
  }
  for (const [accountId, account] of Object.entries(session.accounts)) {
    if (accountId === own || account.isPersonal !== false) continue;
    if (!advertises(account, CAP.mail)) continue;
    out.push({ accountId, name: account.name, kind: "group" });
  }
  return out;
}

/** Whether an account id is the reader's own, by this session's lights. */
export function isOwnMailAccount(
  session: MailSessionLike | null,
  accountId: string | null,
): boolean {
  if (!session || !accountId) return false;
  return accountId === ownAccountForCapability(session, CAP.mail);
}

/**
 * Whether the account on screen is a group mailbox rather than the reader's
 * own. The one classifier for "is this a group context" in the mail UI: a
 * non-own account being browsed is a group mailbox.
 */
export function isGroupMailbox(
  accountId: string | null,
  ownAccountId: string | null,
): boolean {
  return Boolean(accountId && ownAccountId && accountId !== ownAccountId);
}

/**
 * The group mailboxes a working surface may offer: the probed non-personal
 * mail accounts. One classifier for every group-owned creation surface --
 * calendars, contacts, chat -- so the membership rule cannot drift between
 * them. Since ADR 0001 removed the product-admin group, every non-personal
 * mail account is a working group.
 *
 * The server's push-subscription flag `hasChatGroupAccounts`
 * (server/src/upstream.ts) is the wire-level superset of this classifier:
 * it may count more accounts (calendar/files shares), never fewer, so chat
 * offered here always has its FileNode rail. When the two drift, narrow the
 * client classifier, never the server flag.
 */
export function groupMailboxAccounts(accounts: MailAccountInfo[]): MailAccountInfo[] {
  return accounts.filter((a) => a.kind === "group");
}
