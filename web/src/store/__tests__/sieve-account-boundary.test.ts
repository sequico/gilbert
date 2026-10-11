import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession, SieveScript } from "@/jmap/types";
import { useSession } from "@/store/session";
import { useSieve } from "@/store/sieve";

/**
 * A script and its text are the account's own (a Sieve script is a file on
 * that account's server). The store held both across an account change and
 * across a sign-out, so a second sign-in could show -- and `saveScript` from --
 * the previous account's script content.
 */

const SCRIPT: SieveScript = {
  id: "s1",
  name: "gilbert",
  isActive: true,
  blobId: "b1",
} as SieveScript;

const sessionFor = (accountId: string) =>
  ({
    capabilities: { [CAP.sieve]: {} },
    accounts: {
      [accountId]: {
        name: "me@example.org",
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: { [CAP.sieve]: {} },
      },
    },
    primaryAccounts: { [CAP.sieve]: accountId },
    state: "s1",
  }) as unknown as JmapSession;

const loaded = (accountId: string) => ({
  accountId,
  available: true,
  scripts: [SCRIPT],
  contents: { s1: "keep me only for this account" },
  loading: false,
  error: null,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(client, "hasCapability").mockReturnValue(true);
  vi.spyOn(client, "call").mockResolvedValue({
    accountId: "a2",
    state: "1",
    list: [],
    notFound: [],
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  useSieve.setState({
    accountId: null,
    available: false,
    scripts: [],
    contents: {},
    loading: false,
    error: null,
  });
  useSession.setState({ status: "loading", session: null, accountId: null });
});

describe("a second account in the same tab", () => {
  it("does not carry the first account's scripts or their contents", async () => {
    useSieve.setState(loaded("a1"));
    useSession.setState({
      status: "authenticated",
      session: sessionFor("a2"),
      accountId: "a2",
    });

    // `init` sees a different account and starts from nothing before loading.
    await useSieve.getState().init();

    expect(useSieve.getState().accountId).toBe("a2");
    expect(useSieve.getState().scripts).toEqual([]);
    expect(useSieve.getState().contents).toEqual({});
  });
});

describe("a session ending", () => {
  it("drops the scripts and the content read for them", () => {
    useSession.setState({
      status: "authenticated",
      session: sessionFor("a1"),
      accountId: "a1",
    });
    useSieve.setState(loaded("a1"));

    useSession.setState({ status: "anonymous", session: null, accountId: null });

    expect(useSieve.getState().accountId).toBeNull();
    expect(useSieve.getState().scripts).toEqual([]);
    expect(useSieve.getState().contents).toEqual({});
  });
});
