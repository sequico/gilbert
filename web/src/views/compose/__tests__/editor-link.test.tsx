import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RichEditor } from "../RichEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The link button builds an `<a>` out of what somebody typed.
 *
 * The editor engine sets the href on the anchor itself instead of building
 * markup out of the string, so a `"` in the URL cannot leave the attribute and
 * nothing after it becomes an element of its own. The `js/xss-through-dom`
 * finding these tests used to guard is gone by construction; what they check
 * now is that no URL is ever put back into markup as text.
 *
 * The anchor is read through the DOM rather than matched as a string: what
 * matters is the href a browser parses.
 */

describe("a link typed into the composer", () => {
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
    expect(area.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/invoice",
    );
  });

  it("keeps a query string readable as a link", () => {
    const area = insertLink("https://example.com/a?b=1&c=2");
    expect(area.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/a?b=1&c=2",
    );
  });

  it("keeps a quote inside the attribute rather than letting it out", () => {
    const area = insertLink('https://example.com/" onmouseover="alert(1)');
    const link = area.querySelector("a");
    expect(link?.getAttribute("href")).toContain('"');
    // The attribute holds, so nothing after the quote became an attribute of
    // its own, and nothing was parsed as an element.
    expect(link?.hasAttribute("onmouseover")).toBe(false);
    expect(area.querySelector("img, script, iframe")).toBeNull();
  });

  it("keeps an angle bracket inside the attribute rather than opening an element", () => {
    const area = insertLink('https://example.com/"><img src=x onerror="alert(1)');
    expect(area.querySelector("img")).toBeNull();
    expect(area.querySelector("a")).not.toBeNull();
  });
});
