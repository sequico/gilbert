import { describe, expect, it } from "vitest";
import {
  compareMessages,
  isChatMarkerDoc,
  isChatMessageDoc,
  markerNameFor,
  mentionablesOf,
  mentionRegex,
  mentionsFromText,
  messageDoc,
  participantsOf,
  shortName,
  unreadCount,
} from "@/lib/chat";
import { groupMailboxAccounts } from "@/lib/mailAccounts";

/*
 * Group chat helpers (ADR 0005): ordering, the unread kind rule, marker
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
    expect(isChatMessageDoc({ v: 1, from: "a", at: "t", text: "x", mentions: "b" })).toBe(
      false,
    );
    expect(
      isChatMessageDoc({
        v: 1,
        from: "a",
        at: "t",
        text: "x",
        mentions: [{ kind: "principal", id: "b@x" }],
      }),
    ).toBe(true);
    expect(
      isChatMessageDoc({
        v: 1,
        from: "a",
        at: "t",
        text: "x",
        mentions: [{ kind: "other", id: "b@x" }],
      }),
    ).toBe(false);
    expect(isChatMarkerDoc({ v: 1, lastRead: "m1" })).toBe(true);
    expect(isChatMarkerDoc({ v: 1, lastRead: 7 })).toBe(false);
  });
});

describe("participantsOf — the mentionable set", () => {
  it("is the reader plus everyone who has posted, sorted, deduped", () => {
    const msgs = [
      { from: "b@example.org" },
      { from: "a@example.org" },
      { from: "b@example.org" },
    ];
    expect(participantsOf(msgs, "me@example.org")).toEqual([
      "a@example.org",
      "b@example.org",
      "me@example.org",
    ]);
  });

  it("returns just the reader when nobody has posted", () => {
    expect(participantsOf([], "me@example.org")).toEqual(["me@example.org"]);
  });
});

describe("mentionablesOf — the offerable set (ADR 0005)", () => {
  const posted = ["gone@example.org", "here@example.org", "me@example.org"];

  it("offers the transcript when no roster could be read", () => {
    expect(mentionablesOf(posted, null, ["me@example.org"])).toEqual([
      "gone@example.org",
      "here@example.org",
      "me@example.org",
    ]);
  });

  it("offers the roster instead, which drops who has left", () => {
    // Remove the swap and this fails: somebody the group no longer holds stays
    // offerable, which is the report this set exists to answer.
    expect(mentionablesOf(posted, ["here@example.org", "me@example.org"], [])).toEqual([
      "here@example.org",
      "me@example.org",
    ]);
  });

  it("offers a member who has never posted, and keeps the reader and the agent", () => {
    expect(
      mentionablesOf(
        posted,
        ["me@example.org", "new@example.org"],
        ["me@example.org", "gilbert@example.org"],
      ),
    ).toEqual(["gilbert@example.org", "me@example.org", "new@example.org"]);
  });
});

describe("mentionsFromText", () => {
  const participants = ["a@example.org", "b@example.org"];

  it("finds exact @address mentions, once each, in first-appearance order", () => {
    expect(
      mentionsFromText(
        "hi @b@example.org and @a@example.org @b@example.org",
        participants,
      ),
    ).toEqual([
      { kind: "principal", id: "b@example.org" },
      { kind: "principal", id: "a@example.org" },
    ]);
  });

  it("ignores non-participant tokens and bare @", () => {
    expect(mentionsFromText("hi @stranger and @", participants)).toEqual([]);
    expect(mentionsFromText("no mention here", participants)).toEqual([]);
  });
});

describe("mention round-trip", () => {
  it("keeps the space after a mention and renders the short name", () => {
    const participants = ["ada@example.org"];
    const text = "hello @ada@example.org there";
    expect(mentionsFromText(text, participants)).toEqual([
      { kind: "principal", id: "ada@example.org" },
    ]);
    expect(text.split(mentionRegex(["ada@example.org"]))).toEqual([
      "hello ",
      "ada@example.org",
      " there",
    ]);
    expect(shortName("ada@example.org")).toBe("ada");
  });
});

describe("messageDoc — the one message writer", () => {
  it("builds a v1 doc with optional replyTo and mentions", () => {
    const doc = messageDoc("me@example.org", "hi", undefined, [
      { kind: "principal", id: "a@example.org" },
    ]);
    expect(doc).toMatchObject({ v: 1, from: "me@example.org", text: "hi" });
    expect(doc.mentions).toEqual([{ kind: "principal", id: "a@example.org" }]);
    expect(typeof doc.at).toBe("string");
    expect(doc.replyTo).toBeUndefined();
  });

  it("omits empty mentions", () => {
    expect(messageDoc("me@example.org", "hi").mentions).toBeUndefined();
  });
});

describe("groupMailboxAccounts — one classifier for every group surface", () => {
  const accounts = [
    { accountId: "a1", name: "demo@example.com", kind: "own" as const },
    { accountId: "a2", name: "grace@example.org", kind: "group" as const },
    { accountId: "a3", name: "team@example.org", kind: "group" as const },
    { accountId: "a4", name: "gilbert-admin@example.org", kind: "group" as const },
  ];

  it("keeps every group mailbox and drops the own account", () => {
    const groups = groupMailboxAccounts(accounts);
    expect(groups.map((g) => g.accountId)).toEqual(["a2", "a3", "a4"]);
  });

  it("treats a group mailbox named gilbert-admin on any domain as a working group (ADR 0001)", () => {
    const admin = [
      { accountId: "x", name: "gilbert-admin@other.example", kind: "group" as const },
    ];
    expect(groupMailboxAccounts(admin).map((g) => g.accountId)).toEqual(["x"]);
  });
});
