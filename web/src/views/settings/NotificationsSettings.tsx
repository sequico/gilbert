import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import {
  playNewMailSound,
  requestNotificationPermission,
  showNotification,
} from "@/lib/notify";
import { isEnforced } from "@/lib/settingsPolicy";
import { supportsEmailPush, webPushBlocker } from "@/lib/webpush";
import {
  disableWebPush,
  turnOnNotificationsHere,
  webPushActive,
} from "@/lib/webpushEnable";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";
import { Switch } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { webPushBlockerHint, webPushFailureSentence } from "@/views/webPushCopy";

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
   * stored value alone. Nothing asks again on its own, because asking belongs to
   * the gesture that turns a switch on and this one is already on -- so the
   * section says as much and names the gesture that repairs it, which is the
   * switch itself. An effect here would be the very request the gesture rule
   * exists to forbid.
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
            "This browser no longer holds an answer for notifications on this device, so none can be shown. Turning a switch off and on again asks for the permission.",
          )}
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
              const res = await turnOnNotificationsHere();
              setPerm(res.permission);
              if (res.permission !== "granted") return;
              if (res.failure) {
                toast.error(webPushFailureSentence(res.failure));
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
            ? webPushBlockerHint(blocker)
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
