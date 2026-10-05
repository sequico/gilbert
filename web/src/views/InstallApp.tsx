import { Bell, CircleCheck, RefreshCw, Share, Smartphone, X } from "lucide-react";
import { type ReactNode, useEffect, useReducer, useState } from "react";
import { t } from "@/lib/i18n";
import {
  type AppInstallState,
  appInstallState,
  dismissInstallBanner,
  installBannerDismissed,
  installGuide,
  onInstallState,
  promptInstall,
} from "@/lib/installApp";
import { applyAppUpdate, updateAvailable } from "@/lib/staleBuild";
import { webPushBlocker } from "@/lib/webpush";
import { turnOnNotificationsHere } from "@/lib/webpushEnable";
import { Dialog } from "@/ui/dialog";
import { useIsMobile } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { webPushBlockerHint, webPushFailureSentence } from "@/views/webPushCopy";

/*
 * The app-install surface: the nudge above the app, the command in the account
 * menu, and the dialog both open.
 *
 * All three read one answer (`appInstallState`) so they cannot disagree about
 * whether Gilbert is installed, and the mechanisms underneath -- the captured
 * browser prompt, the update check, the notification permission -- live in
 * `lib/installApp`, `lib/staleBuild` and `lib/webpushEnable`. What is here is
 * the reading of that state and the sentences it is shown as.
 */

/**
 * Subscribe a surface to the install state.
 *
 * The prompt event and the install can land after the first paint, so a surface
 * drawn before them has to be woken rather than poll.
 */
export function useInstallState(): { state: AppInstallState } {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onInstallState(bump), []);
  return { state: appInstallState() };
}

/**
 * The nudge at the top of the app, on a phone.
 *
 * One line and one action, and it never says "install" to somebody who already
 * has it: an installed app is met with the question of using it, not with the
 * offer to install again. Dismissing it is remembered for the state it was
 * dismissed in, so the same nudge does not return.
 */
export function InstallBanner({ onOpen }: { onOpen: () => void }) {
  const isMobile = useIsMobile();
  const { state } = useInstallState();
  if (!isMobile || installBannerDismissed()) return null;

  const message =
    state === "installed"
      ? t(
          "Gilbert is already installed on this device. Open it from its icon on your Home Screen to use the app.",
        )
      : state === "installable"
        ? t("Install Gilbert as an app for a full-screen window and notifications.")
        : t("Add Gilbert to your Home Screen.");

  return (
    <div className="install-banner">
      <Smartphone size={18} className="install-banner-icon" />
      <span className="install-banner-text">{message}</span>
      {state === "installable" && (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            void promptInstall().then((outcome) => {
              if (outcome === "accepted")
                toast.success(
                  t(
                    "Gilbert is installing. Open it from its icon to finish setting it up.",
                  ),
                );
            });
          }}
        >
          {t("Install")}
        </button>
      )}
      {state === "manual" && (
        <button type="button" className="btn btn-sm" onClick={onOpen}>
          {t("How")}
        </button>
      )}
      <button
        type="button"
        className="icon-btn install-banner-close"
        aria-label={t("Dismiss")}
        onClick={dismissInstallBanner}
      >
        <X size={16} />
      </button>
    </div>
  );
}

type UpdateState = "checking" | "current" | "available" | "unknown";

/**
 * The install, update and notifications dialog.
 *
 * Opened from the account menu and from the banner. What it shows follows the
 * install state: the browser's install prompt, the steps where there is no
 * prompt, the update check once installed, and the notification permission in
 * every case -- because on a phone the reason to install Gilbert at all is to
 * be told about mail while it is closed.
 */
