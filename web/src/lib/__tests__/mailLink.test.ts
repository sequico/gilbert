import { describe, expect, it } from "vitest";
import {
  MAIL_ACCOUNT_PARAM,
  mailAccountOf,
  mailAccountQuery,
  mailLink,
} from "@/lib/mailLink";

/**
 * The link a mail notification opens.
 *
 * A route names a folder and a conversation and neither says which account owns
 * them, so a link without its account can be captured by whichever account is
 * on screen — which is a conversation that account does not hold.
 */
describe("a mail link", () => {
  it("carries the folder, the conversation and the account", () => {
    expect(mailLink({ mailboxId: "a", threadId: "bv", accountId: "gg" })).toBe(
      `/mail/a/bv?${MAIL_ACCOUNT_PARAM}=gg`,
    );
  });

  it("names the folder alone when there is no conversation", () => {
    expect(mailLink({ mailboxId: "a", accountId: "own" })).toBe(
      `/mail/a?${MAIL_ACCOUNT_PARAM}=own`,
    );
  });

  it("leaves the query out when the account is not known", () => {
    expect(mailLink({ mailboxId: "a", threadId: "bv" })).toBe("/mail/a/bv");
    expect(mailAccountQuery(null)).toBe("");
  });

  it("reads back the account it named, and nothing for a link that named none", () => {
    const link = mailLink({ mailboxId: "a", threadId: "bv", accountId: "gg" });
    expect(mailAccountOf(link.slice(link.indexOf("?")))).toBe("gg");
    expect(mailAccountOf("?q=invoice")).toBeNull();
  });
});
