# ADR 0013 — An automation is written in prose and compiled into its rule

Status: Proposed (2026-09-11)

## Context

An automation is a document the fleet executes (ADR 0003, resolution 2): a
trigger, an area, one of three tiers, and the material that tier runs on — a T0
rule's ordered actions, a T1 rule's closed set of categories each with fixed
actions, a T2 rule's instruction — bounded by a capability allowlist and a
review policy. That shape is exact, and the executor, the matcher, the review
gate and the consent floor are built on it.

Authoring it means choosing among those fields before the intent is settled. An
administrator who wants "when a client mails the group, file the attachment
under their name and tell the group" has to decide whether that is a
deterministic rule with fixed actions or one whose instruction a model decides
on, name the capabilities it may use, and pick the tier the machinery wants —
when the tier is a cost and confidence classification, and the person holding
the intent has an intent, not a classification.

Two facts follow. The classification is a decision a model can make from the
intent, and one the person should not have to make. And the prose is where the
intent actually lives: it is more legible than the compiled form, to the person
who wrote it and to the one reading the group's automations a month later.

## Decision

An automation is authored as prose, and one model call compiles that prose into
the rule document the fleet runs. The prose is the automation's statement of
intent; the compiled rule is the document.

**The compiler is one call with one output.** It receives the prose and the
installation's context and returns an `AgentRule` — the same document the form
produces, with the same fields. Nothing downstream changes: the executor, the
matcher, the tier machinery, the review gate, the consent floor and the audit
trail are untouched, and a rule compiled from prose is indistinguishable from
one assembled by hand.

**The tier is the compiler's decision, not the author's.** The author says what
the automation should do; the compiler decides how much model the decision
costs — whether a fixed set of actions settles it, whether a closed
classification it proposes settles it, or whether a model has to decide at run
time. The vocabulary of tiers stops at the compiler: the surface shows the
automation, never its tier name.

**The context is bounded, and it comes from the product, not from the prose.**
The compiler is given what the installation can actually do — the areas the
deployment serves, the capability catalogue in full, the group's narrowing, and
the review and consent rules — and compiles inside that envelope. It cannot
invent an action, an area or a capability, because the envelope it is handed
does not contain one.

**The prose is data, and the machinery checks the output, not the compiler.**
The prose arrives from an administrator and is treated as untrusted: it is never
interpolated into the compiler's own instructions, and the compiler's system
prompt is fixed by the product, so text that addresses the compiler directly is
read as an automation's content rather than obeyed. Whatever the prose asks for,
the compiled document is validated by the same deterministic checks the form's
output passes (`isAgentRule`, `ruleProblem`) before it is stored, and the
capability allowlist and the consent floor are applied by the executor exactly
as they are for a hand-written rule. The compiler proposes; the schema, the
allowlist and the floor dispose. The rule that governs the standing instruction
governs prose as well: prose steers inside the grant and never widens it.

**The author sees what the prose became.** The compiled rule is shown for review
before it takes effect — the trigger, what it will look at, the actions it will
run or the instruction it will carry, and the capabilities it may use — and the
prose is kept beside it as the automation's own record, so the rule can be read
as the author wrote it and compiled again when the intent changes.

**The form remains.** Assembling a rule field by field stays available as the
exact path, for the administrator who knows the shape and for an installation
that runs no compiler. Prose is the front door, not the only door.

## Consequences

- The three tier names leave the administrator's vocabulary. They remain in the
  document and in the worker, where they decide cost and confidence, and they
  stop being something a person is asked to choose.
- A compiled rule is a proposal until a person accepts it: the preview is shown,
  the prose is kept, and the document that reaches the store is the one the
  administrator saw. Nothing compiles silently into a running automation.
- The compiler is a model call and can be wrong in a way validation does not
  catch: the deterministic checks refuse a rule that is invalid, not a valid
  rule that is not what the author meant. The author's review is what closes
  that gap, and the review policy, the consent floor and the audit trail remain
  the runtime guarantees behind it.
- The compiler needs a provider. With none configured the form is the whole of
  the authoring surface, and the prose path is unavailable rather than degraded:
  a compile that cannot run is named as unavailable, never approximated by a
  silent fallback.
- Compilation consumes the installation's model budget on an authoring action,
  which is a person waiting rather than a run in flight. Its cost is bounded by
  the prose's length, and it is charged to the compiler's own provider
  configuration, not to either run-time tier's.
- A rule recompiled from edited prose is a new version of the same document
  (`version` bumped, in-flight jobs keeping the version they started on), so
  editing prose follows the same versioning an edited rule already follows.
