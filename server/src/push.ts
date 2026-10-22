/**
 * Push by subscription: hold no upstream connection per tab.
 *
 * Today every signed-in tab holds a Server-Sent Events stream to Gilbert,
 * and Gilbert holds a matching stream to Stalwart behind it. The upstream
 * one is most of what a tab costs -- measured, 81 KiB of TLS state plus the
 * request objects -- and it is also the only reason Stalwart's connection
 * limit applies to Gilbert at all.
 *
 * RFC 8620 §7.2 defines the other transport: a PushSubscription, where the
 * server POSTs StateChange objects to a URL the client registers. Stalwart
 * implements it. So Gilbert registers one subscription per *account*, and
 * when Stalwart POSTs a change, fans it out to that account's open tabs over
 * the browser-facing streams it already holds. Nothing is held upstream.
 *
 * A tab is not limited to the accounts it is a member of: the installation's
 * own account is written by the Master and read by nobody else's credential,
 * so a member's subscription never covers it, and a tab that must hear it
 * follows it here instead (`followAccount`). The subscription is the
 * installation's, created with the credential the deployment already holds,
 * and what a tab receives is the StateChange as Stalwart sent it -- an
 * account and a state, never data.
 *
 * Nothing here is taken from any other client's implementation; the shapes
 * are the RFC's.
 *
 * The subscription URL must be https and Stalwart must trust its
 * certificate -- the RFC requires the scheme and Stalwart enforces it. Where
 * that is not the case the subscription never verifies, and the account
 * stays on the per-tab relay it uses today. Both paths coexist; the
 * transition loses no events, because a tab opened before verification keeps
 * its own relay for its whole life.
 */
import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { config } from "./config.js";
import { CAPABILITIES } from "./shared/capabilities.js";
import { errorMessage } from "./shared/errors.js";
import {
  GILBERT_DEVICE_PREFIX,
  gilbertDeviceClientId,
  isBrowserDeviceClientId,
  PUSH_STATE_TYPES,
} from "./shared/push.js";
import { absoluteUpstream, getUpstreamSession, upstreamFor } from "./upstream.js";

const USING = [CAPABILITIES.core, CAPABILITIES.mail];
const RENEW_BEFORE_MS = 60 * 60_000; // renew an hour before Stalwart expires it
const VERIFY_TIMEOUT_MS = 3 * 60_000; // Stalwart's first attempt waits 60 s; allow retries
const SWEEP_MS = 30_000;
/**
 * How long a failed subscription stays failed before the sweeper tries to
 * re-subscribe. A failure is never terminal while a tab still wants the
 * account: without the retry, one failed renewal (or one lost verification
 * POST) parked the account on per-tab relays for as long as a tab stayed
 * open, and the fan-out tabs already attached kept a healthy-looking SSE
 * stream whose upstream subscription was expiring unrenewed.
 */
const SUBSCRIBE_RETRY_MS = 5 * 60_000;
/**
 * How long we ask Stalwart to keep a subscription.
 *
 * A lapsed subscription is not a lost notification -- the account is served by
 * the per-tab relay instead -- so the ceiling is only a bound on how long a
 * subscription nobody owns any more can hold one of the account's slots. That
 * is what a deploy that is killed rather than shut down leaves behind, and
 * "frees itself in a day" is worth an extra renewal a day while tabs are open.
 */
const TTL_MS = 24 * 60 * 60_000;
/**
 * How often a subscription this process believes in is confirmed to still
 * exist.
 *
 * A subscription can be destroyed by something that is not this process: an
 * operator's cleanup, another deployment under the same callback, the account
 * being trimmed by hand. Nothing tells us when that happens, and the failure
 * is of the worst kind -- the entry stays "verified", so its tabs hold a
 * stream that looks healthy and will never carry another change, which is the
 * state `endStaleFanout` exists to end. Asking is one small request.
 */
const LIVENESS_MS = 2 * 60_000;
/**
 * How much a fan-out tab may have queued before the sweeper drops it.
 *
 * A StateChange frame is a few hundred bytes and a keep-alive is ten, so this
 * is thousands of frames -- far past anything a tab that is reading accrues
 * between two sweeps. It is only reached by a socket that has stopped draining,
 * where every further frame would sit in this process's memory for as long as
 * the tab stays open: one browser that stops reading would otherwise queue the
 * account's whole change stream indefinitely.
 */
const TAB_BACKLOG_BYTES = 256 * 1024;

