/**
 * The tab strip, and the three promises its own docstring makes: a badge is
 * drawn inside the tab rather than beside it, only the selected tab names the
 * panel, and the arrows move between the tabs.
 *
 * The three administration surfaces that draw it look identical, so a defect in
 * any of those promises is invisible in a screenshot and invisible in a test
 * that renders one of them for another reason.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabPanel, type TabPart, TabStrip } from "@/ui/tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the tab strip", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (
    parts: readonly TabPart[],
    selected: string,
    onSelect: (id: string) => void = () => undefined,
  ) => {
    await act(async () => {
      root.render(
        <>
          <TabStrip
            parts={parts}
            selected={selected}
            onSelect={onSelect}
            idPrefix="t-"
            label="Sections"
          />
          <TabPanel idPrefix="t-" selected={selected}>
            the panel
          </TabPanel>
        </>,
      );
    });
  };

  const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("draws a count inside the tab, and nothing at all when there is none", async () => {
    await render(
      [
        { id: "pending", label: "Pending", badge: 3 },
        { id: "audit", label: "Audit" },
      ],
      "pending",
    );
    expect(tabs()[0]?.textContent).toBe("Pending3");
    expect(tabs()[0]?.querySelector(".badge")?.textContent).toBe("3");
    expect(tabs()[1]?.querySelector(".badge")).toBeNull();
  });

  it("names the panel on the selected tab only", async () => {
    await render(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      "b",
    );
    expect(tabs()[0]?.getAttribute("aria-controls")).toBeNull();
    expect(tabs()[0]?.getAttribute("aria-selected")).toBe("false");
    expect(tabs()[1]?.getAttribute("aria-controls")).toBe("t-panel");
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("t-panel")?.textContent).toBe("the panel");
  });

  it("moves to the next tab on the arrow, and focuses it", async () => {
    const onSelect = vi.fn();
    await render(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      "a",
      onSelect,
    );
    await act(async () => {
      tabs()[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(document.activeElement).toBe(tabs()[1]);
  });
});
