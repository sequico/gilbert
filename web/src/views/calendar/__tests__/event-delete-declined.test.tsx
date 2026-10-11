import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import { type EventInstance, useCalendar } from "@/store/calendar";
import { useSettings } from "@/store/settings";
import { useToasts } from "@/ui/toast";
import { EventPopover } from "../EventPopover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A deletion the reader declined (finding 3).
 *
 * When the server will only change a whole series, `runScoped` offers that
 * instead and answers `null` if the offer is refused. That is a cancel, not a
 * deletion: nothing may be reported and the popover stays open.
 */

vi.mock("../scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scope")>()),
  // The declined "apply to the whole series" answer.
  askDeleteScope: vi.fn(async () => "series"),
  runScoped: vi.fn(async () => null),
}));

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

const calendar = {
  id: "c1",
  name: "Personal",
  color: "#0f766e",
  myRights: rights,
} as unknown as Calendar;

const occurrence = {
  id: "occ1",
  baseEventId: "master",
  uid: "u1",
  calendarIds: { c1: true },
  title: "Standup",
  start: "2026-09-14T09:00:00",
  duration: "PT30M",
  recurrenceId: "2026-09-14T09:00:00",
} as unknown as CalendarEvent;

describe("a deleted occurrence whose series offer is declined", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useToasts.setState({ toasts: [] });
    useSettings.setState((s) => ({ settings: { ...s.settings, eventCategories: [] } }));
    useCalendar.setState({ calendars: { c1: calendar }, identities: [], events: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useToasts.setState({ toasts: [] });
  });

  it("does not report a deletion, and leaves the popover open", async () => {
    const onClose = vi.fn();
    const inst: EventInstance = {
      key: "occ1",
      accountId: "own",
      event: occurrence,
      start: new Date("2026-09-14T09:00:00"),
      end: new Date("2026-09-14T09:30:00"),
      allDay: false,
      calendar,
    };

    await act(async () => {
      root.render(
        <EventPopover
          inst={inst}
          anchor={{ x: 10, y: 10 }}
          onClose={onClose}
          onEdit={() => {}}
        />,
      );
    });

    const del = [...document.querySelectorAll("button")].find(
      (b) => b.title === "Delete",
    );
    expect(del, "the popover offers Delete").toBeTruthy();
    await act(async () => {
      del!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    const messages = useToasts.getState().toasts.map((t) => t.message);
    expect(messages).not.toContain("Event deleted");
    expect(messages).not.toContain("Occurrence deleted");
  });
});
