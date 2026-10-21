# Plan — implementing ADR 0038, and removing what it replaces

Status: proposed. Every unit below lands on its own, and each says what it
**adds**, what it **deletes**, and what **proves** it. A unit is not done while
the thing it replaced is still in the tree: this plan is as much a removal as an
addition.

The gate is the project's own (`npm run check:ci`) at every push, and the
measurement of ADR 0038 is the eval set — *task accepted* and *cost in calls and
refusals* — run on the mock after the units that touch tools, the loop and the
prompt.

## 0 — The measure, before anything changes

- **Add** `scripts/agent-eval.mjs` (or `server/src/agent/eval/`): 15–20 tasks from
  the 171 run documents — the message, the promise, the outcome a person accepts —
  run against the mock, reporting per task: accepted (yes/no), calls, refused
  calls, milliseconds.
- **Delete** nothing.
- **Prove** the harness itself: the same set on today's tree must reproduce the
  measured classes (a task that hallucinates `mail.search`, a task that ends
  `done` after a refusal), or the set is not a measure.
- **Baseline** is written into the plan's own commit message, not into a doc: the
  numbers a later unit must beat.

## 1 — One instruction per group (replaces ADR 0031)

- **Add** `shared/instruction.ts` extended to carry the areas and the grants:
  `{ text, areas[], grants{ surfaces, classes, drafts } }`; the admin surface
  becomes **Instruction** (one field) plus **Grants** (the matrix).
- **Delete** `agent/rule.ts`, `agent/rules.ts`, `shared/rule.ts`, the `rules/`
  folder and its documents, `ruleApplies`, `mentionRoute`, `candidates`,
  `decision.rules`, `NO_RULE_NOTICE`'s per-surface branching, the Rules panel in
  Administration, and every test that pins a rule's shape.
- **Migrate** the live `rules/*.json` of an installation into one instruction (a
  one-shot reader that writes the instruction and archives the folder), and the
  legacy `agent/rules.json` with it.
- **Prove** a group with one instruction answers a chat mention and a mail; a
  group with none is told so once; `grep -r "ruleApplies\|rules/" server/src` is
  empty.

## 2 — The areas are modules, and a run's catalogue is a selection

- **Add** `agent/areas.ts`: one module per area (mail, files, calendar, contacts,
  knowledge, workorders, chat, memory), each exporting its tools and nothing of
  another area's; `selectAreas(instruction, change)` returning the areas of the
  change plus the instruction's, plus chat, knowledge and memory.
- **Delete** the single `TOOLS` array as the loop's catalogue and the
  `READING_TOOLS` half as a second one: `runTool` takes the selection.
- **Prove** a run started by a mail sees no calendar or workorder tool; an
  instruction declaring three areas sees three; declaring four is refused at save.

## 3 — Tools shaped by the work (replaces the 45 endpoint tools)

- **Add** `mail.triage`, `mail.reply` (draft), `mail.search`, `mail.read`,
  `files.search`, `files.read`, `files.write`, `files.remove`,
  `calendar.find/read/schedule/cancel`, `workorder.list/read/settle`,
  `knowledge.search/read/write`, `memory.remember/list`,
  `chat.say/ask/find/read`, `tool.describe`.
- **Delete** the endpoint catalogue: `mail.find/read/readAttachment/file/trash/
  untrash/keyword/draftReply/editDraft/send`, `files.list/read/write/save/
  overwrite/delete/folder/move/rename`, `calendar.list/read/create/update/delete`,
  `contacts.*`, `knowledge.list/read/page`, `workorder.step`, and the tests that
  pin them one by one.
- **Prove** the eval set: the tasks the old catalogue failed (mail + attachments
  filed; a reply drafted) now succeed at fewer calls; a refused call names the
  catalogue's real names.
- **Rule** for the unit: a tool that no eval task and no instruction needs is not
  written.

## 4 — The change is the trigger (replaces the poll)

- **Add** the stream as the only clock: on a StateChange, read that type's changes
  once from the cursor and compose one run per change; the supervisor keeps no
  cadence for the loop.
