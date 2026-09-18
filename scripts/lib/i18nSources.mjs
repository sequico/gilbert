import { globSync } from "node:fs";
import ts from "typescript";

/**
 * Which files the i18n scripts read, and the kit they read them with -- once.
 *
 * Four scripts look at the tree — the catalogue check, the literals check, the
 * extractor and the coverage report — and each wrote out its own glob with its
 * own exclusions. They disagree in one place on purpose and agree everywhere
 * else, so the two scopes are named here rather than spelled out four times.
 *
 * The exclusions are not cosmetic. `__tests__` asks for strings to assert on,
 * not for a reader to read, and a catalogue keyed from a test would be a key
 * nothing renders. `locales/` *is* the translated side: a string there is a
 * translation, and counting one as a string the code asks for would make every
 * catalogue entry look used.
 *
 * The extractor and the coverage report read a component the same way: which
 * attributes carry a person's text, which elements hold code, which text is
 * neither, and which elements opt out of translation. That kit is here, one
 * definition for both tools, and it is the coverage report's definition — the
 * superset — that stands. Two things it settles, so neither is a surprise:
 *
 *   - `ATTRS` admits `message`, an attribute a person reads: the extractor
 *     wraps a `message="…"` it meets, which is the text the coverage report
 *     already counts as remaining, so the figure the merge moves is the
 *     extractor's `wrapped` count;
 *   - `NOT_PROSE` admits `—`, `#` and `*` among its punctuation, which is the
 *     class the coverage report counts by. The two spellings admitted the same
 *     characters, so the extractor counts that same text and the figure
 *     `i18n:coverage` prints does not move.
 */

/** Every module that can ask for a string, tests and catalogues aside. */
export function sourceFiles() {
  return globSync("web/src/**/*.{ts,tsx}").filter(
    (f) => !f.includes("__tests__") && !f.includes("/locales/"),
  );
}

/**
 * The same, for a caller that has only ever read components.
 *
 * `i18n-coverage.mjs` measures what the views ask for, and reads `.tsx` alone.
 * Widening it is a change to what that report counts rather than a
 * de-duplication, so the scope stays what it was.
 */
export function componentFiles() {
  return globSync("web/src/**/*.tsx").filter((f) => !f.includes("__tests__"));
}

/** The catalogues themselves, one file per language. */
export function catalogFiles() {
  return globSync("web/src/locales/*.ts");
}

/**
 * The attributes that carry text a person reads: a title, a label, a hint, the
 * sentence a surface shows beside a control. `className` and `key` are not
 * among them, and `message` is.
 */
export const ATTRS = new Set([
  "title",
  "aria-label",
  "placeholder",
  "alt",
  "label",
  "hint",
  "confirmLabel",
  "message",
  "description",
]);

/**
 * Text that is not prose: punctuation, separators, and the single glyphs used
 * as dividers. Counting these as untranslated would put a floor under the
 * number that no amount of work could reach.
 */
export const NOT_PROSE = /^[\s·—–\-:;,.()[\]{}/|+×✓~<>#*@0-9]*$/u;

/**
 * Elements whose text is code rather than prose, however much it looks like
 * prose: `label:name` inside `<code>` is a search operator, and translating it
 * breaks the thing it documents. Text inside one is deliberately English, so
 * counting it as remaining work would put a floor under the coverage report's
 * number that no amount of effort could reach -- the report sat at 21 with only
 * 6 real items left, which makes the number something to argue with rather than
 * act on.
 */
export const CODE_TAGS = new Set(["code", "kbd", "pre", "samp", "var"]);

/**
 * Whether an element opts out of translation with `translate="no"`, on the
 * element and on the self-closing element alike. The node and its source text
 * are all it needs, so either tool asks it about a node it is standing on.
 */
export const optedOut = (node, src) => {
  const opening = ts.isJsxElement(node)
    ? node.openingElement
    : ts.isJsxSelfClosingElement(node)
      ? node
      : null;
  return Boolean(
    opening?.attributes.properties.some(
      (a) =>
        ts.isJsxAttribute(a) &&
        a.name.getText(src) === "translate" &&
        a.initializer &&
        ts.isStringLiteral(a.initializer) &&
        a.initializer.text === "no",
    ),
  );
};
