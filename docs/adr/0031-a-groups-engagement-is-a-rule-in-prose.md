# ADR 0031 — A group's engagement is a rule in prose

Status: Accepted

Implementation: Partly built.
`server/src/agent/rule.ts` — the shape, the parser and the test of what wakes a
rule — and `server/src/agent/rules.ts` is where they live, under `rules/` in the
group's own account (ADR 0004), read, created, listed and replaced under the
account's own compare-and-set. The surfaces and their three modes are one
definition, `server/src/shared/surfaces.ts`, read by the parser, the
Administration editor and the guard. A run carries the matrix its rule had when
it opened (`startedBy.surfaces`, `server/src/shared/run.ts`), every writing tool
names the surface it touches (`ToolSpec.surface`,
`server/src/agent/tools/define.ts`), and the guard refuses a write on a surface
the run keeps `off` with the code `surface_off` (`runTool`,
`server/src/agent/tools.ts`), before the authority class is asked. A v1 rule is
read as the matrix it means and is written as v2 on the next save. The calendar
**surface** is in the matrix and its writes are enforced, and the calendar
**change log** wakes it: `CalendarEvent/changes` is read with its own cursor
beside mail and Files (`server/src/agent/events.ts`, one page of each log in one
request), an event written in the group's account is reported on the `calendar`
surface named by its own id — which is what `calendar.read` takes — and the
agent's own create, change and removal leave a mark the reading takes
(`tools/calendar.ts`, `takeOwnCalendarChange`) so a rule never wakes on its own
write. The mail surface wakes on an **arrival** and on nothing else: the reading
names a mail event for a created message that is in the account's Inbox and for
no other mail change (`arrivalsOf`, `server/src/agent/events.ts`), so a message
that was read, marked, filed or removed wakes no rule, and neither does a draft
the group saved or a message it sent. The builder of the prose the agent carries is
`server/src/agent/prose.ts`, in the record's own order. A run records
the rule or the instruction that started it (`server/src/shared/run.ts`,
`RunStart`), the tools a rule's instruction is carried out with are
`server/src/agent/tools.ts`, and the loop that carries it out is
`server/src/agent/loop.ts`: a change is put to the decision turn once, the turn
answers with **every** rule that fits it, and each one opens or continues **its
own** run named by the change it answered — a run whose `startedBy` already names
that rule and that change is the change being worked, or the answer it already
has, so a pass that re-reads a change it did not finish does not work it twice.
Every call carries all three levels of prose: the installation's own line is
`agent.instruction` in the installation's document, read at the boot
(`InstallationAgentSection`); the group's standing instruction is
`instruction.json` in the group's own account, whose shape, parser and address
are `server/src/shared/instruction.ts` and whose reader is
`server/src/agent/instruction.ts`, read once per pass so an edit is in force at
the next one; the rule's own instruction is re-read for each turn of its run. An
**installation administrator** decides both documents, from the rules launcher in
Administration → AI Agents → Prose
(`web/src/views/admin/agents/GroupRules.tsx`), through the administration's own
route (`/api/admin/groups/<name>/prose`, `server/src/routes/agent.ts`), which
writes as the Master behind `requireAdmin` — the boundary is the door, not a
hidden button (owner decision 2026-10-18). Each document is validated by the
server's parser before it is filed, and every write carries the account state the
read answered, so one that lost a race is refused rather than overwriting another
administrator's edit. The installation's line is edited beside its model in
Administration → Installation and read at every pass, so an edit is in force at the
next one.

## Context

A group's work has patterns: a message from a shipper means an answer is owed; a
set of container documents means a folder and a filing; a booking confirmation
means a step of its workorder is now done. Those patterns are the group's own
and they change, and a product that compiled them into features would need a
release for every group that works a little differently (ADR 0027).

What a group can always do is write: a sentence saying what it watches and what
should happen. What the product owes is a place to write it and an agent that
reads it.

## Decision

**One rule is one document, in the group's own account**, and it says two things:
**a surface matrix** — one mode for each of the group's six surfaces the agent
works on (ADR 0027): its **chat**, its **mail** (what arrives in its Inbox),
its **KB** (a page written, a checklist template changed), its **workorders** (a
step settled, a workorder opened or closed), its **Files**, and its **calendar** —
and **in prose, what should happen** when the rule is woken.

- **Three modes.** `watch`: the surface wakes the rule, and the run that wake
  opens may write it. `ondemand`: the surface never wakes the rule; a run already
  open — from chat, from mail, from another watched surface — may write it.
  `off`: no wake and no write; reading stays free, because a reading is proof and
  not an act. There is deliberately no "wake but do not write": a rule that is
  woken acts, and one that may act on a surface it does not watch is called on
  demand.
- **Chat is always `watch`.** The conversation is where the group calls the agent
  and where its report is written; the matrix's type and its parser refuse a
  document with chat off, and the editor does not offer it.
