# Architecture decision records — index

One file per decision (`NNNN-kebab-case-title.md`), numbered by the owner.

Retired numbers, and where their content lives now (a code comment citing a
retired number is looked up here, not in a deleted file): 0004 → 0001;
0006 — the native companion app it proposed is superseded by the web
client's own installable (PWA) mode, with no record of its own; 0010 → 0003;
0011 — folded into 0006 before this revision; 0012 → 0003; 0013 → 0003 (via
0010); 0014 → 0003; 0015 → 0001. Section letters or numbers a retired
record once had (`§4`, `resolution 11`, …) do not carry over — the
surviving record's own structure is what a code comment should be read
against.

Each record describes the decision as it stands and how it is built —
architecture, not a changelog. A record is edited in place when the thing it
describes changes; nothing here narrates what used to be true. History of
that kind lives in git, not in these files.

Every record names the four blocks — **gilbertmailer**, **gilbertserver**,
**gilbertagents** and **gilbertstalwart** — the way `README.md` defines
them, so a decision and the product description use one vocabulary. What
Gilbert *does* is the inventory in `FEATURES.md` and the code itself; a
record here explains why a piece of the architecture is shaped the way it
is, not what a user sees.

## The decisions

- **0001 — Administration.** Gilbert admin is Stalwart admin: a principal is
  an administrator exactly when its permission list carries a configured
  marker, read fresh on every privileged call. Every privileged write into
  an account goes through impersonation; the installation policy, the
  identity lock and the forced-password directive are all per-account
  documents written that way.
- **0002 — Upstream is download-only.** Releases are fetched at merge time,
  nothing flows back, and no mirror branch is kept.
- **0003 — The agent fleet.** One installation-wide agent identity, its own
  process or embedded in the server, coordinated by lease documents with no
  supervisor. An automation is a trigger, a prose instruction, a capability
  allowlist and a review policy; every run asks a model and the allowlist
  bounds what it may do. Covers the notebook, chaining, metering, the
  document tools, and the three-part admin surface (Master, Group Agents,
  Approvals).
- **0005 — Group chat and the group label catalog.** Both are layers on the
  group account's own JMAP Files, owned by the group from creation.
- **0007 — Identity administration.** An administrator sets a person's or a
  group's identity through the same doors impersonation and the agent
  already open; a locked account has no path of its own to change it.
- **0008 — System Sieve scripts.** An admin editor for Stalwart's own
  trusted, server-wide Sieve scripts — a JMAP registry object
  (`x:SieveSystemScript`), not an account's own script — written directly as
  the administrator's session, no impersonation, gated by a permission
  separate from Gilbert's admin marker. Shares its editor component with the
  personal "Scripts (advanced)" tab rather than duplicating one.
- **0009 — The push subscription covers every live type, at the request's
  own origin.** One subscription per account names every state type a
  Gilbert surface keeps live, and its callback address is derived from the
  request rather than configured.
- **0016 — The policy publish is a job with an id.** One id per publish,
  carried by every copy it writes, and the job — the population the
  directory reported, the accounts the policy reached, the ones it did not
  with a code each, and whether the installation can be said to carry the
  policy — is one document in the publishing administrator's own app
  folder. Every per-account write is conditional, and the outcome cannot
  claim more than it reached. Supersedes ADR 0001's policy-publish bullet.
- **0017 — The installation's configuration is the Master's own document.**
  `installation.json` in the Master account's `gilbert` app folder, read
  whole at boot and written by the administration through the same
  impersonation door; the environment carries only the handshake, the
  container's and the image's own facts, the operator's own switch, and the
  facts about the process itself. A publish applies from the next boot.
- **0018 — A durable write is caused by a change, not by a clock.** Stalwart
  charges an account for every blob it uploads and never gives one back, so a
  write on a clock — a heartbeat, a renewed lease, a session's activity stamp —
  spends a finite budget saying that a process is alive. Liveness and activity
  are process facts (ADR 0003's claims, the sessions store), a write that would
  store what is already there is not made, and an idle installation therefore
  costs nothing.
