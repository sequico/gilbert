# ADR 0014 — The agents admin UI: three surfaces, and audit made visible

Status: Proposed (2026-09-12)

## Context

ADR 0003's *Admin surfaces* bullet promised one thing: an Agents section that
shows the Master and its groups, authors per-group rule documents, keeps the
group's standing instruction and its notebook of facts, defines the labels it
files with, configures the provider, and **reads agent status and audit across
groups**. What was actually built is two top-level admin sections that do not
match that promise or one another:

- **Master** (`AdminAgents.tsx`) carries the installation's identity and model
  — in scope — but also embeds the group's standing instruction and its
  notebook, each behind its **own** group picker, disconnected from the
  membership table above them and from each other. Three pickers answer one
  question on one page.
- **Group Agents** (`GroupAgents.tsx`) carries a fourth, separate group picker
  driving Automations, Approvals and the fleet — the pattern the other two
  should have used and did not.
- **Audit across groups**, promised in the same bullet, was never built: the
  only access to a group's trail is a per-row "download the month's JSON"
  button in Master's membership table. ADR 0010 goes further and states a
  standing decision this UI never implemented: *"The Group agents section
  carries a window on that group's own audit... instead of costing a download
  of a month's JSON to find out."* The member-facing chat panel
  (`GroupAgentPanel.tsx`) already renders exactly that window, from the same
  document — so today an ordinary group member sees more of what the agent did
  than an administrator does.
- **Defining the labels it files with** — `addAgentLabels`,
  `POST /admin/groups/:name/agent/labels` — has a server route and a client
  wrapper and is called from no component anywhere. Promised, built underneath,
  never wired.
- `schedule` (a scheduled rule's next due time) and `decisions` (the group's
  full decision history, not only the pending ones) are read into
  `AgentGroupSurface` on every group load and rendered nowhere.

None of this is a gap in what the fleet does. It is a gap between what ADR
0003 and ADR 0010 already decided the admin surfaces owe, and what the client
built. This record closes that gap and replaces the two-section split with a
three-section one that matches how an administrator actually asks about the
fleet: configure it once, author it per group, watch it across all of them.

## Decision

The agents admin area is **three sections**, not one and not the current two.
Nothing here changes a grant, a document shape, the one-model-per-installation
rule, or the executor. This is the surface layer only.

### 1. Master — the installation, configured once

Unchanged in substance from today's `AdminAgents.tsx`: the Master's identity
(address, operational state, the environment variables it comes from), the
one provider/model and its bounds (`AgentProviders`), and the plain list of
groups the Master's session reports — membership shown, never written. Nothing
group-specific lives here any more: this section is what a deployment sets up
once and rarely returns to.

### 2. Group Agents — the per-group workspace, one picker

Everything that is a fact about *one* group moves here, behind the single
group picker `GroupAgents.tsx` already has, as tabs of one workspace instead of
tabs plus two orphaned pickers elsewhere:

- **Automations** — `RuleEditor`/`RuleForm`, as today, with one addition: a
  rule whose trigger is `schedule` shows its next due time, read from
  `AgentGroupSurface.schedule` — already fetched, never rendered.
- **Standing instruction** — `GroupInstruction`, moved here verbatim, reading
  the group from the workspace's own picker instead of holding a second one.
- **Memory** — `GroupMemory`, moved here verbatim, same change.
- **Audit** — new: a window on `AgentGroupSurface.audit`, newest first, the
  same document and the same words (`outcomeText`, `formatListDate` from
  `agentText.ts`) the member panel already renders, reused rather than
  reimplemented. The monthly JSON export (`fetchAgentAuditExport`) is kept as
  an action inside this tab, not a stray button in a membership table.
- **Agents** — the fleet heartbeat table, as today (`Agents()` in
  `GroupAgents.tsx`): who is serving this group, and the grants it has lost.
  Kept named "Agents", per the product vocabulary (`gilbert-project`): these
  are the Master's agents, and this is the group-scoped list of them.

