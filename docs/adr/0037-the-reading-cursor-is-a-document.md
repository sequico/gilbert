# ADR 0037 — The reading cursor is a document

Status: Accepted

Implementation: Built. `server/src/agent/cursors.ts` — `readCursor`,
`writeCursor` and the `gilbert/cursors.json` document in each group's own app
folder — and `server/src/agent/loop.ts`, which restores it on a process's first
pass (`restoreCursor`), writes it after a batch that moved the reading
(`saveCursor`), and says an unreadable one in the pass's gaps. `events.ts` counts
the document as the agent's own, so writing it wakes no rule.

## Context

A pass reads each account's change log from where the last one ended, and the
cursor it keeps is the state the server answered for that read (ADR 0030, ADR
0032). It lived in the loop's memory and nowhere else. A restart — a deployment,
a crash, a container swapped under it — therefore began by anchoring at the state
the server held **then**, which is not a resumption but a fresh start: every
change that arrived while the process was down was never read, and never named as
missed.

The process is disposable by law (`IMMUTABLE=1`, ADR 0027): a cursor in memory is
a cursor lost on every restart, and the deployments of one afternoon were two.
The live symptom was a chat message that mentioned the agent, produced no run, and
left nothing behind that could answer why.

## Decision

**The cursor is a document, per account, in that account's own app folder** —
`gilbert/cursors.json`, beside the runs, the rules and the drop queue — carrying
the three states the reading ended at (`mail`, `files`, `calendar`), the paths it
learned for destroyed nodes (`seen`), and the instant of the read that produced it.

- **It is read on a process's first pass for that account** and taken as the
  cursor; a process that finds none anchors where the server stands, which is the
  first read of a group and the only time a window can be lost unseen.
- **It is written after a batch the pass answered**, and only when the reading
  moved: a quiet account writes nothing, so a cursor never becomes a heartbeat.
- **An unreadable document is a gap the pass says out loud**, and the reading
  anchors afresh — the same ending `cannotCalculateChanges` has. A cursor guessed
  at from a shape this build cannot read would be a window reported as ordinary.
- **`at` is part of the document** because the off path's freshness question
  ("a cursor nobody advanced for an hour") is the cursor's age, and that age has
  to survive a restart for the answer to be the same one.

## Consequences

- A restart resumes instead of forgetting: a deployment no longer eats the mail,
  the chat messages and the file drops that arrived while the service was down,
  and a dropped window becomes a claim the installation can check rather than a
  silence.
- One more write per account per batch that moved, in Stalwart, where the runs
  already are; the cursor is small and is not rewritten when nothing moved.
- A cursor document is now something an operator can read to answer "what has the
  agent seen?", which is the question the live failure could not answer.
