# ADR 0010 — An automation is written in prose and compiled into its rule

Status: Proposed (2026-09-11)

## Context

An automation is a document the fleet executes (ADR 0003): a trigger, a
tier, the material that tier runs on — a T0 rule's ordered actions, a T1
rule's closed set of categories each with fixed actions, a T2 rule's
instruction — bounded by a capability allowlist and a review policy. That shape
is exact, and the executor, the matcher, the review gate and the consent floor
are built on it.

Authoring a rule means choosing among those fields before the intent is
settled. An administrator who wants "when a client mails the group, file the
attachment under their name and tell the group" has to pick the tier, name the
capabilities and fix the actions — when the tier is a cost and confidence
classification, and the person holding the intent has an intent, not a
classification.

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
trail are untouched, and a compiled rule is indistinguishable from a
hand-assembled one to every one of them.

**The tier is the compiler's decision, not the author's.** The author says what
the automation should do; the compiler decides how much model the decision
costs — whether a fixed set of actions settles it (T0), whether a closed
classification it proposes settles it (T1), or whether a model has to decide at
run time (T2). The vocabulary of tiers stops at the compiler: the surface shows
the automation, never its tier name.

**The context is the product's, and it is bounded.** The compiler is given what
the installation can actually do — the capability catalogue in full, and the
review and consent rules — and compiles inside that envelope. It cannot invent
an action or a capability, because the envelope it is handed does not contain
one.

**Underdetermined prose is refused, not guessed.** Prose is a statement of
intent, and an intent can be missing the thing that decides a branch. Where the
compiled rule would have to assume — a category set that silently drops a case,
a T0 action list that does nothing for one of the situations the prose names, a
condition nothing in the document can evaluate — the compiler names the gap and
returns no rule, and the author answers before anything is stored. A T1 and a
T2 rule carry a model's judgement at run time, so an unstated case there is not
a missing default but a decision nobody made. The compiler never fills a gap
with a plausible reading; it reports the prose as incomplete.

**The prose is data, and the machinery checks the output, not the compiler.**
The prose arrives from an administrator and is treated as untrusted: it is never
interpolated into the compiler's own instructions, and the compiler's system
prompt is fixed by the product, so text that addresses the compiler directly is
read as an automation's content rather than obeyed. Whatever the prose asks for,
the compiled document is validated by the same deterministic checks the form's
output passes (`isAgentRule`, `ruleProblem`) before it is stored, and the
capability allowlist the executor enforces and the consent floor
`consentRequired` applies are the same ones a hand-written rule meets. The
compiler proposes; the schema, the allowlist and the floor dispose. The rule
that governs the standing instruction governs prose as well: prose steers
inside the grant and never widens it.

**The author sees what the prose became.** The compiled rule is shown for review
before it takes effect — the trigger, what it will look at, the actions it will
run or the instruction it will carry, and the capabilities it may use — and the
rule records the prose it was compiled from, so the automation can be read as
the author wrote it and compiled again when the intent changes.

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
catch: the deterministic checks refuse a rule that is invalid, not a valid rule
that is not what the author meant. The author's review is what closes that gap,
and the review policy, the consent floor and the audit trail remain the runtime
guarantees behind it.
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

## Alternatives considered

- **Keep the tier as the author's choice.** Rejected: the tier is a cost and
  confidence classification the author cannot make from intent, and asking for
  it makes the author learn the machinery before saying what they want.
- **Store the prose and read it at run time, with no compiled document.**
  Rejected: the executor, the matcher and the review gate are built on the
  `AgentRule` shape, and interpreting prose on every run would move validation,
  capability enforcement and the audit trail into the model, where none of them
  is deterministic.
- **Compile into a new document shape.** Rejected: a second shape would need its
  own executor, matcher and gate, and the two would drift. The compiler targets
  the document that already exists.
- **Let the compiler widen the grant when the prose asks for it.** Rejected:
  prose is untrusted input from an administrator, and what an automation may do
  is decided by the installation's capability catalogue and the consent floor,
  never by the prose.
- **Have the compiler fill an underdetermined prose with a plausible reading.**
  Rejected: a guessed default is a decision nobody made and no one can see, and
  it surfaces as an automation that quietly did the wrong thing to a client's
  mail.

## References

- ADR 0001 — the administration surface, where the authoring path lives
- ADR 0003 — the agent worker fleet: the automation document, the tiers, the
  capability allowlist, the consent floor, the review gate
- `server/src/agent/documents.ts` — `AgentRule`, `AgentTier`, `isAgentRule`,
  `ruleProblem`, `consentRequired`, the capability catalogue
- `server/src/agent/executor.ts` — the executor that refuses an action outside
  the rule's own capability list
- `web/src/views/admin/agent/RuleForm.tsx` — the form that assembles a rule
  field by field
