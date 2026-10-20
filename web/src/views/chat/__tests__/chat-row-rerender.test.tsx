import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import type { ChatConversation } from "@/store/chat";
import { useChat } from "@/store/chat";
import { ChatPanel } from "../ChatPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A message row is memoised on the message it draws.
 *
 * The chat store hands the panel a new conversation object on every change --
 * a draft being typed, a message arriving -- and a conversation holds a few
 * hundred rows. Redrawing all of them for a change that touched one is work
 * nobody asked for; the rows are therefore counted, through `formatListDate`,
 * which a row calls once per render (the clock beside the sender) and which
 * nothing else on this screen calls.
 */
const renders = vi.hoisted(() => ({ rows: 0 }));
vi.mock("@/lib/format", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/format")>();
  return {
    ...real,
    formatListDate: (at: Parameters<typeof real.formatListDate>[0]) => {
      renders.rows += 1;
      return real.formatListDate(at);
    },
  };
});

const GROUP: MailAccountInfo = { accountId: "g1", name: "Team", kind: "group" };

const message = (id: string, from: string, text: string) => ({
  id,
  v: 1 as const,
  from,
  at: "2026-09-09T10:00:00Z",
  text,
  created: "2026-09-09T10:00:00Z",
});

const conversation = (nodes: ReturnType<typeof message>[]): ChatConversation => ({
  accountId: "g1",
  name: "Team",
  folders: null,
  nodes: nodes as ChatConversation["nodes"],
  stateToken: null,
  loading: false,
  loaded: true,
  error: null,
  marker: null,
  draft: "",
  replyTo: null,
  sending: false,
  earliestPos: 0,
  pagingMore: false,
  reachedStart: false,
});

describe("the chat transcript's rows", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    renders.rows = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useChat.setState({
      conversations: {
        g1: conversation([
          message("m1", "alice@example.com", "hi"),
          message("m2", "bob@example.com", "there"),
        ]),
      },
      openAccountId: "g1",
    });
    await act(async () => {
      root.render(<ChatPanel accounts={[GROUP]} onClose={() => {}} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("redraws no message for a change that is not a message", async () => {
    const mounted = renders.rows;
    // Both messages were drawn, and nothing else on this screen draws a date.
    expect(mounted).toBe(2);

    await act(async () => {
      useChat.setState((s) => {
        const conv = s.conversations.g1!;
        return {
          conversations: { ...s.conversations, g1: { ...conv, draft: "typing" } },
        };
      });
    });

    expect(renders.rows).toBe(mounted);
  });

  it("reads back when the reader asks, not when the top comes into view", async () => {
    const loadOlder = vi.fn(async () => undefined);
    await act(async () => {
      useChat.setState({ loadOlder });
    });

    const button = (): HTMLButtonElement | undefined =>
      [...host.querySelectorAll("button")].find(
        (one) => one.textContent === "Load earlier messages",
      ) as HTMLButtonElement | undefined;
    expect(button(), "the window is not the whole conversation").toBeTruthy();

    // Scrolling to the top asks for nothing: the transcript is read back a page
    // at a time, and only when a person says so.
    const thread = host.querySelector(".chat-thread") as HTMLDivElement;
    await act(async () => {
      thread.scrollTop = 0;
      thread.dispatchEvent(new Event("scroll"));
    });
    expect(loadOlder).not.toHaveBeenCalled();

    await act(async () => {
      button()?.click();
    });
    expect(loadOlder).toHaveBeenCalledWith("g1");

    // At the start of the conversation there is nothing earlier to offer.
    await act(async () => {
      useChat.setState((s) => ({
        conversations: {
          ...s.conversations,
          g1: { ...s.conversations.g1!, reachedStart: true },
        },
      }));
    });
    expect(button()).toBeUndefined();
  });
});
