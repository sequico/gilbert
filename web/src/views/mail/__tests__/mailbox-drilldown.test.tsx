import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Mailbox, MailboxRole } from "@/jmap/types";
import { useGroupLabels } from "@/store/groupLabels";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import { MailboxTree } from "../MailboxTree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom has no matchMedia, and the whole question here is which side of the
 * 768px breakpoint we are on — so it is stubbed rather than skipped, and each
 * test says which width it is standing at.
 */
function setWidth(px: number) {
  window.matchMedia = ((q: string) => ({
    matches: /max-width:\s*(\d+)px/.test(q) ? px <= Number(RegExp.$1) : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

const rights = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
};
const box = (
  id: string,
  name: string,
  parentId: string | null,
  unread = 0,
  role: MailboxRole = null,
): Mailbox => ({
  id,
  name,
  parentId,
  role,
  sortOrder: 0,
  totalEmails: unread,
  unreadEmails: unread,
  totalThreads: unread,
  unreadThreads: unread,
  myRights: rights,
  isSubscribed: true,
});

/*
 * Inbox, then Work > Clients > Acme. Three levels is the shape the flat tree
 * handled badly in a 300px drawer, and the one the drill has to walk.
 */
const MAILBOXES = {
  inbox: box("inbox", "Inbox", null, 2, "inbox"),
  work: box("work", "Work", null, 1),
  clients: box("clients", "Clients", "work", 3),
  acme: box("acme", "Acme Corp", "clients", 4),
  sent: box("sent", "Sent", null, 0, "sent"),
};

describe("folder drill-down", () => {
  let host: HTMLDivElement;
  let root: Root;
  const rows = () =>
    Array.from(document.querySelectorAll(".nav-item.folder-row")).map(
      (r) => r.querySelector(".nav-label")?.textContent,
    );
  const rowFor = (name: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(".nav-item.folder-row")).find(
      (r) => r.querySelector(".nav-label")?.textContent === name,
    );
  const drillInto = (name: string) =>
    act(() => {
      rowFor(name)!.querySelector<HTMLElement>(".drill-into")!.click();
    });
  const back = () =>
    act(() => {
      document.querySelector<HTMLElement>(".drill-back")!.click();
    });

  const mount = () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<MailboxTree />));
  };

  beforeEach(() => {
    window.history.replaceState({}, "", "/mail/inbox");
    useMail.setState({ mailboxes: MAILBOXES, mailboxesLoaded: true });
    useSettings.setState((s) => ({
      settings: { ...s.settings, showHiddenFolders: false, labelsSidebar: false },
    }));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the whole tree on a wide screen, and no drill controls", () => {
    setWidth(1280);
    mount();
    expect(rows()).toEqual(["Inbox", "Sent", "Work"]);
    expect(document.querySelector(".drill-into")).toBeNull();
    expect(document.querySelector(".drill-back")).toBeNull();
    // The twisty is what expands a folder in place, and it is still there.
    expect(rowFor("Work")!.querySelector('.nav-twisty[role="button"]')).not.toBeNull();
  });

  it("shows one level at a time on a phone, deepest folders included", () => {
    setWidth(390);
    mount();
    expect(rows()).toEqual(["Inbox", "Sent", "Work"]);
    // Only a folder with children offers the drill, and it replaces the twisty.
    expect(rowFor("Work")!.querySelector(".drill-into")).not.toBeNull();
    expect(rowFor("Work")!.querySelector('.nav-twisty[role="button"]')).toBeNull();
    expect(rowFor("Inbox")!.querySelector(".drill-into")).toBeNull();

    drillInto("Work");
    // The folder drilled into is listed with its children, because it is still
    // a folder you can open — going back out to reach it would be absurd.
    expect(rows()).toEqual(["Work", "Clients"]);
    expect(document.querySelector(".drill-back")!.textContent).toContain("Folders");

    drillInto("Clients");
    expect(rows()).toEqual(["Clients", "Acme Corp"]);
    expect(document.querySelector(".drill-back")!.textContent).toContain("Work");
  });

  /*
   * jsdom has no layout to measure, so this asserts the mechanism the
   * alignment hangs off instead: the indent is dropped for the whole list, by
   * a class on the nav. The first cut put it on the rows offering a drill,
   * which meant only folders with children lost the twisty's 30px gutter and
   * they hung 18px left of every folder without any.
   */
  it("hangs every folder off the same edge, children or not", () => {
    setWidth(390);
    mount();
    expect(document.querySelector("nav")!.className).toContain("folder-drill");
    const depths = Array.from(document.querySelectorAll(".nav-item.folder-row")).map(
      (r) => r.className.match(/depth-\d/)?.[0],
    );
    expect(depths).toEqual(["depth-0", "depth-0", "depth-0"]);

    drillInto("Work");
    // Work has a child and Clients does not; neither may be indented for it.
    expect(
      Array.from(document.querySelectorAll(".nav-item.folder-row")).map(
        (r) => r.className.match(/depth-\d/)?.[0],
      ),
    ).toEqual(["depth-0", "depth-0"]);
    expect(document.querySelector(".nav-item.folder-row.has-drill")).toBeNull();
  });

  it("keeps the indent on a wide screen, where the tree still needs it", () => {
    setWidth(1280);
    mount();
    expect(document.querySelector("nav")!.className).not.toContain("folder-drill");
    act(() => {
      rowFor("Work")!.querySelector<HTMLElement>(".nav-twisty")!.click();
    });
    expect(rowFor("Clients")!.className).toContain("depth-1");
  });

  it("walks back out one level per tap", () => {
    setWidth(390);
    mount();
    drillInto("Work");
    drillInto("Clients");
    back();
    expect(rows()).toEqual(["Work", "Clients"]);
    back();
    expect(rows()).toEqual(["Inbox", "Sent", "Work"]);
    expect(document.querySelector(".drill-back")).toBeNull();
  });

  it("counts the unread hiding below a folder you have not drilled into", () => {
    setWidth(390);
    mount();
    // Work: 1 of its own, plus Clients' 3 and Acme's 4 out of sight.
    expect(rowFor("Work")!.querySelector(".nav-count")!.textContent).toBe("8");
    drillInto("Work");
    // Drilled in, Work speaks only for itself and Clients carries its own subtree.
    expect(rowFor("Work")!.querySelector(".nav-count")!.textContent).toBe("1");
    expect(rowFor("Clients")!.querySelector(".nav-count")!.textContent).toBe("7");
  });

  it("opens at the level of the folder being read, not back at the root", () => {
    setWidth(390);
    window.history.replaceState({}, "", "/mail/acme");
    mount();
    // Reading Acme Corp, the drawer comes back inside Clients where it lives.
    expect(rows()).toEqual(["Clients", "Acme Corp"]);
    expect(rowFor("Acme Corp")!.className).toContain("active");
  });
});

