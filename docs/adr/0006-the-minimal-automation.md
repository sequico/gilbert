# ADR 0006 — The minimal automation

ADR 0003 gives a rule one shape — trigger, prose instruction, capability
allowlist, review policy — and nothing in that shape requires an
administrator to author more than the smallest number of rules a group
actually needs, or to read every one of the catalogue's actions one at a
time. Read cold, the rule editor looked like it wanted both: one rule per
business case, each with its own filter, and a checklist of twelve
individually-named actions to weigh on every rule. Neither is what the
schema asks for. This record names the minimum the schema already allows —
one rule per trigger, and a handful of grouped choices instead of twelve —
so "does this need to be this complicated" has a written answer instead of
being re-litigated at every reading of the automations tab.

## Decision one — one automation per trigger, not per case

**A group authors one enabled automation per trigger it actually uses, not
one per case that trigger can produce.** `AGENT_TRIGGERS` is four values —
`email`, `filenode`, `chat`, `schedule` — and four is also the practical
ceiling on how many enabled automations a well-run group needs, because the
branching between cases belongs in the instruction's prose, not in the
document count. "When an email arrives, file invoices under Accounting,
archive newsletters, and leave anything else for a person to read" is one
rule with one broad instruction, not three narrow ones — the model already
resolves the branch, the same way it resolves everything else `planFor`
hands it (ADR 0003, "An automation is an instruction a model carries out").

Two fields the form offers are optional exactly because the minimum does not
need them, and an administrator following this recipe leaves them alone:

- **The filter.** `RuleForm.tsx` renders the "If" section only when
  `rule.trigger.on === "email"` — a `chat`, `filenode` or `schedule` rule has
  no filter to fill in at all, in the form or in the document it writes. Even
  on an email trigger, an absent filter is not a degraded rule:
  `matchEmailFilter` reads it as "match everything" (`filterProblems` calls
  an empty filter a rule that "matches every message," not an invalid one),
  so the recipe's default is to leave it empty and let the instruction's
  prose carry whatever discrimination the group needs.
- **The count of rules on one trigger.** Nothing stops two enabled rules from
  sharing a trigger, and for `email` that is sometimes right — two filters
  aimed at two disjoint slices of mail are two rules by construction, because
  a filter is what tells them apart. For `chat`, `filenode` and `schedule`,
  which carry no filter, this is never right: `executor.ts`'s
  `fileRecords` runs `for (const rule of chatRules) await this.startJob(...)`
  over **every** enabled chat rule against **every** message that addresses
  the agent, and the schedule and file-node paths fan out the same way. Two
  enabled chat rules do not divide the work between them; both answer the
  same mention, and a member reads two replies to one question. The minimal
  recipe is therefore also the only correct one on these three triggers: at
  most one enabled automation each.

## Decision two — areas, and one thing that never joins an area

The capability checklist stays a checklist of the actions
`AGENT_ACTION_SPECS` already defines — nothing is removed from the
catalogue, and `AgentRule.capabilities` keeps holding the same
`AgentActionName[]` it always has (`server/src/agent/documents.ts`). What
changes is what an administrator looks at while choosing: **four areas
instead of twelve actions**, each one a single checkbox that expands, on
save, to every action it names.

| Area | Expands to | What it is |
|---|---|---|
| Posta | `keyword.add`, `keyword.remove`, `mail.move`, `mail.extract`, `mail.draft` | organizes mail inside the group; nothing it does leaves the account |
| Chat | `chat.post` | writes in the group's own chat |
| File e documenti | `file.write`, `document.read`, `document.split`, `document.merge`, `document.extract` | writes and reshapes the group's own Files |
| *(schedule carries no action of its own — its area is whichever of the above the scheduled job needs)* | | |

**One action is never in an area, on principle rather than by a list kept in
sync by hand: `mail.send` stays its own checkbox, standing beside the areas
rather than folded into Posta, because it is the one entry in
`AGENT_ACTION_SPECS` marked both `external` and `irreversible`.** The rule
is general, not a special case pinned to today's one dangerous action: an
area's expansion is built by excluding whatever the catalogue marks
`external` or `irreversible`, so a future action added to the catalogue with
either flag is excluded from every area's expansion the same way, without
this table needing to be revisited. Ticking "Posta" can never be how a
person grants sending — only ticking "Invio" can, and it is the one checkbox
this editor keeps unmistakably separate rather than the fine print under a
broader one.

This is a UI grouping, not a new document shape: `AGENT_ACTION_SPECS` gains
one optional tag per entry (which area it belongs to, absent for anything
excluded from all of them) for `RuleForm.tsx` to group by; `AgentRule` on
disk is unchanged, so an existing rule's `capabilities` array reads exactly
as it always did, and nothing about `decideActions` or the allowlist check
in `executor.ts` moves. A rule authored before this decision and one
authored after it are the same document shape; only the editor that writes
`capabilities` groups the same 12 checkboxes into 4 as area toggles plus 1
that answers for itself.

