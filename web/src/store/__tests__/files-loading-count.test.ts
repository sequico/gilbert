import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { FileNode } from "@/jmap/types";
import { useFiles } from "@/store/files";

/*
 * `loading` stands for "a level is being read", and two levels read together
 * are two runs: the one that finishes first must not take the spinner down
 * while the other is still on its way.
 */

const level = (id: string): Map<string, unknown> =>
  new Map([
    ["q", [{ ids: [id], total: 1 }]],
    [
      "g",
      [
        {
          list: [{ id, name: id, nodeType: "file", parentId: null } as FileNode],
          state: "1",
        },
      ],
    ],
  ]);

beforeEach(() => {
  useFiles.setState({ accountId: "a1", loading: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("two file levels loaded at once", () => {
  it("keeps loading until the last of them lands", async () => {
    const releases: Array<() => void> = [];
    vi.spyOn(client, "chain").mockImplementation(
      (async () =>
        await new Promise<Map<string, unknown>>((resolve) => {
          releases.push(() => resolve(level("n1")));
        })) as never,
    );

    const first = useFiles.getState().loadChildren(null);
    const second = useFiles.getState().loadChildren("p");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(useFiles.getState().loading).toBe(true);

    releases[0]!();
    await first;
    // The other level is still on its way.
    expect(useFiles.getState().loading).toBe(true);

    releases[1]!();
    await second;
    expect(useFiles.getState().loading).toBe(false);
  });
});
