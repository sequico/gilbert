import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { Identity, JmapSession } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { IdentitiesSettings } from "../IdentitiesSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The person's own section, and the identity somebody else removed.
 *
 * The list this page is built on is the **server's**, and the administration
 * writes it by impersonating the account (ADR 0007) — from another session, or
 * in Stalwart's own administration, nothing of which this session hears about.
 * So the section reads it when it opens rather than trusting the copy the store
 * read at sign-in: a list read once and then believed shows an identity that no
 * longer exists, with a Delete button on it and a From option in the composer.
 * That is the report this file pins — deleting one's own identity from the
 * administration and still seeing it here.
 *
 * The test fails when the section goes back to reading only a missing cache
 * entry: the store holds a list with `gone` in it, the server's answer does not,
 * and only a section that asks finds out.
 */

const OWN = "own";
const ME = "me@example.org";

const identity = (id: string, name: string): Identity =>
  ({
    id,
    name,
    email: ME,
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: true,
  }) as Identity;

const SESSION = {
  accounts: {
    [OWN]: {
      name: ME,
      isPersonal: true,
      accountCapabilities: { [CAP.mail]: {}, [CAP.submission]: {} },
    },
  },
  primaryAccounts: { [CAP.mail]: OWN, [CAP.submission]: OWN },
} as unknown as JmapSession;

const flush = async () => {
  await new Promise<void>((res) => setTimeout(res, 0));
  await new Promise<void>((res) => setTimeout(res, 0));
};

describe("the person's own identities section", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    // What the server still holds: the identity the session is about to be
    // behind on is simply not in it.
    vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      if (method !== "Identity/get") return {} as never;
      return {
        accountId: args.accountId,
        state: "1",
        list: [identity("o1", "Me")],
        notFound: [],
      } as never;
    });
    useSession.setState({ status: "authenticated", session: SESSION, accountId: OWN });
    await flush();
    useMail.setState({
      accountId: OWN,
      ownAccountId: OWN,
      mailAccounts: [{ accountId: OWN, name: ME, kind: "own" }],
      identities: [identity("o1", "Me")],
      // The session's copy, read at sign-in: it still carries `gone`.
      identitiesByAccount: { [OWN]: [identity("o1", "Me"), identity("gone", "Old")] },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    useSession.setState({ status: "loading", session: null, accountId: null });
    useMail.setState({
      accountId: null,
      ownAccountId: null,
      mailAccounts: [],
      identities: [],
      identitiesByAccount: {},
    });
  });

  it("reads the whole list when it opens, not only a missing cache entry", async () => {
    await act(async () => {
      root.render(<IdentitiesSettings />);
    });
    await act(async () => {
      await flush();
    });

    expect(host.textContent).not.toContain("Old");
    expect(host.textContent).toContain(ME);
  });
});
