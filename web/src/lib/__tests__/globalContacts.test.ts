import { GLOBAL_CONTACTS_BOOK_NAME } from "@gilbert/shared/globalContacts";
import { describe, expect, it } from "vitest";
import { isGlobalContactsBook } from "@/lib/contacts";

describe("Global contacts is one named book", () => {
  it("is the book the shared constant names, whatever rights it comes back with", () => {
    const readOnly = {
      mayRead: true,
      mayWrite: false,
      mayShare: false,
      mayDelete: false,
    };
    const writable = { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true };
    expect(
      isGlobalContactsBook({ name: GLOBAL_CONTACTS_BOOK_NAME, myRights: readOnly }),
    ).toBe(true);
    // An administrator may see it writable; it is still the directory.
    expect(
      isGlobalContactsBook({ name: GLOBAL_CONTACTS_BOOK_NAME, myRights: writable }),
    ).toBe(true);
    expect(isGlobalContactsBook({ name: "Team contacts", myRights: readOnly })).toBe(
      false,
    );
  });
});
