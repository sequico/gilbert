import { PUSH_STATE_TYPES } from "@gilbert/shared/push";
import { withBase } from "@/lib/basePath";
import { apiFetch } from "./client";
import type { Id, StateChange } from "./types";

export type PushListener = (accountId: Id, type: string, newState: string) => void;

/** Connected, trying to connect, or not trying. */
export type PushState = "connected" | "connecting" | "disconnected";

/**
 * Everything a tab keeps live, offered to the dispatcher after a reconnect.
 *
 * Push plays nothing back to a client that was away — asleep, offline, or
 * behind a connection that dropped — so a tab that comes back has to ask for
 * everything it shows, and the moment the connection returns is the only
 * moment left to fetch the gap. The types come from the list the subscription
 * itself is built from (`PUSH_STATE_TYPES`), never from a hand-picked few: a
 * surface left out here stays stale for as long as the connection looks
 * healthy, which is the one failure nobody notices.
 */
export function catchUpAfterReconnect(
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
  private connectionListeners = new Set<(state: PushState) => void>();
  /** Called when the connection comes back after a drop, never on the first connect. */
  private reconnectListeners = new Set<() => void>();
  private backoff = 1000;
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
   * "connecting" covers the first attempt and every backoff retry.
   */
  state: PushState = "disconnected";

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

  onConnection(fn: (state: PushState) => void): () => void {
    this.connectionListeners.add(fn);
    return () => this.connectionListeners.delete(fn);
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

  private setState(v: PushState) {
    if (this.state === v) return;
    this.state = v;
    this.connected = v === "connected";
    for (const fn of this.connectionListeners) fn(v);
  }

  /*
   * The network is back (a wake from sleep, a tab made visible again, a
   * network change): waiting out an accumulated backoff would make a healthy
   * connection look dead, so the timer is dropped and the next attempt is
   * immediate from the 1 s base.
   */
  private retryNow() {
    if (this.stopped || this.es) return;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoff = 1000;
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
      this.backoff = 1000;
      this.setState("connected");
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
      // An error on a stream that had opened is most likely a server-side
      // close (a deploy, a timeout): those are not the outage exponential
      // backoff exists for, so the next attempt starts from the 1 s base.
      // Failures while still trying to connect keep doubling, capped at 60 s.
      const opened = this.wasOpen;
      this.wasOpen = false;
      es.close();
      this.es = null;
      if (this.stopped) {
        this.setState("disconnected");
        return;
      }
      if (opened) this.backoff = 1000;
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
      const delay = Math.min(this.backoff, 60_000);
      this.backoff = Math.min(this.backoff * 2, 60_000);
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
  }
}

export const push = new PushManager();
