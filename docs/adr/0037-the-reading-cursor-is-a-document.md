# ADR 0037 — The reading cursor is a document

Status: Proposed

Implementation: Built. `server/src/agent/cursors.ts` — `readCursor`,
`writeCursor` and the `gilbert/cursors.json` document in each group's own app
folder, and the switched-off pass's own `gilbert/notices.json` — and
`server/src/agent/loop.ts`, which restores both on the first pass of a claim it
has just taken (`restoreCursor`, `restoreNotice`), writes each after a batch that
moved that reading (`saveCursor`, `saveNotice`), and says an unreadable one in the
pass's gaps without writing over it. The write hands back the state it produced
and the cursor takes it, so a quiet account writes nothing, and it verifies the
claim immediately before landing; `events.ts` counts both documents as the
agent's own, so writing one wakes no rule.

## Context

A pass reads each account's change log from where the last one ended, and the
cursor it keeps is the state the server answered for that read (ADR 0030, ADR
0032). A cursor that exists only in the loop's memory is a cursor that begins
each process by anchoring at the state the server holds **then**, which is not a
resumption but a fresh start: every change that arrived while the process was
down is never read, and never named as missed.

The process is disposable by law (`IMMUTABLE=1`, ADR 0027): a cursor in memory is
a cursor lost on every restart. The live symptom was a chat message that mentioned
the agent, produced no run, and left nothing behind that could answer why.

## Decision

**The cursor is a document, per account, in that account's own app folder** —
`gilbert/cursors.json`, beside the runs, the rules and the drop queue — carrying
the three states the reading ended at (`mail`, `files`, `calendar`), the paths it
learned for destroyed nodes (`seen`), and the instant of the read that produced it.
The switched-off pass keeps **its own** position in `gilbert/notices.json`, the
same shape: it answers the people who wrote and answers each once, and its
freshness rule is its own, so neither reader can destroy the other's position.

- **It is read on a process's first pass for that account** and taken as the
  cursor; a process that finds none anchors where the server stands, which is the
  first read of a group and the only time a window can be lost unseen. A claim
  this process has just taken is a fresh tenure: both positions are re-read then,
  because what the maps hold was read by the tenure before it.
- **It is written after a batch the pass answered**, and only when the reading
  moved: a quiet account writes nothing, so a cursor never becomes a heartbeat.
- **The claim is its authority.** The account's FileNode state cannot serve as
  this document's compare-and-set token — every run write of the same pass moves
  it, so a conditional write would lose on the state this process itself produced
  a moment earlier. The write verifies the claim immediately before it lands
  (`keepClaim` refuses a holder whose claim is not its own).
- **An unreadable document is a gap the pass says out loud**, and the reading
  anchors afresh — the same ending `cannotCalculateChanges` has. The document is
  left exactly as it is: the pass does not write over it, so what made it
  unreadable is still there for whoever looks. A cursor guessed at from a shape
  this build cannot read would be a window reported as ordinary.
- **`at` is part of the document**, stamped by the write itself rather than
  handed in by the caller, because the notice's freshness question ("a position
  nobody advanced for an hour") is that document's own age, and that age has to
  survive a restart for the answer to be the same one.

## Consequences

- A restart resumes instead of forgetting: a deployment no longer eats the mail,
  the chat messages and the file drops that arrived while the service was down,
  and a dropped window becomes a claim the installation can check rather than a
  silence.
- One more write per account per batch that moved, in Stalwart, where the runs
  already are; the cursor is small and is not rewritten when nothing moved.
- A cursor document is now something an operator can read to answer "what has the
  agent seen?", which is the question the live failure could not answer.