interface AccountPush {
  key: string; // upstream base + username
  username: string;
  accountId: string;
  base: string;
  /** The https origin Stalwart POSTs back to, derived from the request that started it. */
  origin: string;
  token: string; // what Stalwart puts in the URL
  /**
   * What Stalwart is told this subscription's device is: this *installation*,
   * not this process.
   *
   * Derived from what the deployment is configured with, so it is the same
   * value after a restart as before it -- which is what lets a restart release
   * its predecessor's subscription instead of adding to the account's fifteen
   * slots. Its own value, not a slice of the token: the token is the only
   * thing authenticating the callback URL, and what Stalwart records about the
   * subscription is not the place for a piece of it.
   */
  deviceId: string;
  /** Why the last attempt failed, for /api/health. Cleared on success. */
  lastFailure: string | null;
  /** When the subscription was last confirmed to exist (see LIVENESS_MS). */
  checkedAt: number;
  authorization: string; // one live session's credential, for set/verify/renew
  subscriptionId: string | null;
  /**
   * The subscription attempt in flight for this account, if any.
   *
   * A verification can arrive while the create is still running: Stalwart posts
   * it as soon as the subscription exists, and the id the code is applied to is
   * assigned when the answer is read. A verification that arrives in that
   * window waits on this instead of being refused -- the id is an answer still
   * owed, not a refusal.
   */
  subscribing: Promise<void> | null;
  state: "pending" | "verified" | "failed";
  since: number;
  expires: number;
  tabs: Set<ServerResponse>;
  /** Tabs still on the per-tab relay, with the hook that ends their upstream request. */
  relays: Map<ServerResponse, () => void>;
}

/**
 * The largest notification Stalwart may send us.
 *
 * A StateChange names the accounts whose data moved and a PushVerification
 * carries a code: neither is near this size, and every byte of one is written
 * to every open tab of the account, so the ceiling is here rather than left to
 * whoever reads the request. The push route checks the declared length first
 * with the same number; `receive` bounds what it is actually handed.
 */
export const MAX_PUSH_BODY_BYTES = 64 * 1024;

const byKey = new Map<string, AccountPush>();
const byToken = new Map<string, AccountPush>();
let sweeper: NodeJS.Timeout | null = null;

/**
 * Tabs whose last `write()` reported a full buffer.
 *
 * A `false` from `write()` only means the socket has not drained the write it
 * was just handed, which a tab that is reading clears within a moment. Acting
 * on it immediately would drop a healthy tab on a single slow frame, so the
 * signal is remembered here and the sweeper decides: a tab still over
 * `TAB_BACKLOG_BYTES` a sweep later is one that has stopped reading.
 */
const backedUp = new WeakSet<ServerResponse>();

/**
 * Attach a tab to an account's fan-out, and un-attach it whenever it goes.
 *
 * Both the clean close and a socket error leave the same thing behind -- a
 * dead `ServerResponse` in `entry.tabs` -- so both drop the tab; without the
 * error half, a stream that fails rather than closing keeps being written to
 * for the life of the entry.
 */
function addFanoutTab(entry: AccountPush, out: ServerResponse): void {
  entry.tabs.add(out);
  const gone = () => {
    entry.tabs.delete(out);
    backedUp.delete(out);
  };
  out.on("close", gone);
  out.on("error", gone);
}

/**
 * Drop one fan-out tab that has stopped reading, and let it reconnect.
 *
 * Closing the stream is what makes the browser open a fresh one -- on the
 * relay, or on a fresh fan-out -- and the memory the tab's queue was holding
 * goes with it. `destroy` rather than `end`: the socket is not draining, so an
 * orderly end would only queue one more thing behind the backlog.
 */
function dropTab(entry: AccountPush, out: ServerResponse, why: string): void {
  entry.tabs.delete(out);
  backedUp.delete(out);
  if (!out.destroyed) out.destroy();
  console.warn(`[gilbert] push: dropped a tab of ${entry.username} (${why})`);
}

export function pushEnabled(): boolean {
  return config.pushMode === "subscribe";
}

function keyFor(base: string, username: string) {
  return `${base} ${username}`;
}