- **The matrix is the rule's, and the run carries it.** A run records the matrix
  its rule had when it opened, so an edit of the rule does not move the
  permissions of a run already in flight; a run written before the matrix may
  write where it did before.
- **The matrix is enforced on writes, never on reads.** The guard refuses a write
  on a surface the run keeps `off` (code `surface_off`); a reading of that
  surface is still allowed, because it is evidence and not an act.
- **A mode is a scope, not an authority class.** The classes (ADR 0028) still
  decide whether an act needs a person's word, and `sends` is still the outward
  power. The matrix says *where* a run may act, never *what* it may do there.
- **The agent's own acts wake nothing.** A message it sent, filed or marked, a
  message it posted in the chat, and a document it wrote in its own app folder
  are the agent acting, not the group's activity: the server reports every write
  to a message as a change of that message, so a rule woken by the filing its own
  run just made would answer the same mail a second time. A send and a draft are
  creates outside the Inbox, and a filing or a mark is a change of a message
  rather than an arrival; the bullet below is the rule that keeps both out.
- **Mail wakes a rule on an arrival, and on nothing else.** The mail server
  reports every change of a message — read, flagged, filed, removed — as a change
  of that message, and a rule woken by them would work the group's own handling
  of its mail rather than mail it was asked to answer. So a mail event is a
  message that was **created and is in the account's Inbox**: reading, marking,
  filing and removing wake nothing, and neither does a draft a member saved or a
  message the group sent, which are creates in Drafts and Sent Items. A message
  that has left the Inbox has been handled by somebody, which is the whole of what
  this rule is for: a person who reads and files a message has processed it
  already, and the agent is not needed for mail a human has put away
  (`server/src/agent/events.ts`, `arrivalsOf`). A server-side filter that files a
  message on delivery is the same act done automatically — the group's own rule,
  carried out before the agent ever sees the message.
- The prose is the instruction. Nothing about a rule is compiled, and the matrix
  is not a list of actions: what bounds an act is the authority classes (ADR
  0028), not the rule.
- **A rule may declare that it sends.** That is the one power a rule carries of
  its own (ADR 0028 class 3), and it is written in the rule itself, where its
  owner reads it.
- **The prose that reaches the model has three levels**, outermost first: the
  **installation's own line** (one document in the Master's account, carried
  into every call), the **group's standing instruction** (in the group's
  account), and the **rule's own instruction** (in the rule). One builder
  produces that order for every caller, so what the agent is told is one thing
  however it was reached.
- **Several rules may answer one change, and every one that applies runs.** Two
  rules a group wrote over the same activity are both the group's decision, so
  neither is set aside for the other: the model names **every** rule that fits
  the change, and each one opens or continues its own run. A change no rule
  covers is answered with no rule at all, and that is not an error either — a
  rule that did not apply has not failed.
- **A rule belongs to the group that wrote it**, like everything else the group
  owns, and **an installation administrator decides it** (owner decision
  2026-10-18): a member reads it, and changing it is the administrator's act,
  through the administration's route — the group's account grants still let a
  member write the file, so the door is what makes the decision administrative.
- **An instruction from a person is a plan, not a rule** (ADR 0027, ADR 0029):
  a rule is what a group decided in advance, and a sentence in the chat or in
  the mail is what it decided now. **A mention is that sentence's address**: a
  message in the conversation that names the agent opens **exactly one** run —
  the rule the decision turn names among those that watch the conversation, or
  the first of them when it names none — because one address is one answer and a
  group with three chat rules must not answer the same sentence three times. The
  decision turn names **which** rule answers a mention, never how many runs it
  opens. A mention no rule covers is answered with that fact rather than left in
  silence, and a mention whose change became no decision is told the agent found
  nothing to do. The decision turn still chooses among every other change, and
  where it names rules for a change that is not a mention its routing stands.

## Consequences

- A group's practice is written, read and corrected in prose, and the agent's
  behaviour stays reviewable by the people it works for.
- The rules are the group's documents, so they follow the group: a member added
  later reads them, and the agent reads them with the group's own access.
- Prose that does not say what it means is the failure mode, not a missing
  feature: a rule whose instruction is vague makes the agent vague, and that is
  visible to whoever owns it.
- The matrix is a scope an administrator administers, not a permission: it says
  where a run may act, while the authority classes keep deciding what needs a
  person's word. A rule migrated from v1 keeps the reach it had (`ondemand` on
  the surfaces it did not watch), so the administrator reviews it; a surface set
  `off` refuses a write even with a person's word until the rule is edited.
- A group that wants its files reported sets Files to `watch`; one that wants
  silence leaves it `ondemand`, and the agent still fixes files when a chat or
  mail run calls on them. Chat `watch` means every rule hears the conversation:
  a group with one rule reads one decision per message.
- The calendar row governs writes now; waking on calendar changes waits on the
  source the implementation line names as owed.
