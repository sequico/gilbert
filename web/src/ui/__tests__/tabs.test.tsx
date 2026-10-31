import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TabStrip } from "@/ui/tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The one tab strip: the four things a hand-rolled one gets wrong — one tab
 * stop, the arrows moving it (and wrapping), every tab naming its own panel,
 * and a click moving the selection.
 */

const TABS = [
  { id: "one", content: "One" },
  { id: "two", content: "Two" },
  { id: "three", content: "Three" },
];

function Harness({ panelId }: { panelId?: (id: string) => string | null }) {
  const [selected, setSelected] = useState("one");
  return (
    <TabStrip
      label="Sections"
      tabs={TABS}
      selected={selected}
      onSelect={setSelected}
      idPrefix="s"
      panelId={panelId}
    />
  );
}

let root: Root | null = null;
let host: HTMLElement;

const tabs = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const strip = () => host.querySelector<HTMLDivElement>('[role="tablist"]')!;

function render(panelId?: (id: string) => string | null) {
  act(() => root!.render(<Harness panelId={panelId} />));
}

function press(key: string) {
  act(() => {
    strip().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe("the one tab strip", () => {
  it("keeps one tab in the tab order, the selected one", () => {
    render();
    expect(tabs().map((one) => one.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs().map((one) => one.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
  });

  it("moves the selection and the focus with the arrows, wrapping at the ends", () => {
    render();
    press("ArrowRight");
    expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.id).toBe("s-two");
    press("ArrowRight");
    press("ArrowRight");
    // The third press from "three" wraps to the first.
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.id).toBe("s-one");
    press("ArrowLeft");
    expect(tabs()[2]!.getAttribute("aria-selected")).toBe("true");
  });

  it("names each tab's own panel, and names none when there is no per-tab panel", () => {
    render();
    expect(tabs().map((one) => one.getAttribute("aria-controls"))).toEqual([
      "s-one-panel",
      "s-two-panel",
      "s-three-panel",
    ]);
    act(() => root!.unmount());
    root = createRoot(host);
    render(() => null);
    expect(tabs().map((one) => one.getAttribute("aria-controls"))).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("selects on click", () => {
    render();
    act(() => tabs()[2]!.click());
    expect(tabs()[2]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("false");
  });
});