async function jmap(entry: AccountPush, calls: unknown[]) {
  const upstream = await getUpstreamSession(entry.key, entry.authorization, entry.base);
  const res = await fetch(absoluteUpstream(upstream.apiUrl, upstream.baseUrl), {
    method: "POST",
    headers: {
      authorization: entry.authorization,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ using: USING, methodCalls: calls }),
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return (await res.json()) as {
    methodResponses: [string, Record<string, unknown>, string][];
  };
}

/**
 * The installation's identity: its Stalwart, its base path, and the origin it
 * is reached on.
 *
 * Stable across restarts -- which is what lets a restart release its
 * predecessor's subscription instead of adding to the account's fifteen slots
 * -- and distinct from another deployment's, staging beside production
 * included. Two *processes* of one deployment share it: that is one device by
 * this reckoning, which is what makes a restart replace rather than pile up,
 * and it also means two replicas running at the same time are indistinguishable
 * here. This deployment runs one (`docker-compose.yml`), and a deployment that
 * wants several needs an identity per process as well as per installation.
 */
function deviceIdFor(base: string, origin: string): string {
  return createHash("sha256")
    .update(`${base}|${config.basePath}|${origin}`)
    .digest("base64url")
    .slice(0, 16);
}

/**
 * The rows this installation owns by name: the one it is holding, and any
 * carrying its own device identity (a predecessor's, after a restart).
 *
 * Deliberately not "anything under our callback URL" -- that is how a running
 * peer beside this process would be killed, and the peer would never learn:
 * its entry would stay "verified" until the subscription it no longer has
 * expires. See `reclaimPastBuilds`, which is the one place that breadth is
 * wanted.
 */
function isMine(entry: AccountPush, sub: UpstreamSubscription): boolean {
  return (
    sub.id === entry.subscriptionId ||
    sub.deviceClientId === gilbertDeviceClientId(entry.deviceId)
  );
}

/**
 * What an earlier build left behind: a row wearing a Gilbert device id that is
 * neither this installation's own nor a browser's registration.
 *
 * The URL would have named it, and Stalwart does not return it -- a
 * `PushSubscription/get` answers `url: null` even for a row registered with one
 * (live on 0.16.21, 2026-09-14) -- so the device id is what is left, and the
 * shape separates the two kinds exactly: this installation derives a
 * sixteen-character identity, a browser makes a random UUID
 * (`isBrowserDeviceClientId`). The types are deliberately not consulted: a
 * browser may change what it subscribes to, and reading the row's owner off
 * that once made a browser's own registration a candidate for deletion here.
 *
 * Used only when a create has been *refused* for want of a slot -- never on the
 * path that renews or releases.
 */
function isPastBuildOfOurs(entry: AccountPush, sub: UpstreamSubscription): boolean {
  const id = sub.deviceClientId ?? "";
  if (id === gilbertDeviceClientId(entry.deviceId)) return false;
  return id.startsWith(GILBERT_DEVICE_PREFIX) && !isBrowserDeviceClientId(id);
}

interface UpstreamSubscription {
  id: string;
  deviceClientId?: string;
  /**
   * Stalwart does not hand this back: a `PushSubscription/get` answers
   * `url: null` even for a row registered with one (live on 0.16.21,
   * 2026-09-14), which is why nothing here matches on it.
   */
  url?: string | null;
  expires?: string | null;
  /**
   * What the subscription was registered for.
   *
   * Part of the row's shape and deliberately not read to tell one owner from
   * another: a client may change what it subscribes to, and the two kinds of
   * row are told apart by their device id (`isBrowserDeviceClientId`).
   */
  types?: string[] | null;
}

/**
 * The account's subscriptions, as Stalwart hands them over.
 *
 * A method-level `error` is a failure, not an empty list: reading it as
 * "nothing of ours" is how a release turns into a silent no-op while the
 * account stays full.
 */
async function listSubscriptions(entry: AccountPush): Promise<UpstreamSubscription[]> {
  const r = await jmap(entry, [["PushSubscription/get", { ids: null }, "0"]]);
  const [name, payload] = r.methodResponses[0] ?? [];
  if (name === "error")
    throw new Error(
      `PushSubscription/get: ${(payload as { description?: string; type?: string }).description ?? (payload as { type?: string }).type ?? "error"}`,
    );
  const list = (payload as { list?: UpstreamSubscription[] } | undefined)?.list;
  if (!list) throw new Error("PushSubscription/get: no list in the response");
  return list;
}

/** Destroy one subscription by id, best effort. */
async function destroySubscription(entry: AccountPush, id: string): Promise<void> {
  try {
    await jmap(entry, [["PushSubscription/set", { destroy: [id] }, "0"]]);
  } catch (err) {
    console.warn(
      `[gilbert] push: could not destroy subscription ${id} for ${entry.username}: ${errorMessage(err)}`,
    );
  }
}

/** Destroy those of `subs` this installation owns by name. */
async function releaseMine(entry: AccountPush): Promise<number> {
  let mine: UpstreamSubscription[] = [];
  try {
    mine = (await listSubscriptions(entry)).filter((s) => isMine(entry, s));
  } catch (err) {
    console.warn(
      `[gilbert] push: could not list subscriptions for ${entry.username}: ${errorMessage(err)}`,
    );
    return 0;
  }
  if (!mine.length) return 0;
  try {
    await jmap(entry, [
      ["PushSubscription/set", { destroy: mine.map((s) => s.id) }, "0"],
    ]);
    return mine.length;
  } catch (err) {
    console.warn(
      `[gilbert] push: could not release ${mine.length} subscription(s) for ${entry.username}: ${errorMessage(err)}`,
    );
    return 0;
  }
}

/**
 * Take back the slots this installation's earlier builds are holding.
 *
 * Only for the case that asks for it: a create refused for want of a slot,
 * where our own leftovers are the cheapest thing to give up and the only thing
 * we can recognise at all. What an earlier build left is a row under a random
 * `gilbert-…` device id, and `isPastBuildOfOurs` is the whole of the
 * recognition -- the rows that filled one account to `overquota` and had to be
 * cleared by hand before a create could go through again (KNOWN-ISSUES).
 */
async function reclaimPastBuilds(entry: AccountPush): Promise<number> {
  let ours: UpstreamSubscription[] = [];
  try {
    ours = (await listSubscriptions(entry)).filter((s) => isPastBuildOfOurs(entry, s));
  } catch (err) {
    console.warn(
      `[gilbert] push: could not list subscriptions for ${entry.username}: ${errorMessage(err)}`,
    );
    return 0;
  }
  if (!ours.length) return 0;
  try {
    await jmap(entry, [
      ["PushSubscription/set", { destroy: ours.map((s) => s.id) }, "0"],
    ]);
    return ours.length;
  } catch (err) {
    console.warn(
      `[gilbert] push: could not reclaim ${ours.length} subscription(s) for ${entry.username}: ${errorMessage(err)}`,
    );
    return 0;
  }
}

async function subscribe(entry: AccountPush): Promise<void> {
  const attempt = subscribeOnce(entry);
  entry.subscribing = attempt;
  try {
    await attempt;
  } finally {
    if (entry.subscribing === attempt) entry.subscribing = null;
  }
}

async function subscribeOnce(entry: AccountPush) {
  const url = `${entry.origin}${config.basePath}/api/push/${entry.token}`;
  // Every type a surface keeps live, for every account. The list is the one
  // the relay's `types=*` already covers, so which transport a deployment is
  // on does not decide which parts of the app update. See PUSH_STATE_TYPES.
  const types = [...PUSH_STATE_TYPES];
  /* Released before it is recreated: the subscription is the installation's,
     one per account, and this is what keeps that true across restarts. By name
     only -- `reclaimPastBuilds` is the one caller that reaches wider, and only
     when this create comes back refused. */
  const released = await releaseMine(entry);
  if (released)
    console.log(
      `[gilbert] push: released ${released} subscription(s) of this installation for ${entry.username}`,
    );
  /* `expires` is asked for rather than left to the server's default: the TTL is
     what bounds how long an orphan holds a slot (see TTL_MS). It is also the
     one property here taken on trust -- nothing in this tree has watched
     Stalwart 0.16 accept it -- so a server that refuses it gets the create
     again without it rather than no subscription at all. */
  const ask = (withExpiry: boolean) => ({
    deviceClientId: gilbertDeviceClientId(entry.deviceId),
    url,
    types,
    ...(withExpiry ? { expires: new Date(Date.now() + TTL_MS).toISOString() } : {}),
  });
  const send = (withExpiry: boolean) =>
    jmap(entry, [["PushSubscription/set", { create: { s: ask(withExpiry) } }, "0"]]);

  let created: { id: string; expires?: string } | undefined;
  let detail = "no reason given";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await send(attempt === 0 || !/expires/i.test(detail));
    const [name, payload] = r.methodResponses[0] ?? [];
    const body = payload as
      | {
          created?: Record<string, { id: string; expires?: string }>;
          notCreated?: Record<string, { type?: string; description?: string }>;
        }
      | undefined;
    created = name === "error" ? undefined : body?.created?.s;
    if (created) break;
    /* Stalwart says why -- `overquota` when the account's fifteen slots are
       gone, `invalidProperties` when it disliked something -- and a client
       that throws "not created" throws away the only diagnosis there is. */
    const why =
      name === "error"
        ? (payload as { type?: string; description?: string })
        : body?.notCreated?.s;
    detail = why
      ? `${why.type ?? "refused"}${why.description ? `: ${why.description}` : ""}`
      : "no reason given";
    if (/expires/i.test(detail) && attempt === 0) continue;
    if (!/overquota/i.test(detail) || attempt > 0) break;
    /* The slots are gone and the rows earlier builds left are the cheapest
       thing to give up: they are the only ones we can recognise at all. */
    const freed = await reclaimPastBuilds(entry);
    if (freed)
      console.log(
        `[gilbert] push: reclaimed ${freed} subscription(s) left by an earlier build for ${entry.username}`,
      );
    else break;
  }
  if (!created) throw new Error(`subscription not created (${detail})`);
  /*
   * The entry can be torn down while this create is in flight: the sweeper
   * removes an account nobody wants any more (`runSweep`). The id this call
   * just minted then belongs to no entry, and adopting it here would leave it
   * holding one of the account's slots until its own TTL. Give it straight
   * back instead.
   */
  if (byKey.get(entry.key) !== entry) {
    await destroySubscription(entry, created.id);
    return;
  }
  entry.subscriptionId = created.id;
  entry.expires = created.expires ? Date.parse(created.expires) : Date.now() + TTL_MS;
  entry.lastFailure = null;
}

