/**
 * A catalogue that will not load leaves English in force (ADR: the interface's
 * own language is English, and a translation is an addition).
 *
 * The fallback lives in `loadLanguage`'s catch, and only the latest request may
 * take it: an older failure must not override a newer language that is still (or
 * already) in force. This file is separate from the rest of the i18n tests
 * because it is the one that replaces a shipped catalogue with a failure, and a
 * module mock cannot be both.
 */
import { describe, expect, it, vi } from "vitest";
import { currentLanguage, loadLanguage, t } from "@/lib/i18n";

vi.mock("../../locales/it.ts", () => {
  throw new Error("simulated catalogue failure");
});

describe("loadLanguage when the catalogue cannot load", () => {
  it("leaves English in force rather than a half-rendered page", async () => {
    await loadLanguage("it");
    expect(currentLanguage()).toBe("en");
    expect(t("Archive")).toBe("Archive");
  });
});
