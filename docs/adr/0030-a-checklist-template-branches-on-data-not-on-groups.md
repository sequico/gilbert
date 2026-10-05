# ADR 0030 — A checklist template branches on data, not on groups

Status: Accepted

Implementation: Not built.

## Context

A checklist template is a KB page whose body holds `checkListItem` blocks
(ADR 0024): the block's id is the step's stable identity, the text is the
controlled content, and a workorder's checklist is an instance bound to a
revision that stores only each step's state and last signature, never the text
(ADR 0028). One job is not one list. A booking carries steps only for the
shipping line it was made with, more when the container is loaded at the depot
and fewer at the yard; the same file, different work.

The template is the controlled text and is approved and versioned (ADR 0024), so
what varies by case has to be part of the template, not invented by whichever
client renders it. And the people who write templates are administrators, not
programmers: the authoring surface must be a form rather than markup. The
mechanism must also be **generic for every group** — one company KB, one
procedure — so a group is never a template of its own.

## Decision

A checklist template is **one generic template** for a kind of job, in the
company KB or in a group's KB; a workorder instantiates it **once**, its global
checklist and each competent group's part all reading the same template. The
template is never forked per group: a group owns the **instance** (its part, per
ADR 0028) and signs it, and is never a variable of the template.

- The template declares **variants**: named fields and their values (a shipping
  line, a loading point). A step may carry a **condition** naming one variant
  value.
- The step state is `open`, `done` or **`not applicable`**. A `not applicable`
  step is dimmed, excluded from progress and from completion, and can be set back.
  Whoever may check a step may set it `not applicable` — a group's members for
  their part, an administrator or the agent for the global one — and the step
  keeps their signature as a check does. The state is **derived at instantiation
  from the rule and the chosen values and then stored**, and a person may change
  it; the stored state is the truth, so a re-read never recomputes it away.
- At instantiation the creator chooses a value for **every** declared variant — a
  missing one refuses the instantiation, as a template with no revision in force
  is refused. A step whose condition does not match is written `not applicable`
  in the instance; the instance stores the chosen values and **every** step id —
  a step is marked, never removed. The values are the **workorder's**, chosen
  once and carried on its root (ADR 0028): every checklist of the workorder — the
  global and each group's part — resolves from the same values, so branching
  never differs by group.
- The template is the controlled text: variants and conditions are part of the
  **approved revision**, so changing a rule is a new revision, exactly as
  changing a step is.
- The authoring surface for a template's **rules** is a **checklist builder**:
  variants and per-step conditions chosen from controls, not written as syntax.
  The step text and the sections stay the KB body, authored in the page editor
  (ADR 0024); the two write into the same draft, so a template is one document.
  The **variants and the per-step conditions are a JSON Schema bound to the same
  revision**, keyed by the step's block id — a variant is an `enum`, a condition
  an `if`/`dependencies` rule. The builder is **`@ginkgo-bioworks/react-json-schema-form-builder`**
  (Apache-2.0; React 19, maintained) editing that schema and previewing it
  through **`@rjsf/core`** (Apache-2.0). One copy of the text, one schema of
  rules: the reader and the agent read the same structure. The schema and the
  body are one template and must agree: every rule names a step id the body
  holds, a step with no rule is shown unconditionally, and the schema can neither
  add nor remove a step. A template that disagrees is refused, not half-read.
- The builder is **round-trip**: a template it created loads back into it and
  re-saves unchanged — every part it does not know is preserved, exactly as a
  stored document is (ADR 0028) — so an existing template is **edited**, never
  re-created, and a save is a new revision, never an in-place mutation.
- Branching is resolved **from the revision the workorder is bound to**, not from
  the template's current state: instantiation writes the `not applicable` set
  from that schema, and every later read shows the same set. A template edited
  afterwards changes neither a running workorder nor what it was instantiated
  with.
- A **genuinely different procedure** is a different template, not a branch of
  the generic one.

In `gilbertmailer` this is the page editor and the rules builder over one
document, and one checklist render in the workorder panel; in `gilbertserver` it
is the shared step shape and the validation that gates a write, both tiers
reading `@gilbert/shared/*`.

## Consequences

- One generic template serves every group: no per-group template, no per-group
  configuration, and no second copy of the steps to keep in step (SSOT).
- The audit says which steps were **not applicable**, by whom and when — the same
  signature a checked step carries — so a skipped step is accountable rather than
  invisible.
- The third step state is a **contract**: a reader that does not know it must
  still preserve the document (ADR 0028's non-destructive rule), and every reader
  and writer of `WorkorderStepState` moves in one change.
- Conditions are data in an approved revision, so the model that reads a template
  and the client that renders a workorder read the same structure; nothing is
  hidden by client logic.
- Editability and branching are one property: the builder round-trips a template,
  and an instance resolves its `not applicable` set from its **bound revision**,
  so editing a template never disturbs a workorder and re-opening one never
  re-evaluates it against a newer template.
- Branch-by-variant keeps the controlled text whole: a step the case excludes is
  stored, not deleted, so a running workorder bound to an earlier revision is
  unaffected, and the template can be approved and versioned without disturbing
  it.
- The rules are **JSON Schema**, a standard, so the builder and its renderer are
  replaceable without touching the stored data; the two libraries are
  permissively licensed (Apache-2.0) and their attribution belongs in `NOTICE`
  beside the others.
- The builder renders with its own UI kit (MUI and emotion), so it is
  **lazy-loaded and confined to authoring**: the workorder surface the reader
  uses stays Gilbert's own, on Gilbert's design system.
- The builder is real work over the same document — a constrained authoring
  surface and a schema of rules, not a templating language a non-technical
  administrator would have to learn.

## References

- `docs/adr/0024` — the knowledge base: pages, approval, revisions, and the
  checklist templates a workorder instantiates
- `docs/adr/0028` — workorders are group-owned parts: the instance, its
  revision binding, and the non-destructive document rule
