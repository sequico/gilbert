// @vitest-environment node
/**
 * Where a reference the agent wrote sends the reader (ADR 0039).
 *
 * The address is composed here from the kind and the id the server checked, so
 * the test is the one place that fixes the shapes: a kind added later that is
 * not given a route is a render that goes nowhere.
 */
import { describe, expect, it } from "vitest";
import { REF_LABEL, refHref } from "@/lib/agentRefs";

describe("refHref", () => {
  it("opens the conversation, the file, the card and the day", () => {
    expect(refHref({ kind: "thread", id: "t-1" })).toBe("/search/t-1");
    expect(refHref({ kind: "file", id: "node-7" })).toBe("/files/node-7");
    expect(refHref({ kind: "contact", id: "card-9" })).toBe("/contacts/card-9");
    expect(refHref({ kind: "contact", id: "card-9", account: "g1" })).toBe(
      "/contacts/card-9?account=g1",
    );
    expect(refHref({ kind: "event", id: "ev-3", date: "2026-11-03" })).toBe(
      "/calendar/day/2026-11-03",
    );
  });

  it("cannot be steered into another origin, whatever the id holds", () => {
    // The id comes from a document somebody else can write, so it is escaped
    // rather than trusted: an id is a path segment and never a destination.
    expect(refHref({ kind: "file", id: "../../admin" })).toBe("/files/..%2F..%2Fadmin");
    expect(refHref({ kind: "thread", id: "https://evil.example" })).toBe(
      "/search/https%3A%2F%2Fevil.example",
    );
  });

  it("labels every kind with the surface's own word", () => {
    expect(REF_LABEL).toEqual({
      thread: "Mail",
      file: "Files",
      contact: "Contacts",
      event: "Calendar",
    });
  });
});
