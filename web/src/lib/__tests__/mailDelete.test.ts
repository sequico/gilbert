import { describe, expect, it } from "vitest";
import { finalFoldersOf, isFinalFolderRole } from "@/lib/mailDelete";

/**
 * Which folders count as final, and which one wins when an account names two.
 *
 * `finalFoldersOf` used to resolve each role with its own early-returning scan,
 * so the first mailbox carrying a role was the folder. That answer is what the
 * toolbar, the swipe and the delete rule all read, so it is pinned here rather
 * than left to the iteration order of a rewrite: an account that somehow holds
 * two Trash folders answers with the one it lists first, and the answer does
 * not flip when the second one is reached.
 */
describe("the two final folders", () => {
  it("reads a role as one of the two, and nothing else", () => {
    expect(isFinalFolderRole("trash")).toBe(true);
    expect(isFinalFolderRole("junk")).toBe(true);
    for (const role of ["inbox", "sent", "drafts", "archive", "all"] as const)
      expect(isFinalFolderRole(role), role).toBe(false);
    expect(isFinalFolderRole(null)).toBe(false);
    expect(isFinalFolderRole(undefined)).toBe(false);
  });

  it("names the first mailbox a role belongs to, once", () => {
    const mailboxes = {
      m1: { role: "junk" },
      m2: { role: "junk" },
      m3: { role: "trash" },
      m4: { role: "inbox" },
    } as unknown as Record<string, { role: "trash" | "junk" | "inbox" }>;
    expect(finalFoldersOf(mailboxes)).toEqual({ trash: "m3", junk: "m1" });
  });

  it("answers null for a role the account has no folder for", () => {
    expect(finalFoldersOf({})).toEqual({ trash: null, junk: null });
    expect(finalFoldersOf(null)).toEqual({ trash: null, junk: null });
    expect(finalFoldersOf(undefined)).toEqual({ trash: null, junk: null });
  });
});
