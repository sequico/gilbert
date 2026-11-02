import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Id } from "@/jmap/types";
import { EVENTS } from "@/lib/events";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import type { ListActions } from "../MessageList";
import { ThreadView } from "../ThreadView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollIntoView = () => {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.matchMedia = ((q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof window.matchMedia;

/**
 * Answering a message that is not the last of the conversation.
 *
 * Reply, reply all and forward belong to the message they answer: they are the
 * first items of every message's own ⋮ menu, so an earlier message can be
 * written back to. The strip under the conversation — which could only ever
 * answer its last message — is gone, and nothing replaced it with a second
 * spelling of the same commands.
 */

const msg = (id: Id, receivedAt: string): Email =>
  ({
    id,
    threadId: "t1",
    subject: "Hello",
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    from: [{ name: "Ann", email: "ann@example.com" }],
    to: [{ name: "Me", email: "me@example.org" }],
    receivedAt,
    size: 10,
    blobId: "b1",
    preview: "hi",
    htmlBody: [],
    textBody: [{ partId: "1", type: "text/plain" }],
    bodyValues: { "1": { value: "hi", isEncodingProblem: false, isTruncated: false } },
    attachments: [],
  }) as unknown as Email;

describe("replying from a message that is not the last", () => {
  let host: HTMLDivElement;
  let root: Root;
  let reply: ReturnType<typeof vi.fn>;

  const show = async () => {
    await act(async () => {
      root.render(
        <ThreadView
          threadId="t1"
          mailboxId="inbox"
          messageId={null}
          actions={{} as unknown as ListActions}
          onBack={() => undefined}
          onNavigate={() => undefined}
          hasPrev={false}
          hasNext={false}
        />,
      );
    });
  };

  beforeEach(async () => {
    reply = vi.fn(async () => undefined);
    useCompose.setState({ reply } as never);
    useMail.setState({
      accountId: "a1",
      loadingThreads: {} as never,
      mailboxes: { inbox: { id: "inbox", name: "Inbox", role: "inbox" } } as never,
      loadThread: (async () => undefined) as never,
      setOpenThread: (() => undefined) as never,
      markRead: (async () => undefined) as never,
      roleId: (() => null) as never,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    // Both read, so only the last one opens by itself: the earlier message is
    // the one that used to have no way back.
    await act(async () => {
      useMail.setState({
        threads: { t1: { id: "t1", emailIds: ["m1", "m2"] } } as never,
        emails: {
          m1: msg("m1", "2026-10-01T10:00:00Z"),
          m2: msg("m2", "2026-10-01T11:00:00Z"),
        } as never,
        fullIds: { m1: true, m2: true } as never,
      });
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("carries reply all, reply and forward first in the earlier message's menu", async () => {
    await show();
    const earlier = host.querySelector('[data-msg-id="m1"]') as HTMLElement;
    // The earlier message opens collapsed; its own click expands it.
    await act(async () => earlier.click());
    const more = earlier.querySelector('button[aria-label="More"]') as HTMLButtonElement;
    expect(more).not.toBeNull();
    await act(async () => more.click());

    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.slice(0, 4).map((one) => one.textContent)).toEqual([
      "Reply",
      "Reply all",
      "Forward",
      "Forward as attachment",
    ]);

    const replyAll = items.find((one) => one.textContent === "Reply all")!;
    await act(async () => replyAll.click());
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), "replyAll");
    // The menu closes with the command: what it opens is a surface of its own.
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });

  it("answers the message the reader is on with the keyboard", async () => {
    await show();
    const earlier = host.querySelector('[data-msg-id="m1"]') as HTMLElement;
    await act(async () => earlier.click());
    await act(async () => {
      window.dispatchEvent(new CustomEvent(EVENTS.reply, { detail: "replyAll" }));
    });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), "replyAll");
  });

  it("falls back to the conversation's last message when nothing is opened", async () => {
    await show();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(EVENTS.reply, { detail: "reply" }));
    });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ id: "m2" }), "reply");
  });

  it("no longer draws a reply strip under the conversation", async () => {
    await show();
    expect(host.querySelector(".reply-box")).toBeNull();
  });
});
