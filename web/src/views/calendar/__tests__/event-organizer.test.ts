/**
 * Who may edit an event, and whether the reader is its organiser.
 *
 * The two questions are one rule — a write-own right reaches an event only when
 * the reader organised it — and the rule decides a write, so it is pinned here
 * across the inputs that matter: no participants at all, an owner beside the
 * reader, an owner who is somebody else, and an event copied out of another
 * calendar.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { CalendarEvent, ParticipantIdentity } from "@/jmap/types";
import { type EventInstance, useCalendar } from "@/store/calendar";
import { useSession } from "@/store/session";
import { canEditInstance, isEventOrganizer } from "../CalendarContextMenu";

const ME = "mailto:me@example.org";
const OTHER = "mailto:other@example.org";

/**
 * A participant as the server hands one over: the address is carried on the
 * entry, and `myParticipantKeys` matches it there — the map's key is the
 * server's own id for that participant and means nothing outside the event.
 */
const participant = (address: string, roles: Record<string, boolean>) => ({
  calendarAddress: address,
  roles,
});

const event = (
  participants: unknown,
  over: Record<string, unknown> = {},
): CalendarEvent =>
  ({
    "@type": "Event",
    id: "e1",
    uid: "u1",
    participants,
    ...over,
  }) as unknown as CalendarEvent;

const mine = event({ [ME]: participant(ME, { owner: true }) });
const theirEvent = event({ [OTHER]: participant(OTHER, { owner: true }) });

const inst = (
  ev: CalendarEvent,
  myRights?: { mayWriteAll: boolean; mayWriteOwn: boolean },
): EventInstance =>
  ({
    key: "k",
    accountId: "a1",
    event: ev,
    start: new Date(0),
    end: new Date(0),
    allDay: false,
    calendar: myRights ? { myRights } : undefined,
  }) as unknown as EventInstance;

beforeEach(() => {
  useCalendar.setState({
    identities: [{ calendarAddress: ME } as unknown as ParticipantIdentity],
  });
  useSession.setState({ session: { username: "me@example.org" } as never });
});

describe("isEventOrganizer", () => {
  it("reads the owner role, and calls an event naming nobody the reader's own", () => {
    expect(isEventOrganizer(mine, [ME])).toBe(true);
    expect(isEventOrganizer(event(undefined), [ME])).toBe(true);
    expect(isEventOrganizer(event({}), [ME])).toBe(true);
  });

  it("is false when the owner is somebody else, or when the reader holds no key", () => {
    expect(isEventOrganizer(theirEvent, [ME])).toBe(false);
    expect(
      isEventOrganizer(event({ [ME]: participant(ME, { attendee: true }) }), [ME]),
    ).toBe(false);
    expect(isEventOrganizer(mine, [])).toBe(false);
  });

  it("is false on an event copied out of another calendar", () => {
    expect(
      isEventOrganizer(
        event({ [ME]: participant(ME, { owner: true }) }, { isOrigin: false }),
        [ME],
      ),
    ).toBe(false);
  });
});

describe("canEditInstance", () => {
  it("lets write-all through, whatever the organiser", () => {
    expect(canEditInstance(inst(mine, { mayWriteAll: true, mayWriteOwn: false }))).toBe(
      true,
    );
    expect(
      canEditInstance(inst(theirEvent, { mayWriteAll: true, mayWriteOwn: false })),
    ).toBe(true);
  });

  it("lets write-own reach only what the reader organised", () => {
    expect(canEditInstance(inst(mine, { mayWriteAll: false, mayWriteOwn: true }))).toBe(
      true,
    );
    expect(
      canEditInstance(inst(theirEvent, { mayWriteAll: false, mayWriteOwn: true })),
    ).toBe(false);
  });

  it("lets an event with no calendar to ask through", () => {
    expect(canEditInstance(inst(theirEvent))).toBe(true);
  });
});
