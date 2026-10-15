import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { fakeJmapServer, type JmapFake } from "@/test/jmapServer";

/**
 * The `using` property of a JMAP request is not decoration: Stalwart >= 0.16
 * refuses Identity/get and Identity/set with `unknownMethod` unless the
 * submission capability is named, which left users unable to see or create an
 * identity — and so unable to send at all (issue #12).
 */

function session(caps: string[]): JmapSession {
  return {
    capabilities: Object.fromEntries(caps.map((c) => [c, {}])),
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
}

/** The `using` array of the single request a batch produced. */
function using(srv: JmapFake): string[] {
  expect(srv.requests).toHaveLength(1);
  return srv.requests[0]!.using;
}

const ALL = [CAP.core, CAP.mail, CAP.submission, CAP.contacts, CAP.contactsParse];

beforeEach(() => {
  client.session = session(ALL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  client.session = null;
});

describe("request `using`", () => {
  it("names the submission capability for Identity methods", async () => {
    const srv = fakeJmapServer();
    await client.call("Identity/get", { accountId: "a1", ids: null });
    expect(using(srv)).toContain(CAP.submission);
  });

  it("names it for Identity/set too, so identities can be created", async () => {
    const srv = fakeJmapServer();
    await client.call("Identity/set", {
      accountId: "a1",
      create: { n: { email: "a@b.c" } },
    });
    expect(using(srv)).toContain(CAP.submission);
  });

  it("unions the capabilities of every call batched into one request", async () => {
    const srv = fakeJmapServer();
    await Promise.all([
      client.call("Identity/get", { accountId: "a1", ids: null }),
      client.call("Mailbox/get", { accountId: "a1", ids: null }),
    ]);
    expect(using(srv)).toEqual(
      expect.arrayContaining([CAP.core, CAP.mail, CAP.submission]),
    );
  });

  it("drops capabilities the session never advertised", async () => {
    client.session = session([CAP.core, CAP.mail]);
    const srv = fakeJmapServer();
    await client.call("Identity/get", { accountId: "a1", ids: null });
    expect(using(srv)).toEqual(expect.arrayContaining([CAP.core, CAP.mail]));
    expect(using(srv)).not.toContain(CAP.submission);
  });

  it("always keeps core, even before a session is known", async () => {
    client.session = null;
    const srv = fakeJmapServer();
    await client.call("Email/get", { accountId: "a1", ids: [] });
    expect(using(srv)).toContain(CAP.core);
  });
});
