/**
 * Web Push: notifications that arrive when Gilbert is not open.
 *
 * The existing EventSource channel only lives as long as a tab does, so
 * "desktop notifications" have really meant "while you are looking". Stalwart
 * 0.16 signs Web Push with VAPID (RFC 9749) and can carry the message itself in
 * the payload (draft-ietf-jmap-emailpush), so the browser's own push service
 * delivers a useful notification with Gilbert closed.
 *
 * Nothing in this path touches Gilbert's server. Stalwart talks to the push
 * service directly; the only thing proxied is the JMAP call that registers the
 * subscription. That is deliberate — it is why this needs no relay, no extra
 * service to run, and no third party beyond the browser vendor's push endpoint
 * that Web Push requires of everyone.
 *
 * Verified against the live 0.16.19 before this was written: the server
 * publishes a real `applicationServerKey`, and `PushSubscription/get` answers a
 * normal user rather than refusing them.
 */

import { gilbertDeviceClientId, isBrowserDeviceClientId } from "@gilbert/shared/push";
import { CAP, client } from "@/jmap/client";
import type { GetResponse, Id, SetResponse } from "@/jmap/types";
import { isIOS } from "@/lib/installApp";
import type { PushTarget } from "@/lib/mailAccounts";
import { isDeviceTrusted } from "@/lib/storage";

/**
 * Which Email properties to put in the payload, best first.
 *
 * `id` and `threadId` have to be asked for: Stalwart sends only the
 * properties named here (0.16.22). Without them a notification could not be
 * tagged by message, carried no Archive or Mark-read button, and opened the
 * inbox rather than the message -- and because `sw.js` draws its buttons only
 * for a payload that names an `id`, leaving them out meant the buttons it is
 * written to show never appeared at all.
 */
const PAYLOAD_PROPS = ["id", "threadId", "from", "subject", "preview", "receivedAt"];

export interface JmapPushSubscription {
  id: Id;
  deviceClientId: string;
  /**
   * Write-only in practice: Stalwart never hands it back, so a row read from
   * the server has none (`url: null` even for one registered with a URL -- live
   * on 0.16.21, 2026-09-14). Optional rather than required, because required
   * would be a claim that reading a row gives a URL, and the whole reason a row
   * is recognised by its `deviceClientId` is that it does not.
   */
  url?: string;
  expires: string | null;
  verificationCode?: string | null;
}

/** The VAPID key this server signs with, or null if it does not do Web Push. */
export function applicationServerKey(): string | null {
  const cap = client.session?.capabilities?.[CAP.webpushVapid] as
    | { applicationServerKey?: string }
    | undefined;
  return typeof cap?.applicationServerKey === "string" ? cap.applicationServerKey : null;
}

/** Whether the payload can carry the message, rather than only "something changed". */
export function supportsEmailPush(): boolean {
  return Boolean(
    client.session?.capabilities && CAP.emailpush in client.session.capabilities,
  );
}

/**
 * Why background notifications cannot be offered here, as a code.
 *
 * A boolean was not enough to say anything useful. On iOS a browser that has
 * never been added to the Home Screen has no `PushManager` at all, and reading
 * that as "this browser does not support it" tells somebody to give up one tap
 * away from the fix. The surface composes the sentence; this names the
 * obstacle, so the same answer cannot be worded two ways.
 */
export type WebPushBlocker = "unsupported-browser" | "needs-install" | "no-server-key";

export function webPushBlocker(): WebPushBlocker | null {
  if (typeof navigator === "undefined" || typeof window === "undefined")
    return "unsupported-browser";
  if ("serviceWorker" in navigator && "PushManager" in window) {
    return applicationServerKey() === null ? "no-server-key" : null;
  }
  // No PushManager is not the same answer everywhere: on iOS it is the install
  // that is missing, and it is one the reader can complete.
  return isIOS() ? "needs-install" : "unsupported-browser";
}

/** Whether this browser and this server can do Web Push at all. */
export function webPushAvailable(): boolean {
  return webPushBlocker() === null;
}

/**
 * The VAPID key as the Push API wants it.
 *
 * It arrives base64url and unpadded; `atob` needs standard base64 with padding.
 * Getting this wrong fails at subscribe() with an opaque error, which is the
 * sort of thing worth doing in one place with a name.
 */
export function decodeApplicationServerKey(key: string): ArrayBuffer {
  const padded =
    key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (key.length % 4)) % 4);
  const raw = atob(padded);
  // An ArrayBuffer rather than a Uint8Array: TypeScript 5.7 types the latter
  // over ArrayBufferLike, which no longer satisfies BufferSource, and
  // subscribe() wants a BufferSource.
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return buffer;
}

