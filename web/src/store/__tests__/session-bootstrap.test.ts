import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useSession } from "@/store/session";

/**
 * The session probe must not be duplicated. The App mounts its bootstrap
 * effect once, but React's StrictMode (dev) mounts, unmounts and remounts it,
 * so two calls race out of the same first paint -- and every extra call is an
 * extra 401 on an anonymous load, logged by the browser as a console error.
 * Two callers that want the same answer share one request; the latch drops
 * once the answer lands so a later, genuinely new probe still happens.
 */

const SESSION = () =>
  ({
    capabilities: {
      [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 },
      [CAP.mail]: {},
    },
    accounts: {
      a1: {
        name: "me@example.com",
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: { [CAP.mail]: {} },
      },
    },
    primaryAccounts: { [CAP.mail]: "a1" },
    state: "s1",
    /* A trusted device skips the idle-logout timer this test does not want. */
    ihasmail: { remember: true },
  }) as unknown as JmapSession;

function stubServer() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, status: 200, json: async () => SESSION() } as Response;
    }),
  );
  return calls;
}

beforeEach(() => {
  useSession.setState({
    status: "loading",
    session: null,
    accountId: null,
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session bootstrap", () => {
  it("two concurrent bootstraps share one session probe", async () => {
    const calls = stubServer();
    const boot = useSession.getState().bootstrap;
    await Promise.all([boot(), boot()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/auth/session");
    expect(useSession.getState().status).toBe("authenticated");
  });

  it("a later bootstrap probes again once the first landed", async () => {
    const calls = stubServer();
    const boot = useSession.getState().bootstrap;
    await boot();
    expect(calls).toHaveLength(1);
    await boot();
    expect(calls).toHaveLength(2);
  });
});
