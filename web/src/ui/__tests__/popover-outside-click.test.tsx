import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Anchor, Popover } from "../popover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * An outside press dismisses a popover even when its caller re-rendered while
 * it was open.
 *
 * The dismiss listeners are registered a macrotask after the effect runs, so an
 * effect that re-runs on the caller's `onClose` identity tears them down and
 * re-adds them -- leaving a window with no listener at all, in which an outside
 * press is swallowed and the menu stays open. A caller passing an inline
 * callback (`() => setMenu(null)`) hands over a new identity on every render of
 * its own, and the panel behind a menu re-renders on any store change.
 */

const ANCHOR: Anchor = { x: 0, y: 0, w: 0, h: 0 };

/** The listeners are registered on a timeout: one macrotask settles them. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const pressOutside = () =>
  act(() => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });

/** A caller whose `onClose` has a new identity on every render of its own. */
function Scene() {
  const [open, setOpen] = useState(true);
  const [count, setCount] = useState(0);
  return (
    <>
      <Popover anchor={open ? ANCHOR : null} onClose={() => setOpen(false)}>
        <button type="button">entry</button>
      </Popover>
      <button type="button" id="bump" onClick={() => setCount(count + 1)}>
        bump
      </button>
    </>
  );
}

describe("a popover's outside press", () => {
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
    for (const el of document.querySelectorAll(".popover")) el.remove();
    vi.restoreAllMocks();
  });

  it("dismisses when nothing re-rendered", async () => {
    await act(async () => root.render(<Scene />));
    await settle();

    pressOutside();

    expect(document.querySelector(".popover")).toBeNull();
  });

  it("dismisses when the caller re-rendered while it was open", async () => {
    await act(async () => root.render(<Scene />));
    await settle();

    /*
     * The caller renders again, with a fresh `onClose` -- the shape a panel
     * behind the menu has on every store change. No timer is allowed to run
     * between this and the press: that window is exactly where the swallowed
     * click lands.
     */
    await act(async () => {
      document
        .getElementById("bump")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector(".popover")).not.toBeNull();

    pressOutside();

    expect(document.querySelector(".popover")).toBeNull();
  });

  it("leaves its own listeners where they are when only the callback changed", async () => {
    const added = vi.spyOn(document, "addEventListener");
    await act(async () => root.render(<Scene />));
    await settle();
    // Registered once, for the outside press.
    expect(added.mock.calls.filter((c) => c[0] === "mousedown")).toHaveLength(1);

    added.mockClear();
    await act(async () => {
      document
        .getElementById("bump")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    // The caller rendered again; the popover's dismiss listener did not move.
    expect(added.mock.calls.filter((c) => c[0] === "mousedown")).toHaveLength(0);
  });
});
