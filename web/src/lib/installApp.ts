/**
 * Putting Gilbert on a home screen, and knowing whether it is already there.
 *
 * Two questions, and the browser answers them differently on every platform.
 * "Is this copy installed?" is a display mode: a standalone window on
 * Chromium and Android, `navigator.standalone` on iOS. "Can I install it from
 * here?" is an event -- `beforeinstallprompt` -- that Chromium fires when the
 * manifest qualifies, and that Safari never fires, because on iOS the install
 * lives in the Share sheet and nowhere else. Answering both from one module is
 * what lets the account menu offer the right thing and say the right sentence
 * where the browser offers nothing to click.
 *
 * The event is captured once, at start-up (`main.tsx`), because it can arrive
 * before the menu that wants it has been drawn. It is consumed by the install:
 * a prompt can be shown once, and the browser sends a fresh event when it is
 * ready to be asked again -- so there is no re-arming to do here.
 */

/** The `beforeinstallprompt` event, which the DOM lib does not declare. */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

/** What to tell a reader whose browser has no prompt to show. */
export type InstallGuide = "ios" | "browser-menu";

/**
 * iOS, where the Push API and the install both live behind the Home Screen.
 *
 * iPadOS 13+ reports itself as a Mac, so the touch points are asked as well as
 * the user agent. The answer is used twice: to word the install steps, and to
 * say why background notifications cannot be offered from a Safari tab
 * (`webpush.ts`).
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * The display modes an installed app runs in. `browser` is deliberately absent:
 * it is the tab this is trying to tell apart.
 */
const INSTALLED_MODES = [
  "(display-mode: standalone)",
  "(display-mode: minimal-ui)",
  "(display-mode: fullscreen)",
  "(display-mode: window-controls-overlay)",
];

/**
 * True when this copy is running as an installed app.
 *
 * `display-mode: standalone` is the standard signal and the one Gilbert's own
 * manifest declares, but an installed app can also be running in another of the
 * installed modes, and iOS reports it on `navigator.standalone` instead -- the
 * media query came later there -- so every one of them is asked. A browser that
 * matches none answers false, which is the honest default: better to offer the
 * install again than to hide it from somebody who does not have it.
 */
export function isInstalledApp(): boolean {
  try {
    return (
      INSTALLED_MODES.some((mode) => window.matchMedia(mode).matches) ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

let deferred: BeforeInstallPromptEvent | null = null;
let watching = false;
const listeners = new Set<() => void>();

function announce(): void {
  for (const cb of listeners) cb();
}

/**
 * Listen for a change in what the install command can do.
 *
 * The prompt event arrives after the first paint, so a surface drawn before it
 * has to be told rather than poll. Returns a disposer.
 */
export function onInstallState(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Whether the browser is holding an install prompt ready to be shown. */
export function installPromptReady(): boolean {
  return deferred !== null;
}

/**
 * Where the install stands, as one of four:
 *
 * - `in-app` -- this *is* the installed app; nothing to offer.
 * - `installed` -- this is a browser tab, but Gilbert is installed on the
 *   device (it was installed from this browser before). Offering the install
 *   again would be nagging somebody who already took it.
 * - `installable` -- the browser is holding a prompt we can show.
 * - `manual` -- no prompt and no known install: the browser keeps install in
 *   its own menu, or this is Safari, whose install is the Share sheet.
 */
export type AppInstallState = "in-app" | "installed" | "installable" | "manual";

/*
 * Whether Gilbert was ever installed from this browser.
 *
 * The one instance a browser tab can answer without asking the platform:
 * `appinstalled` fires in the tab that completed the install, and the marker it
 * leaves says so when the site is opened as a tab again. It cannot see an
 * install that happened elsewhere on the device -- no web API can, short of
 * `getInstalledRelatedApps`, which returns nothing unless the manifest declares
 * a related app -- so a fresh browser profile falls back to offering the
 * install, which is the safe direction.
 */
const INSTALLED_KEY = "gilbert:appInstalledOnDevice";

function readInstalledMarker(): boolean {
  try {
    return localStorage.getItem(INSTALLED_KEY) === "1";
  } catch {
    return false;
  }
}

let installedMarker = false;
/*
 * True for the rest of the session that completed an install. Without it the
 * banner would flip from "install" to "already installed" the moment the
 * install landed, in the same tab the reader is looking at -- which is telling
 * somebody what they just did.
 */
let justInstalled = false;
/** Whether Gilbert is installed on this device but this is a browser tab. */
export function installedElsewhere(): boolean {
  return !isInstalledApp() && (installedMarker || readInstalledMarker());
}

export function appInstallState(): AppInstallState {
  if (isInstalledApp()) return "in-app";
  if (installedElsewhere()) return "installed";
  if (deferred) return "installable";
  return "manual";
}

/*
 * The top banner is a nudge, not a nag: a reader who closes it for a state does
 * not see that state again. The dismissed value is the state it was closed in,
 * so a change worth a second word -- the install completing, say -- is shown
 * once and no more.
 */
const BANNER_KEY = "gilbert:installBannerDismissed";

export function installBannerDismissed(): boolean {
  if (justInstalled || appInstallState() === "in-app") return true;
  try {
    return localStorage.getItem(BANNER_KEY) === appInstallState();
  } catch {
    return false;
  }
}

export function dismissInstallBanner(): void {
  try {
    localStorage.setItem(BANNER_KEY, appInstallState());
  } catch {
    /* private mode: the banner may return, which is not a failure */
  }
  announce();
}

/**
 * Start listening, once. Safe to call from start-up on every platform.
 *
 * `preventDefault` on the prompt event is what stops Chromium's own mini
 * infobar from competing with the app's banner and menu; the app then owns the
 * moment, and the browser is free to send a new event if the offer is not
 * taken. The address-bar install control is not affected by it.
 */
export function watchInstallApp(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  installedMarker = readInstalledMarker();
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    announce();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installedMarker = true;
    justInstalled = true;
    try {
      localStorage.setItem(INSTALLED_KEY, "1");
    } catch {
      /* private mode: the marker is only a hint */
    }
    announce();
  });
}

/**
 * Show the browser's install prompt. Only meaningful from a user gesture.
 *
 * The event is cleared before the prompt is shown rather than after, because a
 * prompt can be shown once and a second tap on a stale event would fail
 * silently. The browser sends a fresh event when it has another to offer.
 */
export async function promptInstall(): Promise<InstallOutcome> {
  const event = deferred;
  if (!event) return "unavailable";
  deferred = null;
  announce();
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome === "accepted" ? "accepted" : "dismissed";
  } catch {
    return "unavailable";
  }
}

/**
 * What to tell a reader the browser cannot prompt.
 *
 * `null` means the prompt is ready and nothing needs explaining. "ios" is the
 * Share-sheet install, which is the only one Safari has; "browser-menu" is
 * everything else -- a browser that keeps install in its own menu, which is
 * Firefox, or a desktop where the command happens not to be drawn.
 */
export function installGuide(): InstallGuide | null {
  if (deferred) return null;
  return isIOS() ? "ios" : "browser-menu";
}
