import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLoginLanguage,
  rememberLoginLanguage,
  resetLoginLanguageForTest,
} from "@/lib/loginLanguage";
import { resetSettingsPolicyForTest } from "@/lib/settingsPolicy";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";

/**
 * The language chosen on the sign-in form is a preference of the account, not
 * of the page: it has to survive into the account's own settings once those
 * load, and an installation that enforces the language has to win over it.
 * These are the two halves of that promise.
 */
describe("the language picked on the sign-in form", () => {
  beforeEach(() => {
    /* jsdom has no matchMedia, which applying a theme or a language asks for. */
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
    resetSettingsPolicyForTest();
    resetLoginLanguageForTest();
  });

  afterEach(() => {
    resetLoginLanguageForTest();
    resetSettingsPolicyForTest();
    vi.unstubAllGlobals();
  });

  it("writes the choice into the account's settings", () => {
    rememberLoginLanguage("it");
    applyLoginLanguage();
    expect(useSettings.getState().settings.uiLanguage).toBe("it");
  });

  it("does nothing when no language was chosen on the form", () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiLanguage: "de" } });
    applyLoginLanguage();
    expect(useSettings.getState().settings.uiLanguage).toBe("de");
  });

  it("consumes the choice, so a later call writes nothing", () => {
    rememberLoginLanguage("fr");
    applyLoginLanguage();
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiLanguage: "de" } });
    applyLoginLanguage();
    expect(useSettings.getState().settings.uiLanguage).toBe("de");
  });

  it("lets an enforced interface language win over the choice", () => {
    resetSettingsPolicyForTest({ enforced: { uiLanguage: "en" } });
    rememberLoginLanguage("it");
    applyLoginLanguage();
    expect(useSettings.getState().settings.uiLanguage).toBe("en");
  });
});
