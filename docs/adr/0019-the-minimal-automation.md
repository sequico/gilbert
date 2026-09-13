# ADR 0019 — The minimal automation

ADR 0003 gives a rule one shape — trigger, prose instruction, capability
allowlist, review policy — and nothing in that shape requires an
administrator to author more than the smallest number of rules a group
actually needs. Nothing wrote that down, though, and its absence has a cost:
read cold, the rule editor's four sections (`RuleForm.tsx`) look like a
form that wants one rule per business case, each with its own filter, its
own prose, its own checkbox set — which is not what the schema asks for and
not what a group should be authoring. This record names the minimum the
schema already allows, so the question "does this need to be this
complicated" has a written answer instead of being re-litigated at every
reading of the automations tab.

## The decision

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
  prose carry whatever discrimination the group needs. A filter earns its
  place only when the discrimination is cheaper to state as a JMAP condition
  than as a sentence, or when it must be exact regardless of how the model
  reads a message — a mailbox id, an exact sender — never as the default way
  to narrow a rule.
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

## What stays mandatory, and why it is not the same complexity

Two fields are not optional, and the recipe does not soften them, because
they are not authoring overhead — they are the two places ADR 0003's
allowlist and review gate actually bind.

- **The capability allowlist.** `ruleProblem` refuses a rule with none: "the
  rule needs at least one capability to allow: with none it could do
  nothing." This is the one boundary a run cannot cross regardless of what
  its prose says or what the mail it read tried to say (ADR 0003, "Content
  is data, never instruction") — an inbox is adversarial input by
  construction, and the allowlist is enforced by `decideActions` in code,
  not by the model's own restraint. Collapsing rules to one per trigger
  shrinks how many allowlists a group maintains; it does not shrink any one
  of them below what that trigger's job needs.
- **The review policy.** One choice — `always`, `threshold`, `never` — plus a
  number when the mode asks for one. `reviewOutcome` already holds the floor
  a rule's own choice cannot lower: an external or irreversible action pauses
  for a person whatever the mode says (`consentRequired`, `irreversible`),
  so the dropdown decides only how cautious the *rest* of the run is, never
  whether sending mail asks first. One decision per rule, made once, is the
  whole of what this costs an administrator.

## What this does not change

No field is added to or removed from `AgentRule`, `AgentTrigger`,
`AgentReview` or `AgentAction` (`server/src/agent/documents.ts`); no branch
of `executor.ts` changes; the rule editor's fields are exactly the ones
`RuleForm.tsx` already renders. This record is a stated convention for how a
group is meant to be authored inside the shape ADR 0003 already built, not a
revision of that shape — the recipe was always legal, this just says it is
also the default.

## Consequences

- An administrator opening the automations tab for the first time has a
  target rule count — roughly the number of triggers the group's work
  actually needs, one to four — instead of an open-ended one driven by how
  many business cases come to mind.
- The chat/file-node/schedule fan-out (every enabled rule on the trigger
  runs, unfiltered) is now a documented reason a second rule on one of these
  triggers is a mistake to catch at authoring time, not a latent duplicate-
  reply bug discovered in a group's chat. Guarding it in the admin surface —
  refusing or warning on a second enabled rule sharing one of these three
  triggers — is a natural follow-up this record does not itself implement.
- The standing instruction (`agent/instruction.json`, ADR 0003) keeps its own
  job — facts true of the whole group, prepended before any rule's
  instruction — and does not absorb a rule's per-trigger logic; a rule that
  says "follow the group's standing instruction" and nothing else is a
  legal, if unhelpfully thin, instruction, since `ruleProblem` only asks that
  the field be non-empty.

## References

- ADR 0003 — the rule shape, `planFor` → `decideActions`, the allowlist, the
  review gate, the standing instruction's place in the prompt order
- `server/src/agent/documents.ts` — `AGENT_TRIGGERS`, `ruleProblem`,
  `filterProblems`, `matchEmailFilter`, `consentRequired`, `irreversible`,
  `reviewOutcome`
- `server/src/agent/executor.ts` — `fileRecords`, the unfiltered fan-out over
  every enabled rule on a `chat`, `filenode` or `schedule` trigger
- `web/src/views/admin/agent/RuleForm.tsx` — the filter section gated on
  `rule.trigger.on === "email"`, the capability checklist, the review mode
  selector