A small, previously-missing utility rides in this section too: a control that
calls `addAgentLabels` for the picked group, since the section that promised
"defines the labels it files with" is this one.

### 3. Approvals — cross-group oversight, and nothing else

A new top-level section, because "what is waiting on a person" and "what has
the fleet done" are cross-group questions by nature and today can only be
asked one group at a time.

- **Pending** (default tab): the existing queue (`fetchPendingApprovals`),
  shown across every group at once with a group column, instead of pre-filtered
  by whichever group happens to be picked. A badge on this section's nav entry
  carries the total pending count, read from the same store.
- **Audit** (second tab): the same per-group audit entries the Group Agents
  workspace reads, merged client-side across every granted group — no new
  server route, the data already comes back from `fetchAgentGroup` per group —
  filterable by group, rule and outcome.

**This section is read-only oversight, by construction, and stays that way.**
The code already enforces this — `AgentApprovals.tsx`'s own comment: *"there is
no Approve button here, and adding one would be the wrong gate — the chat is
where the conversation, the draft and the arbiter live."* ADR 0003 states the
same boundary: *"Members see, never change... The two member actions are
approving or rejecting a proposed action and addressing the Master, both
through the group chat."* An operator answers a paused run as a member, in the
group's chat, never through this admin surface. This record does not relax
that: it makes the existing oversight-only queue visible across every group
instead of one at a time, and adds an audit window beside it. No approve or
reject control is added here, now or as a natural next step — a future change
that wants one supersedes this record explicitly rather than drifting into it.

## What this record changes in ADR 0003

ADR 0003 keeps everything about the fleet itself: the Master's identity, the
claim and its lease, the review gate and consent floor, the audit and the
scheduler. What this record supersedes is the *Admin surfaces* bullet's
**shape** — one section on today's client became two that did not match its
own promise:

1. **"An Agents section"** (singular) becomes three named sections — Master,
   Group Agents, Approvals — because one section trying to answer
   "configure once" and "author per group" and "watch across groups" at once
   is exactly what produced the three-pickers-on-one-page defect this record
   fixes.
2. **"Keep the group's standing instruction and its notebook of facts"** move
   from Master to Group Agents, beside the rule documents they are grouped
   with in that same sentence — they were built under Master instead, which
   this record corrects rather than ratifies.
3. **"Define the labels it files with"** gains its first UI door
   (`addAgentLabels`, wired into Group Agents) — the bullet was never wrong,
   only unbuilt.
4. **"Read agent status and audit across groups"** gains the Approvals
   section's Audit tab — likewise promised, not built until now.

## What this record changes in ADR 0010

ADR 0010's automation model, its notebook, its metering and its prompt-order
constraints are untouched. What this record fulfils is the resolution
*"Where a group's automations are, its trail is too"*: the Group agents
section (renamed here to *Group Agents*, same concept) gains the audit window
that resolution already declared, reading the same bounded document the
member panel reads, as stated. Nothing about *what* is metered or audited
changes — only that an administrator can now read it without downloading a
file.

## Consequences

- Three nav entries replace two; `AdminAgents.tsx`/`GroupAgents.tsx` are
  restructured along section lines above, `GroupInstruction`/`GroupMemory`
  lose their own group `useState` and take the workspace's group as a prop —
  one picker, one source of truth, per the project's own SSOT rule.
- Every string moves or is added through `t()`; no new hardcoded UI copy.
- No server route is added. The Approvals section's Audit tab is a client-side
  merge over `fetchAgentGroup`, called once per granted group — bounded by how
  many groups the Master holds, the same cost the Group Agents workspace
  already pays per group it is asked about.
- Not in scope here, and deliberately not decided by this record: a dry-run/
  simulate mode for a rule, splitting `RuleForm` into a multi-step wizard, or
  per-field validation instead of one joined error string. These are
  implementation quality, not a surface decision, and can be improved without
  superseding anything.
- `FEATURES.md`'s Agents section is updated in the same change that ships this,
  per the standing rule that the inventory stays current.
