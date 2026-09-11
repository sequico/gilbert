import { PUSH_STATE_TYPES } from "@gilbert/shared/push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catchUpAfterReconnect, push } from "@/jmap/push";

/**
 * The reconnect contract behind the app's catch-up.
 *
 * jsdom has no EventSource, so the connection is faked: each `connect()`
 * creates an instance, and a test drives it — `open()` for the browser's
 * onopen, `fail()` for the drop that sends EventSource into its backoff
 * retry. What is pinned: onReconnect fires only when a connection comes back
 * after a drop, never on the first connect of a session (the initial load is
 * happening then, and firing would double it), and a `stop()`/`start()` pair
 * — what an account switch does — starts a fresh session rather than being
 * treated as a reconnect.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  private handlers = new Map<string, (ev: MessageEvent) => unknown>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: MessageEvent) => unknown): void {
    this.handlers.set(type, fn);
  }
  removeEventListener(type: string): void {
    this.handlers.delete(type);
  }
  close(): void {
    this.closed = true;
  }

  /** The connection coming up. */
  open(): void {
    this.onopen?.(new Event("open"));
  }
  /** The network dropping the connection. */
  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.instances = [];
  push.stop();
});

afterEach(() => {
  push.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("push reconnect", () => {
  it("does not fire onReconnect on the first connect of a session", () => {
    const fn = vi.fn();
    const unsub = push.onReconnect(fn);
    push.start();
    expect(FakeEventSource.instances).toHaveLength(1);
    latest().open();
    expect(push.state).toBe("connected");
    expect(fn).not.toHaveBeenCalled();
    unsub();
  });

  it("fires onReconnect when the connection comes back after a drop", async () => {
    const fn = vi.fn();
    const unsub = push.onReconnect(fn);
    push.start();
    latest().open();
    latest().fail();
    expect(push.state).toBe("connecting");
    // The first retry waits one second of backoff, then reconnects.
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    latest().open();
    expect(push.state).toBe("connected");
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("fires again on each later drop and reconnect", async () => {
    const fn = vi.fn();
    const unsub = push.onReconnect(fn);
    push.start();
    latest().open();
    latest().fail();
    await vi.advanceTimersByTimeAsync(1000);
    latest().open();
    expect(fn).toHaveBeenCalledTimes(1);
    // The second drop waits the doubled backoff before reconnecting.
    latest().fail();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeEventSource.instances).toHaveLength(3);
    latest().open();
    expect(fn).toHaveBeenCalledTimes(2);
    unsub();
  });

  it("treats a stop()/start() pair as a new session, not a reconnect", async () => {
    const fn = vi.fn();
    push.onReconnect(fn);
    push.start();
    latest().open();
    latest().fail();
    await vi.advanceTimersByTimeAsync(1000);
    // An account switch tears the connection down and starts a fresh one; the
    // initial load that follows must not be doubled by a reconnect catch-up.
    push.stop();
    push.start();
    expect(FakeEventSource.instances).toHaveLength(3);
    latest().open();
    expect(fn).not.toHaveBeenCalled();
  });
});

/**
 * What the catch-up actually asks for.
 *
 * The connection contract above says *when* a tab catches up; this says what
 * it asks for when it does. Push replays nothing to a tab that was away, so a
 * type left out of this pass is stale until an unrelated event for the same
 * type happens to arrive — and the connection looks healthy the whole time,
 * which is why the gap went unnoticed. The pass takes every live type from
 * the one list the subscription is built from, so it cannot drift from what
 * the server posts.
 */
describe("push reconnect catch-up", () => {
  it("asks every account for every live type, not a hand-picked few", () => {
    const queued = new Map<string, string[]>();
    const accounts = ["me@example.com", "group@example.com"];
    catchUpAfterReconnect(accounts, (accountId, type) => {
      queued.set(accountId, [...(queued.get(accountId) ?? []), type]);
    });

    // One pass per account: a tab holding a group mailbox catches up both.
    expect([...queued.keys()].sort()).toEqual([...accounts].sort());
    const everyLiveType = [...PUSH_STATE_TYPES].sort();
    for (const [, types] of queued) {
      expect([...types].sort()).toEqual(everyLiveType);
    }
    // The types the old hand-written pass never asked for — calendar,
    // contacts, tasks, filters, quota — are the point of the test.
    expect(everyLiveType).toContain("CalendarEvent");
    expect(everyLiveType).toContain("SieveScript");
  });
});
