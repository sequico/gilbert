import { globSync, readFileSync } from "node:fs";
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
 * The keys a catalogue file actually defines.
 *
 * A catalogue holds its plain keys under `strings` and its counted keys under
 * `plurals`; only those two objects' own property names are keys. The object
 * names themselves and the plural form names (`one`, `other`, …) are the shape
 * of the file, not strings anything asks for, so they are left out by reading
 * the two objects structurally rather than every property in the file.
 *
 * A key may be written as a bare identifier (`Cancel: "Annulla"`) or as a
 * quoted string (`"Turn on notifications": "…"`), and both mean the same key
 * to the app. A checker that reads only the quoted form calls every one-word
 * key missing while its translation sits in the file -- which is what the
 * catalogue check did, so its coverage figure was wrong by every bare key.
 */
export function catalogKeys(src) {
  const keys = new Set();
  const objectOf = (node) => (node && ts.isObjectLiteralExpression(node) ? node : null);
  const nameOf = (name) =>
    ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : name.getText(src);
  const propertiesOf = (obj, name) => {
    const p = obj.properties.find(
      (x) => ts.isPropertyAssignment(x) && nameOf(x.name) === name,
    );
    return p ? objectOf(p.initializer) : null;
  };
  const add = (obj) => {
    if (!obj) return;
    for (const p of obj.properties)
      if (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name))
        keys.add(nameOf(p.name));
  };
  const visit = (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "catalog" &&
      objectOf(n.initializer)
    ) {
      const catalog = n.initializer;
      add(propertiesOf(catalog, "strings"));
      add(propertiesOf(catalog, "plurals"));
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return keys;
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

/*
 * The calls that carry English a reader sees, declared once.
 *
 * Four scripts ask "is this a translation wrapper?" and each had spelled the
 * set for itself — `i18n-literals` even listed `tc`, which the other two did
 * not, so a `tc(...)` key was invisible to the key generator while a literal
 * inside `tc(...)` was exempt from the literals report. One home, so the
 * caller names the wrapper the same way the app does.
 */

/** A call whose first argument is an English source the catalogue keys on. */
export const TRANSLATED_CALLS = new Set(["t", "translate", "tNode"]);

/** The contextual wrapper: `tc(context, source)`, keyed on both halves. */
export const CONTEXT_CALL = "tc";

/** The counted wrapper: `plural(n, forms)`, keyed on `forms.other`. */
export const PLURAL_CALL = "plural";

/** Every function that takes prose and returns it translated. */
export const WRAPPERS = new Set([...TRANSLATED_CALLS, CONTEXT_CALL, PLURAL_CALL]);

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

/**
 * A source file as these tools read it: a TypeScript AST.
 *
 * The parser, not the compiler. These scripts read the tree rather than
 * pattern-match it, so they need a compiler API: `ts.createSourceFile` turns a
 * file into an AST, and a walk asks that AST what a node is -- something a
 * regular expression cannot answer. `typescript` is a devDependency of this
 * repository and carries that API. It is also what `npm run i18n:check` and CI
 * run, so a break here is loud rather than silent.
 *
 * One call site for the parse, because five scripts had written these seven
 * lines out with their own idea of the script kind -- which is how one of them
 * came to read a `.ts` file as TSX.
 */
export function sourceAst(
  file,
  { text = readFileSync(file, "utf8"), kind = ts.ScriptKind.TSX } = {},
) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * The join between a context and its source, as the scan below spells it.
 *
 * The runtime has its own: `tc()` in `web/src/lib/i18n.ts` builds the same
 * separator at the call that renders a context-dependent string, and the
 * catalogues store the keys it produces. This is the scanner's reader of that
 * key, not a second definition of it -- the two must agree, and what holds them
 * together is that a catalogue entry for a contextual string is written with
 * the separator in it and found by this.
 */
function contextKey(context, source) {
  return `${context}\u0004${source}`;
}

/**
 * Every English string the app asks a catalogue for, and every plural set it
 * asks about.
 *
 * One rule set, because there are two readers and they must not disagree: the
 * check that counts the keys a catalogue is still missing and the extractor
 * that lists them. The check's rules are the wider ones -- a label held in a
 * constant and translated where it renders, a keyboard scope's description and
 * group, a palette entry marked translatable -- and the extractor read only the
 * calls, so it reported keys the check called stale. The wider set is the
 * answer: each rule below carries the reason it exists.
 */
export function wantedStrings() {
  const keys = new Set();
  const pluralForms = new Set();
  for (const file of sourceFiles()) {
    const src = sourceAst(file);
    const visit = (n) => {
      /*
       * Labels held in a constant and translated where they render -- t(s.label)
       * -- reach t() as a variable, so there is no literal for this to find and
       * every one of them looked "stale". They are collected from the constants
       * instead: a `label:` property, or a value in an object of them.
       */
      if (
        ts.isPropertyAssignment(n) &&
        n.name.getText(src) === "label" &&
        ts.isStringLiteral(n.initializer)
      )
        keys.add(n.initializer.text);
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        /_LABELS?$/.test(n.name.text)
      ) {
        const walk = (x) => {
          if (ts.isStringLiteral(x)) keys.add(x.text);
          ts.forEachChild(x, walk);
        };
        if (n.initializer) walk(n.initializer);
      }
      /*
       * A keyboard scope entry carries `keys`, a `description` and a `group`;
       * the surfaces that render it look the first two up through t() where
       * they render -- t(b.description), a variable lookup this scan cannot see
       * -- and the group heading does the same. The `keys` sibling is what marks
       * an object as a scope entry rather than some other description-bearing
       * shape.
       */
      if (ts.isObjectLiteralExpression(n)) {
        const props = n.properties.filter(ts.isPropertyAssignment);
        const hasKeys = props.some((p) => p.name.getText(src) === "keys");
        const desc = props.find((p) => p.name.getText(src) === "description");
        if (hasKeys && desc && ts.isStringLiteral(desc.initializer))
          keys.add(desc.initializer.text);
        const group = props.find((p) => p.name.getText(src) === "group");
        if (hasKeys && group && ts.isStringLiteral(group.initializer))
          keys.add(group.initializer.text);
        /*
         * A palette entry's `name` is translated only when the entry marks it
         * as prose rather than a proper name ("Classic" against "Dracula").
         */
        const name = props.find((p) => p.name.getText(src) === "name");
        const translatable = props.find((p) => p.name.getText(src) === "translatable");
        if (
          name &&
          ts.isStringLiteral(name.initializer) &&
          translatable &&
          translatable.initializer.kind === ts.SyntaxKind.TrueKeyword
        )
          keys.add(name.initializer.text);
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const fn = n.expression.text;
        const a0 = n.arguments[0];
        if (TRANSLATED_CALLS.has(fn) && a0 && ts.isStringLiteral(a0)) keys.add(a0.text);
        // Only the contextual key is required: the plain one is tc()'s
        // fallback, not a second obligation.
        if (
          fn === CONTEXT_CALL &&
          a0 &&
          ts.isStringLiteral(a0) &&
          n.arguments[1] &&
          ts.isStringLiteral(n.arguments[1])
        )
          keys.add(contextKey(a0.text, n.arguments[1].text));
        if (
          fn === PLURAL_CALL &&
          n.arguments[1] &&
          ts.isObjectLiteralExpression(n.arguments[1])
        ) {
          const forms = {};
          for (const p of n.arguments[1].properties) {
            if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer))
              forms[p.name.getText(src)] = p.initializer.text;
          }
          if (forms.other) {
            keys.add(forms.other);
            pluralForms.add(JSON.stringify(forms));
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return { keys, pluralForms: [...pluralForms].map((p) => JSON.parse(p)) };
}
