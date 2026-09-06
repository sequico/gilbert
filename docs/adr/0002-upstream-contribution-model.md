# ADR 0002 — Upstream contribution model

Status: Proposed (2026-09-06)

## Context

Gilbert is a full rebrand and a set of own features on top of
[Coffey-Labs/ihasmail](https://github.com/Coffey-Labs/ihasmail), and the owner
wants the parts of the work that are common — fixes, capability handling,
anything upstream would accept — to flow back to upstream as pull requests,
*only* those parts, never the rebranding or the Gilbert-only features.

The tension is structural. A full rebrand renames operational identifiers
repo-wide (see `gilbert-branding`), so once it lands there is no
upstream-shaped copy of the code left inside this tree to contribute from;
every future upstream merge also has to fight the rename. A contribution
therefore needs an upstream-shaped working area that is not the rebranded
main, and the sync between upstream and Gilbert must keep flowing so the two
sides do not drift apart until contribution becomes archaeology.

What already exists and stays:

- `upstream` remote with `pushurl no_push` (accidental pushes are refused at
  the remote level) and `origin` = `sequico/gilbert`;
- the `gilbert` branch mirroring upstream **releases** only, kept by the
  daily `sync-upstream` workflow;
- the habit of merging `upstream/main` into `main` ("Sync upstream: …").
- upstream's own contribution process (`CONTRIBUTING.md`, AGPL, their branch
  rules) — a contribution must follow *their* conventions, not Gilbert's.

## Decision

1. **Contributions are prepared in an upstream-shaped fork, never in this
   tree.** When a common change is ready to offer upstream, it is developed on
   a branch cut from `upstream/main` in a contribution fork of
   Coffey-Labs/ihasmail under the owner's account (the same shape as the
   owner's `waxwing-contrib` setup), with upstream's identifiers, conventions
   and licence lines intact, and opened as a PR against Coffey-Labs/ihasmail
   containing only that change. The rebranded `main` is never the source of a
   contribution, because a patch that has to be un-renamed on its way out is a
   patch that will not be maintained.
2. **The sync direction stays upstream → Gilbert.** `upstream/main` keeps
   being merged into `main`; the `gilbert` release mirror keeps running.
   Common fixes that upstream accepts come back into Gilbert through that
   sync, so they are written once, upstream-shaped, and merged home — not
   written twice.
3. **The rebrand and Gilbert features stay in this repo and this repo only.**
   No Gilbert identifier, feature, policy or doc ever rides in a contribution.
   Files whose whole purpose is upstream process (`SECURITY.md`,
   `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE`/`NOTICE` attribution)
   keep upstream's name and contacts per the existing law.
4. **Cost is accepted and budgeted.** Every sync after the rename costs more;
   the rename itself is a coordinated, deliberate task (see
   `gilbert-branding`), and the sync workflow may need rename-aware
   resolution. This is the price of the direction, recorded rather than
   hidden.

## Consequences

- A contribution fork must exist before the first PR (create it when the
  first common change is ready; nothing in this repo can create GitHub
  remotes).
- Common work is best done *before* or *independently of* rebranding commits,
  so the fork branch can be cut cleanly from a recent `upstream/main`.
- Anyone working in this repo must not "fix" an upstream-shaped piece by
  rebranding it as part of a common change: rebranding is the Gilbert layer
  and stays here.
- The pre-push habit from other contribution setups (a local guard refusing
  pushes to upstream and to non-contrib branches) can be replicated in the
  contribution fork when it is created.

## Alternatives considered

- **Contributing from the rebranded main by "un-renaming" patches**: rejected
  — every PR becomes an extraction project, and the extracted code is not what
  anyone tests or maintains here.
- **Keeping a permanent upstream-shaped branch inside this repo**: the
  `gilbert` branch exists for releases only; a full working line would double
  the maintenance surface inside one checkout and blur which tree is the
  product.
- **Not contributing at all**: simplest, but the owner wants common work to
  benefit upstream, and the sync already depends on upstream's health.

## References

- `.git/config` — `remote.upstream.pushurl no_push`
- `.github/workflows/sync-upstream.yml` — the `gilbert` release mirror
- `CONTRIBUTING.md` — upstream's (adapted) contribution process
- `gilbert-branding` skill — the rename map and its sync cost
