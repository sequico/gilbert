import { AGENT_LABELS } from "@gilbert/shared/labels";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushTwice as flush } from "@/test/testkit";
import { GroupLabels } from "../GroupLabels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The two sections of the group-label surface (ADR 0005).
 *
 * A group owns its label catalog, and the reserved `G-` namespace is the
 * product's own rather than the group's: the surface keeps them apart, and the
 * reserved section draws no control at all, so no add, rename, colour or delete
 * there can reach a label no group owns. Its entries are the shared
 * vocabulary's, never a second list spelled in the web.
 */

/** The shape `apiFetch` reads: JSON with a status. */
function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as Response;
}

describe("the group-label surface", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url === "/api/admin/groups")
          return Promise.resolve(
            json({
              groups: [{ id: "1", name: "a@x" }],
              enumeration: true,
              enumerationMessage: null,
            }),
          );
        if (url.includes("/labels"))
          return Promise.resolve(
            json({
              labels: [{ keyword: "work", name: "Work", color: "#123456" }],
            }),
          );
        return Promise.resolve(json({}));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => root.unmount());
    host.remove();
  });

  /** Render the surface and choose the one group its directory lists. */
  async function render() {
    await act(async () => {
      root.render(<GroupLabels />);
    });
    await act(async () => {
      await flush();
    });
    const select = host.querySelector<HTMLSelectElement>("select");
    if (!select) throw new Error("the group picker is not rendered");
    await act(async () => {
      select.value = "a@x";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await flush();
    });
  }

  function section(heading: string): HTMLElement {
    const found = [...host.querySelectorAll("section")].find(
      (el) => el.querySelector("h2")?.textContent?.trim() === heading,
    );
    if (!found) throw new Error(`no section headed ${heading}`);
    return found;
  }

  it("shows the group's own labels and the product's reserved ones as two sections", async () => {
    await render();

    expect(section("Labels").textContent).toContain("Work");
    const system = section("System labels");
    for (const label of AGENT_LABELS) {
      expect(system.textContent).toContain(label.name);
      expect(system.textContent).toContain(label.keyword);
    }
  });

  it("draws no control over the reserved labels", async () => {
    await render();

    const system = section("System labels");
    expect([
      ...system.querySelectorAll("button, input, select, textarea, [contenteditable]"),
    ]).toEqual([]);
    // The catalog's own row is the only one that offers a delete, so a reserved
    // label rendered beside it as an editable row would offer one too.
    expect(host.querySelectorAll('button[aria-label="Delete label"]')).toHaveLength(1);
    // And no reserved keyword reaches the section that holds the catalog.
    for (const label of AGENT_LABELS) {
      expect(section("Labels").textContent).not.toContain(label.keyword);
    }
  });
});
