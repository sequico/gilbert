import { withBase } from "./basePath";

let baseTitle = "gilbert";
let faviconCanvas: HTMLCanvasElement | null = null;
let baseFavicon: HTMLImageElement | null = null;

export function setBaseTitle(t: string) {
  baseTitle = t;
}

/*
 * The unread count on the installed app's icon.
 *
 * The title and the favicon below are the same idea for a tab, and an
 * installed app has neither: in `display: standalone` there is no tab strip
 * and no favicon anywhere on screen, so nothing this file does for the unread
 * count is visible at exactly the moment somebody puts Gilbert on a home screen.
 * The Badging API is where the count goes instead, and it is the one thing every
 * phone user expects a mail icon to do.
 *
 * Silently nothing where it is unsupported, and silently nothing on iOS until
 * notification permission has been granted, which is that platform's condition
 * for showing a badge at all. Neither is worth reporting: a count that does not
 * appear is not a failure anybody can act on.
 */
function setIconBadge(count: number): void {
  if (!("setAppBadge" in navigator)) return;
  const done = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
  void done.catch(() => {
    /* unsupported, or not permitted on this platform */
  });
}

/** Update document title, favicon and app icon badge with unread count. */
export function setUnreadBadge(count: number): void {
  document.title =
    count > 0 ? `(${count > 999 ? "999+" : count}) ${baseTitle}` : baseTitle;
  setIconBadge(count);
  try {
    const link = document.querySelector<HTMLLinkElement>(
      'link[rel="icon"][type="image/png"]',
    );
    if (!link) return;
    if (!baseFavicon) {
      baseFavicon = new Image();
      baseFavicon.src = withBase("/img/favicon-64.png");
      baseFavicon.onload = () => setUnreadBadge(count);
      return;
    }
    if (!baseFavicon.complete) return;
    if (count <= 0) {
      link.href = withBase("/img/favicon-64.png");
      return;
    }
    faviconCanvas ??= document.createElement("canvas");
    const c = faviconCanvas;
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 64, 64);
    ctx.drawImage(baseFavicon, 0, 0, 64, 64);
    ctx.fillStyle = "#dc2626";
    ctx.beginPath();
    ctx.arc(46, 18, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(count > 99 ? "99" : String(count), 46, 19);
    link.href = c.toDataURL("image/png");
  } catch {
    /* ignore */
  }
}

/**
 * Ask for the browser's notification permission, from a gesture the reader
 * made.
 *
 * The callers are the switches that turn notifications on, and that is the only
 * place it may be asked from: a prompt raised on a start-up path has no gesture
 * behind it, which iOS refuses outright and every other browser teaches people
 * to dismiss.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/**
 * Whether the app should ask the reader, given the switch and the browser's answer.
 *
 * The switches default on, so a reader who never visits Settings is owed the
 * ask rather than silence: this is true while a switch wants notifications and
 * the browser has not been asked yet. An answer already given, in either
 * direction, is final here -- the browser will not prompt again, and `denied`
 * is repaired in its own settings, not by a button that cannot work.
 */
export function shouldAskForNotifications(
  permission: NotificationPermission | "unsupported",
  wanted: boolean,
): boolean {
  return wanted && permission === "default";
}

export function showNotification(
  title: string,
  opts: NotificationOptions & { onClick?: () => void } = {},
): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    const n = new Notification(title, {
      icon: withBase("/img/icon-192.png"),
      badge: withBase("/img/favicon-64.png"),
      ...opts,
    });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
    setTimeout(() => n.close(), 8000);
  } catch {
    /* ignore */
  }
}

let audioCtx: AudioContext | null = null;
/** Short, soft "ding" using WebAudio (no asset needed). */
export function playNewMailSound(): void {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.45);
  } catch {
    /* ignore */
  }
}
