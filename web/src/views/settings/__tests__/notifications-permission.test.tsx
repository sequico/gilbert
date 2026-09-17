import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "@/store/settings";
import { NotificationsSettings } from "../NotificationsSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The permission is asked for from a gesture, and the one state that leaves is
 * said out loud.
 *
 * Both halves are here because both are invisible when broken. An effect that
 * asks at start-up looks like nothing on a desktop browser -- the prompt simply
 * appears -- and is refused outright on iOS. A switch left on over a permission
 * the browser has forgotten looks like a working setting and delivers nothing,
 * which nobody reports as a bug; they report that notifications "do not work".
 * The repair is the switch's own gesture, so what the section owes the reader is
 * the sentence and not a prompt of its own.
 */
describe("the notification permission door", () => {
  let host: HTMLDivElement;
  let root: Root;

  const ask = vi.fn(async () => "granted" as NotificationPermission);

  const mount = async (permission: NotificationPermission, desktop: boolean) => {
    vi.stubGlobal("Notification", { permission, requestPermission: ask });
    useSettings.setState((s) => ({
      settings: { ...s.settings, desktopNotifications: desktop },
    }));
    await act(async () => {
      root.render(<NotificationsSettings />);
    });
  };

  const text = () => host.textContent ?? "";
  const FORGOTTEN = "no longer holds an answer";

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    ask.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("says nothing while the browser holds the answer", async () => {
    await mount("granted", true);
    expect(text()).not.toContain(FORGOTTEN);
  });

  it("says so when the switch is on and the answer is gone", async () => {
    await mount("default", true);
    expect(text()).toContain(FORGOTTEN);
    // And it names the gesture that repairs it, which is the only one allowed.
    expect(text()).toContain("Turning a switch off and on again");
  });

  it("says nothing for a setting that was never turned on", async () => {
    await mount("default", false);
    expect(text()).not.toContain(FORGOTTEN);
  });

  it("draws no button of its own for it", async () => {
    await mount("default", true);
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels).not.toContain("Allow notifications");
  });

  it("never asks on its own, however the section is entered", async () => {
    await mount("default", true);
    expect(ask).not.toHaveBeenCalled();
  });
});
