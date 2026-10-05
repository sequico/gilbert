import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverFromCrash } from "@/lib/crashRecovery";
import { CrashBoundary } from "../CrashBoundary";

vi.mock("@/lib/crashRecovery", () => ({
  recoverFromCrash: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * An error no boundary catches unmounts the whole tree into a blank page —
 * the shape of a lazy view whose chunk failed, after a deploy or on a
 * connection that died while the tab sat idle. The boundary's only job is to
 * hand the crash to the recovery (record + guarded reload) without inventing
 * a screen of its own.
 */
describe("CrashBoundary", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.mocked(recoverFromCrash).mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("renders its children while nothing has gone wrong", () => {
    act(() => {
      root.render(
        <CrashBoundary>
          <p>alive</p>
        </CrashBoundary>,
      );
    });
    expect(host.textContent).toBe("alive");
    expect(recoverFromCrash).not.toHaveBeenCalled();
  });

  it("hands a crash to the recovery and shows nothing of its own", () => {
    function Bomb(): never {
      throw new TypeError("boom");
    }
    act(() => {
      root.render(
        <CrashBoundary>
          <Bomb />
        </CrashBoundary>,
      );
    });
    expect(recoverFromCrash).toHaveBeenCalledTimes(1);
    const [error, componentStack] = vi.mocked(recoverFromCrash).mock.calls[0]!;
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("boom");
    expect(componentStack).toBeTypeOf("string");
    // No designed fallback: the recovery reloads, or the console has the story.
    expect(host.textContent).toBe("");
  });
});
