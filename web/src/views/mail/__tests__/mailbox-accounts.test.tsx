import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAP } from "@/jmap/client";
import type { JmapSession, Mailbox, MailboxRole } from "@/jmap/types";
import { setDeviceTrusted } from "@/lib/storage";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";
import { MailboxTree } from "../MailboxTree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no matchMedia; these tests stand at a wide sidebar. */
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
  unread = 0,
  role: MailboxRole = null,
): Mailbox => ({
  id,
  name,
  parentId: null,
  role,
  sortOrder: 0,
  totalEmails: unread,
  unreadEmails: unread,
  totalThreads: unread,
  unreadThreads: unread,
  myRights: rights,
  isSubscribed: true,
});

const OWN = {
  inbox: box("inbox", "Inbox", 2, "inbox"),
  work: box("work", "Work", 1),
};
/**
 * Six unseen in all: five in the inbox, one filed. The view folder holds the
 * same six messages, so counting it would say twelve.
 */
const TEAM = {
  t1: box("t1", "Team Inbox", 5, "inbox"),
  t2: box("t2", "Jobs", 1),
  t3: box("t3", "All mail", 6, "all"),
};
const SALES = { s1: box("s1", "Sales Inbox", 0, "inbox") };

describe("the accounts under the one in front", () => {
  let host: HTMLDivElement;
  let root: Root;

  const accountRow = (name: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(".nav-item.account-row")).find(
      (r) => r.querySelector(".account-title")?.textContent === name,
    );
  const folderRows = () =>
    Array.from(document.querySelectorAll(".nav-item.folder-row .nav-label")).map(
      (e) => e.textContent,
    );
  const click = (el: HTMLElement) => act(() => el.click());

  const mount = () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<MailboxTree />));
  };

  beforeEach(() => {
    setWidth(1280);
    window.history.replaceState({}, "", "/mail/inbox");
    localStorage.clear();
    sessionStorage.clear();
    setDeviceTrusted(false);
    useSession.setState({
      session: {
        accounts: {
          a1: { name: "me@example.org", isPersonal: true },
          g1: { name: "team@example.org", isPersonal: false },
          g2: { name: "sales@example.org", isPersonal: false },
        },
        primaryAccounts: { [CAP.mail]: "a1" },
        capabilities: {},
        state: "s1",
      } as unknown as JmapSession,
    });
    useSettings.setState((s) => ({
      settings: { ...s.settings, showHiddenFolders: false, labelsSidebar: false },
    }));
    useMail.setState({
      accountId: "a1",
      ownAccountId: "a1",
      mailboxes: OWN,
      mailboxesLoaded: true,
      mailAccounts: [
        { accountId: "a1", name: "me@example.org", kind: "own" },
        { accountId: "g1", name: "team@example.org", kind: "group" },
        { accountId: "g2", name: "sales@example.org", kind: "group" },
      ],
      accountTrees: { a1: OWN, g1: TEAM, g2: SALES },
      labelCounts: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("folds every other account, carrying what it holds unseen", () => {
    mount();
    const team = accountRow("team@example.org")!;
    expect(team.getAttribute("aria-expanded")).toBe("false");
    expect(team.className).toContain("unread");
    expect(team.querySelector(".nav-count")?.textContent).toBe("6");
    // Its tree is folded: the folder only that account holds is not drawn.
    expect(folderRows()).not.toContain("Jobs");
  });

  it("draws no count on an account with nothing unseen", () => {
    mount();
    const sales = accountRow("sales@example.org")!;
    expect(sales.querySelector(".nav-count")).toBeNull();
    expect(sales.className).not.toContain("unread");
  });

  it("shows the folders on open, and puts the number back on fold", () => {
    mount();
    click(accountRow("team@example.org")!);
    const open = accountRow("team@example.org")!;
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(open.querySelector(".nav-count")).toBeNull();
    expect(open.className).not.toContain("unread");
    expect(folderRows()).toContain("Jobs");

    click(accountRow("team@example.org")!);
    const folded = accountRow("team@example.org")!;
    expect(folded.querySelector(".nav-count")?.textContent).toBe("6");
    expect(folderRows()).not.toContain("Jobs");
  });

  it("folds them all again when another account is brought to the front", () => {
    mount();
    click(accountRow("team@example.org")!);
    click(accountRow("sales@example.org")!);
    expect(folderRows()).toContain("Jobs");
    expect(accountRow("sales@example.org")!.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      useMail.getState().setAccount("g2");
    });

    // The account brought forward has no row of its own, and neither of the
    // two that were open stays open.
    expect(accountRow("sales@example.org")).toBeUndefined();
    expect(accountRow("team@example.org")!.getAttribute("aria-expanded")).toBe("false");
    expect(accountRow("me@example.org")!.getAttribute("aria-expanded")).toBe("false");
    // Only the account now in front is drawn whole.
    expect(folderRows()).toEqual(["Inbox"]);
  });

  it("folds them even when the account is switched with the sidebar closed", () => {
    mount();
    click(accountRow("team@example.org")!);
    act(() => root.unmount());
    host.remove();

    // Settings › Folders opens an account with no sidebar to notice the
    // change, and the record still has to be the folded one.
    act(() => {
      useMail.getState().setAccount("g2");
    });

    mount();
    expect(accountRow("team@example.org")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the record for the tab when the sidebar reloads", () => {
    mount();
    click(accountRow("team@example.org")!);
    act(() => root.unmount());
    host.remove();

    // Same session, a reload: session storage is what carries it.
    mount();
    expect(accountRow("team@example.org")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("remembers it in a new session on the reader's own device", () => {
    setDeviceTrusted(true);
    mount();
    click(accountRow("team@example.org")!);
    act(() => root.unmount());
    host.remove();

    sessionStorage.clear();
    mount();
    expect(accountRow("team@example.org")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("forgets it in a new session on a device that is not the reader's", () => {
    setDeviceTrusted(false);
    mount();
    click(accountRow("team@example.org")!);
    act(() => root.unmount());
    host.remove();

    sessionStorage.clear();
    mount();
    expect(accountRow("team@example.org")!.getAttribute("aria-expanded")).toBe("false");
  });
});
