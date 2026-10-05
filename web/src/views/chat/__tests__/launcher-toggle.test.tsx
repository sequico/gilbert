import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import { useChat } from "@/store/chat";
import { useMail } from "@/store/mail";
import { ChatLauncher } from "../ChatLauncher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The launcher is a toggle: clicking the top-bar icon while the panel is
 * open closes it. On desktop the panel popover closes itself on any outside
 * mousedown -- including the launcher's own -- so the click that follows the
 * mousedown must not reopen it.
 */

const GROUP: MailAccountInfo = { accountId: "g1", name: "Team", kind: "group" };

describe("chat launcher toggle", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    /* jsdom has no matchMedia; the launcher asks whether the window is
       narrow before choosing the popover or the content-area sheet. */
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useMail.setState({ mailAccounts: [GROUP], accountId: null, ownAccountId: null });
    useChat.setState({ conversations: {}, openAccountId: null });
    await act(async () => {
      root.render(<ChatLauncher />);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => root.unmount());
    host.remove();
  });

  const launcher = () => host.querySelector<HTMLButtonElement>(".chat-launcher")!;
  /** The panel renders in the popover's portal, straight into the body. */
  const panel = () => document.body.querySelector(".chat-panel");

  /** The popover registers its outside-click listener after a tick. */
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

  const mouseDown = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
  };

  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };

  it("opens on click and opens the first conversation", async () => {
    expect(panel()).toBeNull();
    await click(launcher());
    await settle();
    expect(panel()).not.toBeNull();
    expect(useChat.getState().openAccountId).toBe("g1");
  });

  it("closes on a launcher click while open and stays closed", async () => {
    await click(launcher());
    await settle();
    expect(panel()).not.toBeNull();

    // The browser sequence for a mouse click on the launcher while the panel
    // is open: the press on the launcher is swallowed at the window (capture
    // before the popover's document listener), so the popover does not close
    // it; the click that completes the gesture is the toggle that closes.
    await mouseDown(launcher());
    expect(panel()).not.toBeNull();
    await click(launcher());
    expect(panel()).toBeNull();

    // A fresh click then opens again: the close was consumed, not sticky.
    await click(launcher());
    await settle();
    expect(panel()).not.toBeNull();
  });

  it("still closes when the press starts outside the launcher", async () => {
    await click(launcher());
    await settle();
    expect(panel()).not.toBeNull();

    // A press anywhere else is not swallowed: the popover's own outside-
    // click handler closes the panel.
    await mouseDown(document.body);
    expect(panel()).toBeNull();
  });

  it("closes on keyboard activation (a click without a preceding mousedown)", async () => {
    await click(launcher());
    await settle();
    expect(panel()).not.toBeNull();

    // Enter/Space fire a plain click: no mousedown, so the popover did not
    // close anything and the toggle itself must close the panel.
    await click(launcher());
    expect(panel()).toBeNull();
  });
});
