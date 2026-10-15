import { beforeEach, expect, it, vi } from "vitest";
import { useKnowledge } from "@/store/knowledge";

/*
 * The search engine is a chunk of its own: this store is reached from the boot
 * shell, which applies its changes, so a reader who never searches never
 * fetches it. Its arrival can therefore fail -- a deployment that moved under
 * an open tab is the ordinary way -- and that is not a search with nothing to
 * show. This pins the difference: the failure is reported as the retrieval it
 * is, and the box is not told "Nothing found.".
 */
vi.mock("@orama/orama", () => {
  throw new Error("engine unavailable");
});

beforeEach(() => {
  useKnowledge.getState().reset();
  // No articles: the run has nothing to read, so the only thing that can fail
  // it is the engine itself.
  useKnowledge.setState({
    tiers: [
      {
        scope: "company",
        accountId: "a1",
        group: null,
        canApprove: false,
        articles: [],
      },
    ],
  });
});

it("reports a search engine whose chunk did not arrive", async () => {
  useKnowledge.getState().setSearch("anything");
  await useKnowledge.getState().runSearch();
  const state = useKnowledge.getState();
  expect(state.searching).toBe(false);
  expect(state.results).toEqual([]);
  // The message is the loader's own; what matters is that the failure is said
  // rather than read as a search that matched nothing.
  expect(state.error).not.toBeNull();
});