### Considered and rejected — a model that writes the rule from prose

A stronger version of "make this simpler" was raised and set aside: hand the
administrator's plain-language description of what an automation should do
to the installation's own model, and let it propose the trigger, the areas
and the review policy, the way ADR 0003's reading helper already turns a
draft instruction into words about its gaps. Rejected, not because the idea
is unsound, but because it answers a problem decision two already removes:
the friction it was meant to cut was twelve individually-weighed checkboxes,
and four area toggles plus one separate one are not enough friction to
justify a second model call, a second review surface, and a second place an
inferred grant could be wrong. If a future catalogue grows back past a
handful of areas, this alternative is the one to revisit — and its condition
would be the same ADR 0003 already holds for every other model-influenced
decision: the model proposes a draft, an administrator reads and confirms
it, and nothing it produces is written before that confirmation, most of all
whichever areas is not part of any group.

## What stays mandatory, and why it is not the same complexity

- **The capability allowlist**, now chosen by area, stays mandatory:
  `ruleProblem` refuses a rule with none, since with none it could do
  nothing. This is the one boundary a run cannot cross regardless of what
  its prose says or what the mail it read tried to say (ADR 0003, "Content
  is data, never instruction") — an inbox is adversarial input by
  construction, and the allowlist is enforced by `decideActions` in code,
  not by the model's own restraint. Grouping the choice into areas shrinks
  how many things an administrator weighs; it does not shrink what any one
  rule ends up granted below what its job needs.
- **The review policy.** One choice — `always`, `threshold`, `never` — plus a
  number when the mode asks for one. `reviewOutcome` already holds the floor
  a rule's own choice cannot lower: an external or irreversible action pauses
  for a person whatever the mode says (`consentRequired`, `irreversible`),
  so the dropdown decides only how cautious the *rest* of the run is, never
  whether sending mail asks first. One decision per rule, made once, is the
  whole of what this costs an administrator.

## What this does not change

No field is added to or removed from `AgentRule`, `AgentTrigger`,
`AgentReview` or `AgentAction`; `capabilities` still stores
`AgentActionName[]`, exactly the granularity `decideActions` checks against;
no branch of `executor.ts` changes. The area tag on `AGENT_ACTION_SPECS` is
metadata the catalogue carries for the editor, not a new kind of document,
and existing rules need no migration — they already hold the action names an
area now merely groups.

## Consequences

- An administrator opening the automations tab for the first time has a
  target rule count — roughly the number of triggers the group's work
  actually needs, one to four — and a target number of grants to weigh per
  rule — one to three areas plus, rarely, Invio — instead of an open-ended
  rule count and a flat list of twelve.
- The chat/file-node/schedule fan-out (every enabled rule on the trigger
  runs, unfiltered) is now a documented reason a second rule on one of these
  triggers is a mistake to catch at authoring time, not a latent duplicate-
  reply bug discovered in a group's chat. Guarding it in the admin surface —
  refusing or warning on a second enabled rule sharing one of these three
  triggers — is a natural follow-up this record does not itself implement.
- Nothing marked `external` or `irreversible` in the catalogue can ever be
  granted as a side effect of ticking an area: the exclusion is computed from
  those two flags, not from a second list that could drift from them.
- The standing instruction (`agent/instruction.json`, ADR 0003) keeps its own
  job — facts true of the whole group, prepended before any rule's
  instruction — and does not absorb a rule's per-trigger logic; a rule that
  says "follow the group's standing instruction" and nothing else is a
  legal, if unhelpfully thin, instruction, since `ruleProblem` only asks that
  the field be non-empty.

## References

- ADR 0003 — the rule shape, `planFor` → `decideActions`, the allowlist, the
  review gate, the reading helper's propose-then-confirm shape, the standing
  instruction's place in the prompt order
- `server/src/agent/documents.ts` — `AGENT_TRIGGERS`, `AGENT_ACTION_SPECS`,
  `ruleProblem`, `filterProblems`, `matchEmailFilter`, `consentRequired`,
  `irreversible`, `reviewOutcome`
- `server/src/agent/executor.ts` — `fileRecords`, the unfiltered fan-out over
  every enabled rule on a `chat`, `filenode` or `schedule` trigger;
  `decideActions`, the allowlist check a chosen area cannot widen
- `web/src/views/admin/agent/RuleForm.tsx` — the filter section gated on
  `rule.trigger.on === "email"`, the capability checklist grouped by area,
  Invio kept outside every group, the review mode selector
