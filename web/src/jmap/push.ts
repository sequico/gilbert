import { withBase } from "@/lib/basePath";
import type { Id, StateChange } from "./types";

export type PushListener = (accountId: Id, type: string, newState: string) => void;

/** Connected, trying to connect, or not trying. */
export type PushState = "connected" | "connecting" | "disconnected";

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

  private onVisibility = () => {
    if (document.visibilityState === "visible" && !this.es && !this.stopped)
      this.connect();
  };

  private onOnline = () => {
    if (!this.es && !this.stopped) this.connect();
  };

  private connect(): void {
    if (this.stopped || this.es) return;
    if (this.state !== "connected") this.setState("connecting");
    const url = withBase(`/api/events?types=*&closeafter=no&ping=30`);
    const es = new EventSource(url, { withCredentials: true });
    this.es = es;
    es.onopen = () => {
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
      es.close();
      this.es = null;
      if (this.stopped) {
        this.setState("disconnected");
        return;
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
