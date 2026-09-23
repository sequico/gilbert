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
 * from a folder share -- and they are not consulted here. Mail is the one
 * thing per-folder sharing cannot reach (mail folder sharing is withdrawn --
 * the server stores the share and never delivers it), so a non-personal
 * account that answers `Mailbox/get` with a folder tree is a whole-account
 * grant: a group mailbox. The store probes the candidates this module names
 * and keeps only the ones that answer.
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
}

export interface MailSessionLike {
  accounts: Record<string, MailAccountLike>;
  primaryAccounts: Record<string, string>;
}

/**
 * The accounts worth probing for a mailbox tree: the reader's own first, then
 * every non-personal account the session lists, in session order. The caller
 * probes each "group" candidate with `Mailbox/get` and keeps the ones that
 * answer with a tree. Since ADR 0001 there is no product-admin group to
 * exclude: a non-personal account is a group mailbox candidate, full stop.
 *
 * The account's capability list is deliberately **not** read to narrow this:
 * it is the credential's rights on the account, not what the account was
 * shared for, and the probe -- not a capability -- is the classifier. An
 * account the session lists without that capability is dropped before
 * anything can ask it, and the probe can only classify what it is handed, so
 * a member's group mailbox would be hidden from every session whose record
 * for it advertises nothing.
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
    out.push({ accountId, name: account.name, kind: "group" });
  }
  return out;
}

/**
 * The account that sends for the reader: where their own identities live.
 *
 * ADR 0007: a person's own list is the account that sends for them -- the one
 * the session names for `urn:ietf:params:jmap:submission` -- and not the
 * mailbox the client happens to have on screen. A mailbox on screen is where a
 * message is written; an identity is a claim about who is sending, and that
 * claim does not change because the reader opened a share or a group's mail.
 *
 * Submission first, mail second: the identity objects are stored against the
 * account a message goes out from, and a session that names no submission
 * account still sends as the reader's own mail account.
 */
export function ownIdentityAccountId(session: MailSessionLike | null): string | null {
  return (
    ownAccountForCapability(session, CAP.submission) ??
    ownAccountForCapability(session, CAP.mail)
  );
}

/**
 * The address the session calls one account, or `""` when it names none.
 *
 * For a group mailbox that is the group's **own address**, and it is the input
 * two things share: the assignment route is asked about this group by it
 * (`/api/identities/assignment`), and step 2 of the sending cascade matches an
 * identity carrying it (`@gilbert/shared/identityAssignment`). Defined once so
 * the two cannot be spelt differently.
 */
export function mailAccountAddress(
  accounts: ReadonlyArray<MailAccountInfo>,
  accountId: string | null,
): string {
  if (!accountId) return "";
  return accounts.find((a) => a.accountId === accountId)?.name ?? "";
}

/** Whether an account id is the reader's own, by this session's lights. */
export function isOwnMailAccount(
  session: MailSessionLike | null,
  accountId: string | null,
): boolean {
  if (!session || !accountId) return false;
  return accountId === ownAccountForCapability(session, CAP.mail);
}

/** One account a background subscription covers, with its Inbox id. */
export interface PushTarget {
  accountId: string;
  /** The account's Inbox id, or null when its tree has not been read yet. */
  inboxId: string | null;
}

/** The Inbox of one account's tree, or null when it names none. */
function inboxOf(
  tree: Record<string, { id: string; role?: string | null }> | undefined,
): string | null {
  return Object.values(tree ?? {}).find((m) => m.role === "inbox")?.id ?? null;
}

/**
 * The accounts a background subscription covers, each with its Inbox id: the
 * reader's own plus every group mailbox, the group's Inbox taken from the tree
 * the mail probe already read (`accountTrees`, filled by `discoverMailAccounts`).
 * One list for the `emailPush` map and for the worker's briefing, so what the
 * subscription describes and what the worker reads cannot disagree.
 */
export function pushTargets(
  accounts: ReadonlyArray<MailAccountInfo>,
  accountTrees: Record<string, Record<string, { id: string; role?: string | null }>>,
  ownInboxId: string | null,
): PushTarget[] {
  return accounts.map((a) => ({
    accountId: a.accountId,
    inboxId: a.kind === "own" ? ownInboxId : inboxOf(accountTrees[a.accountId]),
  }));
}

/** Whether an account is one of the group mailboxes, per `MailAccountInfo.kind`. */
function isGroupAccount(a: MailAccountInfo): boolean {
  return a.kind === "group";
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
export function groupMailboxAccounts(
  accounts: ReadonlyArray<MailAccountInfo>,
): MailAccountInfo[] {
  return accounts.filter(isGroupAccount);
}

/**
 * Whether this account is a group mailbox.
 *
 * **The one classifier**, read by every surface that has to know: an account
 * the mail store's probe answered `Mailbox/get` with a folder tree, which is
 * what lists it with `kind: "group"`. Nothing asks whether an account is
 * merely "not mine" -- that counts a calendar or a files share as a group,
 * and a read reaches the app folder, so the wrong answer creates one in
 * somebody else's storage. A label list, a label count and "may I create one
 * here" all read this, so they cannot answer differently.
 */
export function isGroupMailboxAccount(
  accountId: string | null,
  accounts: ReadonlyArray<MailAccountInfo>,
): boolean {
  if (!accountId) return false;
  return accounts.some((a) => isGroupAccount(a) && a.accountId === accountId);
}
