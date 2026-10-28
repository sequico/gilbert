// @vitest-environment node
import { AGENT_SIGNATURE } from "@gilbert/shared/agent";
import { afterEach, describe, expect, it } from "vitest";
import { setCatalog } from "@/lib/i18n";
import { stepStamp } from "@/lib/workorderStamp";

/**
 * Who a settled step says settled it (ADR 0024).
 *
 * A step carries the last actor, and the agent is one of the actors but not a
 * person: the stamp must read as a sentence about the agent rather than showing
 * the stored signature as though it were somebody's name.
 */

afterEach(() => {
  setCatalog("en", { strings: {}, plurals: {} });
});

describe("the stamp under a settled step", () => {
  it("names a person by their own address", () => {
    expect(stepStamp("ann@example.com", "1 March 2026")).toBe(
      "Set by ann@example.com on 1 March 2026",
    );
  });

  it("says the agent where the agent settled it, never the raw signature", () => {
    const stamp = stepStamp(AGENT_SIGNATURE, "1 March 2026");
    expect(stamp).toBe("Set by the agent on 1 March 2026");
    expect(stamp).not.toContain(AGENT_SIGNATURE);
  });

  it("reads in the catalogue's own words", () => {
    setCatalog("it", {
      strings: {
        "Set by the agent on {when}": "Impostato dall'agente il {when}",
      },
      plurals: {},
    });
    expect(stepStamp(AGENT_SIGNATURE, "1 marzo 2026")).toBe(
      "Impostato dall'agente il 1 marzo 2026",
    );
  });
});
