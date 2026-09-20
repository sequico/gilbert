import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_SCHEDULE_PRESETS, ruleProblems } from "@gilbert/agent/documents";
import { useAgents } from "@/store/agents";
import { RuleEditor } from "../RuleEditor";
import { type AgentRuleDraft, RuleForm } from "../RuleForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The trigger an automation stands on, as the editor offers it (ADR 0006).
 *
 * Two things the record promises about this surface are checked here, and both
 * are about a choice rather than a paint:
 *
 * - **Changing the trigger hands back a document that is JSON.** The cadence
 *   belongs to the clock, so an event with no clock carries no `everyMinutes`
 *   key — not one holding `undefined`. That key is not JSON: the shared
 *   validator refuses such a value, and because the editor validates its own
 *   draft while drawing it, the refusal was a blank page rather than a
 *   sentence. This is the regression test for it.
 * - **The select offers only the triggers nothing holds**, plus the one the
 *   automation itself stands on, so two enabled automations on one trigger is
 *   not something a person discovers by having a save refused.
 */

const GROUP = "team@example.org";

/** The schema the server publishes, cut down to what this surface reads. */
const SCHEMA = {
  "x-actions": [{ name: "chat.post" }, { name: "keyword.add" }],
  "x-areas": [
    { area: "chat", label: "Chat", actions: ["chat.post"] },
    { area: "mail", label: "Mail", actions: ["keyword.add"] },
  ],
  "x-standalone": [],
};

/** One rule, as the panel hands the form one. */
function draft(overrides: Partial<AgentRuleDraft> = {}): AgentRuleDraft {
  return {
    v: 1,
    id: "r1",
    version: 1,
    enabled: true,
    trigger: { on: "schedule", everyMinutes: 1440 },
    capabilities: ["keyword.add"],
    instruction: "File what arrives.",
    ...overrides,
  };
}

/** One group's admin surface, with the rules the caller names. */
function groupView(rules: AgentRuleDraft[]) {
  return {
    group: GROUP,
    granted: true,
    agentAddress: "gilbert@example.org",
    rules,
    jobs: [],
    decisions: [],
    audit: [],
    meter: {
      runs: 0,
      inputHitTokens: 0,
      inputMissTokens: 0,
      outputTokens: 0,
      uncounted: 0,
    },
    schedule: [],
  };
}

describe("the trigger an automation stands on", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const answer = String(url).includes("rule-schema")
          ? SCHEMA
          : groupView([draft()]);
        return { ok: true, status: 200, json: async () => answer } as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => root.unmount());
    host.remove();
    useAgents.setState({ groupViews: {}, grant: null, busy: {}, problems: {} });
  });

  async function render(element: ReactElement): Promise<void> {
    await act(async () => {
      root.render(element);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** Pick a value in a select the way a person does. */
  async function pick(select: HTMLSelectElement, value: string): Promise<void> {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("drops the cadence when the trigger leaves the clock", async () => {
    let changed: AgentRuleDraft | null = null;
    // The form is driven as the editor drives it: the change is recorded, and
    // the document it produced is what the editor would then validate.
    const form = (
      <RuleForm
        rule={draft()}
        group={GROUP}
        grant={null}
        taken={new Set()}
        onChange={(next) => {
          changed = next;
        }}
      />
    );
    await render(form);

    const select = host.querySelector<HTMLSelectElement>("#agent-rule-trigger");
    expect(select, "the trigger select is there").toBeTruthy();
    await pick(select as HTMLSelectElement, "chat");

    const next = changed as AgentRuleDraft | null;
    expect(next?.trigger.on).toBe("chat");
    // The key is absent, not `undefined`: a value the schema cannot walk is the
    // document that blanked this page.
    expect(next && Object.hasOwn(next.trigger, "everyMinutes")).toBe(false);
    expect(() => ruleProblems(next)).not.toThrow();
    expect(ruleProblems(next)).toEqual([]);
  });

  it("arms a cadence when the trigger becomes the clock", async () => {
    let changed: AgentRuleDraft | null = null;
    await render(
      <RuleForm
        rule={draft({ trigger: { on: "email" } })}
        group={GROUP}
        grant={null}
        taken={new Set()}
        onChange={(next) => {
          changed = next;
        }}
      />,
    );

    const select = host.querySelector<HTMLSelectElement>("#agent-rule-trigger");
    await pick(select as HTMLSelectElement, "schedule");

    const next = changed as AgentRuleDraft | null;
    expect(next?.trigger.on).toBe("schedule");
    // A rule that stated no cadence before it had a clock gets the first
    // preset rather than a missing key: the clock always has one.
    expect(next?.trigger.everyMinutes).toBe(AGENT_SCHEDULE_PRESETS[0]);
    expect(ruleProblems(next)).toEqual([]);
  });

  it("offers nothing another enabled automation holds, and stays drawable", async () => {
    useAgents.setState({ groupViews: { [GROUP]: groupView([draft()]) } as never });

    await render(<RuleEditor groups={[GROUP]} group={GROUP} />);

    const newButton = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "New automation",
    );
    expect(newButton, "a new automation can be started").toBeTruthy();
    await act(async () => {
      newButton?.click();
    });

    const select = host.querySelector<HTMLSelectElement>("#agent-rule-trigger");
    expect(select, "the form is drawn").toBeTruthy();
    const offered = [...(select?.options ?? [])].map((o) => o.value);
    // The group's one enabled automation is on the clock, so the clock is the
    // one event the form does not offer.
    expect(offered).not.toContain("schedule");
    expect(offered).toContain("chat");

    // Choosing the chat trigger is the interaction that once unmounted the
    // whole panel: the draft it produces is validated as it is drawn.
    if (select) await pick(select, "chat");
    expect(host.textContent ?? "").toContain("What it may do");
  });
});
