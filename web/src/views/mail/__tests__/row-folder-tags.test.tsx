import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Email, Mailbox, MailboxRole } from "@/jmap/types";
import { useMail } from "@/store/mail";

import { Row } from "../MessageList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Where a row says its message lives.
 *
 * The folder tags belong to the row in every layout. The two-line one drew them
 * inside the label block, so a conversation carrying no label showed no folder
 * at all — the same mail said where it was stored or did not, depending on
 * whether somebody had put a label on it and on how wide the pane was.
 *
 * What they name is the row's own messages, the ones in the folder on screen
 * (`rowScope`): a reply filed in Sent is not part of where an Inbox row says it
 * lives, or every conversation with an answer would carry a Sent tag.
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

const box = (id: string, name: string, role: MailboxRole = null): Mailbox => ({
  id,
  name,
  parentId: null,
  role,
  sortOrder: 0,
  totalEmails: 0,
  unreadEmails: 0,
  totalThreads: 0,
  unreadThreads: 0,
  isSubscribed: true,
  myRights: rights,
});

const MAILBOXES = {
  inbox: box("inbox", "Inbox", "inbox"),
  sent: box("sent", "Sent", "sent"),
  archive: box("archive", "Archive", "archive"),
};

const message = (id: string, mailboxIds: Record<string, boolean>): Email =>
  ({
    id,
    threadId: "t1",
    subject: "Hi",
    preview: "",
    receivedAt: 1,
    keywords: {},
    mailboxIds,
    from: [{ name: "A", email: "a@x" }],
    to: [],
    hasAttachment: false,
  }) as unknown as Email;

describe("the folders a row names", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useMail.setState({ mailboxes: MAILBOXES, emails: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (props: Record<string, unknown>) => {
    const AnyRow = Row as unknown as ComponentType<Record<string, unknown>>;
    act(() => {
      root.render(
        <AnyRow
          top={0}
          height={56}
          selected={false}
          focused={false}
          open={false}
          twoLine
          showAvatar={false}
          showPreview={false}
          isDrafts={false}
          isSent={false}
          mailboxId="inbox"
          onClick={() => {}}
          onContext={() => {}}
          onSelect={() => {}}
          onStar={() => {}}
          onArchive={() => {}}
          onTrash={() => {}}
          onRead={() => {}}
          touch={false}
          role="inbox"
          finalFolders={{ trash: null, junk: null }}
          mayEnd
          swipeLeft="none"
          swipeRight="none"
          onLongPress={() => {}}
          onSwipeState={() => {}}
          onSwipeFire={async () => {}}
          {...props}
        />,
      );
    });
  };

  it("names the other folders of a two-line row that carries no label", () => {
    render({ email: message("m1", { inbox: true, archive: true }) });
    expect(host.textContent).toContain("Archive");
  });

  it("does not name a folder holding only another message of the thread", () => {
    render({
      email: message("m1", { inbox: true }),
      threadEmails: [message("m1", { inbox: true }), message("m2", { sent: true })],
    });
    expect(host.textContent).not.toContain("Sent");
  });
});
