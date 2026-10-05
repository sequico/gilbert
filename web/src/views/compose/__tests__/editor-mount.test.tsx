import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RichEditor } from "../RichEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A body the editor is opened with is on screen at once.
 *
 * The engine lives in an effect, and React's StrictMode builds it twice in one
 * commit — set up, tear down, set up. A ref that survives the first teardown
 * makes the second, empty instance look already in sync with the `html` prop,
 * so a reply, a template or a signature would come up blank. The wrapper seeds
 * every instance it builds; this fails if that seeding is taken out.
 */
describe("a pre-filled editor", () => {
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
  });

  it("shows the body it was opened with, under StrictMode", () => {
    act(() => {
      root.render(
        <StrictMode>
          <RichEditor
            html="<div>Hello there</div>"
            onChange={() => {}}
            showToolbar={false}
          />
        </StrictMode>,
      );
    });
    expect(host.querySelector(".editor-area")?.textContent).toContain("Hello there");
  });
});
