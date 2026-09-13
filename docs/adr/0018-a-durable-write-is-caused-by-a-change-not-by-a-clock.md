# ADR 0018 — A durable write is caused by a change, not by a clock

Status: Proposed

## Context

Every durable byte lives in Stalwart (ADR 0001), and a document is stored as a
blob. An account is charged for the blobs it uploads against a finite upload
quota (1000 files or 50 MB on the servers this is deployed against), and JMAP
offers no way to remove one: a blob that is no longer referenced is not a blob
that has been given back. A write is therefore not only work — it is a
permanent expenditure of the account's budget, counted in documents rather than
in size.

A write on a clock spends that budget on nothing. A worker record and a claim
written on every heartbeat, for one group at the default thirty seconds, are
some 8,600 uploads a day — the account's quota gone in under three hours of
idle running. A sessions document writing itself once a minute for as long as
anybody is signed in is the same quota gone in about a day. Neither is work:
both say that a process is alive, or that somebody has used a session
recently, and neither fact needs to be durable to be true. The symptom is not
a slow leak but a wall: once an account is past its quota, *every* write in it
fails, so the next person to save an instruction meets an error about uploads.

## Decision

**No durable write is caused by time passing.** Every write has a reason in the
work: a document changed, a claim was taken or released, a session began or
ended. What a clock would have written is held in the process instead.

- **Liveness is a process fact.** The agent's claims are a fence: written when
  taken and when released, and free to hold. A worker's record says what a
  worker is doing and is written when that changes. The fleet surface reads
  aliveness from `liveWorkers()`, in the process that runs the fleet — the
  server and its agents share a fate, so a durable answer buys nothing.
- **Activity is a process fact.** A session's `lastSeenAt` moves in memory, and
  the extension of its window is not written for its own sake: the document
  carries every live session's current window whenever it is written for a
  reason of its own (a sign-in, a reseal, a sign-out). An idle timeout is
  judged against the deadline the document holds, so the safe direction is the
  one a restart errs in.
- **A write that would store what is already there is not made.** The write
  funnel compares what it is about to store against what the node holds and
  returns without uploading or advancing the node's state — which also stops a
  no-op write from invalidating another writer's compare-and-set token.
- **The cost is a budget, and a test is what keeps it.** An idle agent writes
  zero blobs over many passes, and a session used for hours writes none; both
  are asserted where they can fail, because the rule is invisible until the day
  an account runs out.

Takeover follows from this rather than from a lease: a claim taken before this
process started is one nobody is holding, and a claim taken after it is a peer
that was already running (ADR 0003). A rolling restart's brief overlap is
resolved by the compare-and-set, and a worker that crashed leaves a claim the
next process adopts.

## Consequences

- An idle installation consumes no quota, and a busy one consumes it in
  proportion to work done — which is what a quota can be sized against.
- A restart relaxes a sliding session window to the last one written: a session
  idle for longer than that window ends. That is the safe direction for an idle
  timeout, and it is the price of not writing on a clock.
- The quota is still per account and still finite: an installation must fit its
  work inside it, and retention of the documents work produces (ADR 0003) is
  what keeps a busy group's account from filling.
- A blob already spent is not recoverable; an account that has been driven past
  its quota is relieved by raising the quota or by recreating the account, not
  by this rule.
