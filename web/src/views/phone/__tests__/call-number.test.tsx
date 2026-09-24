import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePhone } from "@/store/phone";
import { CallNumber } from "../CallNumber";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A number's press goes to the in-app phone where that phone can carry it, and
 * to the system's `tel:` handler everywhere else — never the other way round: a
 * desktop with a working bridge must not open a second softphone, and a touch
 * device must not be asked to hold a WebRTC line it cannot keep.
 */

function setCoarse(coarse: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: q.includes("pointer: coarse") ? coarse : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

describe("a phone number", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    usePhone.setState({ ready: false });
  });

  it("is handed to the in-app phone on a desktop that has one", () => {
    setCoarse(false);
    usePhone.setState({ ready: true });
    act(() => root.render(<CallNumber number="+1 555 0103" />));
    expect(host.querySelector("button")?.textContent).toBe("+1 555 0103");
    expect(host.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it("stays a tel: link on a touch device, even with a line ready", () => {
    setCoarse(true);
    usePhone.setState({ ready: true });
    act(() => root.render(<CallNumber number="+1 555 0103" />));
    expect(host.querySelector('a[href="tel:+1 555 0103"]')).not.toBeNull();
    expect(host.querySelector("button")).toBeNull();
  });
});
