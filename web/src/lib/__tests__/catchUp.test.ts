import { describe, expect, it } from "vitest";
import { CATCH_UP_FLOOR_MS, shouldCatchUp } from "@/lib/catchUp";

/**
 * The floor that keeps a blocked stream from re-reading the account back to back.
 *
 * `lastPassAt` is when the previous pass *ended*, which is the property the
 * floor is about: a pass that outlives the floor must not hand the next probe a
 * free start. The stream's own triggers (a reconnect, the line coming back) are
 * decided elsewhere and do not consult this.
 */
describe("a catch-up pass while the stream is down", () => {
  const base = {
    reachable: true,
    connected: false,
    lastPassAt: 0,
    now: 1_000_000,
  };

  it("starts when nothing has run and the server answers", () => {
    expect(shouldCatchUp(base)).toBe(true);
  });

  it("waits out the floor after a pass that has ended", () => {
    const ended = base.now - CATCH_UP_FLOOR_MS + 1;
    expect(shouldCatchUp({ ...base, lastPassAt: ended })).toBe(false);
    expect(shouldCatchUp({ ...base, lastPassAt: ended - 1 })).toBe(true);
  });

  it("measures a pass that outlived the floor, not the one that started it", () => {
    /*
     * A pass whose start is a minute behind us but which ended a moment ago must
     * hold the next probe off: stamping the start would let a pass longer than
     * the floor run back to back, which is the storm the floor exists to stop.
     */
    const startedLongAgo = base.now - 60_000;
    expect(
      shouldCatchUp({ ...base, lastPassAt: startedLongAgo + 59_000 }),
      "the pass ended a second ago",
    ).toBe(false);
  });

  it("does not start while the stream is up, or on a line nothing reaches", () => {
    expect(shouldCatchUp({ ...base, connected: true })).toBe(false);
    expect(shouldCatchUp({ ...base, reachable: false })).toBe(false);
  });
});
