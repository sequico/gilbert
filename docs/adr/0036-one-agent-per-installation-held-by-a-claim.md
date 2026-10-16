# ADR 0036 — One agent per installation, held by a claim

Status: Accepted

Implementation: Built. The claim is `server/src/agent/claim.ts` — its document,
its take, its renew and its release — over the app folder's own compare-and-set
(`writeAppFile` with `ifInState`, `server/src/appFolder.ts`), which the mock
enforces (`server/src/mock/compare-and-set.test.ts`).

## Context

An agent is a process, and a process is the one thing in this design that is not
durable: the container is disposable (ADR 0031, ADR 0034), and a deployment may
run a second copy of it — a rolling restart, an operator's mistake, a supervisor
that starts one before the old one is gone. Two copies working the same runs
would act twice on the same mail, settle the same step twice and answer the same
question twice, and nothing in the runs themselves stops it: both copies read
the same rules and both reach the same work.

What is durable is Stalwart, and what Stalwart offers is a compare-and-set — a
write conditional on the account's FileNode state (`ifInState`). The exclusion
therefore has to be a document rather than a lock in a process, and it has to
live where every copy of the process already is: the account the agent signs in
as.

## Decision

**One claim per installation, and the claim is one document.**

- The claim is `agent-claim.json` in the app folder of the account the agent
  signs in as — the installation's own principal, the Master. **There is one
  claim per installation and no per-group lease**: the agent works every group's
  runs from the one account it is granted, so one document is the whole of what
  a second copy has to lose against.
- **It is taken by the conditional write**, against the state read before it.
  Two processes that race for a free claim cannot both believe they won: the
  loser's write is refused because the state moved, and it comes back to a claim
  that is by then readable. A process that already holds the claim is answered
  as itself, with no write — holding it is not an event, so an ordinary pass
  costs one read and no upload (ADR 0012).
- **It carries who holds it and when it stops being believed.** That instant is
  `CLAIM_TTL_MS` after the take or the last renew, and it means exactly one
  thing: until then the holder is believed, and after it the claim is free. It
  is not a promise that the holder is alive — nothing here asks — and it is not
  a deadline for the work: it is the window in which the installation has an
  agent, written as a date the next process can read.
- **A holder renews it while it works**, and a claim that is not renewed lapses
  into the next process's hands. That is what makes a restart need no attention:
  a process that dies without releasing leaves a claim that expires, and a stale
  claim costs one TTL of waiting — never a document deleted by hand.
- **A release takes nobody's claim but its own**, and is itself conditional on
  the state the claim was read at, so a release cannot remove a claim a peer has
  just taken over.
- **A claim document that cannot be read is no claim.** A document that is not
  this shape, whose dates are not instants, or whose bytes do not come back, is
  read as no claim at all, and the next process takes the installation over
  under the same compare-and-set. Refusing instead would leave an installation
  whose claim document was damaged with no agent and no way back but a hand
  edit, which is the worst outcome this file has.

## Consequences

- Two copies of the agent cannot both work the installation: the second is
  refused while the first is believed, and the exclusion is durable because the
  document is.
- A dead holder is neither an incident nor a manual step: the claim lapses and
  the next start takes it. The cost of a crash is bounded by the TTL.
- The TTL is the one number that decides both halves — how often a working
  holder must renew, and how long a dead one's claim delays the next start — and
  it is one constant rather than a policy an installation chooses.
- The check costs one read per pass: no coordinator, no coordination traffic,
  and nothing on the writable filesystem a container under `IMMUTABLE=1` does
  not have.
- What this does **not** answer is work already begun. The claim says who may
  work the installation, not what has been worked; a run left half-done by a
  holder that died is picked up by the next one from the run document (ADR 0034),
  where the plan, the wait and what it touched are all written down.

## References

- `docs/adr/0031` — the agent's tools, the loop that chooses them, and the budget
- `docs/adr/0034` — the run document, the durable state the next holder reads
- `docs/adr/0012` — a durable write is caused by a change, not by a clock
