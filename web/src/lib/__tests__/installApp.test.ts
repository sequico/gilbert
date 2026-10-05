import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The install command's two questions -- is this copy installed, and can the
 * browser be asked to install it -- and the state the banner and the menu are
 * drawn from.
 *
 * Each case fails if the mechanism it names is removed: the prompt is captured
 * (not dropped), a consumed prompt is not offered twice, the install marker is
 * written and read back, and dismissing the banner silences the state it was
 * dismissed in.
 */

/** jsdom has no matchMedia; `standalone` decides which side of the install it answers. */
function stubMatchMedia(standalone: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: standalone && query.includes("standalone"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function installPrompt(outcome: "accepted" | "dismissed") {
  const event = new Event("beforeinstallprompt") as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string; platform: string }>;
  };
  event.prompt = vi.fn(async () => {});
  event.userChoice = Promise.resolve({ outcome, platform: "web" });
  return event;
}

/** A fresh module, since the captured prompt and the marker are module state. */
async function load() {
  vi.resetModules();
  return await import("@/lib/installApp");
}

beforeEach(() => {
  localStorage.clear();
  stubMatchMedia(false);
});

/*
 * iOS is read from the user agent and standalone from the navigator, both of
 * which jsdom shares across cases -- so each is put back, or the next case
 * answers as if it were still an iPhone.
 */
const ORIGINAL_UA = navigator.userAgent;
afterEach(() => {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: ORIGINAL_UA,
  });
  delete (navigator as unknown as { standalone?: unknown }).standalone;
  vi.unstubAllGlobals();
});

describe("running as an installed app", () => {
  it("reads the standalone display mode", async () => {
    stubMatchMedia(true);
    const { isInstalledApp, appInstallState } = await load();
    expect(isInstalledApp()).toBe(true);
    expect(appInstallState()).toBe("in-app");
  });

  it("reads iOS's own standalone flag", async () => {
    Object.defineProperty(navigator, "standalone", {
      configurable: true,
      value: true,
    });
    const { isInstalledApp } = await load();
    expect(isInstalledApp()).toBe(true);
    delete (navigator as unknown as { standalone?: unknown }).standalone;
  });
});

describe("capturing the browser's install offer", () => {
  it("holds the prompt and shows it when asked", async () => {
    const mod = await load();
    mod.watchInstallApp();
    const event = installPrompt("accepted");
    const prevent = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);

    expect(prevent).toHaveBeenCalled();
    expect(mod.installPromptReady()).toBe(true);
    expect(await mod.promptInstall()).toBe("accepted");
    expect(event.prompt).toHaveBeenCalledOnce();
  });

  it("does not offer a prompt that was already consumed", async () => {
    const mod = await load();
    mod.watchInstallApp();
    window.dispatchEvent(installPrompt("dismissed"));
    expect(await mod.promptInstall()).toBe("dismissed");
    expect(mod.installPromptReady()).toBe(false);
    expect(await mod.promptInstall()).toBe("unavailable");
  });

  it("says the state is installable while the prompt is held", async () => {
    const mod = await load();
    mod.watchInstallApp();
    window.dispatchEvent(installPrompt("accepted"));
    expect(mod.appInstallState()).toBe("installable");
  });
});

describe("an install that already happened", () => {
  it("marks the device when the install completes", async () => {
    const mod = await load();
    mod.watchInstallApp();
    window.dispatchEvent(new Event("appinstalled"));
    expect(localStorage.getItem("gilbert:appInstalledOnDevice")).toBe("1");
    // A browser tab with the marker set is "installed", not "installable".
    expect(mod.appInstallState()).toBe("installed");
  });

  it("leaves the install offer silent for the rest of the session", async () => {
    const mod = await load();
    mod.watchInstallApp();
    window.dispatchEvent(new Event("appinstalled"));
    expect(mod.installBannerDismissed()).toBe(true);
  });
});

describe("dismissing the banner", () => {
  it("silences only the state it was dismissed in", async () => {
    const mod = await load();
    expect(mod.appInstallState()).toBe("manual");
    mod.dismissInstallBanner();
    expect(mod.installBannerDismissed()).toBe(true);

    // A new state is worth one word: the prompt arriving clears the silence.
    mod.watchInstallApp();
    window.dispatchEvent(installPrompt("accepted"));
    expect(mod.installBannerDismissed()).toBe(false);
  });
});

describe("what to tell a browser with no prompt", () => {
  it("names Safari's Share sheet on iOS", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari",
    });
    const mod = await load();
    expect(mod.installGuide()).toBe("ios");
  });

  it("names the browser's own menu everywhere else", async () => {
    const mod = await load();
    expect(mod.installGuide()).toBe("browser-menu");
  });
});
