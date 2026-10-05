import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RichEditor } from "../RichEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A file dropped on the message body, once.
 *
 * The editor and the composer around it can both be handed the same drop: the
 * editor keeps an image for the body and passes anything else to `onFiles`,
 * while the composer attaches every file it is given. With both listening, one
 * drop reached two handlers and a PDF from the desktop came out as two
 * attachments.
 *
 * So the editor — the innermost target — owns the drop and stops the event
 * there, and says so through `onDropHandled` because the composer is the
 * element drawing the drop highlight and would otherwise never hear that the
 * drop is over. This file drops a file on the editor with an outer handler in
 * place, which is what the composer is: it fails if the event is allowed to
 * travel on, and it fails if the editor handles nothing at all.
 */

/** jsdom has no DataTransfer: the two fields a drop is read through are faked. */
function dataTransfer(files: File[]) {
  return { files, types: ["Files"], dropEffect: "", effectAllowed: "" };
}

function fire(el: Element, dt: ReturnType<typeof dataTransfer>) {
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  return act(() => el.dispatchEvent(ev)) as unknown as boolean;
}

const pdf = () => new File(["%PDF-1.4"], "invoice.pdf", { type: "application/pdf" });
const png = () => new File(["x"], "shot.png", { type: "image/png" });

describe("a file dropped on the message body", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    // The editor reads an image with FileReader and pastes the result in.
    vi.stubGlobal(
      "FileReader",
      class {
        result = "data:image/png;base64,x";
        onload: (() => void) | null = null;
        readAsDataURL() {
          this.onload?.();
        }
        addEventListener(_t: string, fn: () => void) {
          this.onload = fn;
        }
        removeEventListener() {}
      },
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  /** Render an editor inside an outer drop handler, as the composer has one. */
  function render() {
    const outer: File[][] = [];
    const handled: number[] = [];
    act(() => {
      root.render(
        <div
          onDrop={(e) => {
            const dt = (e as unknown as { dataTransfer: { files: File[] } }).dataTransfer;
            outer.push(Array.from(dt.files));
          }}
        >
          <RichEditor
            html=""
            onChange={() => {}}
            showToolbar={false}
            onFiles={(files) => outer.push(files)}
            onDropHandled={() => handled.push(1)}
          />
        </div>,
      );
    });
    const area = host.querySelector(".editor-area");
    if (!area) throw new Error("the editor is not rendered");
    return { area, outer, handled };
  }

  it("is attached once, and the drop stops at the editor", () => {
    const { area, outer, handled } = render();

    fire(area, dataTransfer([pdf()]));

    const attached = outer.flat();
    expect(attached.map((f) => f.name)).toEqual(["invoice.pdf"]);
    // One handler saw it, and the element drawing the highlight was told.
    expect(outer.length).toBe(1);
    expect(handled.length).toBe(1);
  });

  it("keeps an image for the body instead of attaching it", () => {
    const { area, outer } = render();

    fire(area, dataTransfer([png()]));

    expect(outer.length).toBe(0);
    expect(area.querySelector("img")).not.toBeNull();
  });
});
