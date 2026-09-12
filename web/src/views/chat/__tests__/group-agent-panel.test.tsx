import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberAgentView } from "@/lib/agents";
import { useAgents } from "@/store/agents";
import { GroupAgentPanel } from "../GroupAgentPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The panel behind the AI indicator beside the group chat, as a member reads it.
 *
 * Two things a member has to be able to read there (ADR 0003 "Members see, never
 * change"): what the agent is told, and what it does. And one thing they must
 * not be able to do from it: change either. Both are about what the panel does
 * with the view it is handed, so the store is seeded directly and the only fetch
 * this file makes is the one under test — the panel reads the member's own route
 * (`/api/agent/group/:name`) and never the admin one, which needs Stalwart
 * administration and would answer a member nothing.
 */

const GROUP = "team@example.org";

/** One group's member view, as the member route answers it. */
function memberView(overrides: Partial<MemberAgentView> = {}): MemberAgentView {
  return {
    group: GROUP,
    granted: true,
    agentAddress: "gilbert@example.org",
    rules: [
      {
        id: "r1",
        name: "Label processed mail",
        enabled: true,
        trigger: { on: "email", filter: { subject: "invoice" } },
        review: { mode: "always" },
        instruction: "Label the invoice so the group can file it.",
      },
    ],
    instruction: {
      text: "Answer in Italian.\nAlways cite the invoice number.",
      notes: "",
      updatedAt: "2026-09-10T09:00:00.000Z",
      updatedBy: "demo@example.com",
      max: 4000,
      notesMax: 2000,
    },
    jobs: [],
    audit: [],
    ...overrides,
  };
}

describe("the group's agent panel", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useAgents.getState().reset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => root.unmount());
    host.remove();
  });

  /** Render the panel and let its effect (and any read) settle. */
  async function renderPanel() {
    await act(async () => {
      root.render(<GroupAgentPanel name={GROUP} onClose={() => {}} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("reads the group through the member's own route, never the admin one", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return {
        ok: true,
        status: 200,
        json: async () => memberView(),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderPanel();

    const asked = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(asked).toContain("/api/agent/group/team%40example.org");
    expect(asked.some((url) => url.includes("/api/admin/"))).toBe(false);
    // The answer landed in the store under the group's own key, which is what
    // the chat's mention picker and the send path read as well.
    expect(useAgents.getState().memberViews[GROUP]?.granted).toBe(true);
  });

  it("shows the group's standing instruction as text, and offers no way to edit it", async () => {
    useAgents.setState({ memberViews: { [GROUP]: memberView() } });

    await renderPanel();

    const text = host.textContent ?? "";
    expect(text).toContain("Answer in Italian.");
    expect(text).toContain("Always cite the invoice number.");
    // The line the owner asked for: the pen is an administrator's.
    expect(text).toContain(
      "Only an administrator of this group changes its instruction and its automations; every member reads them here.",
    );
    expect(text).toContain("Last written by demo@example.com");
    // Read-only by construction: no field, no dropdown, and the only button is
    // the one that closes the panel.
    expect(host.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe("Close");
  });

  it("says a group has no instruction instead of showing a blank", async () => {
    useAgents.setState({
      memberViews: {
        [GROUP]: memberView({
          instruction: {
            text: "  ",
            notes: "",
            updatedAt: null,
            updatedBy: null,
            max: 4000,
            notesMax: 2000,
          },
        }),
      },
    });

    await renderPanel();

    const text = host.textContent ?? "";
    expect(text).toContain("No standing instruction has been written for this group.");
    expect(text).not.toContain("Last written by");
  });

  it("describes each automation in words, not as a document", async () => {
    useAgents.setState({ memberViews: { [GROUP]: memberView() } });

    await renderPanel();

    const text = host.textContent ?? "";
    expect(text).toContain("Label processed mail");
    expect(text).toContain("An email arrives · subject contains invoice");
    expect(text).toContain("Always ask a person first");
    expect(text).toContain("Label the invoice so the group can file it.");
    expect(text).not.toContain("Add a label");
    expect(text).not.toContain("{");
  });

  it("says plainly when no agent works in the group", async () => {
    useAgents.setState({
      memberViews: {
        [GROUP]: memberView({ rules: [], granted: false, agentAddress: "" }),
      },
    });

    await renderPanel();

    expect(host.textContent ?? "").toContain("No agent works in this group");
  });
});
