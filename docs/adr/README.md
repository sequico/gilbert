# Architecture Decision Records — index

One file per decision (`NNNN-kebab-case-title.md`), oldest first, numbers
sequential with no gaps. Each record states **what the decision is**; this
index is only the map — number, status, one line. What Gilbert *does* is the
inventory in `FEATURES.md` and the code itself, never a second copy here.

Every record names the four blocks — **gilbertmailer**, **gilbertserver**,
**gilbertagents** and **gilbertstalwart** — the way `README.md` defines them,
so a decision and the product description use one vocabulary. The definitions,
and the line to upstream, live there and are not repeated here.

## How to read the statuses

- `Status` is the **decision lifecycle**, never an implementation flag:
  `Proposed` (written, the owner has not ratified it), `Accepted` (the owner
  ratified the decision), `Superseded` (a later decision replaced it).
- A decision can be implemented while still `Proposed`, and `Accepted` with
  parts deferred: the code and `FEATURES.md` say where it stands, this line
  does not.
- Supersession is one-way and never rewritten: a superseded record's body
  stays as the historical record of what was decided; only its `Status` line
  moves.
- A record states the decision and the facts it rests on — never the
  conversation that produced it.

## The decisions

- **0001 — The administration surface.** Gilbert admin is Stalwart admin: the
  signed-in session's permission list (marker `sysAccountCreate`, configurable
  in the environment) decides, read fresh on every call, failing closed.
  Impersonation is the write path into an account.
- **0002 — Upstream contribution model.** Upstream is download-only: releases
  are fetched at merge time, nothing flows back, and no mirror branch is kept.
- **0003 — Agent worker fleet.** The installation's agent identity lives in
  the deployment's environment; the agent is one, its workers are many; the
  automations, approvals and audit are the agent's record.
- **0004 — Administrative writes into a user's account.** Publishing the
  installation settings policy, and forcing a password change, ride the
  sign-in and impersonation paths that already exist.
- **0005 — Group chat on the group's own Files.** Chat is a layer on the group
  account's own JMAP Files, one JSON document per conversation.

- **0006 — Mobile companion app.** Companion-only by design: a phone app
  beside the web client, with durable state staying in Stalwart.
- **0007 — Identities an administrator sets.** The administration gains
  **Enforce Identities**, one section under the existing identity surface, so
  the addresses a user may send as are set for them.
- **0008 — System sieves, and the second door to Stalwart.** The administration
  edits the server's system sieves — which needs a way into Stalwart that is
  not the signed-in user's own session.
- **0009 — The push subscription covers every live type, at the request's own
  origin.** The subscription names every state type a Gilbert surface keeps
  live, registered at the origin the app was served from.
- **0010 — An automation is written in prose and compiled into its rule.** An
  automation is authored as prose, and one model call compiles that prose into
  the rule document the fleet runs.

