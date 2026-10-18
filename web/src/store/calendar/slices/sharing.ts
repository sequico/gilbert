import { errorMessage } from "@gilbert/shared/errors";
import { ref } from "@gilbert/shared/jmapQuery";
import { isSharedAccountRecord } from "@gilbert/shared/sessionAccount";
import { API_TIMEOUT_MS, CAP, client, setErrorMessage } from "@/jmap/client";
import type { Calendar, CalendarEvent, GetResponse, SetResponse } from "@/jmap/types";
import { withBase } from "@/lib/basePath";
import { browserTimeZone, dateToZonedLocal } from "@/lib/dates";
import { withDeadline } from "@/lib/deadline";
import { t } from "@/lib/i18n";
import { type IcsEvent, parseIcs } from "@/lib/ics";
import { accountOf, sharedKey } from "@/lib/sharedKey";
import { useSession } from "../../session";
import { settings, useSettings } from "../../settings";
import { CALENDAR_PROPS, EVENT_PROPS, groupAccountIds } from "../shared";
import type { CalendarGet, CalendarSet, CalendarState, SharedCalendar } from "../types";

/**
 * Sharing: calendars somebody else shared, their events, and the reader's own
 * switch on them -- including subscribed ICS feeds, which are someone else's
 * server rather than a JMAP account.
 *
 * A slice of the calendar store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function sharingSlice(
  set: CalendarSet,
  get: CalendarGet,
): Pick<
  CalendarState,
  | "loadSharedCalendars"
  | "setSharedSubscribed"
  | "loadSharedRange"
  | "updateSharedCalendar"
  | "refreshSubscriptions"
> {
  return {
    /*
     * Calendars other people shared, and the events in them.
     *
     * Kept apart from the reader's own and keyed by account, for the reason ids
     * force: they are unique only within an account. Loaded from the same window
     * the reader is looking at, so a colleague's calendar fills in beside their
     * own rather than after a separate wait.
     *
     * An account that answers with no calendars is simply not listed. Sharing a
     * file does not make somebody's calendar worth a heading.
     */
    async loadSharedCalendars() {
      const session = useSession.getState();
      const own = session.ownAccountFor(CAP.calendars);
      const accounts = Object.entries(session.session?.accounts ?? {}).filter(
        ([id, a]) => isSharedAccountRecord(a) && id !== own,
      );
      const unread = new Set<string>();
      /*
       * Every account at once: calls made in one tick share a request, where the
       * loop this replaces sent one after another. `Promise.all` preserves the
       * input order, so the list is still the session's.
       */
      const answers = await Promise.all(
        accounts.map(async ([accountId, account]): Promise<SharedCalendar[]> => {
          try {
            const res = await client.call<GetResponse<Calendar>>("Calendar/get", {
              accountId,
              ids: null,
              properties: CALENDAR_PROPS,
            });
            return res.list.map((calendar) => ({
              accountId,
              accountName: account.name,
              calendar,
            }));
          } catch (err) {
            unread.add(accountId);
            /* Named, because an account whose calendars cannot be read is
             otherwise indistinguishable from one that has none -- and the
             calendars a group owns live in exactly such an account. */
            console.warn(
              `[gilbert] calendars: could not read the shared account ${account.name} (${accountId}): ${errorMessage(err)}`,
            );
            return [];
          }
        }),
      );
      const found = answers.flat();
      if (!found.length && accounts.length > 0 && unread.size) return; // transient
      set((s) => ({
        /* An account that could not be read keeps the calendars it already had:
         dropping them would empty a colleague's grid for the rest of the
         session over one failed request, and nothing would say why. */
        sharedCalendars: [
          ...found,
          ...s.sharedCalendars.filter((x) => unread.has(x.accountId)),
        ],
        /* Every shared account is gone and the server said so -- a revoke, or
         the reader left the team. Its events must not linger in the store,
         because the grid reads the ranges. On a partial answer the caches
         stay untouched: what is not in `found` is dropped by the calendar set
         alone. */
        sharedEvents:
          found.length || !Object.keys(s.sharedEvents).length ? s.sharedEvents : {},
        sharedRanges:
          found.length || !Object.keys(s.sharedRanges).length ? s.sharedRanges : {},
      }));
      /*
       * A group's calendar is subscribed by membership, so one left unsubscribed
       * is put back on the group's own object here: the client once let a member
       * unsubscribe one, which stranded it with no way back. Repairing the shared
       * object restores it for every reader, not only this one. Where the server
       * refuses the write, `setSharedSubscribed` records it for this reader
       * instead and the calendar is drawn all the same.
       */
      const groupIds = groupAccountIds();
      const addedShares = new Set(settings().addedShares);
      for (const c of found)
        if (
          groupIds.has(c.accountId) &&
          !c.calendar.isSubscribed &&
          !addedShares.has(sharedKey(c.accountId, c.calendar.id))
        )
          void get().setSharedSubscribed(c.accountId, c.calendar.id, true);
      // Fill in whatever windows are already on screen.
      for (const key of Object.keys(get().ranges)) {
        const [from, to] = key.split("|").map((n) => new Date(Number(n)));
        if (from && to) void get().loadSharedRange(from, to);
      }
    },

    async setSharedSubscribed(accountId, calendarId, subscribed) {
      // See the note in the contacts store: subscribing writes to another
      // account, so a refusal is an ordinary answer and arrives in `notUpdated`
      // rather than as a thrown error.
      /*
       * Server first, settings when it refuses -- the same arrangement the
       * contacts store explains. Stalwart takes this write on a shared calendar
       * where it will not on a shared address book, but the difference is the
       * server's to change and not worth relying on from here.
       */
      let stored = false;
      try {
        const res = await client.call<SetResponse>("Calendar/set", {
          accountId,
          update: { [calendarId]: { isSubscribed: subscribed } },
        });
        const err = res.notUpdated?.[calendarId];
        if (err) throw new Error(setErrorMessage(err));
        stored = true;
      } catch {
        stored = false;
      }
      if (!stored) {
        const added = new Set(settings().addedShares);
        if (subscribed) added.add(sharedKey(accountId, calendarId));
        else added.delete(sharedKey(accountId, calendarId));
        useSettings.getState().update({ addedShares: [...added] });
      }
      set((s) => ({
        sharedCalendars: s.sharedCalendars.map((c) =>
          c.accountId === accountId && c.calendar.id === calendarId
            ? { ...c, calendar: { ...c.calendar, isSubscribed: subscribed } }
            : c,
        ),
      }));
      // Its events are only fetched for calendars in view, so the windows on
      // screen have to be asked again either way.
      for (const key of Object.keys(get().ranges)) {
        const [from, to] = key.split("|").map((n) => new Date(Number(n)));
        if (from && to) void get().loadSharedRange(from, to);
      }
      /*
       * Whether the server took it. `false` is not a failure of the action: the
       * choice is recorded for this reader in `addedShares` and the calendar is
       * shown as subscribed, which is true here and false on the server. A caller
       * that does not learn which happened draws a subscribed calendar over a
       * refusal, and the reader has no way to tell that from a calendar the
       * server subscribed for them.
       */
      return stored;
    },

    /** The same window, from every account that shared a calendar. */
    async loadSharedRange(start, end) {
      const shared = get().sharedCalendars;
      if (!shared.length) return;
      const key = `${start.getTime()}|${end.getTime()}`;
      const tz = settings().timeZone ?? browserTimeZone;
      const accounts = [...new Set(shared.map((c) => c.accountId))];
      const ids: string[] = [];
      const events: Record<string, CalendarEvent> = {};
      const failed: string[] = [];
      for (const accountId of accounts) {
        /*
         * The keys this account contributed to the window last time. A failed
         * read keeps them: an account that answered with nothing is an account
         * whose events were all cancelled, and an account that could not be read
         * is an account whose events are unknown. Treating the two the same is how
         * a meeting somebody moved out of one shared calendar disappears from
         * every window without a word.
         */
        const held = (get().sharedRanges[key] ?? []).filter(
          (k) => accountOf(k) === accountId,
        );
        try {
          /*
           * Read in pages of what the server will resolve in one `/get`: the ids
           * and the objects are asked for together, and a window wider than that
           * is refused whole -- which the catch below would turn into a shared
           * calendar that silently shows nothing.
           */
          const page = client.maxObjectsInGet;
          for (let position = 0; ; position += page) {
            const res = await client.chain([
              [
                "CalendarEvent/query",
                {
                  accountId,
                  /* after/before are wall-clock times in `timeZone`, so the window's
                   own instants have to be written as that zone's clock -- the
                   browser frame would shift the comparison by the offset between
                   the two and drop the edge hours of every window. */
                  filter: {
                    after: dateToZonedLocal(start, tz),
                    before: dateToZonedLocal(end, tz),
                  },
                  timeZone: tz,
                  sort: [{ property: "start", isAscending: true }],
                  expandRecurrences: true,
                  position,
                  limit: page,
                },
                "q",
              ],
              [
                "CalendarEvent/get",
                {
                  accountId,
                  "#ids": ref("q", "CalendarEvent/query", "/ids"),
                  properties: EVENT_PROPS,
                  timeZone: tz,
                },
                "g",
              ],
            ]);
            const q = res.get("q")?.[0] as unknown as { ids?: string[] };
            const g = res.get("g")?.[0] as unknown as GetResponse<CalendarEvent>;
            const pageIds = q.ids ?? [];
            if (!pageIds.length) break;
            for (const e of g.list) {
              const k = sharedKey(accountId, e.id);
              events[k] = e;
              ids.push(k);
            }
            if (pageIds.length < page) break;
          }
        } catch (err) {
          /*
           * One account among several failed, so what it contributed last time
           * stays in this window and the failure is reported like every other
           * read in this store (`error` is what the window draws). Swallowing it
           * instead would close the window over the accounts that did answer,
           * which is how a meeting somebody moved in the unreadable account comes
           * to look deleted.
           */
          ids.push(...held);
          failed.push(errorMessage(err));
        }
      }
      set((s) => {
        const sharedRanges = { ...s.sharedRanges, [key]: ids };
        /*
         * A window's fresh answer replaces what it held: an event the account no
         * longer returns is dropped rather than kept beside the new key, and so
         * is anything of a window that has since been dropped. What a held window
         * still names stays.
         */
        const live = new Set<string>();
        for (const list of Object.values(sharedRanges)) for (const k of list) live.add(k);
        const held = { ...s.sharedEvents, ...events };
        const sharedEvents: Record<string, CalendarEvent> = {};
        for (const k of live) {
          const e = held[k];
          if (e) sharedEvents[k] = e;
        }
        return { sharedEvents, sharedRanges };
      });
      // Cleared as well as set: a window that read cleanly after a failed one is
      // no longer a window with something wrong on it.
      set({ sharedError: failed.length ? failed.join(" ") : null });
    },

    async updateSharedCalendar(accountId, id, patch) {
      const res = await client.call<SetResponse>("Calendar/set", {
        accountId,
        update: { [id]: patch },
      });
      const err = res.notUpdated?.[id];
      if (err) throw new Error(setErrorMessage(err));
      await get().loadSharedCalendars();
      // Its events are only fetched for calendars in view, so the windows on
      // screen have to be asked again either way.
      for (const key of Object.keys(get().ranges)) {
        const [from, to] = key.split("|").map((n) => new Date(Number(n)));
        if (from && to) void get().loadSharedRange(from, to);
      }
    },

    async refreshSubscriptions() {
      const subs = settings().icalSubscriptions;
      if (!subs.length) {
        if (Object.keys(get().subscriptionEvents).length)
          set({ subscriptionEvents: {}, subscriptionErrors: {} });
        return;
      }
      set({ subscriptionsLoading: true });
      const events: Record<string, IcsEvent[]> = {};
      const errors: Record<string, string> = {};
      /*
       * Sequential rather than parallel. These are other people's servers, and a
       * reader with a dozen subscriptions opening the calendar should not put a
       * dozen simultaneous requests on them from every device they own.
       */
      for (const sub of subs) {
        try {
          // No CSRF header: this is a GET, which the server's guard does not
          // check, and a second spelling of the constant could only drift. The
          // body is read inside the deadline: another server's calendar can take
          // its time, and one that answers and then stalls must not hold the
          // list open for ever.
          const answer = await withDeadline(API_TIMEOUT_MS, undefined, async (signal) => {
            const res = await fetch(
              withBase(`/api/ics?url=${encodeURIComponent(sub.url)}`),
              {
                signal,
              },
            );
            return { ok: res.ok, status: res.status, text: await res.text() };
          });
          if (!answer.ok) {
            // The body is already read (inside the deadline); what it says about
            // the refusal is the server's own sentence, for this subscription.
            let message = `HTTP ${answer.status}`;
            try {
              const body = JSON.parse(answer.text) as { error?: string };
              if (body.error) message = body.error;
            } catch {
              /* not a JSON body: the status is all there is to say */
            }
            errors[sub.id] = message;
            continue;
          }
          events[sub.id] = parseIcs(answer.text).events;
        } catch (err) {
          errors[sub.id] =
            (err as Error).name === "AbortError"
              ? t("The calendar did not answer in time.")
              : errorMessage(err);
        }
      }
      set({
        subscriptionEvents: events,
        subscriptionErrors: errors,
        subscriptionsLoading: false,
      });
    },
  };
}
