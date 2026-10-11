import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushMicrotasks } from "@/test/testkit";
import { ToastHost, useToasts } from "../toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A toast action that rejects (finding 10).
 *
 * The notification ask is async, and its rejection had nowhere to go: `void
 * onClick()` left an unhandled rejection and dismissed the toast as if it had
 * worked. A failure is surfaced as an error toast, and the original stays up
 * until the work it started has settled.
 */

describe("a toast whose action rejects", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useToasts.setState({ toasts: [] });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useToasts.setState({ toasts: [] });
  });

  it("surfaces the failure and only then dismisses the toast", async () => {
    act(() => {
      root.render(<ToastHost />);
    });
    act(() => {
      useToasts.getState().push({
        message: "Turn on notifications?",
        kind: "info",
        duration: 0,
        action: {
          label: "Turn on notifications",
          onClick: () => Promise.reject(new Error("permission denied")),
        },
      });
    });

    const action = host.querySelector<HTMLButtonElement>(".toast-action");
    expect(action).toBeTruthy();
    act(() => {
      action?.click();
    });
    // The action is still open while its work is in flight.
    expect(host.textContent).toContain("Turn on notifications?");

    await act(async () => {
      await flushMicrotasks();
    });

    const texts = useToasts.getState().toasts.map((t) => t.message);
    expect(texts).toContain("permission denied");
    expect(texts).not.toContain("Turn on notifications?");
  });
});