async function verify(entry: AccountPush, code: string) {
  const id = entry.subscriptionId;
  /*
   * The id is minted by `subscribe`, and a verification POST can race it: a
   * code against no subscription has nothing to verify, and keying the update
   * on `null` asks Stalwart to update the subscription named "null".
   */
  if (!id) throw new Error("no subscription to verify yet");
  const r = await jmap(entry, [
    ["PushSubscription/set", { update: { [id]: { verificationCode: code } } }, "0"],
  ]);
  /*
   * The answer decides, not the HTTP status: `jmap` throws only on a non-2xx
   * response, and Stalwart reports a refused update -- a wrong code, a
   * subscription that is gone -- inside a 200 as `notUpdated`, or as a
   * method-level `error`. Reading either as success marks the entry verified
   * while nothing upstream will ever POST to it, which is the failure the
   * liveness check exists to catch, one state too late.
   */
  const [name, payload] = r.methodResponses[0] ?? [];
  const updated = (payload as { updated?: Record<string, unknown> } | undefined)?.updated;
  if (name !== "PushSubscription/set" || !updated || !(id in updated))
    throw new Error(
      `PushSubscription/set did not accept the verification (${name ?? "no response"})`,
    );
  entry.state = "verified";
  // Every tab of this account that has been holding its own upstream stream
  // can now let go of it: the subscription is live, so Stalwart will POST the
  // same changes here. The browser-facing stream is untouched. Done in this
  // order there is no gap -- at worst a change lands twice, which is harmless.
  let moved = 0;
  for (const [out, dropUpstream] of entry.relays) {
    entry.relays.delete(out);
    if (out.destroyed) continue;
    dropUpstream();
    /*
     * A relay that chose to reconnect instead of attaching (the raw relay does:
     * its next request is the one that also follows the installation account)
     * ends its browser stream here. Attaching it would write frames into a
     * closed response.
     */
    if (out.destroyed || out.writableEnded) continue;
    addFanoutTab(entry, out);
    moved++;
  }
  console.log(
    `[gilbert] push: subscription verified for ${entry.username}` +
      (moved ? `, ${moved} tab(s) moved off the relay` : ""),
  );
}

