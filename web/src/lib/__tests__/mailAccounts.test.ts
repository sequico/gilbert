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

describe("mailAccountCandidates — every non-personal mail account is a group mailbox", () => {
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

  it("offers a mailbox named gilbert-admin@… like any other group (ADR 0007)", () => {
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

  it("ignores non-personal accounts without mail", () => {
    const noMail = {
      name: "grace@example.org",
      isPersonal: false,
      isReadOnly: false,
      accountCapabilities: {},
    };
    const s = sessionOf({ a1: account("sam@ops.example.com", true), a2: noMail });
    expect(mailAccountCandidates(s).map((c) => c.accountId)).toEqual(["a1"]);
  });
});
