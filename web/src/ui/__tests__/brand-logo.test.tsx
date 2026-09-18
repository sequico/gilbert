import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRAND_LOGO_COLORWAY_CLASS, BRAND_LOGO_FILES, BrandLogo } from "../BrandLogo";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The mark is drawn twice, for the two surfaces it has to sit on, and the
 * stylesheet is what picks between them.
 *
 * Nothing in the build connects the halves of that. A colorway file that is not
 * there is a broken image on a dark card; a swap rule that is not there is a
 * navy logo on the same card. Both are silent, and both are invisible to every
 * other test in the suite -- so the files the component names, the classes it
 * renders, and the rules that show one and hide the other are checked against
 * each other here.
 *
 * `process.cwd()` rather than `import.meta.url`, as in the other tests that
 * read the tree: vitest serves modules over http, so the latter is not a file
 * URL.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** A rule whose body matches, anywhere in a stylesheet with no nesting to mind. */
const hasRule = (css: string, selector: string, body: RegExp) =>
  new RegExp(`${selector}[^{}]*\\{[^}]*${body.source}`).test(css);

describe("the mark in its two colorways", () => {
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

  const render = (element: ReactElement) => {
    act(() => root.render(element));
    return [...host.querySelectorAll("img")].map((img) => ({
      src: img.getAttribute("src"),
      className: img.className,
    }));
  };

  it("ships a file for every colorway of both kinds", () => {
    for (const [kind, colorways] of Object.entries(BRAND_LOGO_FILES)) {
      for (const [colorway, file] of Object.entries(colorways)) {
        const png = readFileSync(join(process.cwd(), "public", "img", file));
        expect(
          png.subarray(1, 4).toString("latin1"),
          `${kind} ${colorway}: ${file}`,
        ).toBe("PNG");
      }
    }
  });

  it("renders the pair, one class each, for the kind it was asked for", () => {
    const { base, inverse } = BRAND_LOGO_COLORWAY_CLASS;
    expect(render(<BrandLogo />)).toEqual([
      { src: "/img/logo.png", className: base },
      { src: "/img/logo-inverse.png", className: inverse },
    ]);
    expect(render(<BrandLogo kind="mark" />)).toEqual([
      { src: "/img/mark.png", className: base },
      { src: "/img/mark-inverse.png", className: inverse },
    ]);
  });

  it("swaps the pair on the theme, so the one that is shown is the legible one", () => {
    const css = read("src/styles/app.css");
    const { base, inverse } = BRAND_LOGO_COLORWAY_CLASS;
    /* The inverse is what a dark theme shows, so it is the one hidden by
       default -- and `revert` rather than a display value, because these sit in
       a flex row in the top bar and a column on the sign-in card. */
    expect(hasRule(css, `\\.${inverse}`, /display:\s*none/), `${inverse} is hidden`).toBe(
      true,
    );
    expect(
      hasRule(css, `\\[data-theme="dark"\\][^{]*\\.${base}`, /display:\s*none/),
      `${base} is hidden under a dark theme`,
    ).toBe(true);
    expect(
      hasRule(css, `\\[data-theme="dark"\\][^{]*\\.${inverse}`, /display:\s*revert/),
      `${inverse} is shown under a dark theme`,
    ).toBe(true);
  });
});
