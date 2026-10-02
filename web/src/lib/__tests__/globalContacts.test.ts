import { describe, expect, it } from "vitest";
import { isGlobalContactsBook } from "@/lib/contacts";
import { GLOBAL_CONTACTS_BOOK_ID } from "@/lib/globalContactsAdmin";

describe("Global contacts is one book, told by its id", () => {
  it("is the book under the sentinel id", () => {
    expect(isGlobalContactsBook({ id: GLOBAL_CONTACTS_BOOK_ID })).toBe(true);
  });

  it("does not take a member's own book that shares the name", () => {
    // A group or colleague book a member named "Global contacts" is their own
    // book: the name is a label, the id is the marker.
    expect(isGlobalContactsBook({ id: "team-contacts" })).toBe(false);
  });
});
