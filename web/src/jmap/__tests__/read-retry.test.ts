import { afterEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";

/**
 * A read that never arrived is asked once more; a write is not.
 *
 * Opening a folder, a conversation or a calendar is a burst of reads on a page
 * that has been idle, and a connection closed under it fails the burst with no
 * answer — which is what surfaced as a random "Failed to fetch" while changing
 * folders. The next look always worked, so one silent retry of an idempotent
 * read is the fix; a batch carrying a write is never sent twice, because the
 * first attempt may have happened.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const envelope = (id: string) =>
  new Response(
    JSON.stringify({
      methodResponses: [["Email/get", { accountId: "a1", list: [], state: "s1" }, id]],
      sessionState: "s1",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("a request that never arrived", () => {
  it("asks a read again, and hands back the answer", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(envelope("c1"));
    vi.stubGlobal("fetch", fetch);

    const res = await client.request(
      [["Email/get", { accountId: "a1" }, "c1"]],
      [CAP.mail],
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(res.methodResponses[0]![0]).toBe("Email/get");
  });

  it("does not send a batch carrying a write twice", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetch);

    await expect(
      client.request([["Email/set", { accountId: "a1", update: {} }, "c1"]], [CAP.mail]),
    ).rejects.toThrow("Failed to fetch");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a batch that mixes a read with a write", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetch);

    await expect(
      client.request(
        [
          ["Email/get", { accountId: "a1" }, "c1"],
          ["Email/set", { accountId: "a1", update: {} }, "c2"],
        ],
        [CAP.mail],
      ),
    ).rejects.toThrow("Failed to fetch");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
