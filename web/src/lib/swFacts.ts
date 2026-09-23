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

/** One group chat the worker may be woken for, and what reading it needs. */
export interface WorkerChatFact {
  /** The group account the chat lives in (a FileNode change names it). */
  accountId: string;
  /** The group's display name, which is the notification's title. */
  name: string;
  /** The `gilbert/chat` folder's id. */
  folderId: string;
  /** The newest message instant the app has already seen, or "" for none. */
  watermark: string;
}

export interface WorkerFacts {
  /** The account the notifications are about. */
  accountId: string;
  /**
   * The account's Inbox mailbox id.
   *
   * The deep link in a notification is `/mail/<mailbox id>/<thread id>`, so the
   * worker needs the real Inbox id: a literal `inbox` is not a folder the app
   * has, and opening one reads as a stale link and redirects to the inbox with
   * a complaint. Null where the account's tree has not been read yet.
   */
  inboxId: string | null;
  /** Where Archive files to; null where the account has no archive folder. */
  archiveId: string | null;
  /** The reader's own address, so a message they wrote is never announced. */
  ownAddress: string;
  /** Every group chat this device may be woken for (ADR 0016). */
  chats: WorkerChatFact[];
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
 * account, the archive folder — because it is what the worker will still be
 * reading in a week's time. Rewriting it is one cache put; there is nothing to
 * gain by working out whether it differs.
 */
export async function publishWorkerFacts(
  accountId: string | null,
  archiveId: string | null,
  chats: WorkerChatFact[] = [],
  ownAddress = "",
  inboxId: string | null = null,
): Promise<void> {
  if (typeof caches === "undefined" || !accountId) return;
  const facts: WorkerFacts = {
    accountId,
    inboxId,
    archiveId,
    ownAddress,
    chats,
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
