import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/jmap/types";
import { orderIndexOf } from "../tasks";

const task = (over: Partial<TaskItem>): TaskItem =>
  ({
    id: "t1",
    "@type": "Task",
    calendarIds: { c1: true },
    title: "x",
    progress: "needs-action",
    ...over,
  }) as TaskItem;

/**
 * Manual task order lives in the `order-N` keywords. Two properties of that
 * encoding are load-bearing and easy to break:
 *
 * 1. Only true-valued entries count, so a stale key the server kept as
 *    `false` (merge-style keyword removal) must not reorder anything.
 * 2. The smallest true key wins, because after a drag every open task gets a
 *    contiguous 0..n-1 key.
 */
describe("orderIndexOf", () => {
  it("returns null for a task that was never ordered", () => {
    expect(orderIndexOf(task({}))).toBeNull();
  });

  it("returns the only true key", () => {
    expect(orderIndexOf(task({ keywords: { "order-3": true } }))).toBe(3);
  });

  it("ignores stale keys stored as false", () => {
    expect(
      orderIndexOf(
        task({ keywords: { "order-0": false, "order-2": true, "order-5": false } }),
      ),
    ).toBe(2);
  });

  it("keeps the smallest of several true keys", () => {
    expect(orderIndexOf(task({ keywords: { "order-7": true, "order-1": true } }))).toBe(
      1,
    );
  });

  it("ignores unrelated keywords", () => {
    expect(orderIndexOf(task({ keywords: { $seen: true, "order-4": true } }))).toBe(4);
  });
});