async function unsubscribe(entry: AccountPush) {
  if (entry.subscriptionId) await destroySubscription(entry, entry.subscriptionId);
  byKey.delete(entry.key);
  byToken.delete(entry.token);
}

/**
 * Start (or refresh) the account's subscription. Called at sign-in, so that
 * by the time the browser opens its stream the verification is usually
 * already in flight, and called again by attach() as a safety net.
 */
export function prepare(
  username: string,
  accountId: string,
  authorization: string,
  origin: string | null,
): AccountPush | null {
  // No origin means we could not say where Stalwart should POST back to, and
  // RFC 8620 requires https. The account stays on the per-tab relay instead.
  if (!pushEnabled() || !origin) return null;
  const base = upstreamFor(username);
  const key = keyFor(base, username);
  let entry = byKey.get(key);
  if (!entry) {
    entry = {
      key,
      username,
      accountId,
      base,
      origin,
      token: randomBytes(32).toString("base64url"),
      deviceId: deviceIdFor(base, origin),
      authorization,
      subscriptionId: null,
      state: "pending",
      subscribing: null,
      lastFailure: null,
      checkedAt: 0,
      since: Date.now(),
      expires: 0,
      tabs: new Set(),
      relays: new Map(),
    };
    byKey.set(key, entry);
    byToken.set(entry.token, entry);
    subscribe(entry).catch((err) => {
      fail(entry!, `subscribe failed: ${errorMessage(err)}`);
    });
    startSweeper();
  } else {
    entry.authorization = authorization; // keep a live credential for renewals
    // This request is the freshest statement of where we are reachable, and a
    // renewal re-creates the subscription: a deployment that moved converges
    // on its next renewal rather than staying pinned to its old hostname.
    entry.origin = origin;
  }
  return entry;
}

