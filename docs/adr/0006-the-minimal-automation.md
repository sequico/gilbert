# ADR 0006 — The minimal automation

Status: Proposed

The surface this is about is **Admin → Group Agents → Automations** — the
editor that writes a group's rule documents. ADR 0003 gives a rule one shape —
trigger, prose instruction, capability allowlist, review policy — and nothing
in that shape requires an administrator to author more than the smallest
number of rules a group actually needs, or to read every one of the
catalogue's actions one at a time. The editor as it stands offers the other
extreme: a flat checklist of thirteen individually-named actions to weigh on
every rule, and nothing that says a group needs one rule per trigger rather
than one per business case. Neither is what the schema asks for. This record
names the minimum the schema already allows — one rule per trigger, three
grouped choices instead of thirteen, and a context a run reads without either
starving the model of what it needs or paying full price for what it does not
— so "does this need to be this complicated" has a written answer instead of
being re-litigated at every reading of the Automations tab.

**What is built, and what is only decided.** Decision one describes behaviour
the code already has, verified against `executor.ts` and `documents.ts` below:
it is a recipe, not a change. Decisions two and three are **not implemented** —
this record is the design they are built against, and a reader should take
their tense as the design's, never the tree's.

## Decision one — one automation per trigger, not per case

**A group authors one enabled automation per trigger it actually uses, not
one per case that trigger can produce.** `AGENT_TRIGGERS` is four values —
`email`, `filenode`, `chat`, `schedule` (`server/src/agent/documents.ts`) —
and four is also the practical ceiling on how many enabled automations a
well-run group needs, because the branching between cases belongs in the
instruction's prose, not in the document count. "When an email arrives, file
invoices under Accounting, archive newsletters, and leave anything else for a
person to read" is one rule with one broad instruction, not three narrow ones
— the model already resolves the branch, the same way it resolves everything
else `planFor` hands it (ADR 0003, "An automation is an instruction a model
carries out").

Two fields the form offers are optional exactly because the minimum does not
need them, and an administrator following this recipe leaves them alone:

- **The filter.** `RuleForm.tsx` renders the "If" section only when
  `rule.trigger.on === "email"` — a `chat`, `filenode` or `schedule` rule has
  no filter to write, in the form or in the document it saves. Even on an
  email trigger, **no filter at all is not a degraded rule**: `matchEmailFilter`
  answers true for an absent filter, and `filterProblems` has nothing to say
  about one. The form's own default is that absence — a condition emptied of
  its last key is dropped rather than written — so the recipe's answer is to
  leave the filter alone and let the instruction's prose carry whatever
  discrimination the group needs. An **empty group** is a different thing and
  is refused: `{operator, conditions: []}` matches everything or nothing
  depending on the operator, and `filterProblems` will not have it.
- **The count of rules on one trigger.** Nothing stops two enabled rules from
  sharing a trigger, and for `email` that is sometimes right — two filters
  aimed at two disjoint slices of mail are two rules by construction, because
  a filter is what tells them apart. For `chat`, `filenode` and `schedule`,
  which carry no filter, this is never right: `fileRecords` in `executor.ts`
  runs `for (const rule of chatRules) await this.startJob(...)` over **every**
  enabled rule on the trigger against **every** item that trigger produces —
  every message that addresses the agent, every file node, every due instant —
  and the three paths fan out identically. Two enabled chat rules do not
  divide the work between them; both answer the same mention, and a member
  reads two replies to one question. The minimal recipe is therefore also the
  only correct one on these three triggers: at most one enabled automation
  each.

## Decision two — three areas, and the two entries that stand alone

The catalogue stays what it is: `AgentRule.capabilities` holds the same
`AgentActionName[]` it always has, and nothing is removed from
`AGENT_ACTION_SPECS` (`server/src/agent/documents.ts`). What changes is what an
administrator looks at while choosing: **three areas, one checkbox each,
instead of eleven individually-named actions** — and all thirteen of the
catalogue's actions are accounted for, none of them silently.

| Area | Expands to | What it is |
|---|---|---|
| **Mail** | `keyword.add`, `keyword.remove`, `mail.move`, `mail.extract`, `mail.draft` | organizes mail inside the group; nothing it does leaves the account |
| **Chat** | `chat.post` | writes in the group's own chat |
| **Files and documents** | `file.write`, `document.read`, `document.split`, `document.merge`, `document.extract` | writes and reshapes the group's own Files |

**Two entries stand beside the areas rather than inside one**, and they are
two different kinds of exception:

- **`mail.send` stays its own checkbox**, on principle rather than by a list
  kept in sync by hand: it is the one entry in `AGENT_ACTION_SPECS` marked both
  `external` and `irreversible`. The rule is general, not a special case pinned
  to today's one dangerous action — an area's expansion is built by excluding
  whatever the catalogue marks `external` or `irreversible`, so a future action
  carrying either flag is excluded from every area the same way, without this
  table needing to be revisited. Ticking "Mail" can never be how a person
  grants sending; only the sending entry can.
- **`noop` gets no area either, and keeps its own entry**, because it is not a
  behaviour: it is the answer "record the decision and change nothing", and an
  area is a group of *things a run does*. It has to stay reachable, because a
  run may only answer with an action its rule allows: a rule that does not
  grant `noop` cannot have a run decide that nothing should happen. Leaving it
  out of the editor would be a behaviour change smuggled in as a layout — the
  exact thing this record refuses elsewhere.

This is a UI grouping, not a new document shape: when it is built,
`AGENT_ACTION_SPECS` gains one optional tag per entry (which area it belongs
to, absent for anything that stands alone) for `RuleForm.tsx` to group by.
`AgentRule` on disk is unchanged, so an existing rule's `capabilities` array
reads exactly as it always did, and nothing about `decideActions` or the
allowlist check in `executor.ts` moves. A rule authored before this decision
and one authored after it are the same document; only the editor that writes
`capabilities` changes, grouping eleven of the thirteen checkboxes into three
toggles and leaving `mail.send` and `noop` to answer for themselves.

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
  already bounds, and — when a request names one — the one file or message it
  names, fetched by a targeted search rather than attached wholesale. This is
  the same shape `folderRequest`/`folderSlice` already give a chat run that
  asks for a named folder, generalized to a named email or document rather
  than invented fresh: the tail grows by one matched item, not by every item
  that might be relevant.

**Rejected — attaching received and sent mail as standing context.** Beyond the
caching cost above, a run's context is also the one place untrusted content
enters a call at all (ADR 0003, "Content is data, never instruction"); a
mailbox attached wholesale multiplies how much of that content sits in front of
the model on every single run, almost all of it irrelevant to what that run is
about, for a benefit — "it might come up" — the targeted lookup above already
covers for the cases that actually do. Breadth of memory is bought with the
notebook's distillation, not with the size of what is attached raw.

**What building this costs, named.** Neither half of decision three exists
yet, and the first half needs something this installation does not have: **no
capability in `AGENT_ACTION_SPECS` writes a group's own documents.** The
notebook is `agent/notebook.json` in the group account's hidden `gilbert` app
folder, and the one action that writes text — `file.write` — reaches the
visible Files and refuses that folder as a destination
(`writeBytesIntoVisibleFolder`, `server/src/agent/actions.ts`). ADR 0003's own
rule is that a behaviour is an action in the library, so the follow-up includes
**adding one** (a `notebook.write`, gated and fenced the way `file.write` is);
the second half is the narrower change: an extension of `contextFor`'s named
lookup to an email or a document, beside the folder lookup that exists. Nothing
in this record changes `contextFor` or `llm.ts`; what it settles is where new
context is allowed to go, so the implementation does not have to re-derive it
from the caching mechanics each time: distilled and infrequent in the head, or
named and narrow in the tail — never raw and wholesale in either.

## What stays mandatory, and why it is not the same complexity

- **The capability allowlist**, chosen by area once decision two is built,
  stays mandatory: `ruleProblem` refuses a rule with none, since with none it
  could do nothing. This is the one boundary a run cannot cross regardless of
  what its prose says or what the mail it read tried to say (ADR 0003, "Content
  is data, never instruction") — an inbox is adversarial input by
  construction, and the allowlist is enforced by `decideActions` in code, not
  by the model's own restraint. Grouping the choice into areas shrinks how many
  things an administrator weighs; it does not shrink what any one rule ends up
  granted below what its job needs.
- **The review policy.** One choice — `always`, `threshold`, `never` — plus a
  number when the mode asks for one. `reviewOutcome` already holds the floor a
  rule's own choice cannot lower: an external or irreversible action pauses for
  a person whatever the mode says (`consentRequired`, `irreversible`), so the
  dropdown decides only how cautious the *rest* of the run is, never whether
  sending mail asks first. One decision per rule, made once, is the whole of
  what this costs an administrator.

## What this does not change

No field is added to or removed from `AgentRule`, `AgentTrigger`, `AgentReview`
or `AgentAction`; `capabilities` still stores `AgentActionName[]`, exactly the
granularity `decideActions` checks against; no branch of `executor.ts` changes.
The area tag decision two adds to `AGENT_ACTION_SPECS` is metadata the
catalogue would carry for the editor, not a new kind of document, and existing
rules need no migration — they already hold the action names an area merely
groups.

## Consequences

- An administrator opening the Automations tab has a target rule count —
  roughly the number of triggers the group's work actually needs, one to four
  — and a target number of grants to weigh per rule — one to three areas plus,
  rarely, sending — instead of an open-ended rule count and a flat list of
  thirteen.
- The chat/file-node/schedule fan-out (every enabled rule on the trigger runs,
  unfiltered) is a documented reason a second rule on one of these triggers is
  a mistake to catch at authoring time, not a latent duplicate-reply bug
  discovered in a group's chat. Guarding it in the admin surface — refusing or
  warning on a second enabled rule sharing one of these three triggers — is a
  follow-up this record does not itself implement.
- Nothing marked `external` or `irreversible` in the catalogue can ever be
  granted as a side effect of ticking an area: the exclusion is computed from
  those two flags, not from a second list that could drift from them.
- The standing instruction (`agent/instruction.json`, ADR 0003) keeps its own
  job — facts true of the whole group, prepended before any rule's instruction
  — and does not absorb a rule's per-trigger logic; a rule that says "follow
  the group's standing instruction" and nothing else is a legal, if
  unhelpfully thin, instruction, since `ruleProblem` only asks that the field
  be non-empty.
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
- `server/src/agent/documents.ts` — `AGENT_TRIGGERS`, `AGENT_ACTION_SPECS` (the
  thirteen actions an area groups), `ruleProblem`, `filterProblems`,
  `matchEmailFilter`, `consentRequired`, `irreversible`, `reviewOutcome`
- `server/src/agent/executor.ts` — `fileRecords`, the unfiltered fan-out over
  every enabled rule on a `chat`, `filenode` or `schedule` trigger;
  `decideActions`, the allowlist check a chosen area cannot widen;
  `contextFor`, `folderRequest`/`folderSlice`, the pattern a named-item lookup
  generalizes
- `server/src/agent/llm.ts` — `decideActions`'s one call to an
  OpenAI-compatible endpoint, the fixed system-prompt assembly order,
  `usageOf`'s `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` read
- `web/src/views/admin/agent/RuleForm.tsx` — the editor this decision is
  about: the filter section gated on `rule.trigger.on === "email"`, the flat
  checklist of thirteen actions that decision two would group into areas, the
  `external`/`irreversible` tags shown beside an action, and the review mode
  selector
