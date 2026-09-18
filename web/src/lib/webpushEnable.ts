/**
 * Turning Web Push on and off, and completing the handshake it needs.
 *
 * Kept apart from `webpush.ts` so that module stays pure JMAP and stays
 * testable: everything here touches the browser's service worker and
 * permission prompt, none of which exists under a test runner.
 */
import { CAP } from "@/jmap/client";
import { isDeviceTrusted } from "@/lib/storage";
import {
  applicationServerKey,
  createSubscription,
  decodeApplicationServerKey,
  destroySubscriptions,
  deviceClientId,
  extendSubscription,
  findSubscription,
  listSubscriptions,
  mySubscriptions,
  needsRenewal,
  PushSetError,
  pushEnabledHere,
  registeredEndpoint,
  releaseThisDevice,
  rememberEndpoint,
  roomToMake,
  setPushEnabledHere,
  subscriptionPayload,
  unsubscribeThisDevice,
  verifySubscription,
  type WebPushBlocker,
  webPushAvailable,
  webPushBlocker,
} from "@/lib/webpush";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { withBase } from "./basePath";
import { SW_CACHE_NAME } from "./swCache";

let listening = false;

/**
 * Watch for the verification code the server pushes.
 *
 * The service worker cannot answer it — a JMAP call needs the session cookie
 * and this is a background context — so it forwards the code here, or leaves it
 * in the cache when no tab was open to forward it to.
 */
export function listenForVerification(): void {
  if (listening || typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return;
  listening = true;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: string; id?: string; code?: string } | undefined;
    if (d?.type === "push-verification" && d.id && d.code)
      void verifySubscription(d.id, d.code).catch(() => {});
  });
  void collectStoredVerification();
}

/** Pick up a code that arrived while no tab was open. */
async function collectStoredVerification(): Promise<void> {
  try {
    const cache = await caches.open(SW_CACHE_NAME);
    // The same absolute key the worker writes. Relative would be resolved
    // against this document's URL, which is a different place on every route.
    const key = withBase("/gilbert-push-verification");
    const hit = await cache.match(key);
    if (!hit) return;
    const { id, code } = (await hit.json()) as { id?: string; code?: string };
    await cache.delete(key);
    if (id && code) await verifySubscription(id, code);
  } catch {
    /* nothing waiting, or no cache: not a failure */
  }
}

/**
 * Why turning background notifications on did not work, as a code.
 *
 * A code rather than a sentence: the reader's language lives in the catalogue
 * and the surface composes what it says, which is the same reason the admin
 * surface answers a refusal as a code and its parameters.
 */
export type WebPushFailure =
  | WebPushBlocker
  | "permission-denied"
  | "untrusted-device"
  | "subscribe-failed";

/**
 * Subscribe this browser. Safe to call again — what it replaces is released
 * first, by our own hand (see `registerThisBrowser`).
 *
 * Returns why it could not, rather than throwing, because every reason is
 * something to tell the user plainly: an old server, a browser without push, a
 * permission they declined.
 */
export async function enableWebPush(): Promise<
  { ok: true } | { ok: false; code: WebPushFailure; detail?: string }
> {
  const blocker = webPushBlocker();
  if (blocker) return { ok: false, code: blocker };
  if (Notification.permission === "denied")
    return { ok: false, code: "permission-denied" };
  // A subscription outlives the tab and belongs to the account, not the
  // session -- so on a machine the user has told us is not theirs, it would go
  // on delivering their mail to it long after they had gone.
  if (!isDeviceTrusted()) return { ok: false, code: "untrusted-device" };
  const key = applicationServerKey();
  if (!key) return { ok: false, code: "no-server-key" };

  try {
    await registerThisBrowser(key);
    setPushEnabledHere(true);
    listenForVerification();
    return { ok: true };
  } catch (err) {
    return { ok: false, code: "subscribe-failed", detail: (err as Error).message };
  }
}

/**
 * Get this browser subscribed at the push service and registered at Stalwart,
 * with exactly one row there, and that one current.
 *
 * Shared by turning push on and by renewing it, because they are the same call.
 * It used to release its own row and create another, which is how an account
 * filled up: a renewal inside the window added one every time. Now —
 *
 * - the same endpoint as last time, already registered: extend the newest row
 *   when it is close to expiring, and release any extra copies of its own;
 * - anything else — a new endpoint, nothing registered, an extension the server
 *   refused: release this browser's old rows and register afresh.
 *
 * Extending rather than replacing is not only frugal: destroy-then-create
 * leaves a window in which the account has no subscription at all, and a create
 * that fails inside it leaves a device that is not listening until the next app
 * start. An extension has no window.
 *
 * The local subscription is created when it is missing rather than only reused.
 * A browser may drop or rotate one on its own -- a `pushsubscriptionchange`
 * nobody was open to hear -- and reusing only an existing one would give up
 * there, leaving push off for good with the switch still saying it is on.
 */
