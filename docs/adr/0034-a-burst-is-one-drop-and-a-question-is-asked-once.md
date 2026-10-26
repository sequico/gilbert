# ADR 0034 — A burst is one drop, and a question is asked once

Status: Accepted

Implementation: Partly built.
The queue is `server/src/agent/queue.ts`, one document
`gilbert/pending.json` in the group's own app folder, noted by the pass
(`server/src/agent/changes.ts`) and answered by it when the folder has been
quiet for `DROP_QUIET_MS` or the drop has been open for `DROP_CAP_MS`; the
event that stands for a drop carries the folder, its files and the instant it
opened (`server/src/agent/accountEvent.ts`), and the decision turn is shown the
files (`server/src/agent/prompt.ts`). A drop of one file is read before the
decision turn (`readEventFile`, `server/src/agent/loop.ts`), and a file turn
gets two lookups rather than four (`server/src/agent/changes.ts`). The run a drop
opens carries the files it answers (`startedBy.batch`, `server/src/shared/run.ts`),
so its plan reads the names instead of listing the folder again. A folder that
appears is not a document, and a removal whose path is unknown wakes no rule
(`server/src/agent/events.ts`). A run is shown the questions the group already
has open, and `say` with `ask` does not post a question an open run already waits on
(`server/src/agent/tools/chat.ts`). A page's transcription is remembered by the
content of its bytes, and an identifier a model cannot read is asked for as
`(unclear)` (`server/src/agent/model.ts`). The decision turn's calls are counted
on the run it opens, and a run's end is stamped when it ends
(`server/src/agent/loop.ts`). The Work panel shows steps taken and failed steps
as the two tallies they are (`web/src/views/admin/agents/AgentOverview.tsx`).
**Not built:** the mail drop. A message is still its own change and its own run —
`changes.ts` folds a folder's files, not a case's mail. The case's scratchpad is built:
`agent/case.ts` keeps `gilbert/cases/<key>.md`, the `note` tool writes it under the key
the group's report calls the case, the run records that key (`RunDoc.caseKey`), and the
turn reads the note and lists the keys already on file. Folding a burst of mail into
one case is a group's own choice, named in `ROADMAP.md`.

## Context

A delivery pack arrives as one mail whose attachments a person saves into a
folder in Files. Stalwart reports one `FileNode` change per file, and the agent
answered each as a change of its own: the live run of 2026-10-20 answered a
seven-file drop with thirteen chat messages over forty minutes, one per file,
each re-reading the same documents and re-asking the same booking question.
The morning cost 25 runs, at least 188 model calls and a four-page transcript
for one delivery, and the same scanned weighbridge ticket — transcribed afresh
by the model every time — yielded five different booking numbers, each reported
as a fact.

## Decision

**A drop is a change.** A file landing in a folder is noted against that folder
and not answered on its own. The folder is answered once, when it has been quiet
for five minutes or when the drop has been open for twenty, as **one** change
that names the folder, the files and the instant it opened; one decision, one
run, one report. The queue is a document in the group's own app folder, so a
process that dies between passes resumes the same drop, and the run's key — the
folder and the instant the drop opened — makes a retry the same run rather than
a second one.

**A drop of mail is the same change when the group reports per drop.** A message is
then noted against the **case it names** — the key the report itself uses, the case
note below — and answered once, when that case's changes have been quiet for the same
five minutes or the burst has been open for twenty: one change names the messages and
the instant, one decision, one run, one report. The key is the case's and never the
transport's: two unrelated matters from one correspondent are two cases. A group whose
instruction reports per change needs no queue at all — each change is its own
increment, and the case's note keeps the reports from repeating. A reply that answers
a message joins the case through its thread.

**The case keeps a scratchpad.** A run's working memory is a note under the agent's
own bookkeeping (`gilbert/cases/<key>.md`), written and rewritten by the model and
carried whole in every turn of the case, in the order a turn reads it: the key the
report calls the case, the place the work goes, the rule the change needed, what the
last report said and when, and what is still owed. The turn lists the keys already on
file, so a run recognises a case it has seen without a lookup. What must outlive the
case is a fact in the memory (ADR 0033), not a longer note. The note is what makes the
second message of a delivery cheap and what a later change of the same case finds.

**Only documents are changes.** A folder that appears is not a delivery, and a
removal whose path is no longer known is not actionable: neither wakes an agent.

**A question is asked once.** The plan turn is shown the questions the group
already has open, from the runs parked on a person, and `say` with `ask` refuses to
post a question an open run already waits on: it answers with the open
question's message, and the run that would have asked continues.

**A page read is the page's reading.** A transcription is remembered by the
content of its bytes for the life of the process, so the same scan answers the
same words to every run, and an identifier the model cannot read is transcribed
as `(unclear)` rather than guessed.

**The panel tells the truth.** The decision turn's calls are counted on the run
its opens; a run's end is stamped when it ends rather than when the pass began;
and the two tallies — the steps a run spent and the plan entries that failed —
are labelled as what they are.

## Consequences

A report of a drop arrives five to twenty minutes after the first file, not
immediately: the quiet window is what makes the pack one report, and the cap
bounds the wait. A drop that straddles a process restart is resumed from the
queue rather than lost. A second drop in the same folder the same day is a
second run, because the instant the drop opened is part of its key.

A question parked in its own run is a question the conversation already holds;
the mechanism prevents a second copy, it does not close the first.

The queue is the agent's own bookkeeping under `gilbert/`, and is filtered from
the change reading like the runs and the instruction: it is not activity a person
caused.
