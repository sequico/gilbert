import type { Calendar, Id } from "@/jmap/types";
import { dueReminders, dueSubscriptionReminders } from "@/lib/calendarReminders";
import { t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { showNotification } from "@/lib/notify";
import { toast } from "@/ui/toast";
import { useMail } from "../mail";
import { useSession } from "../session";
import type { CalendarState, SharedCalendar } from "./types";

/**
 * The group mailboxes the reader belongs to, per the mail store's probe.
 *
 * A group's calendar is subscribed by membership, so `isSubscribed` is not the
 * member's switch on it: it is drawn whether or not that flag survived, and one
 * found unsubscribed is put back. Read here the way the contacts store reads
 * it, so every group surface asks the same classifier.
 */
export function groupAccountIds(): Set<string> {
  return new Set(
    groupMailboxAccounts(useMail.getState().mailAccounts).map((a) => a.accountId),
  );
}

/**
 * Arm the calendar reminders (ADR 0014).
 *
 * An event that carries a reminder is announced when it falls due, on every
 * channel a running client has: the system notification, and an in-app notice.
 * Only an event with a reminder is announced -- the reminder is the opt-in, and
 * an event without one says nothing. A closed client is not woken for one, and
 * cannot be: Stalwart pushes changes, not clocks. So this is what a page can do
 * while it is open.
 *
 * It reads the events already loaded for the ranges on screen: a reminder is
 * announced for an event the client holds, which is the range the reader has
 * looked at.
 */
let remindersCheckedTo = 0;
let reminderTimer: number | null = null;

export function startReminderTimer(get: () => CalendarState): void {
  if (reminderTimer !== null) return;
  remindersCheckedTo = Date.now();
  reminderTimer = window.setInterval(() => {
    const now = Date.now();
    const from = remindersCheckedTo;
    remindersCheckedTo = now;
    for (const { event } of dueReminders(
      Object.values(get().events),
      get().calendars,
      from,
      now,
      useSession.getState().session?.username ?? "",
    )) {
      const title = event.title || t("(untitled)");
      showNotification(title, {
        body: t("Calendar reminder"),
        tag: `gilbert-reminder-${event.id}`,
        // A reminder is the one notification a focused window must not swallow:
        // the event is not on screen, which is the whole reason it exists.
        evenWhenFocused: true,
      });
      toast.show(t("Reminder: {title}", { title }));
    }
    for (const { key, event } of dueSubscriptionReminders(
      get().subscriptionEvents,
      from,
      now,
    )) {
      showNotification(event.summary, {
        body: t("Calendar reminder"),
        tag: `gilbert-reminder-${key}`,
        evenWhenFocused: true,
      });
      toast.show(t("Reminder: {title}", { title: event.summary }));
    }
  }, 30_000);
}

/** Stop the reminder timer: a sign-out has no reader to remind. */
export function stopReminderTimer(): void {
  if (reminderTimer !== null) {
    window.clearInterval(reminderTimer);
    reminderTimer = null;
  }
}

/*
 * Asked for by name, so the properties a share is read from are always there.
 *
 * A `Calendar/get` with no `properties` came back without `shareWith` on
 * 0.16.19 -- not null, not empty, absent -- confirmed on 2026-08-27 with a
 * calendar that was genuinely shared: omit the list and there is no
 * `shareWith`; name it and the sharee is right there. 0.16.21 returns every
 * property when none are named (confirmed live on 2026-09-06), which makes
 * naming them a guarantee rather than a rescue, and it is the guarantee a
 * server older than that still needs. Omitting it leaves the client with
 * nothing to read a share from: no badge, no "Stop sharing", and a share
 * dialog that opens on "not shared with anyone yet" over a live share.
 *
 * Files and address books ask for their properties by name for the same reason.
 */
export const CALENDAR_PROPS = [
  "id",
  "name",
  "description",
  "color",
  "sortOrder",
  "isSubscribed",
  "isVisible",
  "isDefault",
  "includeInAvailability",
  "defaultAlertsWithTime",
  "defaultAlertsWithoutTime",
  "timeZone",
  "shareWith",
  "myRights",
];

/**
 * Explicit property list: when `properties` is null Stalwart omits the JMAP-only
 * fields baseEventId / utcStart / utcEnd, and we need baseEventId to update
 * recurring instances (synthetic ids can't be patched directly).
 */
export const EVENT_PROPS = [
  /*
   * Asked for by name, because a server that honours `properties` returns
   * none of the JMAP-only fields above unless they are named.
   */
  "@type",
  "id",
  "baseEventId",
  "calendarIds",
  "isDraft",
  "isOrigin",
  "utcStart",
  "utcEnd",
  "useDefaultAlerts",
  "mayInviteSelf",
  "mayInviteOthers",
  "hideAttendees",
  "uid",
  "relatedTo",
  "prodId",
  "created",
  "updated",
  "sequence",
  "title",
  "description",
  "descriptionContentType",
  "showWithoutTime",
  "locations",
  "virtualLocations",
  "links",
  "locale",
  "keywords",
  "categories",
  "color",
  "recurrenceId",
  "recurrenceIdTimeZone",
  "recurrenceRules",
  "recurrenceRule",
  "excludedRecurrenceRules",
  "recurrenceOverrides",
  "excluded",
  "priority",
  "freeBusyStatus",
  "privacy",
  "replyTo",
  "organizerCalendarAddress",
  "sentBy",
  "participants",
  "requestStatus",
  "alerts",
  "timeZone",
  "start",
  "duration",
  "status",
];

/**
 * Which account holds a calendar, from a bare id.
 *
 * A calendar id is unique only within its account: the reader's own and a
 * group's can both be "t1", and two shared accounts can collide too. A bare
 * id that names more than one reachable calendar is ambiguous and resolves to
 * null -- "Calendar is not available" at every call site -- rather than to a
 * guess, because a guess would aim an edit at the wrong account's same-id
 * calendar. Resolution is unambiguous when exactly one side holds the id:
 *
 *  - only the reader's own account holds it → the reader's own account;
 *  - exactly one shared/group account holds it → that account;
 *  - nobody reachable holds it → the reader's own account, the historical
 *    answer for an id whose calendar has not loaded yet (a caller that
 *    really means a group event passes the account explicitly and never
 *    reaches this guess);
 *  - the own account and a shared one both hold it, or two shared accounts
 *    do → null, since the bare id cannot tell which was meant.
 *
 * Callers that know the account (every view path, since an instance carries
 * its account) pass it explicitly and never reach this guess. No id at all
 * means a brand-new event, which starts on the reader's own account.
 */
export function accountOfCalendar(
  calendarId: string | null | undefined,
  own: Record<Id, Calendar>,
  ownAccountId: Id | null,
  shared: SharedCalendar[],
): Id | null {
  if (!calendarId) return ownAccountId;
  const ownHit = Boolean(own[calendarId]);
  const sharedHits = shared.filter((c) => c.calendar.id === calendarId);
  if (ownHit && sharedHits.length) return null;
  if (sharedHits.length > 1) return null;
  const onlyShared = sharedHits.length === 1 ? sharedHits[0] : undefined;
  if (onlyShared) return onlyShared.accountId;
  return ownAccountId;
}
