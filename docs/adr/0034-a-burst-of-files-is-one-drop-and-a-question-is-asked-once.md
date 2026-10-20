# ADR 0034 — A burst of files is one drop, and a question is asked once

Status: Accepted

Implementation: Built.
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
has open, and `chat.ask` does not post a question an open run already waits on
(`server/src/agent/tools/chat.ts`). A page's transcription is remembered by the
content of its bytes, and an identifier a model cannot read is asked for as
`(unclear)` (`server/src/agent/model.ts`). The decision turn's calls are counted
on the run it opens, and a run's end is stamped when it ends
(`server/src/agent/loop.ts`). The Work panel shows steps taken and failed steps
as the two tallies they are (`web/src/views/admin/agents/AgentOverview.tsx`).

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

**Only documents are changes.** A folder that appears is not a delivery, and a
removal whose path is no longer known is not actionable: neither wakes a rule.

**A question is asked once.** The plan turn is shown the questions the group
already has open, from the runs parked on a person, and `chat.ask` refuses to
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

A question asked before this record's change was parked in its own run remains
parked; the mechanism prevents a second copy, it does not close the first.

The queue is the agent's own bookkeeping under `gilbert/`, and is filtered from
the change reading like the runs and the rules: it is not activity a person
caused.
