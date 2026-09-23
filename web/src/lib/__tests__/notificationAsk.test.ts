import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_ASK_COOLDOWN_MS,
  notificationAskDue,
  rememberNotificationAsk,
  shouldAskForNotifications,
} from "@/lib/notify";

/*
 * Whether the app asks the reader for the notification permission.
 *
 * The switches default on, and a browser grants the permission only to a
 * gesture -- so the ask has to be drawn rather than assumed. These fail if the
 * condition widens (asking after an answer, or with the switches off) or
 * narrows (never asking, which is the silence the nudge exists to prevent).
 */
describe("asking for the notification permission", () => {
  it("asks while a switch wants notifications and the browser has not answered", () => {
    expect(shouldAskForNotifications("default", true)).toBe(true);
  });

  it("never asks again once the browser has answered", () => {
    expect(shouldAskForNotifications("granted", true)).toBe(false);
    expect(shouldAskForNotifications("denied", true)).toBe(false);
  });

  it("does not ask when notifications are switched off", () => {
    expect(shouldAskForNotifications("default", false)).toBe(false);
  });

  it("does not ask where the browser has no Notification at all", () => {
    expect(shouldAskForNotifications("unsupported", true)).toBe(false);
  });
});

/*
 * The cooldown is what keeps the ask a nudge rather than a nag: shown once,
 * quiet for a week, then shown again while the browser still has not answered.
 */
describe("the ask's cooldown", () => {
  it("asks the first time, stays quiet after, and asks again a week later", () => {
    localStorage.clear();
    const at = 1_000_000_000_000;
    expect(notificationAskDue(at)).toBe(true);
    rememberNotificationAsk(at);
    expect(notificationAskDue(at + 1_000)).toBe(false);
    expect(notificationAskDue(at + NOTIFICATION_ASK_COOLDOWN_MS)).toBe(true);
  });
});
