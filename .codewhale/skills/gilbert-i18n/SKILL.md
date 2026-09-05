---
name: gilbert-i18n
description: Workflow for adding or changing user-visible strings and languages in the Gilbert web client. Covers English-as-key translation (t/tc/plural/tNode), the per-language catalogs in web/src/locales, registering a UI language, and the i18n checks. Load before editing user-facing copy, a locale catalog, or the language registry.
metadata:
  short-description: Add/audit UI strings & languages
---

# Gilbert — user-visible strings and languages

## The model (read this before touching anything)

- **The English source text is the key.** `t("Archive")` looks "Archive" up in
  the loaded catalog and returns the English if it is absent. There is no
  English catalog file: English is built in (`DEFAULT_UI_LANGUAGE = "en"`,
  empty catalog in `web/src/lib/i18n.ts`). A missing translation degrades to
  readable English by design — never invent a symbolic key.
- A catalog maps English → translation: `{ strings: Record<string,string>,
  plurals: Record<string, PluralForms> }`, exported as `catalog` from
  `web/src/locales/<tag>.ts`. One file per shipped language.
- Changing English copy **orphans** its translations: the old key no longer
  exists, the catalog entry is stale, and the app renders the new English.
  Delete the stale entry from every catalog — the header of each catalog file
  says so ("Deleting an entry is a valid fix"). Do not keep it "just in case".
- Repo content stays English; only the app's UI strings are translated. Do not
  translate comments, docs, or commit messages.

## Which helper, and when

- `t(source, vars?)` — plain text. `{name}` placeholders are interpolated with
  named vars; a translator reorders sentences, so never use positional args.
- `tc(context, source, vars?)` — when one English word does two jobs ("Archive"
  the button vs the folder; "Important" the tag vs the folder). Lookup is
  `context + "\u0004" + source`, fallback stays plain English. Use `tc()`, do
  not hand-craft the separator.
- `plural(n, { other, ... }, vars?)` — counted things. The English `other`
  form is the key and the call site reads as the sentence it produces:
  `plural(messages.length, { one: "{n} message", other: "{n} messages" })`.
  Russian/Ukrainian supply three forms; `Intl.PluralRules` picks.
- `tNode(source, parts)` — one whole sentence with `<code>`/`<kbd>` elements
  inside, as named ReactNode holes. Never split a sentence across two `t()`s.
- Export/import flows, toasts, `confirmDialog` titles: string literals in
  those positions reach a reader translated **only if wrapped or a catalog
  key** — this is what `i18n:literals` enforces.

## Conventions that keep the checks quiet

- A label held in a constant table (`const X_LABELS = { a: { label: "A" } }`)
  and translated at the render site (`t(s.label)`) is a real convention, and
  `i18n-catalog-check.mjs` collects `label:` properties and `*_LABELS`
  variables so they are not reported stale. Do not inline-translate there.
- The app's own name appears in strings as the runtime name (`APP_NAME`), not
  a hardcoded word — check how a neighbouring string does it before writing
  "Gilbert" or "ihasmail" into UI copy.

## Adding a language

1. Write `web/src/locales/<tag>.ts` exporting `catalog` (strings + plurals).
   Copy the header stance from an existing file: state honestly whether a
   native speaker has reviewed it.
2. Then register it in `UI_LANGUAGES` in `web/src/lib/languages.ts`
   (`tag`, `name` in that language, `beta: true` until a person who speaks it
   has read it and said otherwise — a coverage number never earns that).
   Catalogue first, registry second: that order.
3. RTL languages (Arabic, Hebrew, Persian) need bidi and layout work well
   beyond strings — flag that before offering one.

## Checks

- `npm run i18n:check` — runs catalog-check (a catalogue file with no
  `UI_LANGUAGES` entry, and vice versa; **stale keys** — translated but never
  looked up, so they render nothing) plus literals (user-visible English that
  is neither wrapped nor a catalogue key). Read its output rather than the
  exit code: both scripts exit non-zero only with `--check`, which the npm
  script does not pass today.
- `npm run i18n:coverage` — progress report of hardcoded UI text still to
  extract; not a gate unless given `--check`. Not part of `prepush`.
- Tests: `web/src/lib/__tests__/i18n.test.tsx`, catalogs' own `__tests__`.
- In `dev:mock`, set Settings → General language to the tag and look at the
  screen; a string that renders English while neighbours render the language
  is a missing key, not a bug.

## Pitfalls

- `loadLanguage` dynamic-imports `../locales/<resolved>.ts`; a catalog that
  fails to load leaves English in force (caught, by design). A cold first
  paint waits on `whenLanguageReady()` — a toast fired before the catalog
  lands stays English for that render.
- The UI language is an account setting (`uiLanguage`), separate from
  `locale` (dates/numbers) — do not fold the two together.
