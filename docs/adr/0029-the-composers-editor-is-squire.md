# ADR 0029 — The composer's editor is Squire

Status: Accepted

Implementation: Built. The editor wrapper
`web/src/views/compose/RichEditor.tsx` drives Squire; the sanitisation policy it
hands the engine is `sanitizeEditorHtml`/`sanitizeEditorFragment` in
`web/src/lib/html.ts`; the dependency is `squire-rte` in `web/package.json`; its
licence is recorded in `NOTICE`; and the tests are
`web/src/views/compose/__tests__/editor-link.test.tsx`,
`editor-drop-once.test.tsx` and `focus.test.tsx`.

## Context

The message composer, the templates and an identity's signature all edit rich
HTML, and until now each did it through one hand-rolled `contenteditable` with a
custom toolbar over `document.execCommand` — a component the mail client
inherited from upstream ihasmail. That shape carries four costs. `execCommand`
is deprecated with no replacement. Undo, selection and block normalisation are
left to the browser, so the editor saved and restored a `Range` by hand and
rebuilt content with `innerHTML`. Building markup out of strings is where a
typed URL could leave an attribute — the CodeQL `js/xss-through-dom` finding —.
And every browser difference is this project's to reconcile.

None of this touches the architecture law: it is a component of **gilbertmailer**
over the same JMAP, with no service and no database of its own.

## Decision

Use **Squire** (`squire-rte`) for every surface that composes rich HTML — the
composer, templates and signatures — and remove the `execCommand` editor.

Squire is the shelf editor built for email, which is the one property the others
do not share. The HTML is its source of truth, so a quote or a forward keeps a
third party's markup intact; quoting is first-class (`increaseQuoteLevel`);
it normalises the browsers itself and uses no `execCommand`; it keeps its own
undo stack; it ships no UI, so the app's toolbar, popovers, CSS and translations
are unchanged; it is about 16 KB with no dependencies and under the MIT licence;
and it is in production in Fastmail, ProtonMail, Tutanota, Zoho Mail and
Superhuman. TipTap/ProseMirror, Lexical or Quill would each be more assembly for
an email body, and TinyMCE or CKEditor a heavier licence and bundle.

A block editor is the **KB's**, not the composer's: mail wants HTML that mail
clients render, not a structured block document, so the KB takes BlockNote and
the composer takes Squire (ADR 0024). The two editors are deliberate.

How it is wired:

- `RichEditor.tsx` keeps its props and its `RichEditorHandle`, so the three
  callers — the composer, `TemplatesSettings` and `IdentityDialog` — are
  unchanged and one component serves them all.
- Sanitisation is one policy. `sanitizeEditorFragment` returns a
  `DocumentFragment` with the same blocklist and allowed attributes as
  `sanitizeEditorHtml`, and is handed to Squire as its `sanitizeToDOMFragment`,
  so paste, `setHTML` and `insertHTML` all pass through the door the app already
  keeps.
- An image is put in with `insertImage`/`pasteImage`, and a link with
  `makeLink`: a `src` and an `href` are set as element properties and are never
  built into markup, so the string-built-markup XSS class is removed by
  construction rather than by encoding.
- A dropped file that is not an image still goes to `onFiles`, and the editor
  still owns the drop; the non-image paths are unchanged.
- Undo and redo state comes from the engine's `undoStateChange`.

## What is not in it

- The KB's editor — a separate decision (ADR 0024), and BlockNote.
- The chat input (`web/src/views/chat/ChatInput.tsx`): a plain-text field that
  draws emoticons and chips and hands back text, not a rich HTML editor.
- The plain-text composer mode, which is a `<textarea>` and stays one.

## Upstream updates

Squire is taken as an unmodified dependency, which is ADR 0002's download-only
stance applied to a library: its releases flow in, nothing flows back, and no
copy is patched in the tree. Its releases reach this repository through
Dependabot's npm channel — the weekly version updates `.github/dependabot.yml`
already runs over the single root lockfile — so a Squire release arrives without
a hand step and without a fork; a change this project needs is worked around in
the wrapper or waited for upstream. Its MIT licence and copyright line are
recorded in `NOTICE`.

## Consequences

- The deprecated `document.execCommand` editor is gone from the tree.
- The web build gains one client-side dependency, with its licence recorded.
- The editor is now a library the project does not own; that is the trade for
  not maintaining a rich-text engine, and it is the same trade the shelf
  decision makes everywhere else.
- One component still serves all three surfaces, so a future composer change
  lands once.

## References

- `docs/adr/0002` — upstream is download-only
- `docs/adr/0024` — the knowledge base, and its block editor
- `web/src/views/compose/RichEditor.tsx` — the wrapper
- `web/src/lib/html.ts` — one sanitisation policy, string and fragment
- `NOTICE` — the MIT attribution
