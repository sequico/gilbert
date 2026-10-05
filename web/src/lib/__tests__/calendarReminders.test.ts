import { describe, expect, it } from "vitest";
import type { CalendarEvent, JSCalendarAlert } from "@/jmap/types";
import {
  alertInstants,
  dueReminders,
  dueSubscriptionReminders,
  icsAlertInstants,
} from "@/lib/calendarReminders";
import { parseIcs } from "@/lib/ics";

/**
 * When an event's own reminder falls due (ADR 0016).
 *
 * Only an event that carries a reminder is announced, the instant is the start
 * less the trigger's offset, and the calendar's default stands in only for an
 * event that asks for it.
 */

const event = (over: Record<string, unknown>): CalendarEvent =>
  ({
    id: "e1",
    calendarIds: { c1: true },
    start: "2026-01-01T10:00:00",
    timeZone: null,
    showWithoutTime: false,
    title: "Standup",
    ...over,
  }) as unknown as CalendarEvent;

const offset = (
  minutes: number,
  action: "display" | "email" = "display",
): JSCalendarAlert => ({
  "@type": "Alert",
  trigger: { "@type": "OffsetTrigger", offset: `-PT${minutes}M`, relativeTo: "start" },
  action,
});

describe("a calendar event's reminders", () => {
  it("falls due at the start less the trigger's offset", () => {
    expect(alertInstants(event({ alerts: { a: offset(10) } }))).toEqual([
      Date.UTC(2026, 0, 1, 9, 50),
    ]);
  });

  it("takes the calendar's default only when the event asks for it", () => {
    const defaults = { defaultAlertsWithTime: { a: offset(30) } };
    expect(alertInstants(event({ useDefaultAlerts: true }), defaults)).toEqual([
      Date.UTC(2026, 0, 1, 9, 30),
    ]);
    // The default is not applied to an event that carries its own.
    expect(alertInstants(event({ alerts: { a: offset(10) } }), defaults)).toEqual([
      Date.UTC(2026, 0, 1, 9, 50),
    ]);
  });

  it("says nothing for an event with no reminder", () => {
    expect(alertInstants(event({}))).toEqual([]);
  });

  it("ignores an email reminder, which is Stalwart's to send", () => {
    expect(alertInstants(event({ alerts: { a: offset(5, "email") } }))).toEqual([]);
  });

  it("measures an end-relative trigger from the event's end", () => {
    const e = event({
      start: "2026-01-01T10:00:00",
      duration: "PT1H",
      alerts: {
        a: {
          "@type": "Alert",
          trigger: {
            "@type": "OffsetTrigger",
            offset: "-PT10M",
            relativeTo: "end",
          },
          action: "display",
        },
      },
    });
    expect(alertInstants(e)).toEqual([Date.UTC(2026, 0, 1, 10, 50)]);
  });

  it("says nothing for a cancelled event", () => {
    expect(
      alertInstants(event({ status: "cancelled", alerts: { a: offset(10) } })),
    ).toEqual([]);
  });

  it("returns only what falls in the window", () => {
    const today = event({ id: "today", alerts: { a: offset(10) } });
    const tomorrow = event({
      id: "tomorrow",
      start: "2026-01-02T10:00:00",
      alerts: { a: offset(10) },
    });
    const due = dueReminders(
      [today, tomorrow],
      {},
      Date.UTC(2026, 0, 1, 9, 0),
      Date.UTC(2026, 0, 1, 12, 0),
    );
    expect(due.map((d) => d.event.id)).toEqual(["today"]);
    expect(due[0]!.key).toBe(`today@${Date.UTC(2026, 0, 1, 9, 50)}`);
  });

  it("says nothing for an event the reader themselves declined", () => {
    const declined = event({
      participants: {
        me: {
          "@type": "Participant",
          calendarAddress: "mailto:me@example.org",
          participationStatus: "declined",
        },
      },
      alerts: { a: offset(10) },
    });
    expect(alertInstants(declined, undefined, "me@example.org")).toEqual([]);
    // A different reader still gets it.
    expect(alertInstants(declined, undefined, "other@example.org")).not.toEqual([]);
  });
});

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:x",
  "DTSTART:20260101T100000Z",
  "DTEND:20260101T110000Z",
  "SUMMARY:Standup",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT10M",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("a subscribed calendar's alarms", () => {
  it("reads a DISPLAY alarm and falls due before its event", () => {
    const { events } = parseIcs(ICS);
    expect(events[0]!.alarms).toEqual([{ offset: -600, relativeTo: "start" }]);
    expect(icsAlertInstants(events[0]!)).toEqual([Date.UTC(2026, 0, 1, 9, 50)]);
  });

  it("ignores an EMAIL alarm, which is the server's to send", () => {
    const { events } = parseIcs(ICS.replace("ACTION:DISPLAY", "ACTION:EMAIL"));
    expect(events[0]!.alarms).toEqual([]);
  });

  it("measures an end-relative alarm from the event's end", () => {
    const { events } = parseIcs(
      ICS.replace("TRIGGER:-PT10M", "TRIGGER;RELATED=END:-PT10M"),
    );
    expect(icsAlertInstants(events[0]!)).toEqual([Date.UTC(2026, 0, 1, 10, 50)]);
  });

  it("returns only what falls in the window", () => {
    const { events } = parseIcs(ICS);
    const due = dueSubscriptionReminders(
      { sub: events },
      Date.UTC(2026, 0, 1, 9, 0),
      Date.UTC(2026, 0, 1, 12, 0),
    );
    expect(due).toHaveLength(1);
    expect(due[0]!.event.uid).toBe("x");
  });
});
