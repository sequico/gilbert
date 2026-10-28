// @vitest-environment node
import { buildFilter, parseQuery } from "@gilbert/shared/search";
import { describe, expect, it } from "vitest";
import type { Mailbox } from "@/jmap/types";

const mb = (id: string, name: string, role: Mailbox["role"] = null): Mailbox => ({
  id,
  name,
  role,
  parentId: null,
  sortOrder: 0,
  totalEmails: 0,
  unreadEmails: 0,
  totalThreads: 0,
  unreadThreads: 0,
  isSubscribed: true,
  myRights: {} as Mailbox["myRights"],
});

describe("parseQuery", () => {
  it("reads the aliases the grammar names", () => {
    // The prompt tells a model what the grammar is, so every alias the
    // sentence names has to parse to the same field as its canonical form.
    expect(parseQuery("in:Inbox folder:Work").in).toBe("Work");
    expect(parseQuery("since:2024-01-02").after).toBeDefined();
    expect(parseQuery("newer:2024-01-02").after).toBeDefined();
    expect(parseQuery("older:2024-01-02").before).toBeDefined();
    expect(parseQuery("size:2M").larger).toBe(2 * 1024 * 1024);
    expect(parseQuery("has:star").starred).toBe(true);
    expect(parseQuery("has:flag").starred).toBe(true);
    expect(parseQuery("-keyword:x").notLabel).toEqual(["x"]);
  });

  it("parses gmail-style operators", () => {
    const p = parseQuery(
      'from:ada subject:"q3 plan" has:attachment is:unread in:work before:2024-01-02 larger:2M hello world',
    );
    expect(p.from).toBe("ada");
    expect(p.subject).toBe("q3 plan");
    expect(p.hasAttachment).toBe(true);
    expect(p.unread).toBe(true);
    expect(p.in).toBe("work");
    expect(p.before).toMatch(/^2024-01-0[12]T/);
    expect(p.larger).toBe(2 * 1024 * 1024);
    expect(p.text).toEqual(["hello", "world"]);
  });
  it("handles labels and negation", () => {
    const p = parseQuery("label:work -label:done is:starred");
    expect(p.label).toEqual(["work"]);
    expect(p.notLabel).toEqual(["done"]);
    expect(p.starred).toBe(true);
  });

  it("does not read a negated operator it cannot invert as a positive filter", () => {
    // The grammar promises only `-label:`/`-keyword:` are negatable, so
    // `-from:ada` is not a `from:` filter that lost its sign -- that would make
    // an exclusion search for the thing it meant to exclude.
    const p = parseQuery("-from:ada -subject:q3 -in:trash");
    expect(p.from).toBeUndefined();
    expect(p.subject).toBeUndefined();
    expect(p.in).toBeUndefined();
    expect(p.text).toEqual(["-from:ada", "-subject:q3", "-in:trash"]);
  });

  it("refuses a date whose day the month does not have", () => {
    // JS rolls an impossible component into the next month, so `2026-02-30`
    // silently became March 2 and searched a different day; the components are
    // checked against the month's true length instead.
    expect(parseQuery("before:2026-02-30").before).toBeUndefined();
    expect(parseQuery("before:2026-04-31").before).toBeUndefined();
    expect(parseQuery("after:2026/13/01").after).toBeUndefined();
    // The same shape the sibling assertion uses: the instant is local midnight,
    // so a timezone ahead of UTC may render it a day earlier.
    expect(parseQuery("before:2024-02-29").before).toMatch(/^2024-02-2[89]T/);
  });
});

describe("buildFilter", () => {
  const mailboxes = { inbox: mb("inbox", "Inbox", "inbox"), work: mb("work", "Work") };
  it("builds a simple condition", () => {
    const f = buildFilter(parseQuery("invoice"), mailboxes, "inbox");
    expect(f).toEqual({ text: "invoice", inMailbox: "inbox" });
  });
  it("resolves in: to a mailbox by name and ANDs keyword conditions", () => {
    const f = buildFilter(parseQuery("in:work is:starred label:foo"), mailboxes, "inbox");
    expect(f).toEqual({
      operator: "AND",
      conditions: [
        { inMailbox: "work" },
        { hasKeyword: "$flagged" },
        { hasKeyword: "foo" },
      ],
    });
  });
  it("maps is:unread to notKeyword $seen", () => {
    const f = buildFilter(parseQuery("is:unread"), mailboxes, null);
    expect(f).toEqual({ notKeyword: "$seen" });
  });

  it("an in: that names no folder matches nothing, not all mail", () => {
    // The name resolved to nothing and is not the "everywhere" keyword, so the
    // search is a folder that is not there: it must return nothing, where
    // dropping the filter silently widened it to every mailbox.
    const f = buildFilter(parseQuery("in:Nope"), mailboxes, "inbox");
    expect(f).toEqual({
      operator: "AND",
      conditions: [{ before: "1970-01-01T00:00:00Z", after: "1970-01-01T00:00:01Z" }, {}],
    });
  });

  it("in:anywhere still widens to every folder", () => {
    expect(buildFilter(parseQuery("in:anywhere"), mailboxes, "inbox")).toEqual({});
  });
});
