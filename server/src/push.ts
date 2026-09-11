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
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { config } from "./config.js";
import { PUSH_STATE_TYPES } from "./shared/push.js";
import { absoluteUpstream, getUpstreamSession, upstreamFor } from "./upstream.js";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
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
const RETRY_BACKOFF_MS = 5 * 60_000;

interface AccountPush {
  key: string; // upstream base + username
  username: string;
  accountId: string;
  base: string;
  /** The https origin Stalwart POSTs back to, derived from the request that started it. */
  origin: string;
  token: string; // what Stalwart puts in the URL
  authorization: string; // one live session's credential, for set/verify/renew
  subscriptionId: string | null;
  state: "pending" | "verified" | "failed";
  since: number;
  expires: number;
  tabs: Set<ServerResponse>;
  /** Tabs still on the per-tab relay, with the hook that ends their upstream request. */
  relays: Map<ServerResponse, () => void>;
}

const byKey = new Map<string, AccountPush>();
const byToken = new Map<string, AccountPush>();
let sweeper: NodeJS.Timeout | null = null;

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

async function subscribe(entry: AccountPush) {
  const url = `${entry.origin}${config.basePath}/api/push/${entry.token}`;
  // Every type a surface keeps live, for every account. The list is the one
  // the relay's `types=*` already covers, so which transport a deployment is
  // on does not decide which parts of the app update. See PUSH_STATE_TYPES.
  const types = [...PUSH_STATE_TYPES];
  const r = await jmap(entry, [
    [
      "PushSubscription/set",
      {
        create: {
          s: {
            deviceClientId: `gilbert-${entry.token.slice(0, 8)}`,
            url,
            types,
          },
        },
      },
      "0",
    ],
  ]);
  const first = r.methodResponses[0];
  const created = (
    first?.[1] as
      | { created?: Record<string, { id: string; expires?: string }> }
      | undefined
  )?.created?.s;
  if (!created) throw new Error("subscription not created");
  entry.subscriptionId = created.id;
  entry.expires = created.expires
    ? Date.parse(created.expires)
    : Date.now() + 7 * 86_400_000;
}

async function verify(entry: AccountPush, code: string) {
  await jmap(entry, [
    [
      "PushSubscription/set",
      { update: { [entry.subscriptionId!]: { verificationCode: code } } },
      "0",
    ],
  ]);
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
    entry.tabs.add(out);
    out.on("close", () => {
      entry.tabs.delete(out);
    });
    moved++;
  }
  console.log(
    `[gilbert] push: subscription verified for ${entry.username}` +
      (moved ? `, ${moved} tab(s) moved off the relay` : ""),
  );
}

async function unsubscribe(entry: AccountPush) {
  if (entry.subscriptionId) {
    try {
      await jmap(entry, [
        ["PushSubscription/set", { destroy: [entry.subscriptionId] }, "0"],
      ]);
    } catch {
      /* best effort */
    }
  }
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
      authorization,
      subscriptionId: null,
      state: "pending",
      since: Date.now(),
      expires: 0,
      tabs: new Set(),
      relays: new Map(),
    };
    byKey.set(key, entry);
    byToken.set(entry.token, entry);
    subscribe(entry).catch((err) => {
      fail(entry!, `subscribe failed: ${(err as Error).message}`);
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
  entry.tabs.add(out);
  out.on("close", () => {
    entry.tabs.delete(out);
  });
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
  // The entry may already have been cleaned up while the attempt was in
  // flight; nothing wants the account any more, so the failure is moot.
  if (byKey.get(entry.key) === entry)
    console.warn(
      `[gilbert] push: ${why} for ${entry.username}; retry in ${Math.round(RETRY_BACKOFF_MS / 60_000)} min`,
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
  const msg = body as { "@type"?: string; verificationCode?: string; changed?: unknown };
  if (msg["@type"] === "PushVerification" && typeof msg.verificationCode === "string") {
    try {
      await verify(entry, msg.verificationCode);
      return 200;
    } catch (err) {
      console.warn(`[gilbert] push: verify failed: ${(err as Error).message}`);
      return 500;
    }
  }
  if (msg["@type"] === "StateChange") {
    const frame = `event: state\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const out of entry.tabs) {
      if (!out.destroyed) out.write(frame);
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
  const now = Date.now();
  for (const entry of [...byKey.values()]) {
    for (const out of entry.tabs) {
      if (out.destroyed) entry.tabs.delete(out);
      else out.write(": ping\n\n");
    }
    if (entry.state === "pending" && now - entry.since > VERIFY_TIMEOUT_MS) {
      fail(entry, `no verification within ${VERIFY_TIMEOUT_MS / 1000}s`);
    } else if (
      entry.state === "failed" &&
      (entry.tabs.size > 0 || entry.relays.size > 0) &&
      now - entry.since >= RETRY_BACKOFF_MS
    ) {
      // Someone still wants this account (a fan-out tab or a relay): try the
      // subscription again. A failed entry nobody wants is removed below.
      entry.state = "pending";
      entry.since = now;
      subscribe(entry).catch((err) => {
        fail(entry, `re-subscribe failed: ${(err as Error).message}`);
      });
    } else if (entry.state === "verified" && entry.expires - now < RENEW_BEFORE_MS) {
      entry.state = "pending";
      entry.since = now;
      subscribe(entry).catch((err) => {
        fail(entry, `renewal failed: ${(err as Error).message}`);
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

/** One shared timer for every tab: keep-alives, renewals, retries, cleanup. */
function startSweeper() {
  if (sweeper) return;
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
  for (const e of byKey.values()) {
    tabs += e.tabs.size;
    relays += e.relays.size;
    if (e.state === "verified") verified++;
    else if (e.state === "pending") pending++;
    else failed++;
  }
  return {
    mode: pushEnabled() ? "subscribe" : "relay",
    accounts: { verified, pending, failed },
    tabs: { fanout: tabs, relay: relays },
  };
}
