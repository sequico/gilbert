import { type PushState, push } from "@/jmap/push";
import { withBase } from "./basePath";
import { APP_VERSION } from "./version";
import { pollWhileVisible } from "./visiblePoll";

/**
 * Reload the page when the server is serving a build this one did not come
 * from.
 *
 * Signing out and picking up a new version are separate things, and only the
 * first happens on its own. A deploy replaces the container, and the tab that
 * was open still has the old bundle in it -- a 401 swaps the view to the
 * sign-in form and changes nothing else. The old JavaScript would go on talking
 * to the new server until someone happened to reload by hand.
 *
 * `index.html` is served `no-cache` and the assets under it are content-hashed
 * and immutable, so a reload is all it takes, and the only other thing needed
 * is something to ask for one. Comparing versions rather than reloading on
 * every 401 means an ordinary session expiry still lands on the sign-in form
 * with the page intact -- only a build that actually moved costs the page.
 *
 * The reload is unconditional once the versions differ. A compose window can
 * be holding text that never reached the server, and this will sometimes take
 * an unsent draft with it -- the session survives the deploy (it lives in the
 * account's own document), but the text in a form does not survive a reload.
 * That is a deliberate trade: a tab running code the server does not speak is
 * the worse failure, and one that stays behind because someone left a draft
 * open is not automatic at all.
 */
const TRIED_KEY = "gilbert:reloaded-for";

/** sessionStorage throws outright in some privacy modes; treat that as absent. */
function tried(): string | null {
  try {
    return sessionStorage.getItem(TRIED_KEY);
  } catch {
    return null;
  }
}

function remember(version: string): void {
  try {
    sessionStorage.setItem(TRIED_KEY, version);
  } catch {
    /* nothing to do: the guard below is best-effort */
  }
}

function forget(): void {
  try {
    sessionStorage.removeItem(TRIED_KEY);
  } catch {
    /* as above */
  }
}

let inFlight: Promise<boolean> | null = null;

/**
 * True when a reload has been asked for and the caller should leave the page
 * alone. False for every other outcome, including not being able to tell --
 * failing to reach the server is not a reason to throw away what is on screen.
 */
export function reloadIfServerRebuilt(): Promise<boolean> {
  // Several things can notice a deploy at once -- the stream dropping and the
  // request that follows it -- and they should not each ask the server.
  inFlight ??= check().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function check(): Promise<boolean> {
  const serverVersion = await fetchServerVersion();
  if (serverVersion === null) return false;

  if (serverVersion === APP_VERSION) {
    // Back in step, either because nothing changed or because an earlier
    // reload worked. Clear the guard so the next deploy is not mistaken for
    // one already attempted.
    forget();
    return false;
  }
  // Reloading once per version, not once per 401: if the new bundle somehow
  // still reports the old version -- a stale proxy cache, a half-finished
  // deploy -- this stops the two of them reloading each other in a loop.
  if (tried() === serverVersion) return false;
  remember(serverVersion);
  window.location.reload();
  return true;
}

/**
 * The build the server says it is serving, or `null` when it cannot be asked.
 *
 * A health check that hangs -- the dead connection this module exists to
 * notice -- must not park `inFlight` for the life of the tab. Every later
 * check joins the same latch, so one hung fetch would silently disable
 * the whole watcher: the poll, the visibility return and each navigation
 * would all wait on a request that never settles. Give up after a few
 * seconds and let the next ask try again on a fresh connection.
 */
async function fetchServerVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(withBase("/api/health"), {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string" || !body.version) return null;
    return body.version;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Whether the server is serving a build other than this one.
 *
 * The question the automatic watchers answer for themselves, exposed so the
 * app's own "update" command can ask it once, on a reader's tap. `null` means
 * it could not be told -- offline, or a server that did not answer -- which is
 * not the same as "up to date".
 */
export async function updateAvailable(): Promise<boolean | null> {
  const serverVersion = await fetchServerVersion();
  return serverVersion === null ? null : serverVersion !== APP_VERSION;
}

export type UpdateOutcome = "reloading" | "current" | "unknown";

/**
 * Take the newest build now, from a reader's tap.
 *
 * Asking the worker for its script (`reg.update()`) lands a changed worker,
 * which is the half a plain reload cannot force; the version check then
 * decides whether the app itself moved, and only reloads when it did. A reload
 * that is not needed costs the reader the page for nothing, which is why this
 * does not reload unconditionally. "unknown" is reported rather than pretended
 * into "current": a server that could not be reached has not been shown to be
 * up to date.
 */
export async function applyAppUpdate(): Promise<UpdateOutcome> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    /* Offline, or no worker: the check below is what decides. */
  }
  const differs = await updateAvailable();
  if (differs === null) return "unknown";
  if (!differs) return "current";
  window.location.reload();
  return "reloading";
}

/**
 * Watch for a deploy without waiting to be asked.
 *
 * Checking on a 401 alone is deferred rather than automatic: it needs the tab
 * to make a request, so one sitting idle keeps running the old build until
 * someone touches it.
 *
 * The stream drop is not the signal either. A deploy kills the EventSource
 * behind `/api/events`, which looks like the perfect cue -- except it arrives
 * while the container is still being replaced, so the check that follows cannot
 * reach the server. Waiting for the stream to come back does not work either:
 * the session died with the old container, so the reconnect is answered with a
 * 401 and never reaches "connected" at all. The drop is kept below because it
 * is free and sometimes lands early enough to be useful, but nothing depends on
 * it.
 *
 * What the guarantee rests on is a slow poll while the tab is visible, plus a
 * check when it becomes visible again. Neither cares what the stream is doing
 * or whether anyone is at the keyboard: a tab left open through a deploy
 * notices within a minute, and a backgrounded one notices the moment it is
 * looked at. `/api/health` touches nothing upstream, so the cost is one small
 * request a minute per open tab.
 */
const POLL_MS = 60_000;

/**
 * How long a health check may take before it is given up on.
 *
 * Longer than any honest answer needs, short enough that a dead connection
 * cannot park the shared `inFlight` latch for the life of the tab (see
 * `check`). An aborted check is a "cannot tell", and the next ask retries.
 */
const HEALTH_TIMEOUT_MS = 8_000;

export function makeConnectionWatcher(): (state: PushState) => void {
  let wasConnected = false;
  return (state) => {
    if (state === "connected") {
      wasConnected = true;
      return;
    }
    // Only a drop is news. Never having connected is not evidence of anything.
    if (!wasConnected) return;
    wasConnected = false;
    void reloadIfServerRebuilt();
  };
}

export function startBuildWatch(): void {
  push.onConnection(makeConnectionWatcher());
  /*
   * A lazy route's chunk 404s in the window between a deploy and the wait's
   * next check: the running bundle asks for a filename the new build replaced,
   * the dynamic import rejects and the route goes blank until the reader
   * reloads by hand. Vite reports exactly that as `vite:preloadError`, so the
   * reload is made for them -- and `reloadIfServerRebuilt` still decides it, so
   * a chunk that fails with no deploy behind it changes nothing.
   */
  window.addEventListener("vite:preloadError", () => void reloadIfServerRebuilt());
  // A hidden tab is not being read, and is checked when it surfaces; the poll
  // and the return-to-tab read are one policy, shared with the other watchers
  // (`lib/visiblePoll.ts`).
  pollWhileVisible(() => void reloadIfServerRebuilt(), POLL_MS);
}
