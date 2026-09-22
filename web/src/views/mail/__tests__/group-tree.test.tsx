import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAP } from "@/jmap/client";
import type { JmapSession, Mailbox, MailboxRole } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";
import { MailboxTree } from "../MailboxTree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* jsdom has no matchMedia, and the sidebar asks it for the layout it is drawing. */
function setWidth(px: number) {
  window.matchMedia = ((q: string) => ({
    matches: /max-width:\s*(\d+)px/.test(q) ? px <= Number(RegExp.$1) : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

/**
 * A tree that is not the reader's own is drawn whole, and the answer to "whose
 * tree is this" must not wait on the account probe.
 *
 * Stalwart hands a freshly added member every folder of the group
 * unsubscribed, so a tree filtered by subscription would be Inbox and nothing
 * else for every member of every group. The rule that shows it whole used to
 * ask the mail store's group classifier, which answers "group" only once the
 * probe has listed the account -- so for the window a boot sits in, and for any
 * probe that failed, the member's tree was drawn down to Inbox while the
 * administrator's looked fine (their folders are subscribed). Whose tree it is,
 * is a question about the session, and that is where it is now asked.
 */

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
  isSubscribed: boolean,
  role: MailboxRole = null,
): Mailbox => ({
  id,
  name,
  parentId,
  role,
  sortOrder: 0,
  totalEmails: 0,
  unreadEmails: 0,
  totalThreads: 0,
  unreadThreads: 0,
  isSubscribed,
  myRights: rights,
});

/*
 * The group's tree as the mail server hands it over: Inbox > MS2 > two cases,
 * and the archived pair under Archive, every folder unsubscribed because this
 * member was added to the group and a subscription is per-principal state.
 */
const GROUP_TREE = {
  a: box("a", "Inbox", null, false, "inbox"),
  l: box("l", "MS2", "a", false),
  t: box("t", "277044606", "l", false),
  u: box("u", "277045275", "l", false),
  k: box("k", "Archive", null, false, "archive"),
  w: box("w", "MS2", "k", false),
  v: box("v", "276428896", "w", false),
  q: box("q", "276429124", "w", false),
};

/* The order the sidebar draws them in: roles first, then by name. */
const GROUP_ROWS = [
  "Inbox",
  "MS2",
  "277044606",
  "277045275",
  "Archive",
  "MS2",
  "276428896",
  "276429124",
];

const SESSION = {
  accounts: {
    own: { name: "me@example.org", isPersonal: true },
    gg: { name: "team@example.org", isPersonal: false },
  },
  primaryAccounts: { [CAP.mail]: "own" },
  capabilities: {},
  state: "s1",
} as unknown as JmapSession;

describe("a mailbox tree that is not the reader's own", () => {
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

  beforeEach(() => {
    setWidth(1280);
    window.history.replaceState({}, "", "/mail/a");
    useSession.setState({ session: SESSION });
    useMail.setState({
      accountId: "gg",
      mailboxes: GROUP_TREE,
      mailboxesLoaded: true,
      /*
       * Deliberately empty: the probe has not answered yet, and the tree must
       * not be drawn from what it has not said.
       */
      mailAccounts: [],
    });
    useSettings.setState((s) => ({
      settings: { ...s.settings, showHiddenFolders: false, labelsSidebar: false },
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<MailboxTree />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useMail.setState({ accountId: null, mailboxes: {}, mailboxesLoaded: false });
  });

  it("shows every folder it holds, though none of them is subscribed", () => {
    expect(rows()).toEqual(GROUP_ROWS);
  });

  it("opens them by itself, so a member added a moment ago sees where the mail lives", () => {
    // Nothing was clicked: this is what the tree does when it is drawn, and it
    // is why a group's shape is not hidden behind a twisty the reader has to
    // know about.
    expect(rowFor("MS2")).not.toBeNull();
    expect(rowFor("277045275")).not.toBeNull();
  });

  it("keeps a folder the reader closes closed", () => {
    // The counterpart of the default: absence means "the tree's own default",
    // so a folder closed here is recorded as closed rather than forgotten.
    const inbox = rowFor("Inbox")!;
    expect(inbox.querySelector(".nav-twisty")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    act(() => {
      inbox.querySelector<HTMLElement>(".nav-twisty")!.click();
    });
    expect(rows()).toEqual(["Inbox", "Archive", "MS2", "276428896", "276429124"]);
  });

  it("keeps the same folders out of the reader's own tree, where a subscription is a choice", () => {
    act(() => {
      useMail.setState({ accountId: "own", mailboxes: GROUP_TREE });
    });
    // MS2 is unsubscribed, so it is not drawn -- and with it, nothing beneath it.
    expect(rows()).toEqual(["Inbox"]);
  });
});
