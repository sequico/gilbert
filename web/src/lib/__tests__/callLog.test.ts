import { describe, expect, it } from "vitest";
import {
  CALL_LOG_LIMIT,
  type CallLogEntry,
  parseCallLog,
  withCallEntry,
} from "@/lib/phone/callLog";

/**
 * The account's call-history document (ADR 0023). The shape is the one the
 * phone writes and the log panel reads, so what is pinned here is that a
 * malformed document reads as empty, and that the list keeps the newest and
 * stays bounded.
 */

const entry = (n: number): CallLogEntry => ({
  at: n,
  direction: "out",
  remote: `+1555000${n}`,
  seconds: 0,
  outcome: "failed",
});

describe("the call log document", () => {
  it("keeps the valid calls and drops the shapeless", () => {
    const good = {
      at: 1,
      direction: "in",
      remote: "+1",
      seconds: 3,
      outcome: "answered",
    };
    expect(parseCallLog(null)).toEqual([]);
    expect(parseCallLog({ calls: "no" })).toEqual([]);
    expect(parseCallLog({ calls: [good, { at: "x" }, null, { at: 2 }] })).toEqual([good]);
  });

  it("prepends the newest and stays bounded", () => {
    let calls: CallLogEntry[] = [];
    for (let i = 0; i < CALL_LOG_LIMIT + 5; i++)
      calls = withCallEntry(calls, entry(i)).calls;
    expect(calls).toHaveLength(CALL_LOG_LIMIT);
    expect(calls[0]?.at).toBe(CALL_LOG_LIMIT + 4);
  });
});
