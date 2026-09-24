import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The phone's fixed chrome, guarded where it lives.
 *
 * Everything here is a number two places have to agree on: the top bar's
 * height and the inset it starts below, the tabbar's height and the room
 * `.main` reserves for it, the fab's own size and the toasts that must clear
 * it. jsdom has no layout, so a component test cannot see any of it -- a bar
 * drawn 4px too tall renders perfectly and covers the navigation. The
 * stylesheet is the only thing that knows, so the assertions are on it.
 *
 * Read off disk, not imported: `?raw` comes back empty for a stylesheet under
 * vitest, which would pass every assertion below on an empty string.
 */
const here = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : import.meta.url;
const css = readFileSync(resolve(dirname(here), "../app.css"), "utf8");

/** The inside of the first block whose prelude contains `at`, brace-matched. */
function mediaBlock(at: string): string {
  const start = css.indexOf(at);
  expect(start, `no ${at} block`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${at}`);
}

/** The declarations of the last rule whose selector list names `selector`. */
function declarations(scope: string, selector: string): string {
  const found = [
    ...scope.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ]
    .filter((m) =>
      m[1]!
        .split(",")
        .map((s) => s.trim())
        .includes(selector),
    )
    .pop();
  expect(found, `no rule for ${selector}`).toBeDefined();
  return found![2]!;
}

const phone = mediaBlock("@media (max-width: 768px)");

describe("phone chrome", () => {
  it("keeps the module bar off, so the drawer is the tree and not a second tabbar", () => {
    expect(declarations(phone, ".module-bar")).toContain("display: none");
  });

  it("gives the search field the top bar by dropping the address from it", () => {
    expect(declarations(phone, ".topbar-email")).toContain("display: none");
    /* And the address is styled by the stylesheet at all: an inline style is
       not something a media query can turn off. */
    expect(css, "no base rule for .topbar-email").toContain(".topbar-email {");
  });

  it("reserves the top inset on the bar and on the drawer's close", () => {
    for (const selector of [".topbar", ".drawer-head"]) {
      expect(declarations(phone, selector), selector).toContain(
        "env(safe-area-inset-top)",
      );
    }
    /* Both are the same height, or the close does not land on the hamburger
       it stands in for. */
    expect(declarations(phone, ":root")).toContain(
      "--topbar-h: calc(52px + env(safe-area-inset-top))",
    );
    expect(declarations(phone, ".drawer-head")).toContain("height: var(--topbar-h)");
  });

  it("reserves the bottom inset on the full-screen composer's two edges", () => {
    expect(declarations(phone, ".composer-head")).toContain("env(safe-area-inset-top)");
    expect(declarations(phone, ".composer-foot")).toContain(
      "env(safe-area-inset-bottom)",
    );
  });

  it("measures the dialog against the backdrop it is centred in", () => {
    const backdrop = declarations(phone, ".dialog-backdrop");
    expect(backdrop).toContain("env(safe-area-inset-top)");
    expect(backdrop).toContain("env(safe-area-inset-bottom)");
    /* 12px of the backdrop's padding at each end, and the insets with them:
       a max-height that leaves the padding out overflows the box that centres
       it, which is what puts the top of a tall dialog off the screen. */
    expect(declarations(phone, ".dialog")).toContain(
      "max-height: calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
    );
  });

  it("derives the phone's bottom chrome from one set of numbers", () => {
    const chrome = "var(--mobile-chrome)";
    expect(declarations(phone, ".mobile-tabbar")).toContain(`height: ${chrome}`);
    expect(declarations(phone, ".main")).toContain(`padding-bottom: ${chrome}`);
    expect(declarations(phone, ".fab")).toContain(`bottom: calc(${chrome}`);
  });

  it("keeps the minimized draft above the tabbar it would otherwise cover", () => {
    /* A 44px bar on a 60px tabbar: the dock is what lifts it off, so these two
       declarations are the whole mechanism. */
    expect(declarations(phone, ".composer-dock")).toContain(
      "bottom: var(--mobile-chrome)",
    );
    expect(declarations(phone, ".composer.minimized")).toContain("position: static");
  });

  it("makes every full-screen surface measure the area it is actually shown in", () => {
    /*
     * `inset: 0` on a fixed element sizes against the layout viewport, which on
     * a phone browser is the tall one that ignores the address bar. For a
     * surface whose bottom edge carries a control -- the composer's Send, the
     * dialog's foot -- that control ends up behind the toolbar until the page
     * was scrolled, which a fixed element cannot be.
     *
     * Both of these are full height and have something at the bottom; a
     * bottom-anchored bar is not this bug and is not listed.
     */
    expect(declarations(phone, ".composer")).toContain("height: 100dvh");
    expect(declarations(phone, ".dialog-backdrop")).toContain("height: 100dvh");
  });

  it("bounds the chat sheet between the two fixed bars", () => {
    /*
     * The sheet is portaled out of the top bar's stacking context, and it must
     * span only the content area: a full-screen one hid the menu and put its
     * own message field behind the tab bar. Its top is the top bar's foot and
     * its bottom the tab bar's head, so both stay reachable and the field sits
     * above the tab bar. `.chat-sheet` renders on a phone only, so it carries
     * the rule where it is declared rather than under a media query that could
     * not change the answer.
     */
    const sheet = declarations(css, ".chat-sheet");
    expect(sheet).toContain("top: var(--topbar-h)");
    expect(sheet).toContain("bottom: var(--mobile-chrome)");
  });

  it("keeps a toast above the fab it would otherwise land on", () => {
    const bottom = /bottom:\s*([^;]+)/.exec(declarations(phone, ".toast-host"))?.[1];
    expect(bottom, "no bottom on .toast-host").toBeDefined();
    expect(bottom).toContain("var(--mobile-chrome)");
    /* Off the same band the list below stops for, so the two cannot drift
       apart into a toast that lands on the button. */
    expect(bottom).toContain("var(--fab-clearance)");
    expect(declarations(phone, ".mail-list")).toContain(
      "padding-bottom: var(--fab-clearance)",
    );
  });

  it("gives the advanced search panel one column so its Search button fits", () => {
    /* Two columns leave the date range and the Search button past the right
       edge of a phone's panel, with no scrollbar to reach them. One column,
       and the action row wraps under the checkboxes. */
    expect(declarations(phone, ".search-panel .grid")).toContain(
      "grid-template-columns: 1fr",
    );
    expect(declarations(phone, ".search-panel > .row")).toContain("flex-wrap: wrap");
  });

  it("wraps the calendar toolbar so its mode switch stays reachable", () => {
    /* The date, Today and the two arrows leave the Day/Month/Agenda switch no
       room on a phone, and the bar does not scroll: Agenda ran off the right
       edge and could not be pressed at all. The bar wraps instead, and the
       switch takes a full row with its buttons sharing the width. */
    expect(declarations(phone, ".cal-toolbar")).toContain("flex-wrap: wrap");
    expect(declarations(phone, ".cal-toolbar .view-switch")).toContain(
      "flex: 1 1 100%",
    );
  });
});
