# ADR 0009 — The installation's agent identity is recorded in the product

## Status

Proposed (2026-09-11).

## Context

ADR 0003 §2 decided that an installation runs one agent, that the agent is a
principal in Stalwart's own directory, and that `GILBERT_AGENT_ADDRESS` with its
app password (`GILBERT_AGENT_PASSWORD`, or a `GILBERT_AGENTS_FILE`) is the
worker's bootstrap. Read against the administration surface, that decision left
an administrator with nothing to do: an installation with no address showed a
sentence telling them to set a variable and restart, in a product whose every
other installation-wide fact is edited in the product.

Two facts constrain the answer.

- **The web tier needs no secret.** It acts as the agent by impersonating the
  address from an administrator's own session (`openAgentSession`), so an
  address is the whole of what it needs to know.
- **The worker needs one.** It signs in as the agent before it can read anything
  durable, so an address it is told and a secret it holds are the bootstrap, and
  no document can carry them to a process that cannot yet authenticate.

## Decision

The installation records the agent's address in the policy document, under
`agent.address`, beside the settings policy: the deployment's own durable store
(`SETTINGS_POLICY_FILE`), written through `POST /api/admin/agent/address`, read
by the boot path (`readSettingsPolicy`), and in force without a restart — the
existing policy mechanism, not a second one.

The effective address is `agent.address` when the document names one, and
`GILBERT_AGENT_ADDRESS` when it does not: one definition, `agentAddress()`. The
secret is deliberately not part of this — it stays a deployment fact, because
the worker needs it before it can read anything — and the surface says so:
`AgentStatus` carries `addressSource` (policy, deployment, or none) and
`hasSecret`, so naming an address the deployment holds no password for is
visible on the surface instead of arriving as automations that silently do not
run.

The same document records what the worker does in each group:
`agent.groups.<name>.areas` narrows that group to a subset of the areas the
deployment serves. Narrowing is the whole of the permission — the worker
intersects the recorded list with the deployment's own (`servedAreasFor`, one
definition) — so an installation can take work away from a group and can never
hand it work an operator did not open. An empty list is how "served as the
deployment says" is written down, and the surface that edits it takes any
number of groups in one gesture (`POST /api/admin/agent/groups`).

The grant is not part of this and never will be: membership of the agent is
decided in Stalwart's own administration, and the surface that edits the areas
only reads it.

One record now has three doors — the policy editor, the address, the areas — so
the write is a compare-and-set over the document that is actually there
(`changePolicy`): read it, apply the change, write it, and keep the write only
if the record still says what the change was merged into. A second
administrator's groups are their own decision, and a merge never drops what it
did not name. Two writes in one process are serialized; the compare-and-set is
what covers a second replica, where the file is the only thing they share, and
a document that keeps moving is refused loudly rather than clobbered. What is
*not* guarded is two administrators changing the same group at the same moment:
that is the same decision twice, and the later save is the one that holds.

## Consequences

- An administrator names the agent in the product, choosing from the accounts
  the server already lists, and the change reaches the web tier on the next
  request. A browser reload is what applies it; the worker reads the same value
  at its next start, which the surface says.
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
- Two stores can name an address at once — the document and the environment.
  One wins (the document) and the other is reported as the fallback rather than
  left to be guessed; that is what `addressSource` answers.
- The policy document now carries one fact that is not a user setting. It is the
  only installation-wide store a deployment already keeps durably, and a second
  document of its own would be a second source of truth for the same fact.
- With no `SETTINGS_POLICY_FILE` configured, the running copy is the only copy,
  exactly as it is for the settings policy today: a disposable container that
  records nothing durable keeps its behaviour inside the process.
- The boot path refuses an unusable `agent.address` loudly rather than falling
  back silently, so a deployment that names one and mistypes it does not start
  as an agent nobody named.
