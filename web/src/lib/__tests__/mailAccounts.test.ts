import { describe, expect, it } from "vitest";
import { type MailSessionLike, mailAccountCandidates } from "@/lib/mailAccounts";

/**
 * The sidebar can open more than one mailbox: the reader's own, then the group
 * (team) mailboxes their session lists. Capabilities cannot tell a group
 * mailbox from a folder share -- Stalwart advertises the whole set on every
 * account it lists -- so this module names the candidates and the store keeps
 * only the ones that answer `Mailbox/get` with a folder tree.
 */

const MAIL = "urn:ietf:params:jmap:mail";
const FILES = "urn:ietf:params:jmap:filenode";

/** Mine does everything; the team is a non-personal account with mail on it. */
const session = (): MailSessionLike => ({
  accounts: {
    mine: {
      name: "me@example.org",
      isPersonal: true,
      accountCapabilities: { [MAIL]: {}, [FILES]: {} },
    },
    team: {
      name: "team@example.org",
      isPersonal: false,
      accountCapabilities: { [MAIL]: {}, [FILES]: {} },
    },
  },
  primaryAccounts: { [MAIL]: "mine", [FILES]: "mine" },
});

describe("mailAccountCandidates", () => {
  it("names the reader's own account first", () => {
    expect(mailAccountCandidates(session())).toEqual([
      { accountId: "mine", name: "me@example.org", kind: "own" },
      { accountId: "team", name: "team@example.org", kind: "group" },
    ]);
  });

  it("keeps an account that shares only files out of the mailbox list", () => {
    const s = session();
    s.accounts.grace = {
      name: "grace@example.org",
      isPersonal: false,
      accountCapabilities: { [FILES]: {} },
    };
    const ids = mailAccountCandidates(s).map((a) => a.accountId);
    expect(ids).toEqual(["mine", "team"]);
  });

  it("keeps a second personal account out of the candidate list", () => {
    const s = session();
    s.accounts.second = {
      name: "second@example.org",
      isPersonal: true,
      accountCapabilities: { [MAIL]: {} },
    };
    // A second personal account is the reader's own too; the candidate list
    // stays with the primary so the probe below does not ask the alias.
    const own = mailAccountCandidates(s).filter((a) => a.kind === "own");
    expect(own).toEqual([{ accountId: "mine", name: "me@example.org", kind: "own" }]);
  });

  it("answers an empty list for no session", () => {
    expect(mailAccountCandidates(null)).toEqual([]);
  });

  it("does not trust a primary account the server says is not the reader's", () => {
    const s = session();
    s.primaryAccounts[MAIL] = "team";
    // ownAccountForCapability refuses the non-personal primary and finds the
    // reader's own personal account instead; the team stays a group candidate.
    expect(mailAccountCandidates(s)).toEqual([
      { accountId: "mine", name: "me@example.org", kind: "own" },
      { accountId: "team", name: "team@example.org", kind: "group" },
    ]);
  });
});
