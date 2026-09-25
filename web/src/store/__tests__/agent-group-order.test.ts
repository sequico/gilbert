import { describe, expect, it } from "vitest";
import type { AgentStatus } from "@/lib/agents";
import { agentGroupNames } from "@/store/agents";

/**
 * The groups an administration lists, in one order.
 *
 * The status carries the agent's own membership as its session shows it, and
 * the address is the key a person reads the list by — so the Master Groups
 * list, the group picker and the audit filter read their order from this one
 * function rather than sorting a copy each. The fixture arrives out of order
 * and mixed-case, so a function that stopped sorting would show it.
 */

const status = (names: readonly string[]): AgentStatus =>
  ({ groups: names.map((name) => ({ name })) }) as unknown as AgentStatus;

describe("the order the agent's groups are listed in", () => {
  it("sorts them by address, whatever order the status answered", () => {
    expect(
      agentGroupNames(
        status(["zebra@example.org", "Alpha@example.org", "middle@example.org"]),
      ),
    ).toEqual(["Alpha@example.org", "middle@example.org", "zebra@example.org"]);
  });

  it("lists nothing before the status has been read", () => {
    expect(agentGroupNames(null)).toEqual([]);
  });
});
