import type { CalendarEvent, JSCalendarAlert } from "@/jmap/types";
import { parseDuration, zonedToDate } from "./dates";

/**
 * When a calendar event's own reminder falls due (ADR 0016).
 *
 * An event that carries a reminder is announced when its instant arrives, and
 * an event with none is not announced at all -- the reminder *is* the opt-in.
 * The instant is the event's start less the trigger's offset, and a `display`
 * reminder is the action the editor writes and the only one this client owns:
 * an `email` reminder is Stalwart's to send, not this page's.
 */

/** The calendar fields an event falls back to when it uses the defaults. */
export interface AlertDefaults {
  defaultAlertsWithTime?: Record<string, JSCalendarAlert> | null;
  defaultAlertsWithoutTime?: Record<string, JSCalendarAlert> | null;
}

/**
 * The instants an event's reminders fall due, in ms, oldest first, or `[]`.
 *
 * An event with its own `alerts` uses them; one that says `useDefaultAlerts` and
 * carries none takes the calendar's default -- with time, or without, whichever
 * the event is. A trigger that is not an offset from the start (an absolute
 * one) is left alone rather than guessed at.
 */
export function alertInstants(event: CalendarEvent, calendar?: AlertDefaults): number[] {
  const start = zonedToDate(event.start, event.timeZone).getTime();
  if (!Number.isFinite(start)) return [];
  const alerts =
    event.alerts && Object.keys(event.alerts).length
      ? event.alerts
      : event.useDefaultAlerts
        ? ((event.showWithoutTime
            ? calendar?.defaultAlertsWithoutTime
            : calendar?.defaultAlertsWithTime) ?? {})
        : {};
  const out: number[] = [];
  for (const alert of Object.values(alerts)) {
    if (!alert) continue;
    if (alert.action && alert.action !== "display") continue;
    const trigger = alert.trigger;
    if (!trigger || !("offset" in trigger) || typeof trigger.offset !== "string")
      continue;
    const seconds = parseDuration(trigger.offset);
    if (!Number.isFinite(seconds)) continue;
    out.push(start + seconds * 1000);
  }
  return out.sort((a, b) => a - b);
}

/** What falls due in `(from, to]`, one entry per event and instant. */
export function dueReminders(
  events: ReadonlyArray<CalendarEvent>,
  calendars: Record<string, AlertDefaults | undefined>,
  from: number,
  to: number,
): Array<{ key: string; event: CalendarEvent; at: number }> {
  const out: Array<{ key: string; event: CalendarEvent; at: number }> = [];
  for (const event of events) {
    const calendarId = Object.keys(event.calendarIds ?? {})[0];
    const calendar = calendarId ? calendars[calendarId] : undefined;
    for (const at of alertInstants(event, calendar)) {
      if (at > from && at <= to) out.push({ key: `${event.id}@${at}`, event, at });
    }
  }
  return out;
}
