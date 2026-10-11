import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePreviewDialog } from "../filepreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The text preview's read is cancellable (finding 11).
 *
 * `useTextFile` guarded its result with a `live` flag but left the request
 * running: closing the preview, or opening another file, kept fetching a blob
 * nobody wanted. It carries an AbortSignal now, aborted when the read is torn
 * down.
 */

describe("the file preview's text read", () => {
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
    vi.unstubAllGlobals();
  });

  it("passes a signal and aborts the read when the preview closes", async () => {
    let init: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, options?: RequestInit) => {
        init = options;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => "hello",
        } as Response);
      }),
    );

    await act(async () => {
      root.render(
        <FilePreviewDialog
          file={{
            name: "a.txt",
            type: "text/plain",
            url: "/blob/a",
            inlineUrl: "/blob/a",
          }}
          onClose={() => {}}
        />,
      );
    });

    expect(init?.signal).toBeInstanceOf(AbortSignal);

    act(() => root.unmount());
    expect(init?.signal?.aborted).toBe(true);
  });
});
