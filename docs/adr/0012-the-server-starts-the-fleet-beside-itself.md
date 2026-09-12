# ADR 0012 — The server starts the fleet beside itself

Status: Proposed (2026-09-12)

## Context

The installation's fleet is a process that holds a group's account by lease,
wakes on the agent's own event stream and on the schedule, and runs the
automations (ADR 0003). ADR 0003 settled that this process is its own, and among
its rejected alternatives was putting one inside the web server container: the
web tier is disposable and request-scoped, a worker holds long-lived claims and
runs long operations, and the two scale on different things — traffic against
accounts served.

Two costs stayed with the operator. A deployment has to declare the second
process — a container, a unit, a `docker compose --profile agent` — and an
installation whose server is up and whose worker was never started reads exactly
like one that works, until a person goes looking for the worker list. Nothing in
the product says "a group has granted this agent and nothing is serving it",
because the thing that would say it is the process that is missing.

The objection rests on containers rather than on the process boundary. It is
`IMMUTABLE=1`, a disposable container and a restart policy that make the split
worth its cost for a deployment that scales. An installation that starts one
process on one machine has none of those to lose, and it is the case the product
was making harder than it had to be.

## Decision

**The server starts a worker beside the web tier, in its own process, when the
deployment names an agent.** One command — what the image already runs — is an
installation that both serves and works. No agent named, no fleet started: that
is the state the admin surface reports as `agent_not_configured`, not a failure
of the start.

**The worker is the same code either way.** The boot retry, the identity watch
and the stop live in one function (`startAgentFleet`), called by the worker's own
entrypoint and by the server. `node server/dist/agent/worker.js` stays the whole
of the separate process, and `GILBERT_AGENT_INPROCESS=0` is how a deployment
keeps it there.

**The fleet's life is the server's.** The server's shutdown stops it — claims
released, stream released — so nothing is left holding an account under a live
lease, and the work a restart interrupts is taken up by the successor that claims
the account after the lease lapses.

**Nothing about a claim changes.** A lease arbitrates two workers on one account
whether they are two processes or one, so a scaled web tier scales claimants and
the lease keeps that correct: one holder per account, the rest idle. The job's
pin on the rule version, the audit entry, the capability allowlist and the review
gate are untouched — an in-process worker runs exactly the fleet an out-of-process
one runs.

**What the split protected is named where it is lost.** A bug in the fleet can now
take the web tier with it, and a restart policy watching the server cannot tell
"the web tier is down" from "the worker is up and holding nothing" unless
`GILBERT_AGENT_HEALTH_PORT` is set. The admin surface remains the answer to the
second question, and diagnosing a fleet that is quiet inside a process that still
answers requests is recorded as open work in `ROADMAP.md`.

**A deployment that wants the two apart says so, once.** `docker compose
--profile agent up` with `GILBERT_AGENT_INPROCESS=0` runs the fleet in a
container of its own, with its own health endpoint and its own restart policy.

## Consequences

- Starting an installation is one command and one environment pair
  (`GILBERT_AGENT_ADDRESS`, `GILBERT_AGENT_PASSWORD`) rather than a command per
  process, which is what the product asked of an operator before.
- A web-tier restart now interrupts runs in flight. That is survivable by
  construction: the job stays in the documents, the claim lapses, and the next
  worker finishes it — at the cost of the lease interval, not of the work.
- Scale couples: N web replicas are N claimants. The lease makes that correct
  and leaves the losers idle, which is spend rather than error.
- The separate process remains fully supported, so an installation that wants
  blast-radius isolation, a fleet restart policy, or the fleet on another machine
  loses nothing but the default.
- A fleet that hangs inside the server is one failure with two faces. The
  recovery path is unchanged (heartbeats stop, the claim lapses, a successor takes
  over); the missing part is diagnosis, and it is tracked.

## Alternatives considered

- **A launcher that starts both processes, keeping the split.** One command and
  two processes, forwarding signals and restarting the fleet. Rejected as the
  default: it keeps the operator's mental model of two things, needs a supervisor
  in the image, and buys isolation only for the deployments that already know
  they want it — which is exactly what `GILBERT_AGENT_INPROCESS=0` gives them,
  without a second program to maintain.
- **Better documentation of the second command.** Rejected: the failure is not
  that the command is unknown, it is that forgetting it is silent. A product that
  can start what it needs should start it.
- **A worker started unconditionally, credentials or not.** Rejected: most
  installations name no agent, and a process that exists to warn about its own
  missing configuration is noise. The pair is what makes a fleet meaningful, and
  it is what the start is conditioned on.
- **Splitting the tier so the web process cannot be taken down by the fleet**
  (a worker thread or a child process inside the same container). Rejected: a
  child process inside the container is the launcher above with the supervisor
  removed — the restart policy would still only see the server, and the fleet
  would be invisible to the operator's own tooling.

## References

- ADR 0003 — the agent worker fleet: the claim, the lease, the heartbeat, the
  boot retry, the identity watch, and the alternative this record supersedes
- `server/src/index.ts` — the server that starts the fleet and stops it
- `server/src/agent/worker.ts` — `startAgentFleet`, shared by both entrypoints
- `server/src/config.ts` — `GILBERT_AGENT_INPROCESS`
