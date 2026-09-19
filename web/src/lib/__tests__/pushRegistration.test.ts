import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { setDeviceTrusted } from "@/lib/storage";
import {
  deviceClientId,
  type JmapPushSubscription,
  roomToMake,
  setPushEnabledHere,
} from "@/lib/webpush";
import { renewWebPush } from "@/lib/webpushEnable";

/**
 * What a registration does to the account's subscription pool.
 *
 * The pool is fifteen rows, shared with gilbertserver's own fan-out row, and a
 * create past it is refused `overQuota`. Every row this app ever registered
 * stayed there until it expired — a repeated `deviceClientId` does not replace
 * (confirmed live on 0.16.22, 2026-09-16) — so a renewal that created a row
 * every time emptied the pool within a week of use.
 *
 * The server below behaves the way a live 0.16.22 was seen to: duplicates are
 * kept, the sixteenth create is refused, a `get` hands back no `url` and no
 * `keys`, and an `expires` update is accepted. Each case asserts the *write*
 * that was made, which is the only thing that tells extend from
 * destroy-and-create — the two are indistinguishable from the outside.
 */

const KEY =
  "BBvig2GPmqohMJJHMzp6bTKviHibYiVCyAY8gdq2fPhS-9YfO9_0TnhMyZ0a0JxTsbCqd3zm1rEiXsXsL3jveJY";
