import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { LONG_PRESS_MS, SWALLOW_RELEASE_MS, useTouchRow } from "../touch";

/*
 * The row's click, and the gesture that must not become one.
 *
 * A swipe or a long press ends with the finger lifting, which the browser reads
 * as a click — so the gesture swallows it and the row does not open. That flag
 * must not outlive the gesture that set it: a swipe that ends off the row, or a
 * long-press menu closed without a click, produces no click to consume it, and
 * the next click — one with no touch of its own to clear it — must not be eaten.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Row({ onLongPress, onClick }: { onLongPress: () => void; onClick: () => void }) {
  const gesture = useTouchRow({ enabled: true, onLongPress });
  return <div data-testid="row" {...gesture} onClick={onClick} />;
}

describe("the row gesture's click swallow", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onClick: Mock<() => void>;
  let onLongPress: Mock<() => void>;

  const row = () => host.querySelector("[data-testid=row]") as HTMLDivElement;

  const fire = (type: string) => {
    const e = new PointerEvent(type, {
      bubbles: true,
      pointerId: 1,
      pointerType: "touch",
      clientX: 10,
      clientY: 10,
    });
    act(() => {
      row().dispatchEvent(e);
    });
  };

  const click = () => {
    act(() => {
      row().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  /** Put a finger on the row and hold it still until the long press fires. */
  const longPress = () => {
    fire("pointerdown");
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    onClick = vi.fn<() => void>();
    onLongPress = vi.fn<() => void>();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(<Row onLongPress={onLongPress} onClick={onClick} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("swallows the click the gesture itself produces", () => {
    longPress();
    fire("pointerup");
    click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("releases the flag after the gesture, so a later click is not eaten", () => {
    longPress();
    fire("pointerup");
    // No click followed — a long-press menu closed some other way.
    act(() => {
      vi.advanceTimersByTime(SWALLOW_RELEASE_MS);
    });
    click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("releases the flag when a gesture is cancelled rather than lifted", () => {
    longPress();
    fire("pointercancel");
    act(() => {
      vi.advanceTimersByTime(SWALLOW_RELEASE_MS);
    });
    click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("lets a genuine tap through, which clears the flag on its own pointerdown", () => {
    longPress();
    fire("pointerup");
    fire("pointerdown");
    fire("pointerup");
    click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
