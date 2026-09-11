# ADR 0009 — The installation's agent identity is the deployment's

Status: Accepted (2026-09-11)

## Context

ADR 0003 §2 settled that an installation runs one agent, that the agent is a
principal in Stalwart's own directory, and that the pair
`GILBERT_AGENT_ADDRESS` / `GILBERT_AGENT_PASSWORD` is how a process reaches it.
This record settles the rest: what the product itself keeps about the identity,
and what it keeps about the work.

Two facts constrain the answer.

- **The pair belongs to the deployment.** A credential reaches a process that
  cannot yet authenticate only from outside it — the environment the operator
  starts the server and the worker in. A copy the product held would be a second
  source of truth for one fact, and minting or rotating it would be a duty the
  product should not carry over a credential that is the agent's own.
- **The product still decides one thing: how much of what the deployment opens
  each group gets.** That is a user decision, and it is the only installation-
  wide fact about the agent that is the product's to record.

## Decision

The agent's address and password are the deployment's environment and nothing
else: `GILBERT_AGENT_ADDRESS` with the account's own password in
`GILBERT_AGENT_PASSWORD` — the account's own, not an app password, because the
agent signs in as itself. One definition reads them (`agentAddress()`), and both
processes read the same pair: the worker opens its session with it, and the web
tier signs in as the agent with it to read the fleet. Nothing in the product
names the address, records it, or asks an administrator for it.

A pair that is absent or incomplete is not fatal to the server, and nothing
throws at boot. The installation runs with no agent, and the admin surface
names which state it is in — `agent_not_configured` when the deployment carries none,
`agent_credentials_rejected` when Stalwart refuses the pair it carries,
`agent_unreachable` when the server cannot be asked — beside how to set the two
variables. The worker process is the one thing that stops: with nothing to serve
it exits naming both variables rather than starting half-configured. An
installation that runs without an agent is visible as one, rather than arriving
as automations that silently do not run.

Nothing about the identity is written down in the product, and the product
neither mints nor rotates a credential. Rotating the password is the operator's
act in Stalwart's own administration, and it lands on the deployment: the
variables are read at boot, so a restart carries the new value. Membership is
not recorded either — it is decided in Stalwart's own administration, and the
surface reads it from the agent's own session, which is the whole of the grant.

What the product does record is the narrowing: `agent.groups.<name>.areas` in
the settings policy document, written through `POST /api/admin/agent/groups` and
read by the boot path. Narrowing is the whole of the permission — the worker
intersects the recorded list with the areas the deployment serves
(`servedAreasFor`, one definition) — so an installation can take work away from
a group and can never hand it work an operator did not open. An empty list is
how "served as the deployment says" is written down, and the surface that edits
it takes any number of groups in one gesture.

The policy document is shared by the policy editor and the areas, so the write
is a compare-and-set over the document that is actually there (`changePolicy`):
read it, apply the change, write it, and keep the write only if the record still
says what the change was merged into. An administrator's groups are their own
decision, and a merge never drops what it did not name. Two writes in one
process are serialized; the compare-and-set is what covers a second replica,
where the store is the only thing they share, and a document that keeps moving
is refused loudly rather than clobbered. What is *not* guarded is two
administrators changing the same group at the same moment: that is the same
decision twice, and the later save is the one that holds.

## Consequences

- An installation with no pair, or a pair Stalwart refuses, runs and says so:
  the admin surface carries the state and the two variables to set, and the
  fleet is not operational until the deployment is corrected and restarted.
- **A group whose record drops an area stops being served there.** The worker
  stops renewing that claim and the lease lapses on its own — no worker deletes
  another's claim, and this never touches the fence — so the rules in that area
  do not run for that group. The surface shows what is served where, which is
  the only signal: nothing audits a run that was never going to start. The
  timing, in full: the record reaches a **worker at its next start** (the web
  tier reads it live, the worker has its own copy of the configuration), and
  from there the claim stops being renewed at the first pass and lapses within
  `GILBERT_AGENT_LEASE_MS` — three minutes by default. The session refresh (a
  minute, and about membership rather than this record) does not shorten that.
- **The record cannot claim an area nobody serves.** The areas saved for a group
  are refused unless the deployment serves them, in the deployment's own words,
  so a record never says something the fleet cannot do; `servedAreasFor` in the
  worker remains the enforcement, and the door is the second net.
- The policy document now carries one fact that is not a user setting. It is the
  only installation-wide store a deployment already keeps durably, and a second
  document of its own would be a second source of truth for the same fact.
- With no `SETTINGS_POLICY_FILE` configured, the running copy is the only copy,
  exactly as it is for the settings policy today: a disposable container that
  records nothing durable keeps its behaviour inside the process.
- The identity is one place — the deployment — so there is no second copy for a
  surface to drift from and none to reconcile; changing it is a restart, and
  nothing pretends otherwise.
