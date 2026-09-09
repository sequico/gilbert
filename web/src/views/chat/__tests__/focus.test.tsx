import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import type { ChatConversation } from "@/store/chat";
import { useChat } from "@/store/chat";
import { ChatInput, type ChatInputHandle } from "../ChatInput";
import { ChatPanel } from "../ChatPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The composer keeps (or regains) the caret after mouse actions in the chat
 * panel: clicking reply or picking an emoji must never force a refocus on
 * the typing window.
 *
 * jsdom does not move focus to a button on mousedown, so the browser-side
 * half of the fix (mousedown preventDefault on the buttons) is not
 * observable here; what is observable is the explicit refocus the handlers
 * perform and the guarded `ChatInput.focus()` that keeps the caret in place
 * when the editor already has it.
 */

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

describe("chat composer focus", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useChat.setState({ conversations: {}, openAccountId: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const editor = () => host.querySelector<HTMLElement>('[contenteditable="true"]');

  const renderPanel = async () => {
    useChat.setState({
      conversations: {
        g1: conversation([message("m1", "alice@example.com", "hi")]),
      },
      openAccountId: "g1",
    });
    await act(async () => {
      root.render(<ChatPanel accounts={[GROUP]} onClose={() => {}} />);
    });
  };

  /** Focus something neutral so the composer is not the active element. */
  const moveFocusAway = async () => {
    const dummy = document.createElement("button");
    host.appendChild(dummy);
    dummy.focus();
    expect(document.activeElement).toBe(dummy);
  };

  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };

  it("focuses the composer as soon as the panel opens", async () => {
    await renderPanel();
    expect(document.activeElement).toBe(editor());
  });

  it("refocuses the composer when reply is clicked with the mouse", async () => {
    await renderPanel();
    await moveFocusAway();

    await click(host.querySelector<HTMLButtonElement>(".chat-reply")!);

    expect(document.activeElement).toBe(editor());
    expect(useChat.getState().conversations.g1?.replyTo).toBe("m1");
  });

  it("keeps the composer focused when the reply is cancelled", async () => {
    await renderPanel();
    await moveFocusAway();

    await click(host.querySelector<HTMLButtonElement>(".chat-reply")!);
    await click(host.querySelector<HTMLButtonElement>(".chat-replybar .icon-btn")!);

    expect(document.activeElement).toBe(editor());
    expect(useChat.getState().conversations.g1?.replyTo).toBeNull();
  });

  it("closing the emoji picker hands focus back to the composer", async () => {
    await renderPanel();
    await moveFocusAway();

    const toggle = () => host.querySelector<HTMLButtonElement>(".chat-emoji-btn")!;
    await click(toggle()); // open
    expect(host.querySelector(".chat-emoji-grid")).not.toBeNull();
    await click(toggle()); // close without picking

    expect(document.activeElement).toBe(editor());
  });

  it("reply, cancel-reply and emoji buttons swallow the mousedown", async () => {
    // In browsers a mousedown moves focus to the button; the handlers must
    // prevent that default so the caret never leaves the composer.
    await renderPanel();

    const mousedown = (el: Element) => {
      const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev;
    };
    expect(
      mousedown(host.querySelector<HTMLButtonElement>(".chat-reply")!).defaultPrevented,
    ).toBe(true);

    await click(host.querySelector<HTMLButtonElement>(".chat-reply")!);
    expect(
      mousedown(host.querySelector<HTMLButtonElement>(".chat-replybar .icon-btn")!)
        .defaultPrevented,
    ).toBe(true);

    await click(host.querySelector<HTMLButtonElement>(".chat-emoji-btn")!);
    expect(
      mousedown(host.querySelector<HTMLButtonElement>(".chat-emoji-cell")!)
        .defaultPrevented,
    ).toBe(true);
  });
});

describe("ChatInput focus handle", () => {
  let host: HTMLDivElement;
  let root: Root;
  const handleRef = createRef<ChatInputHandle>();
  const onChange = vi.fn();

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    handleRef.current = null;
    onChange.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = async (value: string) => {
    await act(async () => {
      root.render(
        <ChatInput
          ref={handleRef}
          value={value}
          placeholder="Message"
          maxLength={4000}
          mentionables={[]}
          onChange={onChange}
          onSend={() => {}}
        />,
      );
    });
  };

  const editor = () => host.querySelector<HTMLElement>('[contenteditable="true"]')!;

  /** Put the DOM caret at plain-text offset 0 without firing any events. */
  const caretAtStart = () => {
    const sel = window.getSelection();
    if (!sel) throw new Error("no selection");
    const range = document.createRange();
    range.setStart(editor().firstChild!, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  it("does not move the caret when the editor already has focus", async () => {
    await render("abc");
    await act(async () => handleRef.current?.focus());
    expect(document.activeElement).toBe(editor());

    // The composer already holds the caret (at the start here); focusing it
    // again must not jump the caret to the end of the text.
    caretAtStart();
    await act(async () => handleRef.current?.focus());
    expect(document.activeElement).toBe(editor());
    onChange.mockClear();
    await act(async () => handleRef.current?.insertEmoji("❤"));
    expect(onChange).toHaveBeenLastCalledWith("❤abc");
  });

  it("focuses and moves to the end when the editor had no focus", async () => {
    await render("abc");
    const dummy = document.createElement("button");
    host.appendChild(dummy);
    dummy.focus();

    await act(async () => handleRef.current?.focus());
    expect(document.activeElement).toBe(editor());
    onChange.mockClear();
    // The caret went to the end of the draft: a fresh keystroke appends.
    await act(async () => handleRef.current?.insertEmoji("❤"));
    expect(onChange).toHaveBeenLastCalledWith("abc❤");
  });

  it("inserts an emoji at the live caret, not a stale cached one", async () => {
    await render("abc");
    await act(async () => handleRef.current?.focus());

    // Move the caret without the editor reporting it (no blur, no keystroke):
    // the cached caret is still null/end, the live DOM caret is at 0.
    caretAtStart();
    await act(async () => handleRef.current?.insertEmoji("❤"));

    expect(onChange).toHaveBeenLastCalledWith("❤abc");
    expect(document.activeElement).toBe(editor());
  });

  it("inserts an emoji without corrupting text after an astral emoji", async () => {
    await render("a😀bc");
    await act(async () => handleRef.current?.focus());

    // Caret between the astral emoji image and "b": DOM nodes are per
    // grapheme, so the "b" text node is the third child.
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(editor().childNodes[2]!, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    await act(async () => handleRef.current?.insertEmoji("❤"));

    expect(onChange).toHaveBeenLastCalledWith("a😀❤bc");
    expect(document.activeElement).toBe(editor());
  });
});
