import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email } from "@/jmap/types";
import { useMail } from "@/store/mail";

const captured = vi.hoisted(() => ({
  args: null as null | { onSwipeEnd: (dir: -1 | 1) => void },
}));

/*
 * The swipe gesture, driven directly: the row's own `onSwipeEnd` is what arms
 * the delayed action, and `useTouchRow` is the pointer plumbing around it.
 */
vi.mock("@/lib/touch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/touch")>()),
  useTouchRow: (args: unknown) => {
    captured.args = args as never;
    return {} as never;
  },
}));

import { Row } from "../MessageList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A swipe whose row is unmounted before the action runs (finding 1).
 *
 * The action fires a beat after the finger lifts, so the row is seen out first.
 * On a virtualised list a row scrolls out of the window in that beat, and the
 * pending write used to land for a row that is no longer on screen. The timer
 * is held and cancelled with the row.
 */

const email = {
  id: "m1",
  threadId: "t1",
  subject: "Hi",
  preview: "",
  receivedAt: 1,
  keywords: {},
  mailboxIds: { inbox: true },
  from: [{ name: "A", email: "a@x" }],
  to: [],
  hasAttachment: false,
} as unknown as Email;

describe("a row's delayed swipe action", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useMail.setState({ mailboxes: {}, emails: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    host.remove();
  });

  const render = (fire: (id: string, desc: unknown) => Promise<void>) => {
    const props = {
      email,
      top: 0,
      height: 56,
      selected: false,
      focused: false,
      open: false,
      twoLine: false,
      showAvatar: false,
      showPreview: false,
      isDrafts: false,
      isSent: false,
      mailboxId: "inbox" as const,
      onClick: () => {},
      onContext: () => {},
      onSelect: () => {},
      onStar: () => {},
      onArchive: () => {},
      onTrash: () => {},
      onRead: () => {},
      touch: true,
      role: "inbox",
      finalFolders: { trash: null, junk: null },
      mayEnd: true,
      swipeLeft: "none" as const,
      swipeRight: "delete" as const,
      onLongPress: () => {},
      onSwipeState: () => {},
      onSwipeFire: fire,
    };
    const AnyRow = Row as unknown as ComponentType<Record<string, unknown>>;
    act(() => {
      root.render(<AnyRow {...props} />);
    });
  };

  it("fires once the beat has passed, with the row still there", async () => {
    const fire = vi.fn(async () => {});
    render(fire);
    await act(async () => {
      captured.args!.onSwipeEnd(1);
    });
    expect(fire).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending action when the row unmounts first", async () => {
    const fire = vi.fn(async () => {});
    render(fire);
    await act(async () => {
      captured.args!.onSwipeEnd(1);
    });
    act(() => root.unmount());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(fire).not.toHaveBeenCalled();
  });
});
