import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../dialog";
import { type Anchor, Popover } from "../popover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * One Escape, one surface (finding 9).
 *
 * A dialog and a popover both close on Escape, and both listen on the document
 * in the capture phase. `stopPropagation` does not stop the other listener on
 * the same node, so an Escape in a popover that sat inside a dialog closed both.
 * The overlay that opened last is the one that acts.
 */

const ANCHOR: Anchor = { x: 0, y: 0, w: 0, h: 0 };

describe("Escape across stacked overlays", () => {
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
    for (const el of document.querySelectorAll(".popover, .dialog-backdrop")) el.remove();
  });

  const pressEscape = () => {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
  };

  it("closes the popover and leaves the dialog under it open", () => {
    const closeDialog = vi.fn();
    const closePopover = vi.fn();
    function Scene() {
      const [anchor, setAnchor] = useState<Anchor | null>(null);
      return (
        <Dialog open onClose={closeDialog} title="Under">
          <button id="open" type="button" onClick={() => setAnchor(ANCHOR)}>
            open
          </button>
          <Popover
            anchor={anchor}
            onClose={() => {
              closePopover();
              setAnchor(null);
            }}
          >
            <button type="button">menu entry</button>
          </Popover>
        </Dialog>
      );
    }

    act(() => root.render(<Scene />));
    // The popover opens after the dialog: the menu inside it is the surface on
    // top, and Escape is the popover's.
    act(() => {
      document.getElementById("open")?.click();
    });
    pressEscape();

    expect(closePopover).toHaveBeenCalledTimes(1);
    expect(closeDialog).not.toHaveBeenCalled();
  });

  it("closes a lone dialog when nothing sits above it", () => {
    const closeDialog = vi.fn();
    act(() =>
      root.render(
        <Dialog open onClose={closeDialog} title="Only">
          <span>content</span>
        </Dialog>,
      ),
    );
    pressEscape();
    expect(closeDialog).toHaveBeenCalledTimes(1);
  });

  it("gives Escape to a dialog opened after the popover", () => {
    const closeDialog = vi.fn();
    const closePopover = vi.fn();
    function Scene() {
      const [showDialog, setShowDialog] = useState(false);
      return (
        <>
          <Popover anchor={ANCHOR} onClose={closePopover}>
            <button type="button" id="rise" onClick={() => setShowDialog(true)}>
              rise
            </button>
          </Popover>
          {showDialog && (
            <Dialog open onClose={closeDialog} title="Above">
              <span>content</span>
            </Dialog>
          )}
        </>
      );
    }

    act(() => root.render(<Scene />));
    act(() => {
      document.getElementById("rise")?.click();
    });
    pressEscape();

    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(closePopover).not.toHaveBeenCalled();
  });

  /*
   * A surface nearer the key wins. The arbiter listens in the bubble phase and
   * yields to a key already claimed with `preventDefault` (finding 2), so an
   * input's own dropdown inside a dialog handles Escape without the dialog
   * closing under it. Dispatched on the input so the event passes through the
   * element's own handler before reaching the arbiter on the document.
   */
  it("lets an element claim Escape before an overlay it sits in", () => {
    const closeDialog = vi.fn();
    const handleLocal = vi.fn();
    act(() =>
      root.render(
        <Dialog open onClose={closeDialog} title="Host">
          <input
            id="inner"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                handleLocal();
              }
            }}
          />
        </Dialog>,
      ),
    );

    const input = document.getElementById("inner")!;
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(handleLocal).toHaveBeenCalledTimes(1);
    expect(closeDialog).not.toHaveBeenCalled();
  });
});
