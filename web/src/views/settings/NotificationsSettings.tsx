import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import {
  playNewMailSound,
  requestNotificationPermission,
  showNotification,
} from "@/lib/notify";
import { isEnforced } from "@/lib/settingsPolicy";
import { supportsEmailPush, type WebPushBlocker, webPushBlocker } from "@/lib/webpush";
import {
  disableWebPush,
  enableWebPush,
  type WebPushFailure,
  webPushActive,
} from "@/lib/webpushEnable";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";
import { Switch } from "@/ui/misc";
import { toast } from "@/ui/toast";

/*
 * Why this browser and this server cannot do it, in words the reader can act
 * on.
 *
 * The codes come from the libs and the sentences live here, in the catalogue,
 * because they are the reader's language and a library has none. The iOS case
 * is the one worth spelling out: the permission exists, the switch is simply
 * one install away.
 */
function blockerHint(code: WebPushBlocker): string {
  switch (code) {
    case "needs-install":
      return t(
        "Add Gilbert to your Home Screen in Safari and open it from there: iOS offers notifications only to a web app installed that way.",
      );
    case "no-server-key":
      return t("Your mail server publishes no push key, so it cannot wake this browser.");
    case "unsupported-browser":
      return t(
        "This browser has no Push API, so notifications with Gilbert closed cannot be turned on here.",
      );
  }
}

/** One sentence for a refusal, with the diagnostic beside it when there is one. */
function failureReason(res: { code: WebPushFailure; detail?: string }): string {
  const sentence = (() => {
    switch (res.code) {
      case "permission-denied":
        return t("Notifications are blocked for this site in your browser's settings.");
      case "untrusted-device":
        return t(
          "Background notifications need a device you have marked as your own. Sign in again with “This is my own device” ticked.",
        );
      case "subscribe-failed":
        return t("Could not subscribe to notifications.");
      default:
        return blockerHint(res.code);
    }
  })();
  return res.detail ? `${sentence} ${res.detail}` : sentence;
}

export function NotificationsSettings() {
  const s = useSettings((st) => st.settings);
  const update = useSettings((st) => st.update);
  const pushConnected = useSession((st) => st.pushConnected);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(
    "Notification" in window ? Notification.permission : "unsupported",
  );
  const [background, setBackground] = useState(false);
  const [busy, setBusy] = useState(false);
  const blocker = webPushBlocker();
  const canBackground = blocker === null;
  /*
   * A permission this browser no longer holds an answer for.
   *
   * An answer is recorded per device by the browser, and the browser is the one
   * that can forget it -- a permission reset in its own settings leaves the
   * switch still on. Nothing asks again on its own, because asking belongs to
   * the gesture that turns a switch on and this one is already on, and the hint
   * under it would go on promising notifications that cannot arrive. A button
   * is a gesture, which is why repairing this is one and not an effect.
   */
  const permissionForgotten =
    perm === "default" && (s.desktopNotifications || background);
  useEffect(() => {
    void webPushActive().then(setBackground);
  }, []);
  useEffect(() => {
    if ("Notification" in window) setPerm(Notification.permission);
  }, [s.desktopNotifications]);
  return (
    <div>
      <h1>{t("Notifications")}</h1>
      <p className="lead">
        {t("Live updates are delivered via JMAP push ({state}).", {
          state: pushConnected ? t("connected") : t("reconnecting…"),
        })}
      </p>
      <Switch
        checked={s.desktopNotifications}
        onChange={async (v) => {
          if (v) {
            const p = await requestNotificationPermission();
            setPerm(p);
            if (p !== "granted") return;
          }
          update({ desktopNotifications: v });
        }}
        label={t("Desktop notifications while Gilbert is open")}
        hint={
          perm === "denied"
            ? t("Notifications are blocked in your browser settings.")
            : perm === "unsupported"
              ? t("Not supported in this browser.")
              : t(
                  "Shows a system notification when new mail arrives in your Inbox while the tab is in the background.",
                )
        }
        disabled={perm === "denied" || perm === "unsupported"}
      />
      {permissionForgotten && (
        <p className="hint mt-8">
          {t(
            "This browser has no recorded answer for notifications on this device, so nothing can be shown until they are allowed again.",
          )}{" "}
          <button
            className="btn"
            onClick={async () => {
              const p = await requestNotificationPermission();
              setPerm(p);
              if (p === "granted") toast.success(t("Notifications are on"));
              else toast.error(failureReason({ code: "permission-denied" }));
            }}
          >
            {t("Allow notifications")}
          </button>
        </p>
      )}
      {/*
        The distinction worth drawing for the user: the switch above needs a tab
        open, this one does not. One label for both would call the tab-bound
        kind "desktop notifications" and promise more than it delivers.
      */}
      <Switch
        checked={background}
        disabled={!canBackground || busy || perm === "denied"}
        onChange={async (v) => {
          setBusy(true);
          try {
            if (v) {
              const p = await requestNotificationPermission();
              setPerm(p);
              if (p !== "granted") return;
              const res = await enableWebPush();
              if (!res.ok) {
                toast.error(failureReason(res));
                return;
              }
              setBackground(true);
              toast.success(t("Background notifications are on"));
            } else {
              await disableWebPush();
              setBackground(false);
            }
          } finally {
            setBusy(false);
          }
        }}
        label={t("Notify me even when Gilbert is closed")}
        hint={
          blocker
            ? blockerHint(blocker)
            : supportsEmailPush()
              ? t(
                  "Your mail server delivers these straight to your browser, so they arrive with no Gilbert tab open, naming the sender and subject. Your browser still has to be running — if you quit it completely, notifications wait and arrive when you open it again.",
                )
              : t(
                  "Your mail server can wake this browser, but will not include the sender or subject. Your browser still has to be running.",
                )
        }
      />
      <Switch
        locked={isEnforced("notificationSound")}
        checked={s.notificationSound}
        onChange={(v) => update({ notificationSound: v })}
        label={t("Play a sound for new mail")}
      />
      <div className="row mt-16">
        <button
          className="btn"
          onClick={() => {
            showNotification(t("Gilbert test"), {
              body: t("This is what a new-mail notification looks like."),
            });
            playNewMailSound();
          }}
        >
          {t("Test notification")}
        </button>
      </div>
      <p className="hint mt-8">
        {t("The tab title and favicon always show your unread Inbox count.")}
      </p>
    </div>
  );
}
