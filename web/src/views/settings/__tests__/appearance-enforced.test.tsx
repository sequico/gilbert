import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSettingsPolicyForTest } from "@/lib/settingsPolicy";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { AppearanceSettings } from "../AppearanceSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * An enforced setting's control stays on screen and goes dead -- that is the
 * promise the admin surface makes when it offers a key as governable (see
 * views/admin/SettingsKeyTable.tsx). The interface-language picker was offered
 * there without honouring it here, so the promise was only word-deep.
 */
describe("Appearance controls respect the installation policy", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (el: React.ReactNode) => {
    await act(async () => {
      root.render(el);
    });
  };
  const uiLanguage = () => host.querySelector<HTMLSelectElement>("#ui-language")!;

  beforeEach(() => {
    /* jsdom has no matchMedia, and the screen asks it two questions: whether
       the system is dark, and whether the pointer is a finger. */
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
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
    resetSettingsPolicyForTest();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetSettingsPolicyForTest();
    vi.unstubAllGlobals();
  });

  it("leaves the interface language live when nothing enforces it", async () => {
    await render(<AppearanceSettings />);
    expect(uiLanguage().disabled).toBe(false);
  });

  it("goes dead when the installation enforces the interface language", async () => {
    resetSettingsPolicyForTest({ enforced: { uiLanguage: "en" } });
    await render(<AppearanceSettings />);
    expect(uiLanguage().disabled).toBe(true);
  });
});
