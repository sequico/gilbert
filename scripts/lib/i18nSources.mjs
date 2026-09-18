import { globSync } from "node:fs";

/**
 * Which files the i18n scripts read, decided once.
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
