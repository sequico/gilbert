import { describe, expect, it } from "vitest";
import { IDENTITIES_SECTION, visibleSettingsSections } from "@/lib/settingsSections";

/**
 * ADR 0010 §4: an account whose identity an administrator has taken over is
 * offered **no** Identities & signatures section. This is the invariant that
 * names, and it fails the moment the filtering goes away — which is the point:
 * the lock is a rule about the surface, so it is the surface's list that has to
 * change, and nothing else about settings may.
 */

const SECTIONS = [
  { id: "general", label: "General" },
  { id: IDENTITIES_SECTION, label: "Identities & signatures" },
  { id: "security", label: "Security & sessions" },
];

describe("the sections a settings surface offers", () => {
  it("takes the identity section away from a locked account", () => {
    expect(visibleSettingsSections(SECTIONS, true).map((s) => s.id)).toEqual([
      "general",
      "security",
    ]);
  });

  it("leaves the list untouched for everyone else, in the caller's order", () => {
    const shown = visibleSettingsSections(SECTIONS, false);
    expect(shown).toBe(SECTIONS);
    expect(shown.map((s) => s.id)).toEqual(["general", "identities", "security"]);
  });

  it("removes nothing but the identity section", () => {
    const only = [{ id: "identities", label: "Identities & signatures" }];
    expect(visibleSettingsSections(only, true)).toEqual([]);
    expect(visibleSettingsSections([{ id: "about", label: "About" }], true)).toHaveLength(
      1,
    );
  });
});
