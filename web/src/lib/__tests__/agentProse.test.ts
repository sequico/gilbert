import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A group's prose is written through the administration's route, not the group's
 * account (owner decision 2026-10-18). What this tier owns is the call: the
 * group's name in the path, and the state the read answered carried back on every
 * write so the server can refuse one that lost a race.
 */
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/jmap/client", () => ({ apiFetch }));

import { deleteRule, readGroupProse, saveInstruction, saveRule } from "../agentProse";

const GROUP = "team@example.org";
const PATH = "/api/admin/groups/team%40example.org/prose";

beforeEach(() => {
  apiFetch.mockReset();
});

describe("the prose route", () => {
  it("reads the instruction, the rules and the state", async () => {
    apiFetch.mockResolvedValue({
      instruction: "Answer in the group's voice.",
      rules: [{ id: "invoices" }],
      state: "s7",
    });
    const prose = await readGroupProse(GROUP);
    expect(apiFetch).toHaveBeenCalledWith(PATH);
    expect(prose.state).toBe("s7");
    expect(prose.rules).toHaveLength(1);
  });

  it("carries the state the read answered back on a write", async () => {
    apiFetch.mockResolvedValue({ ok: true });
    await saveInstruction(GROUP, "Answer in the group's voice.", "s7");
    expect(apiFetch).toHaveBeenCalledWith(`${PATH}/instruction`, {
      method: "PUT",
      body: JSON.stringify({
        instruction: "Answer in the group's voice.",
        ifInState: "s7",
      }),
    });

    apiFetch.mockResolvedValue({ rule: { id: "invoices" } });
    await saveRule(GROUP, { id: "invoices" } as never, "s7");
    expect(apiFetch).toHaveBeenCalledWith(`${PATH}/rules/invoices`, {
      method: "PUT",
      body: JSON.stringify({ rule: { id: "invoices" }, ifInState: "s7" }),
    });

    apiFetch.mockResolvedValue({ ok: true });
    await deleteRule(GROUP, "invoices", "s7");
    expect(apiFetch).toHaveBeenCalledWith(`${PATH}/rules/invoices`, {
      method: "DELETE",
      body: JSON.stringify({ ifInState: "s7" }),
    });
  });
});
