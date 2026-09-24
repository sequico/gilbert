import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import { useChat } from "@/store/chat";
import { type Draft, useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { ChatLauncher } from "../ChatLauncher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * On a phone the panel is a sheet in the content area, and this pins the three
 * mechanisms that keep it from burying the app's own chrome: it is portaled
 * out of the top bar's stacking context (without which the tab bar paints over
 * it and hides the composer), an outside press dismisses it, and opening a
 * composer -- always full-screen on a phone -- closes it.
 */

const GROUP: MailAccountInfo = { accountId: "g1", name: "Team", kind: "group" };

const draft = (key: string, init: Partial<Draft> = {}) =>
  ({ key, minimized: false, maximized: false, ...init }) as Draft;

/** Stand the window at a phone width before the launcher reads the breakpoint. */
function setPhone() {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: /max-width:\s*768px/.test(q),
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe("chat launcher on a phone", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    setPhone();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useMail.setState({ mailAccounts: [GROUP], accountId: null, ownAccountId: null });
    useChat.setState({ conversations: {}, openAccountId: null });
    useCompose.setState({ drafts: [], activeKey: null });
    await act(async () => {
      root.render(<ChatLauncher />);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => root.unmount());
    host.remove();
    useCompose.setState({ drafts: [], activeKey: null });
  });

  const launcher = () => host.querySelector<HTMLButtonElement>(".chat-launcher")!;
  const sheet = () => document.body.querySelector(".chat-sheet");

  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };

  const mouseDown = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
  };

  const openSheet = async () => {
    await click(launcher());
  };

  it("renders the sheet in the body, not inside the top bar's subtree", async () => {
    await openSheet();
    expect(sheet()).not.toBeNull();
    // The portal is what frees the sheet from the top bar's stacking context;
    // without it the sheet is a descendant of the launcher's host.
    expect(host.querySelector(".chat-sheet")).toBeNull();
  });

  it("dismisses on a press outside the sheet", async () => {
    await openSheet();
    expect(sheet()).not.toBeNull();
    await mouseDown(document.body);
    expect(sheet()).toBeNull();
  });

  it("closes when a composer opens, so the two never share the screen", async () => {
    await openSheet();
    expect(sheet()).not.toBeNull();
    await act(async () => {
      useCompose.setState({ drafts: [draft("d1")], activeKey: "d1" });
    });
    expect(sheet()).toBeNull();
  });

  it("does not open behind a composer that is already on screen", async () => {
    await act(async () => {
      useCompose.setState({ drafts: [draft("d1")], activeKey: "d1" });
    });
    await openSheet();
    expect(sheet()).toBeNull();
  });
});