- **Delete** `AGENT_PASS_INTERVAL_MS` as the loop's beat, `AGENT_PASS_INTERVAL_
  WITH_WAKE_MS`, the 10/30-second distinction, the pass as the unit of "the agent
  worked", and the `slow pass` line (a run's own lines are the progress now).
- **Keep** the cursor as reconciliation (ADR 0037), the dated timers for a
  question's deadline, and the claim (ADR 0032).
- **Prove** a chat message opens a run within seconds with the loop idle otherwise;
  a stopped stream loses nothing (the reconciliation read finds it); a quiet
  installation writes no line and makes no call.

## 5 — Three beats, and a plan only when told

- **Add** the beats to `workRun`: read, act, report; the report is always the last
  step; a run ends on its report whatever budget is left.
- **Delete** the free-form plan as the normal path: the wave and readiness
  machinery stay for the plan case only, `RUN_STEPS_MAX` stops being a per-run
  plan ceiling for workflow runs, and the "plan bigger than the room" refusal
  disappears with them.
- **Prove** a mail run has exactly three steps in its document; the plan case
  (one instruction that asks for one) still works; the eval's cost per task drops.

## 6 — What leaves is a draft (replaces the send licence)

- **Add** the draft as `mail.reply`'s only outcome, its id on the run's ending and
  evidence; the surface shows the draft and a person sends it.
- **Delete** `mail.send` and every `sends` field the model reads: `startedBy.sends`
  is read by the loop's guard, never rendered in a prompt; `mail.draftReply` and
  `mail.editDraft` merge into `mail.reply`.
- **Prove** no run can submit; the eval's reply task ends with a draft and no
  message in the account's sent box.

## 7 — The ending is judged, and a guardrail trip has its own ending

- **Add** the judge call (ask + plan + evidence → covers / names the gap), the
  `refused` ending in `shared/run.ts` and its label, and the tool-answer filter
  (credential, key, session token removed before the turn sees it).
- **Delete** the unconditional `done`: a `done` with no evidence is refused
  without a call.
- **Prove** the two runs quoted in ADR 0038 (`b5d2a714`, `410a8e4f`) replayed from
  the corpus do not end `done`; a document carrying a pasted password is not
  returned to the turn whole.

## 8 — Secrets outside every readable document

- **Add** the provider's key and the agent's credential read from the process
  environment at boot (a systemd `EnvironmentFile` on a deployment), and the
  filter of unit 7 as the second line.
- **Delete** `agent.provider.apiKey` from `installation.json` and every reader and
  writer of it; the admin field becomes a write-only secret that never returns.
- **Prove** the installation document holds no key; a run cannot read one; the
  admin save still replaces the key.

## 9 — The surfaces say the new words

- **Add** Instruction + Grants in Administration, the areas and the beats in the run
  card, the draft on the run, `Runs in flight` with the opening line and the plan
  (already built, kept).
- **Delete** the Rules list, the rule editor, the `mentionRoute` explanation in the
  UI, and every string that speaks of "rules" where the product now says
  "instruction" — the i18n catalogs with them.
- **Prove** no screen shows a rule; a person edits the instruction and the next
  change follows it.

## 10 — The documents follow the tree

- **Add** `FEATURES.md`'s agent section rewritten for areas, instruction and beats;
  the ADR index with 0038 `Accepted` once the owner accepts it; `docs/upstream.md`
  dispositions untouched.
- **Delete** from `FEATURES.md` and `README.md` every sentence describing rules,
  the 45 tools, the poll, the plan as the normal path and the send licence; the
  legacy `agent/rules.json` reader; the migration code of unit 1 once the
  installation has run it.
- **Prove** a grep for `rule` in the public docs finds only the word in its
  ordinary sense, and no document claims a mechanism the tree no longer has.

## Order and the first day

0 → 1 → 2 → 3 is the spine: measure, one instruction, areas, job tools. 4 and 5
are the loop; 6, 7, 8 are the safety; 9 and 10 are the surfaces and the prose.

The eval set of unit 0 is the gate the other units answer to; without it, the
first four units are a rewrite with no score, which is how the last four months
went.