const DAY = 24 * 60 * 60 * 1000;
/** A row belonging to another browser: the shape a UUID makes. */
const OTHER = (n: number) =>
  `gilbert-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * A row as the fake server holds it.
 *
 * Deliberately without `url` and `keys`: a live 0.16.22 hands neither back (the
 * URL was confirmed absent on 0.16.21, 2026-09-14), and modelling the row
 * without them is what makes a test that reads one fail instead of pass.
 */
type Row = Omit<JmapPushSubscription, "url" | "keys"> & {
  types?: string[] | null;
  verified?: boolean;
};

let server: Row[];
let writes: Array<[string, Record<string, unknown>]>;
let seq: number;

/** A browser subscription, as `pushManager` hands one over. */
function browserSub(endpoint: string) {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "BPub", auth: "auth" } }),
    getKey: () => null,
  };
}

function install(running: ReturnType<typeof browserSub> | null) {
  client.session = {
    capabilities: {
      "urn:ietf:params:jmap:core": { maxCallsInRequest: 16 },
      "urn:ietf:params:jmap:webpush-vapid": { applicationServerKey: KEY },
    },
    accounts: {},
    primaryAccounts: {},
    state: "s",
  } as unknown as JmapSession;
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", { permission: "granted" });
  const reg = {
    pushManager: {
      getSubscription: async () => running,
      subscribe: async () => running,
    },
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve(reg),
      getRegistration: async () => reg,
      addEventListener: () => {},
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const { methodCalls } = JSON.parse(init.body as string) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const methodResponses = methodCalls.map(([name, args, id]) => {
        if (name === "PushSubscription/get") {
          // `keys` is write-only and `url` is never handed back, which is
          // exactly what the rows above do not carry.
          return [name, { list: server.map((s) => ({ ...s })), notFound: [] }, id];
        }
        if (name === "PushSubscription/set") {
          writes.push([name, args]);
          const created = (args.create ?? {}) as Record<string, Record<string, unknown>>;
          for (const [cid, obj] of Object.entries(created)) {
            if (server.length >= 15)
              return [
                name,
                {
                  notCreated: {
                    [cid]: {
                      type: "overQuota",
                      description:
                        "There are too many subscriptions, please delete some before adding a new one.",
                    },
                  },
                },
                id,
              ];
            seq += 1;
            server.push({
              id: `ps${seq}`,
              deviceClientId: String(obj.deviceClientId ?? ""),
              expires: new Date(Date.now() + 7 * DAY).toISOString(),
              types: (obj.types as string[] | null) ?? null,
            });
            return [name, { created: { [cid]: { id: `ps${seq}` } } }, id];
          }
          const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
          for (const [id2, patch] of Object.entries(update)) {
            const row = server.find((s) => s.id === id2);
            if (!row) return [name, { notUpdated: { [id2]: { type: "notFound" } } }, id];
            if (patch.expires) row.expires = String(patch.expires);
          }
          const destroy = (args.destroy ?? []) as string[];
          server = server.filter((s) => !destroy.includes(s.id));
          return [name, { updated: {}, destroyed: destroy }, id];
        }
        return [name, {}, id];
      });
      return new Response(JSON.stringify({ methodResponses }), { status: 200 });
    }),
  );
}

/** The one call that reached `PushSubscription/set`, if any. */
const lastWrite = () => writes[writes.length - 1]?.[1];

beforeEach(() => {
  server = [];
  writes = [];
  seq = 0;
  setDeviceTrusted(true);
  localStorage.clear();
  setPushEnabledHere(true);
});

afterEach(() => {
  client.session = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a registration does not add a row it can reuse", () => {
  it("extends the row it already has, and writes no create", async () => {
    install(browserSub("https://push.example/mine"));
    const mine = deviceClientId();
    localStorage.setItem("gilbert:pushEndpoint", "https://push.example/mine");
    server.push({
      id: "psA",
      deviceClientId: mine,
      expires: new Date(Date.now() + 1 * DAY).toISOString(),
    });

    await renewWebPush();

    expect(server.length).toBe(1);
    const args = lastWrite();
    expect(args?.create).toBeUndefined();
    expect(args?.update).toHaveProperty("psA");
    // The row is given a full week again, not the day it had left.
    expect(Date.parse(server[0]!.expires!) - Date.now()).toBeGreaterThan(6 * DAY);
  });

  it("leaves a row that is nowhere near expiring alone, with no write at all", async () => {
    install(browserSub("https://push.example/mine"));
    localStorage.setItem("gilbert:pushEndpoint", "https://push.example/mine");
    server.push({
      id: "psA",
      deviceClientId: deviceClientId(),
      expires: new Date(Date.now() + 6 * DAY).toISOString(),
    });

    await renewWebPush();

    expect(writes).toEqual([]);
  });

  it("clears its own duplicates rather than letting them hold slots", async () => {
    install(browserSub("https://push.example/mine"));
    const mine = deviceClientId();
    localStorage.setItem("gilbert:pushEndpoint", "https://push.example/mine");
    /*
     * One instant for both rows, read once. Two `Date.now()` calls are two
     * reads of a clock that moves: under load the second can land a millisecond
     * later, the two rows then differ in expiry, and a renewal that keeps the
     * newer one keeps `psB` — which is this test failing for a reason that is
     * not about duplicates at all.
     */
    const expires = new Date(Date.now() + 6 * DAY).toISOString();
    server.push(
      { id: "psA", deviceClientId: mine, expires },
      { id: "psB", deviceClientId: mine, expires },
    );

    await renewWebPush();

    expect(server.map((s) => s.id)).toEqual(["psA"]);
    expect(lastWrite()?.destroy).toEqual(["psB"]);
  });

  it("registers afresh when the endpoint changed, since the old row points elsewhere", async () => {
    install(browserSub("https://push.example/new"));
    localStorage.setItem("gilbert:pushEndpoint", "https://push.example/old");
    server.push({
      id: "psA",
      deviceClientId: deviceClientId(),
      expires: new Date(Date.now() + 6 * DAY).toISOString(),
    });

    await renewWebPush();

    // The stale row went and one row stands, on the new endpoint.
    expect(server.length).toBe(1);
    expect(server[0]!.id).not.toBe("psA");
    expect(lastWrite()).toHaveProperty("create");
  });
});

describe("a full account is not the end of notifications", () => {
  it("gives up another browser's unverified row and registers once more", async () => {
    install(browserSub("https://push.example/mine"));
    // Fifteen rows, none of them this browser's: the pool is spent by the
    // reader's other devices and by browsers that can never come back.
    server = Array.from({ length: 15 }, (_, i) => ({
      id: `other${i}`,
      deviceClientId: OTHER(i),
      expires: new Date(Date.now() + 7 * DAY).toISOString(),
      verified: i > 0,
    }));

    await renewWebPush();

    // One was released -- the never-verified one -- and this browser's row
    // took its slot.
    expect(server.length).toBe(15);
    expect(server.some((s) => s.id === "other0")).toBe(false);
    expect(server.some((s) => s.deviceClientId === deviceClientId())).toBe(true);
  });
});

describe("which row is given up", () => {
  const row = (id: string, days: number, verified: boolean): Row => ({
    id,
    deviceClientId: OTHER(Number(id.replace(/\D/g, "")) || 0),
    expires: new Date(Date.now() + days * DAY).toISOString(),
    verificationCode: verified ? "v" : null,
  });

  it("never this browser's own, and never a row the server cannot have made", () => {
    const mine = deviceClientId();
    const rows = [
      { id: "mine", deviceClientId: mine, expires: null },
      // The installation's own fan-out row: a derived identity, not a UUID.
      { id: "server", deviceClientId: "gilbert-a1b2c3d4e5f60718", expires: null },
      row("other1", 1, false),
    ];
    expect(roomToMake(rows, mine)).toEqual(["other1"]);
  });

  it("takes the never-verified row before one that works, then the soonest to expire", () => {
    const mine = deviceClientId();
    const rows = [
      row("other1", 6, true),
      row("other2", 5, false),
      row("other3", 1, true),
    ];
    expect(roomToMake(rows, mine, 2)).toEqual(["other2", "other3"]);
  });
});
