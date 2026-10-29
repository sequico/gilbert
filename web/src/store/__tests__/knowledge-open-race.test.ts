import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKnowledge } from "@/store/knowledge";

/*
 * The KB store's two out-of-order hazards.
 *
 * A slow `open` must not land over a newer one -- the reader may already be
 * editing the newer article, and the stale answer would wipe those edits. And a
 * `load` that answers after the store was emptied must be dropped rather than
 * repopulate it for the next session.
 */

const article = (nodeId: string, folder: string) => ({
  kind: "article" as const,
  id: `id-${nodeId}`,
  title: folder,
  tags: [],
  folder,
  nodeId,
  parentId: null,
  inForce: null,
  pending: null,
  rev: null,
  order: 0,
  retired: null,
  created: null,
  updated: null,
  template: null,
  saved: true,
});

const view = (nodeId: string, folder: string, title: string) => ({
  scope: "company" as const,
  accountId: "a1",
  summary: article(nodeId, folder),
  draft: { title, text: `${title} body`, tags: [], blocks: [] },
  effective: null,
  revisions: [],
});

const respond = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

beforeEach(() => {
  useKnowledge.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("opening a KB article", () => {
  it("keeps the newer article when an earlier open answers later", async () => {
    useKnowledge.setState({
      tiers: [
        {
          scope: "company",
          accountId: "a1",
          group: null,
          canApprove: false,
          canEdit: false,
          articles: [article("n1", "Old"), article("n2", "New")],
        },
      ],
    });

    const releases: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("folder=Old"))
          return await new Promise<Response>((resolve) => {
            releases.push(() =>
              resolve(respond({ ok: true, article: view("n1", "Old", "Old") })),
            );
          });
        return respond({ ok: true, article: view("n2", "New", "New") });
      }),
    );

    const first = useKnowledge.getState().open("a1", "Old", "n1");
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    await useKnowledge.getState().open("a1", "New", "n2");
    useKnowledge.getState().setEdit({ text: "an edit the reader is making" });

    releases[0]!();
    await first;

    // The stale open left the newer article and its unsaved edits alone.
    expect(useKnowledge.getState().article?.summary.nodeId).toBe("n2");
    expect(useKnowledge.getState().edit?.text).toBe("an edit the reader is making");
    expect(useKnowledge.getState().articleLoading).toBe(false);
  });
});

describe("a KB load that answers after reset", () => {
  it("does not repopulate the tiers", async () => {
    const releases: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/knowledge/company/tree"))
          return await new Promise<Response>((resolve) => {
            releases.push(() =>
              resolve(
                respond({
                  ok: true,
                  accountId: "a1",
                  articles: [article("n1", "Old")],
                }),
              ),
            );
          });
        return respond({ ok: true });
      }),
    );

    const loading = useKnowledge.getState().load();
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    useKnowledge.getState().reset();
    releases[0]!();
    await loading;

    expect(useKnowledge.getState().tiers).toEqual([]);
    expect(useKnowledge.getState().loaded).toBe(false);
  });
});
