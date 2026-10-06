import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentLanguage, whenLanguageReady } from "@/lib/i18n";
import { resetLoginLanguageForTest } from "@/lib/loginLanguage";
import { setInterfaceLanguage } from "@/store/settings";
import { LoginPage } from "../Login";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The sign-in form is where the interface language is first chosen, so it has
 * to know two things: the name under the logo is the logo's, not a second
 * heading, and picking a language turns the form on the spot rather than after
 * the next sign-in.
 */
describe("the sign-in language picker", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (el: React.ReactNode) => {
    await act(async () => {
      root.render(el);
    });
  };

  beforeEach(() => {
    /* jsdom has no matchMedia, and the form asks for the app config over the
       network. */
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
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    localStorage.removeItem("gilbert:lastUser");
    resetLoginLanguageForTest();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await act(async () => {
      setInterfaceLanguage("en");
      await whenLanguageReady();
    });
    host.remove();
    resetLoginLanguageForTest();
    vi.unstubAllGlobals();
  });

  it("offers the picker without repeating the name under the logo", async () => {
    await render(<LoginPage />);
    expect(host.querySelector("#login-language")).not.toBeNull();
    expect(host.querySelector("h1")).toBeNull();
  });

  it("turns the sign-in form when a language is chosen", async () => {
    await render(<LoginPage />);
    const select = host.querySelector<HTMLSelectElement>("#login-language")!;
    await act(async () => {
      select.value = "it";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await whenLanguageReady();
    });
    expect(currentLanguage()).toBe("it");
  });
});
