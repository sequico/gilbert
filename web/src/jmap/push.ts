import { PUSH_STATE_TYPES } from "@gilbert/shared/push";
import { withBase } from "@/lib/basePath";
import { t } from "@/lib/i18n";
import { apiFetch } from "./client";
import type { Id, StateChange } from "./types";

export type PushListener = (accountId: Id, type: string, newState: string) => void;

/** Connected, trying to connect, or not trying. */
export type PushState = "connected" | "connecting" | "disconnected";

/**
 * How long to wait before opening the stream again.
 *
 * Fixed at one second rather than escalating — the failures that keep a tab off
 * the stream (a deploy, a proxy's idle timeout, a network that just came back)
 * end in seconds, and a heartbeat that never slows down reconnects the instant
 * the server does instead of waiting out a grown-backoff delay. The reachability
 * probe behind each failed attempt rides the same cadence, which is what keeps a
 * blocked stream's catch-up moving.
 */
const PUSH_RETRY_MS = 1000;

/**
 * Everything a tab keeps live, offered to the dispatcher.
 *
 * The one definition for both triggers of the live catch-up: the moment the
 * stream returns after a drop, and the reachability probe that runs while the
 * stream is down. Push plays nothing back to a client that was away — asleep,
 * offline, or behind a connection that dropped — so a tab has to ask for
 * everything it shows. The types come from the list the subscription itself is
 * built from (`PUSH_STATE_TYPES`), never from a hand-picked few: a surface left
 * out here stays stale for as long as the connection looks healthy, which is
 * the one failure nobody notices.
 */
export function catchUpLive(
  accountIds: Iterable<Id>,
  queue: (accountId: Id, type: string) => void,
): void {
  for (const accountId of accountIds) {
    for (const type of PUSH_STATE_TYPES) queue(accountId, type);
  }
}

/**
 * JMAP push over Server-Sent Events (proxied through our server).
 * Emits per-type state changes so stores can refresh incrementally.
 */
class PushManager {
  private es: EventSource | null = null;
  private listeners = new Set<PushListener>();
  private connectionListeners = new Set<
    (state: PushState, reason: string | null) => void
  >();
  /** Called when the connection comes back after a drop, never on the first connect. */
  private reconnectListeners = new Set<() => void>();
  /**
   * Called after every reachability probe, not only when the answer changes.
   *
   * The stream retries every second while down, so a probe every second is what
   * a network that blocks the stream leaves as the only "the server answers"
   * signal — and it has to arrive every time, because the catch-up it triggers
   * is single-flight and coalesces rather than piling up.
   */
  private reachabilityListeners = new Set<(reachable: boolean) => void>();
  /** Whether this connection has already asked the session a question. */
  private authChecked = false;
  /** Whether the current EventSource ever opened; see the error handler. */
  private wasOpen = false;
  private reconnectTimer: number | null = null;
  private stopped = true;
  /** Whether this session has ever had a connection up (reset by stop()). */
  private everConnected = false;
  private lastStates = new Map<string, string>();
  connected = false;
  /**
   * Finer than `connected`, which cannot tell "trying" from "given up".
   * "connecting" covers the first attempt and every retry.
   */
  state: PushState = "disconnected";
  /** Why the stream is not connected, when it is not: the dot says it on hover. */
  private reason: string | null = null;

