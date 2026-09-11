import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useSession } from "@/store/session";

/**
 * The forced-password-change wall (ADR 0004), client side: the session store
 * lifts the wall flag when the server says `gilbert.mustChangePassword`, and
 * a mid-session 403 `password_change_required` from any data request raises
 * it the way a 401 signs the session out. A refreshed session without the
 * flag lowers it again, which is what lets the app continue after the change.
 */

const SESSION = (forced: boolean) =>
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
    gilbert: { remember: true, mustChangePassword: forced },
  }) as unknown as JmapSession;

/** Route-aware server stub: session probe, refresh, JMAP data, logout. */
function stubServer(forcedSession: boolean) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/auth/session")) {
        return {
          ok: true,
          status: 200,
          json: async () => SESSION(forcedSession),
        } as Response;
      }
      if (url.includes("/api/jmap")) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: "password_change_required" }),
        } as Response;
      }
      if (url.includes("/api/auth/logout")) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
  return calls;
}

beforeEach(() => {
  client.session = null;
  useSession.setState({
    status: "loading",
    session: null,
    accountId: null,
    error: null,
    forcedPasswordChange: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("forced password change", () => {
  it("a session flagged mustChangePassword mounts the wall at boot", async () => {
    stubServer(true);
    await useSession.getState().bootstrap();
    expect(useSession.getState().status).toBe("authenticated");
    expect(useSession.getState().forcedPasswordChange).toBe(true);
  });

  it("an unflagged session stays in the app", async () => {
    stubServer(false);
    await useSession.getState().bootstrap();
    expect(useSession.getState().status).toBe("authenticated");
    expect(useSession.getState().forcedPasswordChange).toBe(false);
  });

  it("a mid-session 403 password_change_required raises the wall", async () => {
    stubServer(false);
    await useSession.getState().bootstrap();
    expect(useSession.getState().forcedPasswordChange).toBe(false);

    await client.call("Principal/get", { accountId: "a1", ids: null }).catch(() => {});
    expect(useSession.getState().forcedPasswordChange).toBe(true);
    // The wall keeps the session signed in: it is a wall, not a sign-out.
    expect(useSession.getState().status).toBe("authenticated");
  });

  it("a refreshed session without the flag lowers the wall", async () => {
    stubServer(false);
    await useSession.getState().bootstrap();
    await client.call("Principal/get", { accountId: "a1", ids: null }).catch(() => {});
    expect(useSession.getState().forcedPasswordChange).toBe(true);

    // The successful change happened server-side; the refresh the wall runs
    // afterwards carries no flag, and the app mounts again.
    await useSession.getState().refresh();
    expect(useSession.getState().forcedPasswordChange).toBe(false);
  });

  it("signing out of the wall clears the flag", async () => {
    stubServer(false);
    await useSession.getState().bootstrap();
    await client.call("Principal/get", { accountId: "a1", ids: null }).catch(() => {});
    expect(useSession.getState().forcedPasswordChange).toBe(true);

    await useSession.getState().logout();
    expect(useSession.getState().status).toBe("anonymous");
    expect(useSession.getState().forcedPasswordChange).toBe(false);
  });
});
