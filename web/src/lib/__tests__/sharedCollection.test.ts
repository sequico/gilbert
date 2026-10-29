import { describe, expect, it } from "vitest";
import { isSharedCollectionBook } from "@/lib/contacts";

/*
 * Which books are a **shared collection** — the installation's directory, or a
 * group's — and therefore where importing or exporting is an installation
 * administrator's. This is the rule the sidebar draws and the import and export
 * ask again where they run, so it is pinned here rather than through a menu.
 */

const rule = (spec: {
  bookId?: string;
  accountId?: string | null;
  groups?: string[];
  groupsKnown?: boolean;
}) =>
  isSharedCollectionBook({
    bookId: spec.bookId ?? "b1",
    accountId: spec.accountId ?? null,
    groups: new Set(spec.groups ?? []),
    groupsKnown: spec.groupsKnown ?? true,
  });

describe("a shared collection's book", () => {
  it("is the installation's directory, whatever the account says", () => {
    expect(rule({ bookId: "global-contacts", accountId: "global" })).toBe(true);
    expect(rule({ bookId: "global-contacts", accountId: null })).toBe(true);
    // A directory card read from "All contacts" has no book of its own: the
    // account is what is left to recognise it by.
    expect(rule({ bookId: "all", accountId: "global" })).toBe(true);
  });

  it("is a group's book, and not a colleague's share", () => {
    expect(rule({ accountId: "freight", groups: ["freight"] })).toBe(true);
    expect(rule({ accountId: "grace", groups: ["freight"] })).toBe(false);
  });

  it("is the reader's own book, which has no account of its own", () => {
    expect(rule({ accountId: null })).toBe(false);
  });

  it("is any other account's book until the group probe has answered", () => {
    expect(rule({ accountId: "grace", groupsKnown: false })).toBe(true);
  });
});
