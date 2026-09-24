import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePhone } from "@/store/phone";
import { PhoneLauncher } from "../PhoneLauncher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The phone is a desktop surface (ADR 0023): a page suspended in the background
 * or behind a locked screen cannot ring, so a touch device is offered no entry —
 * which also means it registers nothing and asks for no microphone, because the
 * launcher is what does both.
 */

/** jsdom has no matchMedia; this decides which pointer the device reports. */
function setCoarse(coarse: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: q.includes("pointer: coarse") ? coarse : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

describe("the phone on a touch device", () => {
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
    usePhone.setState({ ready: false, state: "off" });
  });

  it("is offered no entry, even when the line would be ready", () => {
    setCoarse(true);
    usePhone.setState({ ready: true, state: "registered" });
    act(() => root.render(<PhoneLauncher />));
    expect(host.querySelector('button[aria-label="Phone"]')).toBeNull();
    expect(host.firstChild).toBeNull();
  });
});
