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

/* Inbox > MS2 > two cases: a group's folders as the mail server hands them over. */
const GROUP_TREE = {
  a: box("a", "Inbox", null, false, "inbox"),
  l: box("l", "MS2", "a", false),
  t: box("t", "277044606", "l", false),
  u: box("u", "277045275", "l", false),
};

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
  const expand = (name: string) =>
    act(() => {
      rowFor(name)!.querySelector<HTMLElement>(".nav-twisty")!.click();
    });

  beforeEach(() => {
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
    expand("Inbox");
    expand("MS2");
    expect(rows()).toEqual(["Inbox", "MS2", "277044606", "277045275"]);
  });

  it("keeps the same folders out of the reader's own tree, where a subscription is a choice", () => {
    act(() => {
      useMail.setState({ accountId: "own", mailboxes: GROUP_TREE });
    });
    expand("Inbox");
    // MS2 is unsubscribed, so it is not drawn -- and with it, nothing beneath it.
    expect(rows()).toEqual(["Inbox"]);
  });
});
