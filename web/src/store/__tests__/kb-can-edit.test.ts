import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKnowledge } from "@/store/knowledge";
import { useMail } from "@/store/mail";

/*
 * Shaping a tier's tree belongs to the tier: a group's KB is its members', so a
 * member who is not an installation administrator still creates, renames and
 * moves there; the company's stays an administrator's. The store is where the
 * surface reads that from, so it is pinned here: if the split is dropped,
 * `canEdit` is a copy of `canApprove` and a member stops being able to add a
 * page.
 */

const respond = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

beforeEach(() => {
  useKnowledge.getState().reset();
  // A member of one group, and no administrator marker on the session.
  useMail.setState({
    mailAccounts: [{ accountId: "a3", name: "team@example.org", kind: "group" }],
  });
});

afterEach(() => {
  useMail.setState({ mailAccounts: [] });
  vi.unstubAllGlobals();
});

describe("who shapes a KB tier's tree", () => {
  it("lets a group's member edit while the company tier stays an admin's", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/api/knowledge/company/tree")
          ? respond({ ok: true, accountId: "a1", articles: [] })
          : respond({ ok: true }),
      ),
    );

    await useKnowledge.getState().load();

    const tiers = useKnowledge.getState().tiers;
    const company = tiers.find((tier) => tier.scope === "company");
    const group = tiers.find((tier) => tier.scope === "group");
    expect(company?.canEdit).toBe(false);
    expect(group?.canEdit).toBe(true);
  });
});
