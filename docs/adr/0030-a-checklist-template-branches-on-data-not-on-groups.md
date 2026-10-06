# ADR 0030 — A checklist template branches on data, not on groups

Status: Accepted

Implementation: Built. The rules and their resolver are `KnowledgeChecklist`,
its `variants`/`sections`/`steps`, the conditions, the section **gate**
(`KnowledgeSection.requires`) and `resolveChecklist` in
`server/src/shared/knowledge.ts`; the write door is `server/src/knowledgeAdmin.ts`
and `server/src/app.ts`; the template's own body is derived (`checklistBlocks`).
The authoring surface is Gilbert's own (`web/src/views/knowledge/ChecklistSurface.tsx`).
The instance side is `server/src/shared/workorder.ts` and
`server/src/workorderAdmin.ts`, with the panel `web/src/views/workorder/` (ADR 0028):
the gate is latched on the root's `gates` (`reconcileGates`) and filtered per
part in `groupsFor`/`summaryOf`.

## Context

A checklist template is a KB page that defines the steps a kind of job takes, as
**data**. One job is not one list. A booking carries a choice made once (the
shipping line), sections whose checklist differs by that choice, and a section
that repeats once per container. The template is approved and versioned (ADR
0024), so what varies by case is part of the template, not invented by whichever
client renders it; the people who write it are administrators, not programmers;
and the mechanism must be **generic** — any number of variables, any number of
repeats, one company KB.

A JSON Schema form is the wrong tool for this: its conditional visibility
(`dependencies`) works **inside one object**, so a step inside a repeated section
could not branch on a value chosen at the top, and a form is data entry, not a
process with loops.

## Decision

A checklist template is a **process document**, `{ variants, sections }`, stored
on the page's draft and every revision:

- **Variants** are named choices with values. A workorder picks **one value per
  variant**, and that value holds **everywhere** — across every section and at
  any depth, including inside a repeat.
- **Sections** are ordered; each holds **steps**, an optional **condition**, an
  optional **repeat** and an optional **group** it is competent for.
- **Steps** are boolean checks with a stable key, a controlled label and an
  optional condition.
- A **condition** is `{ variant, equals }`. It may sit on a section or a step and
  resolves against the workorder's chosen values **wherever it is** — the
  cross-scope rule a JSON Schema form cannot express. `resolveChecklist(def,
  values, items, target)` is the **one** resolver, read by a workorder's
  instantiation and by its view.
- A section may carry a **gate**, `requires`: up to three other section keys
  that must have been **completed once** (all their steps `done` or `skipped`)
  before the section is shown. The gate is a **latch** — opened once, it stays
  open for the rest of the workorder, so re-opening a prerequisite for a
  revision does not hide a section a group has already been given — and it
  resolves over the **whole workorder**, so a prerequisite may live in another
  part: the global checklist or a different group's. A gated section whose gate
  has not opened is not served at all, from any part. A section with **no**
  applicable steps is **complete** (a gate on it does not block), a prerequisite
  naming no section — one an editor removed — is **tolerated** rather than
  hiding the section for ever, and the editor never offers a section that
  already depends on this one, so a cycle cannot be written.
- A **repeat** (`{ item, fields }`) is instantiated once per **item** the
  workorder names (the containers, stated at creation). A step's identity is its
  **path**, which carries the item (`loading[CONT-1].seal`), so the same step in
  two items is two entries and never collides. A repeat may declare per-item
  **data fields**; the instance stores each item's values beside its key.
- A **section may be assigned to a group**, by that group's **account id**
  (`section.group`); a section with no assignment is the **global** checklist. A
  workorder's part resolves only its own target (`resolveChecklist` takes it), so
  a section assigned to the freight group lands in the freight group's part and
  the global holds the rest. This is **competence**, not a variable: the workorder
  does not choose it, and it is not a fork of the template — one template serves
  every group, and a workorder's parts are exactly the groups its sections name.
- The page's **body and search text are derived** from the rules
  (`checklistBlocks`), so the rules are the one copy.
- The **authoring surface is Gilbert's own**, not a generic form builder:
  variants, sections, steps, conditions, repeats and a section's group are edited
  with the app's own controls. JSON Schema and an off-the-shelf form builder are
  deliberately **not used** — the model is a process, not a form, and cross-scope
  conditions and repeats fall outside what a form expresses.
- Branching resolves from the **bound revision**, never the template's current
  state; changing a variant, a section, a step, a condition, a repeat or a
  section's group is a new revision.
- A **genuinely different procedure** is a different template, not a branch of
  the generic one.

In `gilbertmailer` this is the builder and the checklist render; in
`gilbertserver` it is the resolver and the validation that gate a write, both
tiers reading `@gilbert/shared/*`.

## Consequences

- One generic template serves every case: no per-group fork, no per-case copy of
  the steps (SSOT).
- The value chosen once is consistent across the whole process, and a condition
  reads it at any depth — the cross-scope branching that made a form builder the
  wrong tool.
- Step identity is a **path**, so a repeated section materialises per item
  without collisions and its history is per item.
- Competence is **data**: which group does what is a property of the template's
  sections, so a workorder derives its parts from the template rather than an
  administrator listing groups by hand.
- Content a condition **excludes is not instantiated** — another line's section
  simply does not exist for this job. A step that applies but the operator
  decides the case does not need is **`not-applicable`** (dimmed, out of
  progress); a step declared **`skipped`** counts as complete but says so, with a
  note. Every touched step keeps **who and when** — the last signature.
- The resolver and the authoring are ours, so the rules are plain JSON of our own
  shape and no heavy builder or second rendering engine ships; the builder is the
  app's own surface.
- A group can be given a section only after another has been finished, across
  competences: this is **order of work**, which a workorder's chosen values
  cannot express, and the latch keeps a section a group already reached when a
  prerequisite is later reopened for revision.
- The repository is the kind of shape a real cycle needs — a global choice,
  conditional sections, a loop — without pretending it is a form.

## References

- `docs/adr/0024` — the knowledge base: pages, approval, revisions, and the
  checklist templates a workorder instantiates
- `docs/adr/0028` — workorders: the instance, its revision binding, its
  per-path steps and their states
