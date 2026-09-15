# Architecture decision records — index

One file per decision (`NNNN-kebab-case-title.md`), numbered by the owner.

A citation names a record that is a file here, and a section inside it is
named rather than numbered: the record's own structure is what a code
comment is read against.

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
- **0004 — A contact group is not a recipient.** A group card
  (`kind: "group"`, its `members` named by `uid`, no address of its own) is a
  client-side convenience over addresses: the composer's To/Cc/Bcc
  autocomplete, the recipient picker and the contact card's "Email group"
  action resolve it through one resolver, when it is chosen, into chips for the
  individual addresses — one per member, the preferred one — so the wire, the
  drafts and the replies never know a group exists. Resolved against every book
  the reader may read, a group mailbox's books among them; a member that cannot
  be resolved is skipped and counted; no nesting, and no threshold of its own.
- **0005 — Group chat and the group label catalog.** Both are layers on the
  group account's own JMAP Files, owned by the group from creation.
- **0006 — The minimal automation.** A group authors one enabled automation
  per trigger it actually uses — up to the four `AGENT_TRIGGERS`, never one
  per business case — with no filter and the branching carried in prose. The
  capability checklist is chosen as three areas (Mail, Chat, Files and
  documents) instead of eleven individual actions; whatever the catalogue
  marks `external` or `irreversible` — today only `mail.send` — is excluded
  from every area and keeps its own entry, as does `noop`, so ticking an area
  can never grant sending as a side effect and a rule can still answer that
  it changes nothing. `AgentRule.capabilities` is unchanged; the area is
  metadata the editor would group by, not a new document field. New context
  belongs in one of two speeds — distilled into the group's notebook by an
  infrequent process, staying in the prompt's cached head, or fetched
  narrowly and by name into the volatile tail — never attached wholesale
  (a full mailbox, an unbounded document set), which would defeat the
  provider's own prompt caching and widen the untrusted-content surface at
  once. The rule recipe is what the code does; the areas and the two speeds
  of context are decided here and not built.
- **0007 — Identity administration.** An administrator sets a person's or a
  group's identity through the same doors impersonation and the agent
  already open; a locked account has no path of its own to change it, and the
  lock is about personal mailboxes only. Which identity a member sends as in
  a group is **an assignment the administration records** in the group's own
  app folder — next to the identity it writes, in the same action — and not a
  comparison of display names: the name is what a recipient reads, and a name
  that is also a key fails on any spelling, any rename and any name nobody
  set. A member with no assignment sends as **the group's own identity**, the
  one the agent sends as, and only a group holding no identity at all leaves
  the composer with nothing to offer.
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
- **0010 — The client has no tasks module.** A task list is a convention, not
  a type: a calendar marked in its own `description`, holding objects the
  client does not name. Nothing in the client recognises or writes it and no
  document here calls it a thing: no route, no section, no catalog string, no
  marker, no separate kind of calendar to filter out of the pickers. What is
  already in Stalwart is left where it is, drawn as the calendar objects they
  are — no migration, no purge, no hiding pass. Supersedes ADR 0005's
  task-list enumeration.
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
