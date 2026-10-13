import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showNotification } from "@/lib/notify";

/**
 * Where a notification is held back, and the two callers that are not that
 * news.
 *
 * A mail or chat notification over a focused window says what the list has
 * already shown; a calendar reminder and the Settings test button do not. The
 * test button runs in a tab that is necessarily focused, so a suppression
 * applied to it is a button that reads as broken.
 */
describe("showNotification", () => {
  const shown = vi.fn();

  beforeEach(() => {
    shown.mockClear();
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string) {
        shown(title);
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification as unknown as typeof Notification);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("holds back new mail in a tab the reader is looking at", () => {
    showNotification("New mail");
    expect(shown).not.toHaveBeenCalled();
  });

  it("shows a reminder or a test in that same tab", () => {
    showNotification("Gilbert test", { evenWhenFocused: true });
    expect(shown).toHaveBeenCalledWith("Gilbert test");
  });

  it("shows nothing without permission, asked for or not", () => {
    (Notification as unknown as { permission: string }).permission = "denied";
    showNotification("Gilbert test", { evenWhenFocused: true });
    expect(shown).not.toHaveBeenCalled();
  });
});
