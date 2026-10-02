import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useKnowledge } from "@/store/knowledge";
import { KnowledgeSidebar } from "@/views/knowledge/KnowledgeSidebar";

/*
 * Clearing the KB search must bring the tree back. This is the regression the
 * reader reported: after searching, the x left the sidebar empty.
 */

function article(title: string) {
  return {
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
  };
}

afterEach(() => {
  useKnowledge.getState().reset();
  document.body.innerHTML = "";
});

describe("clearing the KB search", () => {
  it("shows the tree again", async () => {
    useKnowledge.getState().reset();
    useKnowledge.setState({
      tiers: [
        {
          scope: "company",
          accountId: "a1",
          group: null,
          canApprove: false,
          articles: [article("Pagina di prova")],
        },
      ],
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<KnowledgeSidebar />);
    });
    expect(host.textContent).toContain("Pagina di prova");

    await act(async () => {
      useKnowledge.getState().setSearch("prova");
    });
    expect(host.textContent).toContain("Results");

    const clear = host.querySelector('button[aria-label="Clear search"]');
    expect(clear).toBeTruthy();
    await act(async () => {
      (clear as HTMLButtonElement).click();
    });
    expect(useKnowledge.getState().search).toBe("");
    expect(host.textContent).toContain("Pagina di prova");
  });
});
