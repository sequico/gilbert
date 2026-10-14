import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mailbox, MailboxRole } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import { MailboxTree } from "../MailboxTree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A folder row is told what it draws and nothing else, so a mail-store change
 * that leaves the tree alone stops at the tree.
 *
 * The sidebar subscribes to things that move without the folder tree moving at
 * all -- keyword counts most of all -- and every one of those re-renders the
 * tree. A row that is not memoised is walked again for each of them, one render
 * per folder in the sidebar on every store snapshot.
 *
 * The rows are counted through `useTouchRow`, which a row's body calls once per
 * render and which nothing else in this tree calls. It is how many times they
 * actually rendered, which the DOM cannot show: React reuses the same elements
 * whether the row was re-rendered or skipped.
 */
const renders = vi.hoisted(() => ({ rows: 0 }));
vi.mock("@/lib/touch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/touch")>()),
  /* Counted, and nothing else: the row only spreads the gestures onto its
     element, and no gesture is driven here. */
  useTouchRow: () => {
    renders.rows += 1;
    return {} as never;
  },
}));

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

const MAILBOXES = {
  inbox: box("inbox", "Inbox", null, 2, "inbox"),
  work: box("work", "Work", null, 1),
  clients: box("clients", "Clients", "work", 3),
  sent: box("sent", "Sent", null, 0, "sent"),
};

describe("the folder tree's rows", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    renders.rows = 0;
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    window.history.replaceState({}, "", "/mail/inbox");
    useSettings.setState((s) => ({
      settings: { ...s.settings, showHiddenFolders: false, labelsSidebar: false },
    }));
    useMail.setState({
      accountId: "a1",
      ownAccountId: "a1",
      mailboxes: MAILBOXES,
      mailboxesLoaded: true,
      mailAccounts: [{ accountId: "a1", name: "me@example.org", kind: "own" }],
      accountTrees: {},
      labelCounts: {},
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("redraws no row for a store change that does not touch the tree", () => {
    act(() => root.render(<MailboxTree />));
    const mounted = renders.rows;
    // The probe counts exactly the rows on screen, one render each.
    expect(mounted).toBe(host.querySelectorAll(".nav-item.folder-row").length);
    expect(mounted).toBeGreaterThan(0);

    act(() => {
      // A change the sidebar does subscribe to, and which the folder tree does
      // not depend on: the star count moving.
      useMail.setState({ labelCounts: { $flagged: { total: 1, unread: 1 } } });
    });

    expect(renders.rows).toBe(mounted);
  });
});
