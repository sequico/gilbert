import { describe, expect, it } from "vitest";
import {
  compareMessages,
  isChatMarkerDoc,
  isChatMessageDoc,
  markerNameFor,
  unreadCount,
} from "@/lib/chat";
import { groupMailboxAccounts } from "@/lib/mailAccounts";

/*
 * Group chat helpers (ADR 0006): ordering, the unread kind rule, marker
 * naming, document validation and the working-group classifier. Pure logic —
 * the JMAP paths against the mock are covered by the server suite.
 */

const msg = (id: string, created: string, replyTo?: string) => ({
  v: 1 as const,
  id,
  created,
  from: "demo@example.com",
  at: "2026-09-08T10:00:00.000Z",
  text: "hello",
  ...(replyTo ? { replyTo } : {}),
});

describe("compareMessages", () => {
  it("orders by server creation time, oldest first", () => {
    const a = msg("f1", "2026-09-08T10:00:00.000Z");
    const b = msg("f2", "2026-09-08T10:00:01.000Z");
    expect(compareMessages(a, b)).toBeLessThan(0);
    expect(compareMessages(b, a)).toBeGreaterThan(0);
  });

  it("breaks a same-instant tie by id so the order is total", () => {
    const a = msg("fb", "2026-09-08T10:00:00.000Z");
    const b = msg("fa", "2026-09-08T10:00:00.000Z");
    expect(compareMessages(a, b)).toBeGreaterThan(0);
    expect(compareMessages(b, a)).toBeLessThan(0);
    expect(compareMessages(a, a)).toBe(0);
  });
});

describe("unreadCount — the ADR kind rule", () => {
  const nodes = [msg("m1", "t1"), msg("m2", "t2"), msg("m3", "t3")];

  it("no marker means badge 0, whatever the transcript holds", () => {
    expect(unreadCount(nodes, null)).toBe(0);
    expect(unreadCount([], null)).toBe(0);
  });

  it("a marker born on an empty chat counts everything after it", () => {
    expect(unreadCount(nodes, { lastRead: null })).toBe(3);
  });

  it("counts only messages newer than the marker", () => {
    expect(unreadCount(nodes, { lastRead: "m2" })).toBe(1);
    expect(unreadCount(nodes, { lastRead: "m3" })).toBe(0);
  });

  it("a marker pointing at a message we no longer hold reads as nothing new", () => {
    expect(unreadCount(nodes, { lastRead: "gone" })).toBe(0);
  });
});

describe("markerNameFor", () => {
  it("is deterministic and encodes the address", () => {
    expect(markerNameFor("demo@example.com")).toBe(markerNameFor("demo@example.com"));
    expect(markerNameFor("demo@example.com")).toContain("%40");
  });

  it("keeps two members' markers distinct", () => {
    expect(markerNameFor("ada@example.org")).not.toBe(markerNameFor("grace@example.org"));
  });
});

describe("message document validation", () => {
  it("accepts a v1 message with an optional replyTo", () => {
    expect(isChatMessageDoc({ v: 1, from: "a@example.org", at: "t", text: "hi" })).toBe(
      true,
    );
    expect(
      isChatMessageDoc({
        v: 1,
        from: "a@example.org",
        at: "t",
        text: "hi",
        replyTo: "f1",
      }),
    ).toBe(true);
  });

  it("rejects malformed documents", () => {
    expect(isChatMessageDoc(null)).toBe(false);
    expect(isChatMessageDoc({ v: 2, from: "a", at: "t", text: "x" })).toBe(false);
    expect(isChatMessageDoc({ v: 1, from: 5, at: "t", text: "x" })).toBe(false);
    expect(isChatMessageDoc({ v: 1, from: "a", at: "t", text: "x", replyTo: 7 })).toBe(
      false,
    );
    expect(isChatMarkerDoc({ v: 1, lastRead: "m1" })).toBe(true);
    expect(isChatMarkerDoc({ v: 1, lastRead: 7 })).toBe(false);
  });
});

describe("groupMailboxAccounts — one classifier for every group surface", () => {
  const accounts = [
    { accountId: "a1", name: "demo@example.com", kind: "own" as const },
    { accountId: "a2", name: "grace@example.org", kind: "group" as const },
    { accountId: "a3", name: "team@example.org", kind: "group" as const },
    { accountId: "a4", name: "gilbert-admin@example.org", kind: "group" as const },
  ];

  it("keeps working groups and drops the own account and the admin group", () => {
    const groups = groupMailboxAccounts(accounts);
    expect(groups.map((g) => g.accountId)).toEqual(["a2", "a3"]);
  });

  it("treats the admin group on any domain as not a working group", () => {
    const admin = [
      { accountId: "x", name: "gilbert-admin@other.example", kind: "group" as const },
    ];
    expect(groupMailboxAccounts(admin)).toEqual([]);
  });
});
