import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import type { Calendar } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import { choiceDialog } from "@/ui/dialog";
import { CalendarSidebar } from "../CalendarSidebar";

vi.mock("@/ui/dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ui/dialog")>()),
  choiceDialog: vi.fn(async () => "finance"),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Every group's calendars in one run, not a heading each.
 *
 * The section used to announce one group at a time, so a reader belonging to
 * several groups scrolled past a label per group to reach the calendar they
 * wanted. They are now one **Group calendars** list, each row naming its group
 * on hover, and the section's single **+** still creates a calendar the group
 * owns. This pins both: one heading, every calendar present, and the create
 * still routed to the group the reader picks.
 */

const cal = (id: string, name: string, sortOrder = 0) =>
  ({
    id,
    name,
    color: "#0f766e",
    sortOrder,
    isSubscribed: true,
    isVisible: true,
    isDefault: false,
    shareWith: {},
    myRights: {
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: true,
      mayWriteOwn: true,
      mayUpdatePrivate: true,
      mayRSVP: true,
      mayShare: true,
      mayDelete: true,
    },
  }) as unknown as Calendar;

/** What React's `onChange` sees when a character is typed. */
const type = (el: HTMLInputElement, value: string) => {
  act(() => {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
      .set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("the calendar sidebar's group section", () => {
  let host: HTMLDivElement;
  let root: Root;

  const sectionTitles = () =>
    [...host.querySelectorAll(".nav-section > span")].map((s) => s.textContent ?? "");
  const rowNames = () =>
    [...host.querySelectorAll(".cal-list-item")].map((r) => r.textContent ?? "");
  const rowFor = (name: string) =>
    [...host.querySelectorAll(".cal-list-item")].find((r) =>
      (r.textContent ?? "").includes(name),
    );

  beforeEach(async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    window.history.replaceState({}, "", "/calendar/week/2026-09-30");
    useMail.setState({
      mailAccounts: [
        { accountId: "me", name: "me@example.org", kind: "own" },
        { accountId: "freight", name: "freight@example.org", kind: "group" },
        { accountId: "finance", name: "finance@example.org", kind: "group" },
      ],
    });
    useSettings.setState((s) => ({
      settings: { ...s.settings, birthdayCalendar: false, icalSubscriptions: [] },
    }));
    useCalendar.setState({
      accountId: "me",
      available: true,
      calendars: {},
      sharedCalendars: [
        {
          accountId: "freight",
          accountName: "freight@example.org",
          calendar: cal("fc", "Freight calendar"),
        },
        {
          accountId: "finance",
          accountName: "finance@example.org",
          calendar: cal("fnc", "Finance calendar", 1),
        },
        {
          accountId: "colleague",
          accountName: "colleague@example.org",
          calendar: cal("cc", "Colleague calendar", 2),
        },
      ],
      hidden: {},
      sharedEvents: {},
      sharedRanges: {},
      events: {},
      ranges: {},
      identities: [],
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <Router>
          <CalendarSidebar />
        </Router>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("lists every group's calendars in one run, without a heading per group", () => {
    const titles = sectionTitles();
    expect(titles.filter((s) => s === "Group calendars")).toHaveLength(1);
    expect(titles).not.toContain("freight@example.org");
    expect(titles).not.toContain("finance@example.org");
    const rows = rowNames();
    expect(rows.some((r) => r.includes("Freight calendar"))).toBe(true);
    expect(rows.some((r) => r.includes("Finance calendar"))).toBe(true);
  });

  it("offers no remove on a group's calendar, and a remove on a share", () => {
    // A group's calendar is hidden and shown, never unsubscribed -- for a
    // member and an administrator alike: membership is the subscription, and a
    // calendar removed this way had no way back.
    for (const name of ["Freight calendar", "Finance calendar"])
      expect(rowFor(name)?.querySelector('[title="Remove from my calendar"]')).toBeNull();
    // Somebody else's calendar still offers the remove that "Available to add"
    // completes.
    expect(
      rowFor("Colleague calendar")?.querySelector('[title="Remove from my calendar"]'),
    ).toBeTruthy();
  });

  it("creates a group calendar in the group chosen on the section's +", async () => {
    const createCalendar = vi
      .spyOn(useCalendar.getState(), "createCalendar")
      .mockResolvedValue(undefined as never);
    const header = [...host.querySelectorAll(".nav-section")].find((s) =>
      (s.textContent ?? "").includes("Group calendars"),
    );
    const plus = header?.querySelector("button");
    expect(plus).toBeTruthy();
    await act(async () => {
      plus!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(vi.mocked(choiceDialog)).toHaveBeenCalled();
    const name = document.querySelector<HTMLInputElement>(".dialog input.input");
    expect(name).toBeTruthy();
    type(name!, "Group plan");
    const save = [...document.querySelectorAll<HTMLButtonElement>(".dialog button")].find(
      (b) => b.textContent === "Save",
    );
    expect(save).toBeTruthy();
    await act(async () => {
      save!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(createCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Group plan" }),
      "finance",
    );
  });
});
