import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKnowledge } from "@/store/knowledge";

/*
 * The KB search box reads the pages' text and matches it as the reader types.
 * These pin the store half: a page is found by a word in its body, and by its
 * title even when the body could not be read, and the box records the term a
 * run searched so it never says "Nothing found." for a term no run has reached.
 */

function tier(title: string) {
  return {
    scope: "company" as const,
    accountId: "a1",
    group: null,
    canApprove: false,
    articles: [
      {
        kind: "article" as const,
        id: "id1",
        title,
        tags: [],
        folder: title,
        nodeId: "n1",
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
      },
    ],
  };
}

const ok = (text: string) =>
  vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, article: { draft: { text } } }),
      }) as unknown as Response,
  );

beforeEach(() => {
  useKnowledge.getState().reset();
  useKnowledge.setState({ tiers: [tier("Pagina di prova")] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the KB search", () => {
  it("finds a page by a word in its body", async () => {
    vi.stubGlobal("fetch", ok("parola magica sul contenuto"));
    useKnowledge.getState().setSearch("magica");
    await useKnowledge.getState().runSearch();
    expect(useKnowledge.getState().results.map((r) => r.nodeId)).toEqual(["n1"]);
  });

  it("finds a page by its title even when the body cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("gone");
      }),
    );
    useKnowledge.getState().setSearch("prova");
    await useKnowledge.getState().runSearch();
    expect(useKnowledge.getState().results.map((r) => r.nodeId)).toEqual(["n1"]);
  });

  it("records the term the run searched, not the one being typed", async () => {
    vi.stubGlobal("fetch", ok(""));
    useKnowledge.getState().setSearch("niente");
    await useKnowledge.getState().runSearch();
    expect(useKnowledge.getState().searchedTerm).toBe("niente");
    useKnowledge.getState().setSearch("niente di nuovo");
    expect(useKnowledge.getState().searchedTerm).toBe("niente");
  });
});
