import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A group's instruction is written through the administration's route, not the
 * group's account (owner decision 2026-10-18). What this tier owns is the call:
 * the group's name in the path, the areas it works, and the state the read
 * answered carried back on every write so the server can refuse one that lost a
 * race.
 */
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/jmap/client", () => ({ apiFetch }));

import { readGroupInstruction, saveInstruction } from "../agentInstruction";

const GROUP = "team@example.org";
const PATH = "/api/admin/groups/team%40example.org/prose";

beforeEach(() => {
  apiFetch.mockReset();
});

describe("the instruction route", () => {
  it("reads the instruction, the areas and the state", async () => {
    apiFetch.mockResolvedValue({
      instruction: "Answer in the group's voice.",
      areas: ["mail", "files"],
      state: "s7",
    });
    const prose = await readGroupInstruction(GROUP);
    expect(apiFetch).toHaveBeenCalledWith(PATH);
    expect(prose.state).toBe("s7");
    expect(prose.areas).toEqual(["mail", "files"]);
  });

  it("carries the state the read answered back on a write", async () => {
    apiFetch.mockResolvedValue({ ok: true });
    await saveInstruction(GROUP, "Answer in the group's voice.", ["mail"], "s7");
    expect(apiFetch).toHaveBeenCalledWith(`${PATH}/instruction`, {
      method: "PUT",
      body: JSON.stringify({
        instruction: "Answer in the group's voice.",
        areas: ["mail"],
        ifInState: "s7",
      }),
    });
  });
});
