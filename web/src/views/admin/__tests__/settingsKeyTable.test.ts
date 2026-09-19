import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/store/settings";
import { ENTRIES, GROUPS } from "../SettingsKeyTable";

/**
 * The table and this build's settings, kept in step by something other than a
 * comment.
 *
 * `ENTRIES` is written by hand from the `Settings` interface's doc comments, and
 * the two drifted the way hand-written pairs do: a key a group named could lose
 * its row and the table would render it under a generic description, which is
 * the fallback working as designed and also a sentence nobody notices going
 * missing. These two checks are what the comment above the table means.
 */

describe("the settings-key table", () => {
  it("has a row for every key its groups name", () => {
    const missing: string[] = [];
    for (const group of GROUPS) {
      for (const key of group.keys) {
        if (key === "appliedPolicyChanges") continue;
        if (!(key in ENTRIES)) missing.push(`${group.title}/${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("names only keys this build has", () => {
    // An entry for a key `DEFAULT_SETTINGS` does not carry is a row nobody can
    // reach: the table lists the keys the build has, not the ones a doc recalls.
    const unknown = Object.keys(ENTRIES).filter((key) => !(key in DEFAULT_SETTINGS));
    expect(unknown).toEqual([]);
  });
});
