import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isSettingsKey } from "@/store/settings";
import { ENTRIES, EXAMPLES, exampleFor, GROUPS } from "../SettingsKeyTable";

/**
 * The table and this build's settings, kept in step by something other than a
 * comment.
 *
 * `ENTRIES` is written by hand from the `Settings` interface's doc comments, and
 * the two drifted the way hand-written pairs do: a key a group named could lose
 * its row and the table would render it under a generic description, which is
 * the fallback working as designed and also a sentence nobody notices going
 * missing. These two checks are what the comment above the table means.
 *
 * The example column had a third copy of the product's own defaults, hand
 * written, and it was the copy that went stale: seven rows told an
 * administrator that the working day starts at 9, that an event lasts 30
 * minutes and that the list pane is 320 wide, none of which the product does.
 * The example is read from `DEFAULT_SETTINGS` now, and this is the check that
 * keeps a row from going back to a value the code stopped using.
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
    const unknown = Object.keys(ENTRIES).filter((key) => !isSettingsKey(key));
    expect(unknown).toEqual([]);
  });

  it("shows the default the product ships, unless the row carries a sample", () => {
    // Every row without a sample quotes `DEFAULT_SETTINGS`, read at render
    // time. A key that drifted away from that -- the copy of the defaults that
    // said the working day starts at 9 and an event lasts 30 minutes -- cannot
    // come back, because there is nowhere left to write it down.
    for (const key of Object.keys(ENTRIES)) {
      if (key in EXAMPLES) continue;
      expect(exampleFor(key)).toBe(
        (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key],
      );
    }
  });

  it("carries a sample only for a key that has one, and only where it says more", () => {
    // An override is a hand-written value again, so it is fenced in: it names a
    // key the table has, and it differs from the default it stands in for (a
    // hex rather than a palette name, a URL rather than an empty list, a zone
    // rather than `null`).
    for (const [key, sample] of Object.entries(EXAMPLES)) {
      expect(key in ENTRIES, `${key} has no row`).toBe(true);
      expect(sample).not.toEqual(
        (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key],
      );
    }
  });
});