/**
 * Whose labels the sidebar lists, and where they sit.
 *
 * A group mailbox has a catalog of its own (ADR 0005), so the section belongs
 * to whichever account is in the foreground — the reader's personal labels on
 * the reader's own mailbox, the group's own on a group's. And it sits under
 * that account's folder tree and before the other accounts' sections, because
 * it is part of what that account shows rather than a section of the sidebar in
 * general.
 */
describe("the labels section", () => {
  let host: HTMLDivElement;
  let root: Root;

  /** The nav's own rows in document order: section headers and labelled rows. */
  const outline = () =>
    Array.from(document.querySelectorAll(".nav-section, .nav-item")).map((el) =>
      (el.querySelector(".nav-label") ?? el.querySelector("span"))?.textContent?.trim(),
    );

  const mount = () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<MailboxTree />));
  };

  beforeEach(() => {
    setWidth(1280);
    window.history.replaceState({}, "", "/mail/inbox");
    useSettings.setState((s) => ({
      settings: {
        ...s.settings,
        showHiddenFolders: false,
        labelsSidebar: true,
        labels: [{ keyword: "mine", name: "Mine", color: "#222" }] as never,
      },
    }));
    useMail.setState({
      accountId: "a1",
      ownAccountId: "a1",
      mailboxes: MAILBOXES,
      mailboxesLoaded: true,
      mailAccounts: [
        { accountId: "a1", name: "me@example.org", kind: "own" },
        { accountId: "g1", name: "team@example.org", kind: "group" },
      ],
      accountTrees: {
        a1: MAILBOXES,
        g1: { ginbox: box("ginbox", "Team Inbox", null, 0) },
      },
      labelCounts: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useGroupLabels.setState({ byAccount: {} });
  });

  it("lists the reader's own labels, under their tree and before the group's", () => {
    mount();
    expect(outline()).toEqual([
      "Folders",
      "Inbox",
      "Sent",
      "Work",
      "Labels",
      "Starred",
      "Mine",
      // The other account's section, after the labels and not among them.
      "team@example.org",
      "Team Inbox",
    ]);
  });

  it("lists the group's own catalog when the group is in the foreground", () => {
    useGroupLabels.setState({
      byAccount: {
        g1: [{ keyword: "freight", name: "Freight", color: "#111" }] as never,
      },
    });
    useMail.setState({
      accountId: "g1",
      mailboxes: { ginbox: box("ginbox", "Team Inbox", null, 0) },
      accountTrees: {
        a1: MAILBOXES,
        g1: { ginbox: box("ginbox", "Team Inbox", null, 0) },
      },
    });
    mount();
    const seen = outline();
    // The group's label, and Starred, both above the reader's own mailbox.
    expect(seen).toContain("Freight");
    expect(seen).toContain("Starred");
    // The reader's personal label is not what a group mailbox files under.
    expect(seen).not.toContain("Mine");
    expect(seen.indexOf("Freight")).toBeLessThan(seen.indexOf("me@example.org"));
  });

  it("shows Starred even when there is no label at all", () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, labels: [] } }));
    mount();
    expect(outline()).toContain("Starred");
  });

  it("draws Starred as the star it is named after: filled, not an outline", () => {
    // The one row that is not a label draws no swatch, and the icon standing in
    // for it is the star itself -- filled, in the star's colour -- rather than
    // the bare outline a stray `<Star />` renders.
    mount();
    const row = document.querySelector('a[href="/search?q=is:starred"]');
    const svg = row?.querySelector(".nav-label-icon svg");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.closest(".nav-label-icon")?.getAttribute("style")).toContain("--star");
  });

  it("offers no Manage link on a group's own catalog", () => {
    useMail.setState({
      accountId: "g1",
      mailboxes: { ginbox: box("ginbox", "Team Inbox", null, 0) },
      accountTrees: { g1: { ginbox: box("ginbox", "Team Inbox", null, 0) } },
    });
    mount();
    // Settings › Labels edits the reader's personal labels, which is not this
    // list: a pencil here would open the wrong surface.
    expect(document.querySelector('a[href="/settings/labels"]')).toBeNull();
  });
});