/**
 * Called when a tab opens. Returns the account's push entry if the tab can
 * be served by fan-out right now, or null if it must hold its own relay.
 */
export function attach(
  username: string,
  accountId: string,
  authorization: string,
  out: ServerResponse,
  origin: string | null,
): AccountPush | null {
  const entry = prepare(username, accountId, authorization, origin);
  if (entry?.state !== "verified") return null;
  addFanoutTab(entry, out);
  return entry;
}

/**
 * A tab that had to start on the relay registers here with the hook that
 * ends its upstream request, so verify() can move it to fan-out later.
 */
export function attachRelay(
  username: string,
  out: ServerResponse,
  dropUpstream: () => void,
): void {
  if (!pushEnabled()) return;
  const entry = byKey.get(keyFor(upstreamFor(username), username));
  if (!entry) return;
  entry.relays.set(out, dropUpstream);
  out.on("close", () => {
    entry.relays.delete(out);
  });
}

/**
 * Have a tab follow an account its own credential does not cover.
 *
 * The step an administrator checks on the installation's checklist is written
 * in the Master's account (ADR 0024), and no member is a member of it, so
 * Stalwart never delivers that change to a member's own subscription -- this
 * fan-out is the only thing that can reach them. One subscription is kept for
 * that account, created with the credential the installation already holds
 * rather than the tab's, and every tab following it is handed the StateChange
 * as it arrived: an account id and a state, no data. A reader answers it by
 * re-reading through its own route, which is what decides what it may see.
 *
 * A tab that arrives before the subscription verifies is parked in `relays`
 * with nothing to give up, so `verify` moves it to the fan-out exactly like a
 * tab that was holding its own upstream stream.
 */
export function followAccount(
  username: string,
  accountId: string,
  authorization: string,
  out: ServerResponse,
  origin: string | null,
): void {
  const entry = prepare(username, accountId, authorization, origin);
  if (!entry) return;
  if (entry.state === "verified") addFanoutTab(entry, out);
  else attachRelay(username, out, () => {});
}

/**
 * A subscription attempt failed. The entry goes back to "failed" with
 * `since` stamped now, which is what the sweeper measures the retry backoff
 * from; verification can still lift it out of that state at any time.
 *
 * Fan-out tabs are deliberately left attached here: the old subscription
 * keeps POSTing changes until its own expiry, and ending the streams early
 * would only push the account onto relays while it may still verify. A
 * subscription that really dies unrenewed is the sweeper's job (see
 * endStaleFanout).
 */
function fail(entry: AccountPush, why: string): void {
  entry.state = "failed";
  entry.since = Date.now();
  entry.lastFailure = why;
  /*
   * A subscription that has just been released and not replaced is one whose
   * tabs are being told nothing. Marking the entry expired is what makes the
   * sweeper end those streams (see `endStaleFanout`), so the browser
   * reconnects on the per-tab relay instead of holding a healthy-looking
   * stream that will never carry another change.
   */
  entry.expires = Date.now();
  entry.subscriptionId = null;
  // The entry may already have been cleaned up while the attempt was in
  // flight; nothing wants the account any more, so the failure is moot.
  if (byKey.get(entry.key) === entry)
    console.warn(
      `[gilbert] push: ${why} for ${entry.username}; retry in ${Math.round(SUBSCRIBE_RETRY_MS / 60_000)} min`,
    );
}

