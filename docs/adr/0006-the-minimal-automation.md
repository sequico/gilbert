# ADR 0006 — The minimal automation

Status: Accepted

Implementation: Built. Decisions one, two and four: the rule
shape the editor writes (`server/src/agent/documents.ts` — `AgentRule`,
`AGENT_TRIGGERS`, `rulesProblem`, `areaActions`), the three areas with the two
entries that stand beside them (`AGENT_AREAS`, `standaloneActions`,
`agentRuleJsonSchema`'s `x-areas`) and the group's policy document
(`AgentGroupPolicyDoc`, `policyOf`, `AgentReviewMode`). Decision three, the two
speeds of context: the distilled head is the notebook, which a run may now write
(`notebook.write`, `server/src/agent/actions.ts`), and the narrow tail is the
named lookup a run asks for and gets (`AgentLookup` in
`server/src/agent/documents.ts`, the answer in `server/src/agent/llm.ts`, the
reads in `server/src/agent/executor.ts`, ADR 0020).

The surface this is about is **Admin → Group Agents → Automations** — the
editor that writes a group's automations. ADR 0003 gives an automation one
shape — trigger, prose instruction, capability allowlist, review policy — and
nothing in that shape requires an administrator to author more than the
smallest number of automations a group actually needs, or to read every one of
the catalogue's actions one at a time. The editor once offered the other
extreme: a flat checklist of thirteen individually-named actions to weigh on
every automation, and nothing that said a group needs one automation per
trigger rather than one per business case. Neither is what the schema asks for.
This record names the minimum the schema allows — one automation per trigger,
three grouped choices instead of thirteen, a policy written once for the group,
and a context a run reads without either starving the model of what it needs or
paying full price for what it does not — so "does this need to be this
complicated" has a written answer instead of being re-litigated at every
reading of the Automations tab.

**What is built.** All four decisions, and the files are named in each of them.

## Decision one — one automation per trigger, not per case

**A group authors one enabled automation per trigger it uses, not one per case
that trigger can produce.** `AGENT_TRIGGERS` is four values — `email`,
`filenode`, `chat`, `schedule` (`server/src/agent/documents.ts`) — and four is
also the ceiling on how many enabled automations a well-run group needs, because
the branching between cases belongs in the instruction's prose, not in the
document count. "When an email arrives, file invoices under Accounting, archive
newsletters, and leave anything else for a person to read" is one automation
with one broad instruction, not three narrow ones — the model resolves the
branch, the same way it resolves everything else `planFor` hands it (ADR 0003,
"An automation is an instruction a model carries out").

**An automation carries no filter, and that is what makes the count the rule
rather than a recipe.** The fan-out is what decides it: `emailRecords` in
`executor.ts` walks every changed message and starts a job for every enabled
automation on the trigger, and `fileRecords` does the same for every chat
mention and every file node. Two enabled automations on one trigger therefore do
not divide the work between them — both answer the same arrival, and a member
reads two replies to one question. Nothing in a document tells them apart: the
discrimination between one case and another is the prose's, and there is no
second field for it to be read out of.

The count is therefore enforced, in three places, at the seam each one owns:

- **The save** refuses a document that carries more than one enabled automation
  on a trigger — `rulesProblem` in `documents.ts`, read by `saveRules` in
  `agentAdmin.ts`, which is what the editor's own check calls.
- **The editor** offers only the triggers nothing holds, so the refusal is not
  something a person has to discover by trying (`web/src/views/admin/agent/RuleEditor.tsx`).
- **The executor** says so once, in the log and in the group's chat, when it
  reads a document that carries two anyway — written by hand, restored from a
  backup, or written by a build that predates the guard. It does not silently
  run one of them, because choosing one would be this product deciding which of
  two automations a person meant.

A **disabled** automation is a draft: it wakes nothing, so it may sit beside the
enabled one while its author decides to replace it. The count is of enabled
automations, not of documents.

## Decision two — three areas, and the two entries that stand alone

The catalogue stays what it is: `AgentRule.capabilities` holds the same
`AgentActionName[]` it always has, and nothing is removed from
`AGENT_ACTION_SPECS` (`server/src/agent/documents.ts`). What changes is what an
administrator looks at while choosing: **three areas, one checkbox each,
instead of thirteen individually-named actions** — and every entry of the
catalogue is accounted for, none of them silently.

| Area | Expands to | What it is |
|---|---|---|
| **Mail** | `keyword.add`, `keyword.remove`, `mail.move`, `mail.extract`, `mail.draft` | organizes mail inside the group; nothing it does leaves the account |
| **Chat** | `chat.post` | writes in the group's own chat |
| **Files and documents** | `file.write`, `document.read`, `document.split`, `document.merge`, `document.extract` | writes and reshapes the group's own Files |

**The expansion is computed, not listed.** Each entry of the catalogue carries
the area it belongs to (`AgentActionSpec.area`), and `areaActions(area)` returns
that area's members **minus** everything the catalogue marks `external` or
`irreversible`. The exclusion is therefore a rule about the catalogue rather
than a table kept in step by hand: an action added later lands in its area by
declaring one, and an action carrying either flag leaves every area the same
way without this record being revisited. It is tested against a catalogue this
build does not have — the point of the rule is what it does to a future entry,
not what it does to today's thirteen.

**Two entries stand beside the areas rather than inside one**, and they are two
different kinds of exception — both derived the same way, from what the areas do
not grant (`standaloneActions`):

- **`mail.send` stays its own entry**, on principle rather than by a list kept
  in sync by hand: it is the one entry in `AGENT_ACTION_SPECS` marked both
  `external` and `irreversible`, so no area can grant it. Ticking "Mail" can
  never be how a person grants sending; only the sending entry can.
- **`noop` gets no area either**, because it is not a behaviour: it is the
  answer "record the decision and change nothing", and an area is a group of
  *things a run does*. It is not a permission at all — a run may always decline,
  so every automation has it — and leaving it out of what a run may answer
  would be a behaviour change smuggled in as a layout, which is the thing this
  record refuses elsewhere. It is granted by `effectiveCapabilities(rule)` to
  the prompt and to the allowlist check alike, so the two cannot disagree about
  what a run may answer.

`AgentRule` is unchanged by this decision: a rule's `capabilities` array reads
exactly as it always did, and nothing about `decideActions` or the allowlist
check in `executor.ts` moved. What the editor paints comes from the published
schema — `agentRuleJsonSchema()` derives `x-areas` from the same constant the
executor reads — so an area cannot offer a grant the executor does not have.

### Rejected — a model that writes the rule from prose

Handing the administrator's plain-language description of what an automation
should do to the installation's own model, and letting it propose the trigger,
the areas and the review policy, the way ADR 0003's reading helper already
turns a draft instruction into words about its gaps, is rejected — not because
the idea is unsound, but because it answers a problem decision two already
removes. The friction it was meant to cut was thirteen individually-weighed
checkboxes, and three area toggles plus two that answer for themselves are not
enough friction to justify a second model call, a second review surface, and a
second place an inferred grant could be wrong. If a future catalogue grows
back past a handful of areas, this alternative is the one to revisit — and its
condition would be the one ADR 0003 already holds for every other
model-influenced decision: the model proposes a draft, an administrator reads
and confirms it, and nothing it produces is written before that confirmation,
most of all whichever area is not part of any group.

## Decision three — a stable, cached head and a narrow, targeted tail

A group's agent should remember its mail and its files the way it already
reads its chat, so a member never has to re-explain what is written down
somewhere in the account. The obvious way there — hand every run the group's
received and sent mail alongside whatever the trigger is about — is also the
one that breaks both of this record's own goals at once, and it is worth being
precise about why, because the mechanism is not what it looks like from the
admin surface.

**Caching here is not something Gilbert asks for; it is the provider
recognizing a prompt prefix it has already billed once.** `llm.ts` speaks to
one OpenAI-compatible endpoint and reads back `prompt_cache_hit_tokens` and
`prompt_cache_miss_tokens` — there is no cache directive Gilbert sends, only a
prefix the provider either does or does not recognize as one it served before.
ADR 0003 already built the prompt around that fact: system preamble, capability
catalogue, notebook, standing instruction, in that fixed order, "because the
stable head is what a provider's context cache can serve nearly free; the
volatile tail is what a run actually pays for." A head that changes on every
call is a head no provider ever recognizes twice, which makes "attach the
mailbox" the one addition that turns the very thing this architecture built to
be nearly free into the most expensive part of every single run — mail changes
on every run, so it could only ever live in the tail, in full, uncached, every
time.

The decision is therefore **two speeds of memory, not one list that grows**:

- **The stable head carries distilled facts, not raw correspondence.** The
  group's notebook is already the place ADR 0003 gives this — "the facts about
  this group that its automations should never have to repeat" — and it stays
  cheap precisely because a person, or a low-frequency automation, writes to it
  rarely. A `schedule` automation that reads the day's mail and files and
  rewrites the notebook with what changed — an open item, a reply still owed, a
  filing convention just used — belongs here: it touches the head once a day,
  not once a run, and every chat or email run afterwards reads the distillation
  at cache-hit prices instead of the correspondence at full price.
- **The volatile tail stays narrow and named, never broad and implicit.** A run
  reads the item its trigger is about, the chat window `conversationContext`
  already bounds, and whatever it asks for through the closed lookup catalogue
  ADR 0020 decides (`AgentLookup`, the shared search grammar, the bounded loop
  in `planFor`), so the tail grows by one named read rather than by every item
  that might be relevant.

**Rejected — attaching received and sent mail as standing context.** Beyond the
caching cost above, a run's context is also the one place untrusted content
enters a call at all (ADR 0003, "Content is data, never instruction"); a
mailbox attached wholesale multiplies how much of that content sits in front of
the model on every single run, almost all of it irrelevant to what that run is
about, for a benefit — "it might come up" — the targeted lookup above already
covers for the cases that actually do. Breadth of memory is bought with the
notebook's distillation, not with the size of what is attached raw.

**What building this cost, named.** Both halves are built. The head needed a
capability that writes the group's own documents — no entry of the catalogue
did, and the one that writes text (`file.write`) reaches the visible Files and
refuses the hidden app folder as a destination. The catalogue carries
`notebook.write` now: it writes a fact into `agent/notebook.json` in the group
account's hidden `gilbert` app folder, gated and fenced the way `file.write` is
(`server/src/agent/actions.ts`, `buildAction`). The tail is ADR 0020's bounded
lookup: the deciding call may answer with a kind and its parameter instead of
actions, the run reads the group's own mail and asks again. What this record
settles is where new context is allowed to go, so the implementation does not
have to re-derive it from the caching mechanics each time: distilled and
infrequent in the head, or named and narrow in the tail — never raw and
wholesale in either.

## What stays mandatory, and why it is not the same complexity

- **The capability allowlist**, chosen by area, stays mandatory: `ruleProblem`
  refuses an automation with none, since with none it could do nothing. This is
  the one boundary a run cannot cross regardless of what its prose says or what
  the mail it read tried to say (ADR 0003, "Content is data, never
  instruction") — an inbox is adversarial input by construction, and the
  allowlist is enforced by the check in `executor.ts`, not by the model's own
  restraint. Grouping the choice into areas shrinks how many things an
  administrator weighs; it does not shrink what any one automation ends up
  granted below what its job needs.
- **The group's review policy**, and it is the group's own document rather than
  a field on every automation: two choices — when a person has to agree, and
  whether a run may reach outside the group without one — and no number.
  `reviewOutcome` holds the floors a group's own choice cannot lower: an action
  that cannot be undone pauses for a person whatever the policy says, and one
  that reaches outside the group pauses unless the group has raised that floor on
  purpose (`consentRequired`, `irreversible`), so the policy decides only how
  cautious the *rest* of a run is, never whether sending mail asks first. One
  decision per group, made once, is the whole of what this costs an
  administrator; a group that has written none runs on the confident reading —
  an in-group action the model is sure of goes ahead, an unsure one stops for a
  person — with those floors holding whatever it says.
- **The prose**, in three places rather than one: the installation's own rules,
  the group's standing instruction, and the automation's own instruction. ADR
  0019 is where the three levels are decided; what this record adds is that none
  of them is a place a grant lives.

## What this does not change

`capabilities` still stores `AgentActionName[]`, exactly the granularity the
allowlist check asks about, and the area is metadata the catalogue carries for
the editor rather than a field of a document. `decideActions` narrows nothing by
area: it is handed the rule's grant, and it refuses an answer outside it. What
this record does change in the shape of a document is what it *removes* — the
filter, the author-written name, the per-automation review policy — and each of
those is ADR 0003's record to state, because that is where the rule shape is
written down.

## Consequences

- An administrator opening the Automations tab has a target automation count —
  the number of triggers the group's work actually needs, one to four — and a
  target number of grants to weigh — one to three areas plus, rarely, sending —
  instead of an open-ended count and a flat list of thirteen. Nothing else is
  asked for: no name, no filter, no per-automation policy, no cadence to invent.
- The fan-out (every enabled automation on a trigger runs, against everything
  that trigger produces) is why a second enabled automation on one trigger is
  refused rather than tolerated: it is decided in decision one, and the refusal
  reaches the save, the editor and the executor alike.
- Nothing marked `external` or `irreversible` in the catalogue can ever be
  granted as a side effect of ticking an area: the exclusion is computed from
  those two flags, not from a second list that could drift from them.
- The standing instruction (`agent/instruction.json`, ADR 0003) keeps its own
  job — facts true of the whole group, carried before any automation's
  instruction — and does not absorb one automation's logic; an automation that
  says "follow the group's standing instruction" and nothing else is a legal, if
  unhelpfully thin, instruction, since `ruleProblem` only asks that the field be
  non-empty.
- The fleet meter's own `inputHitTokens`/`inputMissTokens` split (Master, ADR
  0003) is what confirms decision three is working, rather than something to
  assume: a notebook that is edited too often to stay in the cached head, or a
  context path that widened past a named lookup back into something broad,
  shows up there as a miss rate that does not fall, not as a claim to take on
  faith.

## References

- ADR 0003 — the rule shape, `planFor` → `decideActions`, the allowlist, the
  review gate, the reading helper's propose-then-confirm shape, the notebook,
  the fixed prompt order and why it is cache-friendly, the standing
  instruction's place in it
- ADR 0019 — the three levels of prose an agent carries
- `server/src/agent/documents.ts` — `AGENT_TRIGGERS`, `AGENT_ACTION_SPECS` (the
  actions an area groups and the flags that keep one out of every area),
  `AgentArea`/`AGENT_AREAS`, `areaActions`, `standaloneActions`,
  `effectiveCapabilities`, `automationLabel`, `AgentGroupPolicyDoc`, `policyOf`,
  `AGENT_REVIEW_THRESHOLD`, `ruleProblem`, `rulesProblem`, `consentRequired`,
  `irreversible`, `reviewOutcome`, `agentRuleJsonSchema`'s `x-areas`
- `server/src/agent/executor.ts` — `emailRecords`/`fileRecords`, the fan-out
  every enabled automation on a trigger runs through; `rulesOrReport`, where a
  document carrying two is reported once; the allowlist check a chosen area
  cannot widen; `contextFor`, `lookupSlice` and the lookup readers, the named
  reads a run asks for
- `server/src/agentAdmin.ts` — `saveRules`, where the count is refused before
  anything is written; `runRuleNow`, which meets the same automation on the
  same terms
- `server/src/agent/llm.ts` — `decideActions`'s one call to an
  OpenAI-compatible endpoint, `proseHead`, the one builder of the prompt's
  stable head, and the `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`
  read the meter is built from
- `web/src/views/admin/agent/RuleForm.tsx` — the editor this decision is about:
  the trigger, the instruction and the areas, and the areas derived from the
  schema (`x-areas`) rather than listed in the client
- `web/src/views/admin/agent/GroupPolicy.tsx` — the group's policy, written
  once beside its standing instruction
