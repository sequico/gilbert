import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RichEditor } from "../RichEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The link button builds an `<a>` out of what somebody typed.
 *
 * The URL box takes text, and the composer puts that text into markup: a
 * `"` left in it would end the href attribute and the rest of the line would
 * land in the message as elements. Code scanning reports exactly this as
 * `js/xss-through-dom` (`security-severity` 7.8), and the fix is the three
 * characters a URL cannot carry raw being percent-encoded before the markup is
 * built -- so these tests fail if that encoding is taken out again.
 *
 * The anchor is read through the DOM rather than matched as a string: what
 * matters is the href a browser parses, not the characters the editor happened
 * to write, and an injection that survives parsing is the finding.
 */

/** A minimal `document.execCommand`: jsdom has none, and the editor uses it. */
function stubExecCommand(host: HTMLElement) {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string, _ui: boolean, html?: string) => {
      if (command === "insertHTML" && html) {
        const area = host.querySelector(".editor-area");
        // parsed, then appended: the nodes a browser would build, and nothing
        // here is ever assigned as markup on a live document.
        if (area)
          area.append(
            ...new DOMParser().parseFromString(html, "text/html").body.childNodes,
          );
      }
      return true;
    },
  });
}

describe("a link typed into the composer", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    stubExecCommand(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /** Render with the toolbar, open the link popup, and submit a URL. */
  function insertLink(url: string): HTMLElement {
    act(() => {
      root.render(<RichEditor html="" onChange={() => {}} showToolbar={true} />);
    });
    const area = host.querySelector(".editor-area");
    if (!area) throw new Error("the editor is not rendered");

    const linkButton = host.querySelector<HTMLButtonElement>(
      'button[title="Insert link (Ctrl+K)"]',
    );
    if (!linkButton) throw new Error("the link button is not rendered");
    act(() => {
      linkButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const input = document.querySelector<HTMLInputElement>(".link-popup input");
    if (!input) throw new Error("the link box did not open");
    /* React reads a controlled input through its own value setter, so the
       change has to be dispatched the way a keystroke would. */
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, url);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = document.querySelector<HTMLFormElement>(".link-popup");
    if (!form) throw new Error("the link box is not a form");
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    return area as HTMLElement;
  }

  it("links what was typed, without a scheme of its own", () => {
    const area = insertLink("example.com/invoice");
    const link = area.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/invoice");
    expect(link?.textContent).toBe("https://example.com/invoice");
  });

  it("keeps a query string readable as a link", () => {
    const area = insertLink("https://example.com/a?b=1&c=2");
    expect(area.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/a?b=1&c=2",
    );
  });

  it("encodes a quote rather than letting it out of the attribute", () => {
    const area = insertLink('https://example.com/" onmouseover="alert(1)');
    const link = area.querySelector("a");
    expect(link?.getAttribute("href")).toContain("%22");
    // The attribute holds, so nothing after the quote became an attribute of
    // its own, and nothing was parsed as an element.
    expect(link?.hasAttribute("onmouseover")).toBe(false);
    expect(area.querySelector("img, script, iframe")).toBeNull();
  });

  it("encodes an angle bracket rather than letting it open an element", () => {
    const area = insertLink('https://example.com/"><img src=x onerror="alert(1)');
    expect(area.querySelector("img")).toBeNull();
    expect(area.querySelector("a")?.getAttribute("href")).toContain("%22");
  });
});
