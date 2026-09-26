import { client } from "@/jmap/client";
import type { Email, GetResponse, Id } from "@/jmap/types";
import { withBase } from "@/lib/basePath";
import { playNewMailSound, showNotification } from "@/lib/notify";
import { settings } from "../settings";
import type { MailState } from "./types";

/** The sender's name for a message, or a generic one when it names none. */
export function senderName(email: Pick<Email, "from">): string {
  const from = email.from?.[0];
  return from?.name || from?.email || "New message";
}

/**
 * One mail notification: the sender as its title, the subject and preview as
 * its body, and a tap that opens the message where it lives. One renderer, so
 * the reader's own account and a group cannot show the same arrival two ways.
 */
export function announceMail(
  email: Pick<Email, "id" | "threadId" | "from" | "subject" | "preview">,
  inboxId: Id,
  title: string,
): void {
  showNotification(title, {
    body: `${email.subject || "(no subject)"}\n${email.preview ?? ""}`.trim(),
    tag: `gilbert-${email.id}`,
    onClick: () => {
      window.location.hash = "";
      // The one navigation that does not go through wouter -- it is synthesising
      // a popstate so the router picks the address up -- so it is also the one
      // that has to add the mount prefix itself.
      window.history.pushState({}, "", withBase(`/mail/${inboxId}/${email.threadId}`));
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
  });
}

export async function notifyNewMail(created: Id[], get: () => MailState) {
  const s = settings();
  const inbox = get().roleId("inbox");
  if (!inbox) return;
  const emails = await get().getEmails(created);
  const fresh = emails.filter(
    (e) => e.mailboxIds[inbox] && !e.keywords.$seen && !e.keywords.$draft,
  );
  if (!fresh.length) return;
  if (s.notificationSound) playNewMailSound();
  if (!s.desktopNotifications) return;
  for (const e of fresh.slice(0, 3)) announceMail(e, inbox, senderName(e));
}

/**
 * Announce the mail a group mailbox received, while a tab is open.
 *
 * The closed client is woken by the same delivery (ADR 0016); a reader who
 * keeps Gilbert open on a group must not go quiet. `notifyNewMail` is the
 * reader's own account and this is its group sibling: the same two switches and
 * the same suppression, with a title that names the group as well as the
 * sender.
 *
 * Only what arrived after this page was opened is announced. A group's Inbox
 * may hold a backlog a tab has never shown, and announcing it on the first
 * change is the noise the watermark avoids on the closed path; a set of ids
 * keeps one message from being announced twice.
 */
export const MAIL_OPENED_AT = Date.now();
export const announcedGroupMail = new Set<Id>();

export async function notifyGroupMail(
  accountId: Id,
  get: () => MailState,
): Promise<void> {
  const s = settings();
  if (!s.desktopNotifications && !s.notificationSound) return;
  const inbox = Object.values(get().accountTrees[accountId] ?? {}).find(
    (m) => m.role === "inbox",
  )?.id;
  if (!inbox) return;
  const q = await client.call<{ ids?: Id[] }>("Email/query", {
    accountId,
    filter: { inMailbox: inbox, notKeyword: "$seen" },
    sort: [{ property: "receivedAt", isAscending: false }],
    limit: 3,
  });
  const ids = q.ids ?? [];
  if (!ids.length) return;
  const got = await client.call<GetResponse<Email>>("Email/get", {
    accountId,
    ids,
    properties: ["id", "threadId", "from", "subject", "preview", "receivedAt"],
  });
  const fresh = got.list.filter((e) => {
    if (announcedGroupMail.has(e.id)) return false;
    const at = e.receivedAt ? Date.parse(e.receivedAt) : Number.NaN;
    return Number.isFinite(at) && at >= MAIL_OPENED_AT;
  });
  if (!fresh.length) return;
  for (const e of fresh) announcedGroupMail.add(e.id);
  if (s.notificationSound) playNewMailSound();
  if (!s.desktopNotifications) return;
  const name =
    get().mailAccounts.find((a) => a.accountId === accountId)?.name ?? accountId;
  for (const e of fresh) announceMail(e, inbox, `${senderName(e)} · ${name}`);
}
