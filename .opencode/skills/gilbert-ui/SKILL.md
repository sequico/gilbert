---
name: gilbert-ui
description: The one visual language of the Gilbert client — which control to use for which action, where the primitives live, and how to keep a surface from inventing a second way of saying something. Load before adding or changing any control, empty state, counter, list row, action bar, table or icon, and for any pass that judges whether screens look alike.
metadata:
  short-description: One control per action, one look per control
---

# Gilbert — one visual language

The client is one product with one shell: a control means the same thing on
every surface, and a surface that needs something new extends the shared
primitive rather than inventing a second one. This skill is the working half of
the single-source rule: code↔code duplication is a defect, and **a second visual
spelling of the same action is that defect wearing a costume**.

## Before you add a control

1. **Name the action.** "Save to Files", "Create", "Select all". Then find how
   the app already says it: `grep -rn` for the class and for the label
   (`grep -rn 'Save to Files' web/src`). If a surface already does it, reuse —
   including the icon.
2. **Find the primitive, not the nearest copy.** `web/src/ui/` holds the shared
   ones: `dialog.tsx` (Dialog, confirmDialog, promptDialog), `popover.tsx`
   (Popover, MenuItem, MenuSep, MenuTitle), `toast.tsx`, `tabs.tsx`,
   `SectionShell.tsx`, `misc.tsx` (`Empty`), `LoadState.tsx`, `selection.tsx`,
   `datefield.tsx`, `JsonDocumentEditor.tsx`, `Splitter.tsx`.
3. **If the pattern is wrong, fix the pattern.** A local override that makes one
   surface look right leaves the next surface wrong. Correct the class, the
   shared component or the token, and every caller inherits it.

## The classes and what they mean

- **Buttons** (`.btn` in `styles/app.css`): one primary action per surface
  (`.btn-primary`), secondary as `.btn` with a border or `.btn-ghost` without —
  **not both for the same weight**, destructive as `.btn-danger` and set apart
  from the group. Sizes `.btn-sm` / `.btn-lg`; icon-only is `.icon-btn`
  (`.sm`, `.xs`). An icon-only control carries a `title` and an `aria-label`.
- **Icons**: lucide only, one meaning per glyph across the app (a folder for
  "put it in Files", an arrow-into-tray for "put it on this machine"; never an
  arrow pointing up for a save). Sizes 14 (inside a button or a row), 16–18
  (toolbar), 22 (list header illustration). Same family and direction for a pair
  of sibling actions.
- **Empty states**: `Empty` (`ui/misc.tsx`) — icon, title, one line. Every
  surface uses it; nobody writes a bespoke "nothing here" paragraph.
- **Loading**: a `.spinner` for a pane that has nothing yet; a carried window
  plus the two-pixel `.list-loading` bar when the previous content can stay. Never
  draw placeholder rows for content that is about to arrive.
- **Counters and badges**: one markup per idea — `.nav-count` for a folder's
  unread count, a `.tag` for a label, a badge only for a pending queue. A number
  in a new pill is a new visual language.
- **Tags and chips**: `.tag` (a label), `.folder-tag` (where a row lives),
  `.attachment` (a file, whole chip clickable, `.viewable` cursor `zoom-in`).
- **Colours and spacing come from tokens**: `var(--bg)`, `--bg-elev`,
  `--bg-sunken`, `--read-bg`, `--border`, `--fg*`, `--accent*`, `--danger`,
  `--radius*`, `--shadow*`. No hex in a component, no new elevation. Spacing is
  the 4/8 scale already in use (`4, 6, 8, 10, 12, 16, 24`), not arbitrary pixels.
- **Truncation**: `text-overflow: ellipsis` with the full value in `title`; a
  chip that clips mid-word without a title is a defect.
- **Tables**: header in the same case everywhere (small caps is the app's), the
  numeric column right-aligned, a row menu in the last cell.
- **Destructive actions**: separated from the neutral group (spacing or a
  divider) and never styled exactly like "Save". Deleting a draft, emptying a
  folder, removing an account are not one grey icon among five.

## Surfaces that must agree

Mail, Calendar, Contacts, Files, KB, Chat, Workorders, Settings, Administration.
For each, the same question asked the same way: does the toolbar carry the
primary action once? do the section headings read the same? do the actions of a
row sit in the same place? An action added in one surface is checked against the
others before it ships.

## The shell tells no lies

The top bar is the same on every surface, so anything in it must be true
everywhere: a search box that queries mail is labelled and behaves as mail (or
is contextual), not presented as the global search of the product. A section
title with no items under it is removed, not left as decoration.

## Process

- **Design the exception out.** A one-off that "looks better here" is either
  promoted to the shared primitive or dropped.
- **A visual pass is read-only first**: walk the surfaces at a real viewport,
  collect the divergences with their route and element, rank them, and let the
  owner choose — the same discipline as a code review, ending in decisions.
- **The inventory above is the current state**: when a primitive changes, this
  file changes in the same diff (snapshot mode, no history).
- **i18n**: every new label is a `t()`/`tc()`/`plural()` key — see
  `gilbert-i18n`; a control is not done until its words are.
