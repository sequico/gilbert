import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "@/store/settings";
import { toast } from "@/ui/toast";
import { NotificationsSettings } from "../NotificationsSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The permission is asked for from a gesture, and a browser that no longer holds
 * an answer can be asked again.
 *
 * Both halves are here because both are invisible when broken. An effect that
 * asks at start-up looks like nothing on a desktop browser -- the prompt simply
 * appears -- and is refused outright on iOS. A switch left on over a permission
 * the browser has forgotten looks like a working setting and delivers nothing,
 * which nobody reports as a bug; they report that notifications "do not work".
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

  it("offers nothing to repair while the browser holds the answer", async () => {
    await mount("granted", true);
    expect(text()).not.toContain("Allow notifications");
  });

  it("offers the permission again when the switch is on and the answer is gone", async () => {
    await mount("default", true);
    expect(text()).toContain("Allow notifications");
  });

  it("does not offer it for a setting that was never turned on", async () => {
    await mount("default", false);
    expect(text()).not.toContain("Allow notifications");
  });

  it("asks, from the click, and reports the answer the browser gave", async () => {
    const said = vi.spyOn(toast, "success");
    await mount("default", true);
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Allow notifications",
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(ask).toHaveBeenCalledTimes(1);
    // The outcome is what the reader is told, not that a request was made.
    expect(said).toHaveBeenCalledWith("Notifications are on");
    // And the row that offered it is gone: the browser holds an answer now.
    expect(text()).not.toContain("Allow notifications");
  });

  it("never asks on its own, however the section is entered", async () => {
    await mount("default", true);
    expect(ask).not.toHaveBeenCalled();
  });
});