async function registerThisBrowser(key: string): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      // Web Push requires it, and Chrome refuses a subscription without it.
      userVisibleOnly: true,
      applicationServerKey: decodeApplicationServerKey(key),
    }));
  const deviceId = deviceClientId();
  const mine = mySubscriptions(await listSubscriptions(), deviceId);
  const [newest, ...extra] = mine;

  /*
   * The row already pointing at this browser's endpoint, when it is still this
   * browser's: `registeredEndpoint` is local and the server never hands a row's
   * URL back, so it is the only way to know whether the row we are about to
   * extend is still aimed where this browser is listening. Extending a stale one
   * would leave a subscription that is alive and delivering nowhere.
   */
  if (newest && registeredEndpoint() === sub.endpoint) {
    if (extra.length) await destroySubscriptions(extra.map((s) => s.id));
    // The same predicate the old renewal gate used, so the boundary between
    // "close enough to extend" and "leave it" is defined once and tested once.
    if (!needsRenewal(mine, deviceId)) return;
    try {
      await extendSubscription(newest.id);
      return;
    } catch {
      /* Not extendable: replaced below, which is what this did before. */
    }
  }

  const accountId = useSession.getState().ownAccountFor(CAP.mail);
  const inboxId = useMail.getState().roleId("inbox");
  const payload = subscriptionPayload(sub, accountId, inboxId);
  await releaseThisDevice(sub.endpoint);
  /*
   * One retry, because the release has already happened: the row that was
   * serving is gone, so a create that fails on a transient error (offline, a
   * 502 from the push service) would leave the account with no subscription at
   * all until the next start -- and, before this, the old row was still there
   * to serve. A retry costs one request where the alternative costs the
   * feature.
   */
  for (let attempt = 0; ; attempt++) {
    try {
      await createSubscription(payload);
      rememberEndpoint(sub.endpoint);
      return;
    } catch (err) {
      /*
       * The account's fifteen are spent. Releasing our own rows (above) freed
       * the ones we held, so what is left is somebody else's: a second browser
       * of the reader's, or a row left behind by a browser whose site data was
       * cleared, which no tab can ever reach again. Making room means releasing
       * one of those, and `roomToMake` picks the one that was never verified or
       * is closest to expiring -- never this browser's, never the server's own
       * fan-out row. The device it belonged to registers again next time it is
       * opened, which is the only repair available from here.
       */
      if (err instanceof PushSetError && err.type === "overQuota" && attempt < 1) {
        const room = roomToMake(await listSubscriptions(), deviceClientId());
        if (!room.length) throw err;
        await destroySubscriptions(room);
        continue;
      }
      if (attempt >= 1) throw err;
      console.warn("[gilbert] push: registration failed, trying once more:", err);
    }
  }
}

/**
 * Keep a subscription alive, from app start.
 *
 * Renewal has to happen here rather than in the service worker: registering
 * with Stalwart is a JMAP call, and a JMAP call needs the session cookie that
 * only a page has. So the guarantee is "push keeps working as long as Gilbert
 * is opened now and again", and the renewal window is wide enough that once a
 * week is enough.
 *
 * Silent by design. Every reason to stop is a normal state -- push was never
 * turned on here, the permission is gone, the device is not trusted any more --
 * and none of them is news to deliver on a cold start.
 */
export async function renewWebPush(): Promise<void> {
  if (!pushEnabledHere() || !webPushAvailable()) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted")
    return;
  const key = applicationServerKey();
  if (!key) return;
  try {
    // `registerThisBrowser` decides for itself whether anything is due: it
    // reads the rows and extends only one close to expiring, so a start with
    // nothing to do costs one request and no write.
    await registerThisBrowser(key);
    listenForVerification();
  } catch (err) {
    /* Offline, or the server said no. The next start tries again -- but the
       row this was renewing has been released by now, so the failure has to be
       visible rather than swallowed: until it succeeds the account has no
       subscription. */
    console.warn("[gilbert] push: renewal did not complete:", err);
  }
}

/** Remove this browser's subscription, at the browser and at the server. */
export async function disableWebPush(): Promise<void> {
  await unsubscribeThisDevice();
}

/**
 * Whether *this browser* has a subscription registered at the server.
 *
 * The device has to match. "Does the account have any subscription at all", the
 * account-wide question, is true the moment one other device has one -- so a
 * phone that has never successfully registered, or whose registration has
 * expired, would show the switch already on and deliver nothing. That question
 * is not one this switch is asking.
 */
export async function webPushActive(): Promise<boolean> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!(await reg?.pushManager.getSubscription())) return false;
    return Boolean(findSubscription(await listSubscriptions(), deviceClientId()));
  } catch {
    return false;
  }
}
