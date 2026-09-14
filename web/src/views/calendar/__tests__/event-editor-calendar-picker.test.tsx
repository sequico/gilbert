import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Calendar } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { EventEditor } from "../EventEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Where a new event goes, and whether the writer can say so.
 *
 * A group's calendar lives in the group's own account and is reached through
 * the reader's session on it, so the editor has to offer it beside the
 * reader's own -- and having added a shared calendar to the view is a question
 * about drawing it, not about writing into it. This pins the list the field
 * offers; where the field sits in the dialog is a drawing question the
 * calendar's own surfaces answer.
 */

const rights = {
  mayReadFreeBusy: true,
  mayReadItems: true,
  mayWriteAll: true,
  mayWriteOwn: true,
  mayUpdatePrivate: true,
  mayRSVP: true,
  mayShare: true,
  mayDelete: true,
};

const calendar = (over: Partial<Calendar>) =>
  ({
    id: "c1",
    name: "Personal",
    color: "#0f766e",
    description: null,
    sortOrder: 0,
    isSubscribed: true,
    isVisible: true,
    isDefault: true,
    includeInAvailability: "all",
    timeZone: "UTC",
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    shareWith: {},
    myRights: rights,
    ...over,
  }) as unknown as Calendar;

describe("the calendar a new event is created in", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => {
      root.render(
        <EventEditor
          init={{
            start: new Date("2026-09-14T10:00:00Z"),
            end: new Date("2026-09-14T11:00:00Z"),
            allDay: false,
          }}
          onClose={() => undefined}
        />,
      );
    });
  };

  /** The Calendar field's `<select>`: the one offering account-qualified names. */
  const calendarSelect = () =>
    [...document.querySelectorAll<HTMLSelectElement>("select")].find((s) =>
      [...s.options].some((o) => o.textContent?.includes(" · ")),
    );

  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    useCalendar.setState({
      accountId: "own",
      calendars: { c1: calendar({}) },
      sharedCalendars: [
        {
          accountId: "grp",
          accountName: "freight@example.org",
          calendar: calendar({ id: "gc1", name: "Team calendar", isDefault: false }),
        },
      ],
      sharedEvents: {},
      sharedRanges: {},
      events: {},
      ranges: {},
      hidden: {},
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("offers the group's calendar beside the reader's own", async () => {
    await render();
    const sel = calendarSelect();
    expect(sel).toBeTruthy();
    expect([...sel!.options].map((o) => o.textContent)).toEqual([
      "Personal",
      "Team calendar · freight@example.org",
    ]);
  });

  it("starts on the reader's own default, so a new event goes there unless asked", async () => {
    await render();
    const sel = calendarSelect();
    expect(sel!.options[sel!.selectedIndex]!.textContent).toBe("Personal");
  });
});