/**
 * Base64url, unpadded — the form the W3C Push API produces for its keys.
 *
 * Stalwart 0.16 accepts unpadded keys, so this deliberately does not pad:
 * sending what the browser gave us is the shape the server handles, and
 * re-padding would be inventing one nobody tested.
 */
export function encodeKey(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The id this browser is known by at the server, and stable for its session.
 *
 * Stable matters twice over: the registration sends it, and the release before
 * a new registration matches on it (`releaseThisDevice`). An id that changed
 * per call would make that release a silent no-op and let the account's
 * fifteen slots fill with rows nothing can match.
 *
 * A trusted device stores one in `localStorage` so it survives restarts. An
 * untrusted device gets a per-session id instead of a stored one -- the same
 * trade private mode makes -- and a storage that throws (private mode) falls
 * back to one made here, held for the life of the tab rather than refreshed on
 * every call.
 */
let fallbackDeviceId: string | null = null;
export function deviceClientId(): string {
  const KEY = "gilbert:pushDeviceId";
  if (!isDeviceTrusted())
    return (fallbackDeviceId ??= gilbertDeviceClientId(crypto.randomUUID()));
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const made = gilbertDeviceClientId(crypto.randomUUID());
    localStorage.setItem(KEY, made);
    return made;
  } catch {
    return (fallbackDeviceId ??= gilbertDeviceClientId(crypto.randomUUID()));
  }
}

/**
 * What to send Stalwart for a browser subscription.
 *
 * `inboxId` is the Inbox's mailbox id. It is a parameter rather than something
 * looked up here because an `inMailbox` condition needs a real id: the first
 * version of this passed `null`, meaning "the inbox" in the author's head and
 * nothing at all to the server, which answered "Invalid filter" and refused the
 * whole subscription. Without an id the filter simply leaves `inMailbox` out
 * and notifies more widely, which is a worse default but a working one.
 *
 * What this answers is read from Stalwart's own source at v0.16.22 rather than
 * from a running server (ADR 0016): a subscription is stored in the account
 * that asked for it and registered for every account in that token's
 * `member_ids()` -- its own plus its group mailboxes -- while `emailPush` is a
 * **map** with one entry per account, each with its own filter, and the entry
 * for an account the token is not a member of is refused `forbidden`. So the
 * reader's own account is where one row lives and where each group is named
 * inside it, which is what this builds: one `emailPush` entry per target
 * account, the account's Inbox as its filter's `inMailbox`. What a running
 * server still has to say is written down where the record keeps its debt.
 *
 * ADR-0016 OWED: live-emailpush-map
 * ADR-0016 OWED: group-emailpush-payload
 * ADR-0016 OWED: chat-wake-read
 * ADR-0016 OWED: verification-per-device
 * ADR-0016 OWED: degraded-statechange-type
 */
export function subscriptionPayload(
  sub: PushSubscription,
  targets: ReadonlyArray<PushTarget>,
  watchChat = false,
): Record<string, unknown> {
  const json = sub.toJSON();
  const body: Record<string, unknown> = {
    deviceClientId: deviceClientId(),
    url: sub.endpoint,
    keys: {
      p256dh: json.keys?.p256dh ?? encodeKey(sub.getKey("p256dh")),
      auth: json.keys?.auth ?? encodeKey(sub.getKey("auth")),
    },
    /*
     * New mail, and chat where the reader has a group to be woken for.
     *
     * `EmailDelivery` changes only when a message is delivered. `Email`
     * changes on every read, flag and move, from any client, and each of
     * those arrived here as a push the worker could only show as "New mail"
     * -- the app has its own event stream while it is open, so this channel
     * exists for when it is not. A subscription carrying an `emailPush` filter
     * is sent a delivery as an `EmailPush` alone, so what the filter describes
     * does not arrive twice.
     *
     * `FileNode` is named only when the reader is in at least one group, which
     * is where chat lives: a `FileNode` change is the only wake-up a chat
     * message produces, because `emailpush` has no vocabulary for a file. It
     * wakes the device for every file write in every account the subscription
     * serves -- an upload, an agent document, the reader's own settings -- and
     * the worker's read is what turns the chat ones into a notification and
     * the rest into nothing (ADR 0016). A reader in no group asks for neither.
     *
     * A delivery with no `emailPush` entry describing its account -- a group
     * mailbox, today -- is degraded to a state change instead, and whether that
     * state change wears this same name is a fact only a live server can settle
     * (ADR 0016, `degraded-statechange-type`). If it does not, a group delivery
     * stops waking this device rather than merely losing its sender, which is
     * why the question is written down rather than assumed.
     */
    types: watchChat ? ["EmailDelivery", "FileNode"] : ["EmailDelivery"],
  };
  if (supportsEmailPush()) {
    /*
     * One entry per account the subscription serves -- the reader's own and
     * every group mailbox -- each with its own Inbox filter (ADR 0016). The map
     * is what makes a delivery to a group arrive as an `EmailPush` that names
     * it, rather than a bare `StateChange`. An account whose Inbox id is not
     * yet known gets **no** entry: an entry carries that account's own Inbox
     * filter, and without one the delivery stays a `StateChange`, which the
     * worker notifies generically and names from the briefing. `sw.js` reads
     * the same `inboxId` to tell the two apart, so the two must agree.
     */
    const emailPush: Record<string, unknown> = {};
    for (const t of targets) {
      if (!t.inboxId) continue;
      emailPush[t.accountId] = {
        filter: { inMailbox: t.inboxId, notKeyword: "$seen" },
        properties: PAYLOAD_PROPS,
        urgency: "normal",
      };
    }
    if (Object.keys(emailPush).length) body.emailPush = emailPush;
  }
  return body;
}