/**
 * End the fan-out streams of an account whose subscription has lapsed while
 * tabs were still attached to it. The tabs' SSE looked healthy -- the
 * sweeper kept pinging them -- while nothing upstream was reaching them any
 * more, so state changes were silently going missing. Ending the response
 * makes the browser reconnect, and the next /api/events lands on the
 * per-tab relay until the account verifies again.
 */
function endStaleFanout(entry: AccountPush): void {
  let n = 0;
  for (const out of [...entry.tabs]) {
    if (out.destroyed) continue;
    out.end();
    n++;
  }
  entry.tabs.clear();
  console.warn(
    `[gilbert] push: subscription for ${entry.username} expired while unverified; ${n} tab(s) back on the relay`,
  );
}

/** Stalwart's POST. Returns an HTTP status. */
export async function receive(token: string, body: unknown): Promise<number> {
  const entry = byToken.get(token);
  if (!entry) return 404;
  /* Measured on the frame a tab would be handed, not on a header: this has to
     hold for whatever the caller passes, and Stalwart's own statement about
     how long the body is has not been checked against what arrived. */
  let json: string;
  try {
    json = JSON.stringify(body) ?? "";
  } catch {
    return 400; // a body that cannot be framed for a tab is not a notification
  }
  if (Buffer.byteLength(json) > MAX_PUSH_BODY_BYTES) return 413;
  const msg = body as { "@type"?: string; verificationCode?: string; changed?: unknown };
  if (msg["@type"] === "PushVerification" && typeof msg.verificationCode === "string") {
    /* Only a subscription we are waiting on can be verified. A code that
       arrives after the entry gave up would revive it as "verified" while the
       subscription it names may be gone -- the sweeper re-subscribes instead,
       and answering 200 stops Stalwart retrying a verification we cannot use. */
    if (entry.state !== "pending") return 200;
    try {
      /* The create mints the id this code belongs to, and Stalwart posts the
         verification as soon as the subscription exists -- which can be while
         that create is still running. A code against an id nobody has read yet
         is an answer we are still owed, so wait for the attempt rather than
         refusing it; once it settles, the state above is re-read by `verify`. */
      if (!entry.subscriptionId && entry.subscribing) await entry.subscribing;
      await verify(entry, msg.verificationCode);
      return 200;
    } catch (err) {
      console.warn(`[gilbert] push: verify failed: ${errorMessage(err)}`);
      return 500;
    }
  }
  if (msg["@type"] === "StateChange") {
    /* Believed only for a verified subscription (RFC 8620 §7.2): while the
       entry is pending or failed, nothing legitimate is being delivered to
       this URL, and writing it to the tabs would hand whoever found the URL a
       way to drive every open tab of the account. */
    if (entry.state !== "verified") return 200;
    const frame = `event: state\ndata: ${json}\n\n`;
    for (const out of entry.tabs) {
      if (out.destroyed) continue;
      // A `false` says the socket is not draining; the sweeper drops the tab if
      // it is still over the ceiling a sweep later (see `TAB_BACKLOG_BYTES`).
      if (!out.write(frame)) backedUp.add(out);
    }
    return 200;
  }
  return 400;
}

/**
 * One sweep pass: keep-alives, renewals, retries, stale fan-out teardown,
 * and cleanup. Runs on the shared timer below; exported so the tests can run
 * a pass on demand without waiting out SWEEP_MS.
 */
