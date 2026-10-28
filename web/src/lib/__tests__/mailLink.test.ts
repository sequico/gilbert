// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MAIL_ACCOUNT_PARAM,
  mailAccountOf,
  mailAccountQuery,
  mailLink,
  mailRouteAccount,
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

/**
 * Which account a route opens.
 *
 * The account on screen answers a route that names none; a hint is obeyed only
 * when this session holds it, so a link from a session that has ended opens this
 * account rather than nothing — and a notice with no folder to name still opens
 * the account it was built for.
 */
describe("the account a route opens", () => {
  const accounts = [{ accountId: "own" }, { accountId: "gg" }];

  it("opens the account the link names", () => {
    expect(mailRouteAccount({ hint: "gg", active: "own", accounts })).toBe("gg");
  });

  it("keeps the account on screen when the link names none", () => {
    expect(mailRouteAccount({ hint: null, active: "own", accounts })).toBe("own");
  });

  it("obeys a hint that names the account already on screen", () => {
    // Even before the probe has listed it: the account on screen is one this
    // session is already reading.
    expect(mailRouteAccount({ hint: "own", active: "own", accounts: [] })).toBe("own");
  });

  it("ignores a hint this session does not hold", () => {
    expect(mailRouteAccount({ hint: "gone", active: "own", accounts })).toBeNull();
  });
});
