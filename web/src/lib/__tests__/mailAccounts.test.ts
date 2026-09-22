import { describe, expect, it } from "vitest";
import { type MailSessionLike, mailAccountCandidates } from "@/lib/mailAccounts";

const MAIL = "urn:ietf:params:jmap:mail";
const sessionOf = (accounts: Record<string, unknown>): MailSessionLike => ({
  accounts: accounts as MailSessionLike["accounts"],
  primaryAccounts: { [MAIL]: "a1" },
});

function account(name: string, isPersonal: boolean) {
  return {
    name,
    isPersonal,
    isReadOnly: false,
    accountCapabilities: { [MAIL]: {} },
  };
}

describe("mailAccountCandidates — every non-personal account is a candidate", () => {
  it("lists the own account first, then the group mailboxes", () => {
    const s = sessionOf({
      a1: account("sam@ops.example.com", true),
      a3: account("freight@ops.example.com", false),
    });
    expect(mailAccountCandidates(s)).toEqual([
      { accountId: "a1", name: "sam@ops.example.com", kind: "own" },
      { accountId: "a3", name: "freight@ops.example.com", kind: "group" },
    ]);
  });

  it("offers a mailbox named gilbert-admin@… like any other group (ADR 0001)", () => {
    const s = sessionOf({
      a1: account("sam@ops.example.com", true),
      a4: account("gilbert-admin@ops.example.com", false),
      a3: account("freight@ops.example.com", false),
    });
    const ids = mailAccountCandidates(s).map((c) => c.accountId);
    expect(ids).toContain("a1");
    expect(ids).toContain("a3");
    expect(ids).toContain("a4");
    expect(ids).toHaveLength(3);
  });

  it("asks a non-personal account that advertises nothing, and lets the probe decide", () => {
    /*
     * The capability list is the credential's rights on the account, not what
     * the account was shared for, so it cannot be the thing that decides
     * whether an account is asked. A member's group mailbox is the case that
     * fails when it is: the account is in the session, and nothing asks it.
     */
    const noCapabilities = {
      name: "freight@ops.example.com",
      isPersonal: false,
      isReadOnly: false,
      accountCapabilities: {},
    };
    const s = sessionOf({ a1: account("sam@ops.example.com", true), a2: noCapabilities });
    expect(mailAccountCandidates(s)).toEqual([
      { accountId: "a1", name: "sam@ops.example.com", kind: "own" },
      { accountId: "a2", name: "freight@ops.example.com", kind: "group" },
    ]);
  });
});
