import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeChecklist } from "@/lib/knowledge";
import ChecklistSurface from "../ChecklistSurface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Two bugs in the process builder (finding 6): a condition control that
 * remembered the last section's open state, and a section removal that left the
 * editor pane pointing at a section nobody had chosen.
 */

const checklist = (): KnowledgeChecklist =>
  ({
    variants: [{ key: "v", label: "V", values: [{ value: "x", label: "X" }] }],
    sections: [
      { key: "s1", label: "Alpha", steps: [] },
      { key: "s2", label: "Beta", steps: [] },
      { key: "s3", label: "Gamma", steps: [] },
    ],
  }) as KnowledgeChecklist;

describe("the checklist builder's editor pane", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /** The builder is controlled: the harness is where a change is kept. */
  function Harness() {
    const [model, setModel] = useState<KnowledgeChecklist>(() => checklist());
    return <ChecklistSurface checklist={model} editable onChange={setModel} />;
  }

  const clickByText = (text: string) => {
    const button = [...host.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(text),
    );
    expect(button, `a button reading "${text}"`).toBeTruthy();
    button!.click();
  };

  const sectionField = () =>
    host.querySelector<HTMLInputElement>('input[aria-label="Section"]');

  it("starts the condition closed when the selected section changes", () => {
    act(() => root.render(<Harness />));

    // Edit Beta, and open its condition control.
    act(() => clickByText("Beta"));
    act(() => clickByText("Add condition"));
    expect(host.textContent).toContain("Show when");

    // Switch to Alpha, which carries no condition of its own. It must not
    // inherit Beta's open control.
    act(() => clickByText("Alpha"));
    expect(sectionField()?.value).toBe("Alpha");
    expect(host.textContent).toContain("Add condition");
    expect(host.textContent).not.toContain("Show when");
  });

  it("keeps the editor on the section the reader chose when an earlier one goes", () => {
    act(() => root.render(<Harness />));

    act(() => clickByText("Beta"));
    expect(sectionField()?.value).toBe("Beta");

    // Remove Alpha (index 0), before the selection: Beta shifts up to index 0
    // and stays the one being edited.
    const row = [...host.querySelectorAll(".ck-outline")].find((el) =>
      (el.textContent ?? "").includes("Alpha"),
    );
    expect(row).toBeTruthy();
    const remove = row!.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove section"]',
    );
    expect(remove).toBeTruthy();
    act(() => remove!.click());

    expect(sectionField()?.value).toBe("Beta");
  });
});
