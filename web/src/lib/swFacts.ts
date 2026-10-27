/*
 * What the service worker cannot work out for itself.
 *
 * The worker can act on mail — see the note on `jmap()` in sw.js — but it
 * cannot read a catalogue or a store. It is plain JavaScript copied into the
 * build, outside the bundle, with no i18n and no idea which mailbox is the
 * archive. Both of those are things a tab knows and can simply write down.
 *
 * So the app leaves a short briefing in the same cache it uses for every other
 * handoff, and the worker reads it when a notification arrives. Where there is
 * none, the worker offers no actions at all rather than guessing: an untitled
 * button that files mail somewhere is worse than a notification you have to
 * open.
 *
 * That means the actions appear once Gilbert has been opened since the worker
 * was installed, which is the same condition background notifications already
 * carry — a push subscription has to be renewed from a tab too.
 */
import { withBase } from "./basePath";
import { t } from "./i18n";
import { SW_CACHE_NAME } from "./swCache";

export const FACTS_KEY = "/gilbert-worker-facts";

/** One account the subscription covers, as the worker needs it. */
interface WorkerAccountFact {
  /** The account the facts are about. */
  accountId: string;
  /** Whether this is the reader's own account rather than a group mailbox. */
  own: boolean;
  /** What the session calls it: a group's address, or the reader's own. */
  name: string;
  /**
   * The account's Inbox id, for the notification's deep link.
   *
   * The route is `/mail/<mailbox id>/<thread id>?a=<account>`, so the worker
   * needs the real Inbox id: a literal `inbox` is not a folder the app has, and
   * opening one reads as a stale link and redirects to the inbox with a
   * complaint. The account is what the link is made *for*, because a folder id
   * alone does not say whose it is -- the Inbox is `a` in every account -- and
   * a link resolved against the account on screen opens a conversation that
   * account does not hold. Null where the account's tree has not been read
   * yet.
   */
  inboxId: string | null;
  /** Where Archive files to in this account; null where it has no archive folder. */
  archiveId: string | null;
  /** The account's `gilbert/chat` folder id, when it is a group with a chat. */
  chatFolderId: string | null;
  /** The newest chat instant the app has already seen, or "" for none. */
  watermark: string;
}

export interface WorkerFacts {
  /** The reader's own address, so a message they wrote is never announced. */
  ownAddress: string;
  /** One entry per account the subscription covers (ADR 0014). */
  accounts: WorkerAccountFact[];
  /** The worker's own user-visible text, in the language this tab is in. */
  strings: {
    newMail: string;
    newMessage: string;
    noSubject: string;
    archive: string;
    markRead: string;
    failed: string;
  };
}

/**
 * Write the briefing.
 *
 * Called again whenever what is in it could have changed — the language, the
 * accounts, a folder moved — because it is what the worker will still be
 * reading in a week's time. Rewriting it is one cache put; there is nothing to
 * gain by working out whether it differs.
 */
export async function publishWorkerFacts(
  accounts: ReadonlyArray<WorkerAccountFact>,
  ownAddress = "",
): Promise<void> {
  if (typeof caches === "undefined" || !accounts.length) return;
  const facts: WorkerFacts = {
    ownAddress,
    accounts: accounts.map((a) => ({ ...a })),
    strings: {
      newMail: t("New mail"),
      newMessage: t("New message"),
      noSubject: t("(no subject)"),
      archive: t("Archive"),
      markRead: t("Mark as read"),
      failed: t("Could not do that — open Gilbert and try again"),
    },
  };
  try {
    const cache = await caches.open(SW_CACHE_NAME);
    await cache.put(
      withBase(FACTS_KEY),
      new Response(JSON.stringify(facts), {
        headers: { "content-type": "application/json" },
      }),
    );
  } catch {
    /* no cache storage: the worker falls back to a notification with no actions */
  }
}

/**
 * The id of an account's folder by role, read from **that account's own tree**.
 *
 * A folder id belongs to one account: the own account's Inbox is the own
 * account's, never the account on screen. Reading it through the mail store's
 * `roleId` (which reads the active tree) is how the own account's worker entry
 * once got a group's Inbox, and sent a notification for own mail into the group
 * — which held no such conversation.
 */
export function folderIdOfRole(
  trees: Record<string, Record<string, { id: string; role?: string | null }>>,
  accountId: string,
  role: string,
): string | null {
  for (const folder of Object.values(trees[accountId] ?? {}))
    if (folder.role === role) return folder.id;
  return null;
}

/**
 * The accounts the worker's briefing lists, built from what the app holds.
 *
 * One entry per account the subscription covers (ADR 0014): each with the Inbox
 * and archive **of that account's own tree** — never the account on screen,
 * which is what `roleId` reads and what once put a group's Inbox in the own
 * entry and sent a notification for own mail into the group — its name, and, for
 * a group with a chat, the chat folder and the newest instant seen.
 */
export function workerAccounts(opts: {
  mailAccounts: ReadonlyArray<{ accountId: string; kind: string; name: string }>;
  accountTrees: Record<string, Record<string, { id: string; role?: string | null }>>;
  ownAddress: string;
  conversations: ReadonlyArray<{
    accountId: string;
    folders?: { chat?: string | null } | null;
    nodes: ReadonlyArray<{ at: string }>;
  }>;
}): WorkerAccountFact[] {
  return opts.mailAccounts.map((a) => {
    if (a.kind === "own")
      return {
        accountId: a.accountId,
        own: true,
        name: opts.ownAddress,
        inboxId: folderIdOfRole(opts.accountTrees, a.accountId, "inbox"),
        archiveId: folderIdOfRole(opts.accountTrees, a.accountId, "archive"),
        chatFolderId: null,
        watermark: "",
      };
    const conv = opts.conversations.find((c) => c.accountId === a.accountId && c.folders);
    return {
      accountId: a.accountId,
      own: false,
      name: a.name,
      inboxId: folderIdOfRole(opts.accountTrees, a.accountId, "inbox"),
      archiveId: folderIdOfRole(opts.accountTrees, a.accountId, "archive"),
      chatFolderId: conv?.folders?.chat ?? null,
      // biome-ignore lint/complexity/useMathMinMax: ISO timestamps compared as strings; Math.max would coerce them to NaN.
      watermark: conv ? conv.nodes.reduce((m, n) => (n.at > m ? n.at : m), "") : "",
    };
  });
}

/**
 * Forget the briefing.
 *
 * Signing out is the one moment nothing rewrites it: the accounts the worker
 * notifies for are gone, and the briefing names the address and folders of the
 * session that just ended. Left in the cache, the worker would read them for
 * whoever signs in next, so the entry is removed rather than overwritten with
 * an empty one — an absent briefing is what the worker already falls back to.
 */
export async function clearWorkerFacts(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(SW_CACHE_NAME);
    await cache.delete(withBase(FACTS_KEY));
  } catch {
    /* no cache storage: there is nothing written to forget */
  }
}