  start(): void {
    this.stopped = false;
    this.connect();
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.onOnline);
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.es?.close();
    this.es = null;
    this.everConnected = false;
    this.setState("disconnected");
  }

  subscribe(fn: PushListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onConnection(fn: (state: PushState, reason: string | null) => void): () => void {
    this.connectionListeners.add(fn);
    return () => this.connectionListeners.delete(fn);
  }

  /**
   * The answer of the reachability probe behind a failed attempt.
   *
   * `true` means a cheap route answered even though the stream did not open —
   * the stream is blocked, not the line — so a surface that syncs over normal
   * requests has a reason to run. `false` means nothing answered. Fired on
   * every probe, not only on a change.
   */
  onReachability(fn: (reachable: boolean) => void): () => void {
    this.reachabilityListeners.add(fn);
    return () => this.reachabilityListeners.delete(fn);
  }

  /**
   * Fired once when a connection comes back after a drop.
   *
   * JMAP push only delivers changes that happen while the connection is up —
   * nothing is replayed to a client that was asleep, offline or suspended — so
   * a reconnect is the moment to catch up from the state each store last knew.
   * Not fired on the very first connect of a session: the initial load that
   * follows `start()` is the catch-up there, and firing too would double it.
   */
  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn);
    return () => this.reconnectListeners.delete(fn);
  }

  private setState(v: PushState, reason: string | null = null) {
    if (this.state === v && this.reason === reason) return;
    this.state = v;
    this.reason = reason;
    this.connected = v === "connected";
    for (const fn of this.connectionListeners) fn(v, reason);
  }

  /**
   * Why the stream failed, told apart by whether the server answers at all.
   *
   * An `EventSource` error carries no status, so the one cheap question that
   * separates "the network or the server is gone" from "the server closed this
   * stream" is whether another route answers. One request per failed attempt,
   * and the answer is what the dot says on hover.
   */
  private async failureReason(): Promise<string> {
    try {
      await fetch(withBase("/api/health"), { cache: "no-store" });
      this.emitReachability(true);
      return t("the server closed the live-updates stream");
    } catch {
      this.emitReachability(false);
      return t("the server could not be reached");
    }
  }

  /** Tell every listener what the reachability probe just found. */
  private emitReachability(reachable: boolean) {
    for (const fn of this.reachabilityListeners) fn(reachable);
  }

  /*
   * The network is back (a wake from sleep, a tab made visible again, a
   * network change): waiting out the retry timer would make a healthy
   * connection look dead, so the timer is dropped and the next attempt is
   * immediate.
   */
  private retryNow() {
    if (this.stopped || this.es) return;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible") this.retryNow();
  };

  private onOnline = () => {
    this.retryNow();
  };

  private connect(): void {
    if (this.stopped || this.es) return;
    if (this.state !== "connected") this.setState("connecting");
    const url = withBase(`/api/events?types=*&closeafter=no&ping=30`);
    const es = new EventSource(url, { withCredentials: true });
    this.es = es;
    es.onopen = () => {
      this.wasOpen = true;
      this.authChecked = false;
      this.setState("connected");
      // After the state, so a reachability listener does not read this as a
      // blocked stream that still needs the probe-driven catch-up.
      this.emitReachability(true);
      if (!this.everConnected) {
        this.everConnected = true;
        return;
      }
      // A connection is back after a drop: everything that changed while it
      // was down was missed, so listeners catch up from their last state.
      for (const fn of this.reconnectListeners) fn();
    };
    es.addEventListener("state", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data as string) as StateChange;
        if (data["@type"] !== "StateChange") return;
        for (const [accountId, types] of Object.entries(data.changed)) {
          for (const [type, state] of Object.entries(types)) {
            const key = `${accountId}/${type}`;
            if (this.lastStates.get(key) === state) continue;
            this.lastStates.set(key, state);
            for (const fn of this.listeners) fn(accountId, type, state);
          }
        }
      } catch {
        /* ignore malformed */
      }
    });
    es.addEventListener("ping", () => {
      /* keepalive */
    });
    es.onerror = () => {
      // A drop and a first-attempt failure are the same thing here: close and
      // retry on a fixed one-second heartbeat, for as long as the tab is open.
      const opened = this.wasOpen;
      this.wasOpen = false;
      es.close();
      this.es = null;
      if (this.stopped) {
        this.setState("disconnected");
        return;
      }
      /*
       * A session that ended while a tab sat open leaves the stream failing for
       * ever: the browser sees a connection error, never a 401, so the tab sits
       * on "connecting" and never reaches the sign-in screen. One probe of a
       * cheap route tells the two apart -- `apiFetch` signs the client out on a
       * 401, which takes this stream down with it -- and it is asked once per
       * connection rather than on every retry.
       */
      if (opened && !this.authChecked) {
        this.authChecked = true;
        void apiFetch("/api/config").catch(() => undefined);
      }
      // A retry is already scheduled below, so this is "trying", not "given up".
      this.setState("connecting");
      void this.failureReason().then((why) => {
        if (!this.stopped && this.state !== "connected") this.setState("connecting", why);
      });
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, PUSH_RETRY_MS);
    };
  }
}

export const push = new PushManager();
