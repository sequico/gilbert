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

## Consequences

- An administrator names the agent in the product, choosing from the accounts
  the server already lists, and the change reaches the web tier on the next
  request. A browser reload is what applies it; the worker reads the same value
  at its next start, which the surface says.
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
