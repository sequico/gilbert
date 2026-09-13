# Architecture decision records — index

One file per decision (`NNNN-kebab-case-title.md`). A number is never
reused: a decision folded into another retires its number rather than
leaving a gap for something unrelated to fill.

Retired numbers, and where their content lives now (a code comment citing a
retired number is looked up here, not in a deleted file): 0004 → 0001;
0006 — dropped, the native companion app it proposed is superseded by the
web client's own installable (PWA) mode; 0008 — dropped, the feature it
described was never built; 0010 → 0003; 0011 — folded into 0006 before this
revision, and dropped with it; 0012 → 0003; 0013 → 0003 (via 0010);
0014 → 0003; 0015 → 0001. Section letters or numbers a retired record once
had (`§4`, `resolution 11`, …) do not carry over — the surviving record's
own structure is what a code comment should be read against.

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
- **0009 — The push subscription covers every live type, at the request's
  own origin.** One subscription per account names every state type a
  Gilbert surface keeps live, and its callback address is derived from the
  request rather than configured.