export function InstallAppDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { state } = useInstallState();
  const installed = state === "in-app" || state === "installed";
  const guide = installGuide();
  const [busy, setBusy] = useState(false);
  const [update, setUpdate] = useState<UpdateState>("checking");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  useEffect(() => {
    if (!open || !installed) return;
    let live = true;
    setUpdate("checking");
    void updateAvailable().then((differs) => {
      if (!live) return;
      setUpdate(differs === null ? "unknown" : differs ? "available" : "current");
    });
    return () => {
      live = false;
    };
  }, [open, installed]);

  useEffect(() => {
    if (!open) return;
    if (typeof Notification !== "undefined") setPermission(Notification.permission);
  }, [open]);

  async function install(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await promptInstall();
      if (outcome === "accepted") {
        toast.success(
          t("Gilbert is installing. Open it from its icon to finish setting it up."),
        );
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  async function updateNow(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await applyAppUpdate();
      // A reload is the success path and takes the page away: nothing to say.
      if (outcome === "reloading") return;
      if (outcome === "current") {
        setUpdate("current");
        toast.success(t("Gilbert is up to date."));
      } else {
        setUpdate("unknown");
        toast.error(t("Could not check for updates."));
      }
    } finally {
      setBusy(false);
    }
  }

  async function turnOnNotifications(): Promise<void> {
    setBusy(true);
    try {
      const res = await turnOnNotificationsHere();
      setPermission(res.permission);
      if (res.failure) toast.error(webPushFailureSentence(res.failure));
      else if (res.permission === "granted")
        toast.success(t("Notifications are on for this device."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={installed ? t("Mobile app") : t("Install mobile app")}
    >
      {installed ? (
        <>
          <p className="install-dialog-status">
            <CircleCheck size={18} />
            <span>{t("Gilbert is installed on this device.")}</span>
          </p>
          <p className="hint install-dialog-update">{updateMessage(update)}</p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || update !== "available"}
            onClick={() => void updateNow()}
          >
            <RefreshCw size={16} /> {t("Update now")}
          </button>
        </>
      ) : state === "installable" ? (
        <>
          <p>
            {t(
              "Install Gilbert on your phone to open it from its own icon, full screen, and to be notified when it is closed.",
            )}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void install()}
          >
            {t("Install app")}
          </button>
        </>
      ) : guide === "ios" ? (
        <>
          <p>{t("Safari installs a web app from the Share sheet:")}</p>
          <ol className="install-steps">
            <li>
              <Share size={14} /> {t("Tap the Share button.")}
            </li>
            <li>{t("Choose “Add to Home Screen”.")}</li>
            <li>{t("Open Gilbert from the new icon.")}</li>
          </ol>
        </>
      ) : (
        <p>
          {t(
            "This browser keeps install in its own menu — look for “Install app” or “Add to Home screen”.",
          )}
        </p>
      )}

      <h3 className="install-dialog-heading">{t("Notifications")}</h3>
      <NotificationsPart
        installed={installed}
        permission={permission}
        busy={busy}
        onTurnOn={() => void turnOnNotifications()}
      />
    </Dialog>
  );
}

function updateMessage(update: UpdateState): string {
  switch (update) {
    case "available":
      return t("A newer version is on the server.");
    case "current":
      return t("You are on the newest version.");
    case "unknown":
      return t("Could not check for updates.");
    default:
      return t("Checking for updates…");
  }
}

/**
 * What the dialog says about notifications, from the state already known.
 *
 * The iOS tab is named before the permission is: the permission there is not
 * refused, it is simply unavailable until the app is installed, and asking the
 * reader to grant it would ask for something Safari will not offer.
 */
function NotificationsPart({
  installed,
  permission,
  busy,
  onTurnOn,
}: {
  installed: boolean;
  permission: NotificationPermission | "unsupported";
  busy: boolean;
  onTurnOn: () => void;
}) {
  const blocker = webPushBlocker();
  let body: ReactNode;
  if (blocker === "needs-install" && !installed) {
    body = <p className="hint">{webPushBlockerHint("needs-install")}</p>;
  } else if (permission === "unsupported") {
    body = <p className="hint">{t("This browser cannot show notifications.")}</p>;
  } else if (permission === "denied") {
    body = (
      <p className="hint">
        {t("Notifications are blocked for this site in your browser's settings.")}
      </p>
    );
  } else if (permission === "granted") {
    body = <p className="hint">{t("Notifications are on for this device.")}</p>;
  } else {
    body = (
      <button type="button" className="btn" disabled={busy} onClick={onTurnOn}>
        <Bell size={16} /> {t("Turn on notifications")}
      </button>
    );
  }
  return <>{body}</>;
}