/**
 * Whether push was switched on *in this browser*.
 *
 * Device-local on purpose. A subscription is a browser and an endpoint, not an
 * account: turning it on for a phone says nothing about the desktop, and the
 * account-wide settings file is the wrong place to record it. Sign-out forgets
 * it -- `unsubscribeThisDevice` removes it -- which matches sign-out already
 * destroying the subscription itself.
 */
const ENABLED_KEY = "gilbert:pushEnabled";

export function pushEnabledHere(): boolean {
  if (!isDeviceTrusted()) return false;
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPushEnabledHere(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, "1");
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    /* private mode: push will not survive the session there anyway */
  }
}

/**
 * Whether the reader turned background push **off** in this browser.
 *
 * The switch's off is a decision, not an absence: without recording it, the
 * client could not tell "never turned on" from "turned off on purpose", and a
 * start that subscribes a granted browser by itself would resurrect what
 * somebody switched off. Kept across a sign-out (storage's `KEEP_ON_SIGN_OUT`),
 * so the decision outlives the session it was made in.
 */
const OPTOUT_KEY = "gilbert:pushOptOut";

export function pushOptedOutHere(): boolean {
  if (!isDeviceTrusted()) return false;
  try {
    return localStorage.getItem(OPTOUT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPushOptedOutHere(on: boolean): void {
  try {
    if (on) localStorage.setItem(OPTOUT_KEY, "1");
    else localStorage.removeItem(OPTOUT_KEY);
  } catch {
    /* private mode: nothing is remembered there anyway */
  }
}

/**
 * How close to expiry a subscription is re-registered rather than left alone.
 *
 * Two days against a ceiling of seven, so an app opened even once over a
 * weekend keeps its notifications. Renewing is a single idempotent call, so
 * being early costs almost nothing and being late costs everything.
 */
export const RENEW_WITHIN_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * The lifetime asked for when renewing a subscription, and JMAP's ceiling.
 *
 * Seven days, which is what Stalwart grants a new row. A create leaves the
 * lifetime to the server, since the default is this same seven days; an
 * extension has to name one, and naming anything smaller would shorten the row
 * on every renewal.
 */
export const PUSH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * This browser's newest registered row, out of everything the account has.
 *
 * Defined in terms of `mySubscriptions` rather than as its own scan: "this
 * browser's row" means the one with the most time left when there are several
 * -- Stalwart keeps every create (0.16.22, 2026-09-16) -- and two scans that
 * could disagree about which one that is would be a bug waiting for the day the
 * account has two.
 */
export function findSubscription(
  subs: JmapPushSubscription[],
  deviceId: string,
): JmapPushSubscription | null {
  return mySubscriptions(subs, deviceId)[0] ?? null;
}

/**
 * Whether this browser's subscription needs registering again.
 *
 * A JMAP push subscription expires -- seven days is the ceiling -- and it is
 * the client's job to re-register before it does. The Settings switch is not
 * enough on its own: `enableWebPush` is reachable only from there, so a
 * subscription registered once and never revisited goes quiet within a week of
 * being turned on -- and on a phone, where the app is opened for a minute at a
 * time and Settings almost never, that is indistinguishable from the feature
 * not working.
 *
 * An expiry that will not parse counts as needing renewal. It should never
 * happen; if it does, one extra write is the cheaper way to be wrong.
 */
export function needsRenewal(
  subs: JmapPushSubscription[],
  deviceId: string,
  now: number = Date.now(),
): boolean {
  const mine = findSubscription(subs, deviceId);
  if (!mine) return true;
  // No expiry: the server is not going to take it away, so leave it alone.
  if (!mine.expires) return false;
  const at = Date.parse(mine.expires);
  if (Number.isNaN(at)) return true;
  return at - now <= RENEW_WITHIN_MS;
}

export async function listSubscriptions(): Promise<JmapPushSubscription[]> {
  const res = await client.call<GetResponse<JmapPushSubscription>>(
    "PushSubscription/get",
    { ids: null },
    [CAP.core, CAP.webpushVapid],
  );
  return res.list;
}

/**
 * A `PushSubscription/set` refusal, with the server's own type kept.
 *
 * The type is what makes the refusal actionable: `overQuota` means the
 * account's fifteen are spent and something has to be released, where any
 * other type means this registration is simply not going to be made. A plain
 * `Error` carrying only the description left the caller unable to tell them
 * apart.
 */
export class PushSetError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = "PushSetError";
  }
}

export async function createSubscription(
  body: Record<string, unknown>,
): Promise<Id | null> {
  const res = await client.call<SetResponse<JmapPushSubscription>>(
    "PushSubscription/set",
    { create: { s: body } },
    [CAP.core, CAP.webpushVapid, CAP.emailpush],
  );
  const refused = res.notCreated?.s;
  if (refused)
    throw new PushSetError(
      String(refused.type),
      String(refused.description ?? refused.type),
    );
  return (res.created?.s as { id?: Id } | undefined)?.id ?? null;
}

/**
 * Whether a subscription was registered by a browser running Gilbert.
 *
 * The shape is the shared module's (`@gilbert/shared/push`), because
 * gilbertserver reads the same rows from the other side and has to tell a
 * browser's registration from its own: reading that off the `types` a client
 * happens to ask for is how a browser's own row became a deletion candidate on
 * a full quota. One definition, both readers.
 */
export function isBrowserSubscription(s: JmapPushSubscription): boolean {
  return isBrowserDeviceClientId(s.deviceClientId);
}

/**
 * Which subscriptions to release when the account's quota is spent.
 *
 * Stalwart allows fifteen per account and refuses the sixteenth with
 * `overQuota`. Both this app's rows and gilbertserver's own fan-out row spend
 * from that one pool, and a row this app can no longer reach -- a browser whose
 * site data was cleared hands itself a new `deviceClientId` while the old row
 * keeps its slot -- is exactly how a pool fills with nothing serving it. Only
 * another browser's rows are candidates, never this browser's and never the
 * server's: one that was never verified goes first, then the one closest to
 * expiring. A device that loses its subscription this way registers again the
 * next time the app is opened there, because it then finds no row of its own.
 */
export function roomToMake(
  subs: JmapPushSubscription[],
  deviceId: string,
  count = 1,
): Id[] {
  const expiry = (s: JmapPushSubscription) =>
    s.expires ? Date.parse(s.expires) || 0 : Number.MAX_SAFE_INTEGER;
  return subs
    .filter((s) => s.deviceClientId !== deviceId && isBrowserSubscription(s))
    .sort(
      (a, b) =>
        Number(Boolean(a.verificationCode)) - Number(Boolean(b.verificationCode)) ||
        expiry(a) - expiry(b),
    )
    .slice(0, count)
    .map((s) => s.id);
}

export async function destroySubscriptions(ids: Id[]): Promise<void> {
  if (!ids.length) return;
  await client.call<SetResponse<JmapPushSubscription>>(
    "PushSubscription/set",
    { destroy: ids },
    [CAP.core, CAP.webpushVapid],
  );
}

/**
 * This browser's registered rows, the one with the most time left first.
 *
 * Plural because Stalwart keeps every create: a second create under the same
 * `deviceClientId` sits beside the first rather than replacing it (confirmed
 * live on 0.16.22, 2026-09-16). An account therefore holds as many as were ever
 * registered under that identity until each expires.
 */
export function mySubscriptions(
  subs: JmapPushSubscription[],
  deviceId: string,
): JmapPushSubscription[] {
  const left = (s: JmapPushSubscription) =>
    s.expires ? Date.parse(s.expires) || 0 : Number.MAX_SAFE_INTEGER;
  return subs
    .filter((s) => s.deviceClientId === deviceId)
    .sort((a, b) => left(b) - left(a));
}

/**
 * Give a row more time rather than registering another one.
 *
 * Seven days is JMAP's ceiling and what Stalwart grants a new row; the server
 * may shorten what is asked for, and whatever it keeps is what counts. This is
 * the whole reason renewal does not go through a destroy-then-create: that
 * leaves a window in which the account has no subscription at all, and a create
 * that fails inside it leaves a device that is not listening until the next app
 * start. Extending has no window.
 */
export async function extendSubscription(id: Id): Promise<void> {
  const expires = new Date(Date.now() + PUSH_TTL_MS)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const res = await client.call<SetResponse<JmapPushSubscription>>(
    "PushSubscription/set",
    { update: { [id]: { expires } } },
    [CAP.core, CAP.webpushVapid],
  );
  const err = res.notUpdated?.[id];
  if (err) throw new PushSetError(String(err.type), String(err.description ?? err.type));
}

/**
 * The push endpoint this browser last registered with the server.
 *
 * The server never returns a row's URL — `url: null` even for one registered
 * with a URL (live on 0.16.21, 2026-09-14) — so a row cannot be matched by
 * endpoint, and this local note is the only way to tell a row that still points
 * at this browser's endpoint from one made for an endpoint the browser has
 * since replaced. Extending a stale row would leave the account with a
 * subscription that is alive and delivering nowhere.
 */
const ENDPOINT_KEY = "gilbert:pushEndpoint";

export function registeredEndpoint(): string | null {
  try {
    return localStorage.getItem(ENDPOINT_KEY);
  } catch {
    return null;
  }
}

export function rememberEndpoint(endpoint: string | null): void {
  try {
    if (endpoint) localStorage.setItem(ENDPOINT_KEY, endpoint);
    else localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    /* private mode: every start is then a fresh registration, which still works */
  }
}

/**
 * Hand back the code the server pushed.
 *
 * A JMAP push subscription delivers nothing until this round-trip completes —
 * the server sends a code over the channel to prove it reaches this client, and
 * the client echoes it. A subscription left unverified looks registered and is
 * silent, which is the confusing failure worth being explicit about.
 */
export async function verifySubscription(
  id: Id,
  verificationCode: string,
): Promise<void> {
  const res = await client.call<SetResponse<JmapPushSubscription>>(
    "PushSubscription/set",
    { update: { [id]: { verificationCode } } },
    [CAP.core, CAP.webpushVapid],
  );
  const err = res.notUpdated?.[id];
  if (err) throw new Error(String(err.description ?? err.type));
}

/**
 * Destroy every subscription this browser registered at the server.
 *
 * The account's ceiling is fifteen subscriptions and the server keeps one of
 * its own per account, so a re-registration releases what it replaces rather
 * than adding to the pile. Relying on the server to replace by
 * `deviceClientId` is an assumption nothing here can validate -- and it is now
 * known to be false: a live 0.16.22 keeps both rather than replacing
 * (2026-09-16), which is why the mock was changed to keep them too. So the
 * release is done by hand, by the rows this browser can name.
 *
 * Two marks, because one of them can be lost: this browser's `deviceClientId`,
 * and the push endpoint itself (`endpoint`), which is this browser's own
 * subscription and nobody else's. Clearing site data hands the browser a new
 * device id while the old rows keep their slots, and the endpoint is what
 * would still recognise them -- on a server that hands a subscription's `url`
 * back, which a live Stalwart does not (live on 0.16.21, 2026-09-14:
 * `url: null` even for a row registered with one). A browser that cleared its
 * site data therefore leaves a row behind that only an operator's cleanup can
 * free: `scripts/probe-push-subscriptions.mjs`.
 */
export async function releaseThisDevice(endpoint?: string | null): Promise<number> {
  const mine = deviceClientId();
  let released = 0;
  try {
    const doomed = (await listSubscriptions()).filter(
      (s) => s.deviceClientId === mine || Boolean(endpoint && s.url === endpoint),
    );
    await destroySubscriptions(doomed.map((s) => s.id));
    released = doomed.length;
  } catch (err) {
    /* The registration that follows will say so itself if it cannot be made;
       but a release that failed has to be visible, because what it leaves
       behind holds one of the account's fifteen slots. */
    console.warn("[gilbert] push: could not release this browser's subscriptions:", err);
  }
  return released;
}

/** This browser's push endpoint, or null when the browser has none. */
export async function thisEndpoint(): Promise<string | null> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
  } catch {
    return null;
  }
}

/** Remove every subscription this browser registered. Used when signing out. */
export async function unsubscribeThisDevice(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    /* the browser end is gone or was never there; still clear the server end */
  }
  // The release reports its own failures (see `releaseThisDevice`): signing out
  // is not the place to fail over them.
  await releaseThisDevice(await thisEndpoint());
  setPushEnabledHere(false);
}
