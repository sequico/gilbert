import { AGENT_LABELS } from "@gilbert/shared/labels";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { LabelsSettings } from "../LabelsSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A person's own label surface (ADR 0005).
 *
 * The reserved `G-` labels name the agent's work in a group's account, and the
 * agent works in groups only — a person's account has none — so this surface is
 * the one section of personal labels and never a system section beside it.
 */
describe("a person's label surface", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        labels: [{ keyword: "work", name: "Work", color: "#123456" }],
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  });

  it("is the personal labels alone, with no system section", async () => {
    await act(async () => {
      root.render(<LabelsSettings />);
    });

    const text = host.textContent ?? "";
    expect(text).toContain("Work");
    expect(text).toContain("work");
    expect(text).not.toContain("System labels");
    for (const label of AGENT_LABELS) {
      expect(text).not.toContain(label.name);
      expect(text).not.toContain(label.keyword);
    }
  });
});
