import { errorMessage } from "@gilbert/shared/errors";
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type {
  Calendar,
  GetResponse,
  Id,
  ParticipantIdentity,
  SetResponse,
} from "@/jmap/types";
import { useSession } from "../../session";
import { CALENDAR_PROPS, startReminderTimer } from "../shared";
import type { CalendarGet, CalendarSet, CalendarState } from "../types";

/**
 * Calendars: the reader's own set, their lifecycle, and which of them are
 * drawn.
 *
 * A slice of the calendar store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function calendarsSlice(
  set: CalendarSet,
  get: CalendarGet,
): Pick<
  CalendarState,
  | "init"
  | "loadCalendars"
  | "createCalendar"
  | "updateCalendar"
  | "destroyCalendar"
  | "toggleHidden"
> {
  return {
    async init() {
      // The reader's own: a shared calendar is shown beside theirs, not instead.
      const accountId = useSession.getState().ownAccountFor(CAP.calendars);
      const available = Boolean(accountId && client.hasCapability(CAP.calendars));
      if (accountId !== get().accountId)
        set({ accountId, calendars: {}, events: {}, ranges: {} });
      set({ available });
      if (!available) return;
      /*
       * Side by side. None of the three waits on another, and calls made in one
       * tick share a request -- so awaiting one before starting the next, as this
       * did, cost a round trip apiece at sign-in.
       */
      const identities = client
        .call<GetResponse<ParticipantIdentity>>("ParticipantIdentity/get", {
          accountId,
          ids: null,
        })
        .then(
          (res) => set({ identities: res.list }),
          () => set({ identities: [] }),
        );
      void get().loadSharedCalendars();
      await Promise.all([get().loadCalendars(), identities]);
      startReminderTimer(get);
    },

    async loadCalendars() {
      const accountId = get().accountId;
      if (!accountId) return;
      try {
        const res = await client.call<GetResponse<Calendar>>("Calendar/get", {
          accountId,
          ids: null,
          properties: CALENDAR_PROPS,
        });
        const calendars: Record<Id, Calendar> = {};
        for (const c of res.list) calendars[c.id] = c;
        set({ calendars, error: null });
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    /**
     * Create a calendar, owned by `accountId` when given and by the reader's
     * own account otherwise. A calendar created on a group account belongs to
     * the group: it is written directly into the group's own account, so every
     * member -- including one added after the fact -- reaches it through their
     * session on that account, and no share or per-user ACL is written.
     *
     * Subscribed from the start: the reader made the calendar to use it, and a
     * server that leaves a new calendar unsubscribed unless the client says
     * otherwise (Stalwart does; the mock hides it by filling the flag in) would
     * keep it invisible to every client that honours `isSubscribed`.
     */
    async createCalendar(data, accountId?: Id) {
      const own = get().accountId!;
      const target = accountId ?? own;
      const res = await client.call<SetResponse<Calendar>>("Calendar/set", {
        accountId: target,
        create: { c: { name: "Calendar", isSubscribed: true, ...data } },
      });
      const err = res.notCreated?.c;
      if (err) throw new Error(setErrorMessage(err));
      if (target === own) await get().loadCalendars();
      else await get().loadSharedCalendars();
      return res.created!.c!.id;
    },

    async updateCalendar(id, patch) {
      const accountId = get().accountId!;
      const res = await client.call<SetResponse>("Calendar/set", {
        accountId,
        update: { [id]: patch },
      });
      const err = res.notUpdated?.[id];
      if (err) throw new Error(setErrorMessage(err));
      await get().loadCalendars();
    },

    async destroyCalendar(id) {
      const accountId = get().accountId!;
      const res = await client.call<SetResponse>("Calendar/set", {
        accountId,
        destroy: [id],
        onDestroyRemoveEvents: true,
      });
      const err = res.notDestroyed?.[id];
      if (err) throw new Error(setErrorMessage(err));
      await get().loadCalendars();
      get().refreshWindows();
    },

    toggleHidden(id) {
      set((s) => {
        const hidden = { ...s.hidden };
        if (hidden[id]) delete hidden[id];
        else hidden[id] = true;
        return { hidden };
      });
    },
  };
}
