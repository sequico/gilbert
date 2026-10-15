/**
 * What the sign-in does with the device-local store.
 *
 * Two promises: the name it signed in with is remembered, and a store that
 * refuses the write — a full quota, a private window — is not a failed sign-in.
 * The second is the one worth pinning: the write sits inside the sign-in's own
 * `try`, so an unguarded refusal used to surface as "Network error" for a
 * sign-in that had already worked.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_KEYS, deviceKey } from "@/lib/storage";
import { useSession } from "@/store/session";
import { LoginPage } from "../Login";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the sign-in form's device storage", () => {
  let host: HTMLDivElement;
  let root: Root;
  let login: ReturnType<typeof vi.fn>;

  const render = async () => {
    await act(async () => {
      root.render(<LoginPage />);
    });
  };

  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const signIn = async () => {
    const inputs = [...host.querySelectorAll<HTMLInputElement>("input")];
    await type(inputs.find((one) => one.autocomplete === "username")!, "me@example.org");
    await type(
      inputs.find((one) => one.autocomplete === "current-password")!,
      "a-password",
    );
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  };

  beforeEach(() => {
    /* jsdom has no matchMedia, and the form asks for the app config. */
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
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
    localStorage.removeItem(deviceKey(DEVICE_KEYS.lastUser));
    login = vi.fn(async () => undefined);
    useSession.setState({ login } as never);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("remembers the name it signed in with", async () => {
    await render();
    await signIn();
    expect(login).toHaveBeenCalled();
    expect(localStorage.getItem(deviceKey(DEVICE_KEYS.lastUser))).toBe("me@example.org");
  });

  it("signs in even when the store refuses the write", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    await render();
    await signIn();
    expect(login).toHaveBeenCalled();
    expect(setItem).toHaveBeenCalled();
    expect(host.textContent).not.toContain("Network error");
  });
});