export function runSweep(): void {
  if (shuttingDown) return;
  const now = Date.now();
  for (const entry of [...byKey.values()]) {
    for (const out of entry.tabs) {
      if (out.destroyed) {
        entry.tabs.delete(out);
        backedUp.delete(out);
        continue;
      }
      /*
       * A tab whose last write did not drain is given one sweep to catch up;
       * one still over the ceiling now has stopped reading, and dropping it is
       * what keeps its queue from growing for the tab's whole life.
       */
      if (backedUp.has(out)) {
        backedUp.delete(out);
        if (out.writableLength > TAB_BACKLOG_BYTES) {
          dropTab(entry, out, `${out.writableLength} bytes queued`);
          continue;
        }
      }
      if (!out.write(": ping\n\n")) backedUp.add(out);
    }
    if (entry.state === "pending" && now - entry.since > VERIFY_TIMEOUT_MS) {
      fail(entry, `no verification within ${VERIFY_TIMEOUT_MS / 1000}s`);
    } else if (
      entry.state === "failed" &&
      (entry.tabs.size > 0 || entry.relays.size > 0) &&
      now - entry.since >= SUBSCRIBE_RETRY_MS
    ) {
      // Someone still wants this account (a fan-out tab or a relay): try the
      // subscription again. A failed entry nobody wants is removed below.
      entry.state = "pending";
      entry.since = now;
      subscribe(entry).catch((err) => {
        fail(entry, `re-subscribe failed: ${errorMessage(err)}`);
      });
    } else if (entry.state === "verified" && entry.expires - now < RENEW_BEFORE_MS) {
      entry.state = "pending";
      entry.since = now;
      subscribe(entry).catch((err) => {
        fail(entry, `renewal failed: ${errorMessage(err)}`);
      });
    } else if (
      entry.state === "verified" &&
      entry.subscriptionId &&
      now - entry.checkedAt > LIVENESS_MS
    ) {
      /* Still there? A subscription destroyed under us leaves the entry
         believing it is verified, and its tabs reading a stream that carries
         nothing from then on. `checkedAt` is stamped before the ask and left
         there whatever the answer: a check that could not reach the server is
         not a disappearance, so the next look is on the ordinary cadence
         rather than the very next sweep. */
      entry.checkedAt = now;
      const id = entry.subscriptionId;
      jmap(entry, [["PushSubscription/get", { ids: [id] }, "0"]])
        .then((r) => {
          const [name, payload] = r.methodResponses[0] ?? [];
          const gone =
            name === "error" ||
            ((payload as { list?: unknown[] } | undefined)?.list ?? []).length === 0;
          if (!gone || (byKey.get(entry.key) === entry && entry.state !== "verified"))
            return;
          console.warn(
            `[gilbert] push: the subscription for ${entry.username} is gone from the account; its tabs go back on the relay`,
          );
          fail(entry, "the subscription is no longer in the account");
        })
        .catch(() => {
          /* the ask did not reach the server; `checkedAt` stays where it was set */
        });
    }
    // A fan-out tab past its subscription's life hears nothing once the
    // subscription dies unrenewed: end the stream so it reconnects on a relay.
    if (
      entry.state !== "verified" &&
      entry.expires > 0 &&
      entry.expires <= now &&
      entry.tabs.size > 0
    ) {
      endStaleFanout(entry);
    }
    if (
      entry.tabs.size === 0 &&
      entry.relays.size === 0 &&
      (entry.state === "failed" || now - entry.since > 10 * 60_000)
    ) {
      void unsubscribe(entry);
    }
  }
  if (byKey.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/** Set on the way down: the sweeper must not re-subscribe what we just gave back. */
let shuttingDown = false;

/** One shared timer for every tab: keep-alives, renewals, retries, cleanup. */
function startSweeper() {
  if (sweeper || shuttingDown) return;
  sweeper = setInterval(() => runSweep(), SWEEP_MS);
  sweeper.unref();
}

/** For /api/health: how many accounts are on each path. */
export function pushStatus() {
  let verified = 0,
    pending = 0,
    failed = 0,
    tabs = 0,
    relays = 0;
  const failures: string[] = [];
  for (const e of byKey.values()) {
    tabs += e.tabs.size;
    relays += e.relays.size;
    if (e.state === "verified") verified++;
    else if (e.state === "pending") pending++;
    else failed++;
    if (e.state === "failed" && e.lastFailure)
      failures.push(`${e.username}: ${e.lastFailure}`);
  }
  return {
    mode: pushEnabled() ? "subscribe" : "relay",
    accounts: { verified, pending, failed },
    tabs: { fanout: tabs, relay: relays },
    /* Why the accounts that are not on the fast path are not: the question an
       operator asks when notifications are "slow", and the one Stalwart has
       been answering all along without anybody reading it. */
    failures,
  };
}

/**
 * Give up the subscriptions while the credentials that can still destroy them
 * are in hand. Called on the way down, which is what a deploy is: without
 * this, every deploy leaves one subscription per account behind, and enough
 * deploys fill the account's fifteen slots (see `releaseMine`).
 *
 * By name only, and the sweeper is stopped first: a release that reached wider
 * could take a subscription another process is serving from, and a sweeper
 * still armed could put a fresh one back after this release -- leaving the
 * deploy's own orphan, which is the thing this exists to prevent.
 */
export async function releaseOnShutdown(): Promise<void> {
  shuttingDown = true;
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  await Promise.all(
    [...byKey.values()].map(async (entry) => {
      const released = await releaseMine(entry);
      if (released)
        console.log(
          `[gilbert] push: released ${released} subscription(s) for ${entry.username} on shutdown`,
        );
    }),
  );
}
