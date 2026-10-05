import { t } from "@/lib/i18n";
import type { WebPushBlocker } from "@/lib/webpush";
import type { WebPushFailure } from "@/lib/webpushEnable";

/*
 * The sentences a web-push refusal is shown as.
 *
 * The libs answer codes (`WebPushBlocker`, `WebPushFailure`) and never prose,
 * because the reader's language lives in the catalogue and a library has none.
 * Two surfaces now ask for a background subscription -- the Notifications
 * settings and the app-install command -- so the wording lives here, composed
 * once, rather than being copied into each and drifting.
 */

/** Why this browser and this server cannot do it, in words the reader can act on. */
export function webPushBlockerHint(code: WebPushBlocker): string {
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
export function webPushFailureSentence(res: {
  code: WebPushFailure;
  detail?: string;
}): string {
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
        return webPushBlockerHint(res.code);
    }
  })();
  return res.detail ? `${sentence} ${res.detail}` : sentence;
}
