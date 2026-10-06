# ADR 0002 — Upstream is download-only

Status: Accepted

Implementation: Built, and carried by the repository's own shape rather than by
code: the `upstream` remote is fetch-only (`no_push`), no mirror branch exists,
a release is fetched by the merge that takes it in, `docs/upstream.md` carries
the per-commit record, and `.github/workflows/upstream-watch.yml` reads it once a
day to decide whether the newest release is accounted for.

Gilbert's mail client is based on **ihasmail**, by **Coffey Labs**; `NOTICE`
carries the attribution and the addresses. Upstream is consumed here and never
contributed to: releases arrive, nothing goes back.

## How it works

A merge that takes a release in adds upstream's repository as a remote (its
address, with the attribution, is in `NOTICE`), fetches its tags into a
namespace of their own (`refs/upstream/tags/*`, never `refs/tags` — this
repository keeps its own release tags), and merges the release; the mail core
lands with Gilbert's identifiers applied by the rename layer
(`gilbert-branding`). There is no mirror branch: nothing has to be pushed to
keep upstream close, and no credential is kept to push it.

`.github/workflows/upstream-watch.yml` runs the same fetch once a day, takes
the newest upstream release, and asks whether it is accounted for — one way per
kind of take: its commit is an ancestor of `main` (a merge or a wholesale take),
or every work commit it adds carries a row in `docs/upstream.md`. If it is,
nothing has been missed. If it is not, the watch opens an issue that names the
owner and closes it once the release is accounted for. The workflow pushes
nothing and holds no secret.

The second check is what a hand-take needs: a release whose work was
**hand-taken** commit by commit never makes the release's own commit an ancestor,
so ancestry alone would keep reporting it as missing. `docs/upstream.md` is the
record that answers it — one row per upstream commit and what became of it — and
every hand-take records the upstream sha in its own message
(`Upstream: <sha>`), so the mapping lives in the history and the table is rebuilt
from it rather than maintained by hand.

No upstream-shaped fork is kept, no un-renaming patches exist, and nothing is
proposed back upstream: work that upstream might once have accepted simply lives
here, renamed or not. Attribution stays intact — the mail core is a derivative
work of ihasmail, `NOTICE` carries Coffey Labs' attribution and the addresses
of that project's own site, documentation and issue archive, and the copyright
in this derivative is Sequi Company's.

Two GitHub facts shape the mechanism rather than a preference for it: a
workflow's own token cannot create or update a file under `.github/workflows`
at any permission setting, and a copy of an upstream release necessarily
carries upstream's own workflow files — so fetch-and-merge, not a mirror
branch, is what a public repository's token model allows. The watch's row check
holds only while a hand-take records its commits: a commit taken without a row
in `docs/upstream.md` would be reported as missing — a false alarm, which is the
direction the check is built to fail in.

## Consequences

- No fork maintenance, no extraction projects, no upstream review cycle.
- Divergence from upstream is accepted and can grow; sync conflicts are
  resolved at merge time.
- The rename layer runs over every merged delta.

## References

- `.github/workflows/upstream-watch.yml` — the fetch, the two checks, the issue
- `docs/upstream.md` — the per-commit record the watch's row check reads
- upstream's repository — the remote a merge fetches from; the address is in `NOTICE`
- upstream's GitHub-era issue archive — the issues and pull requests from GitHub, whose numbers match GitHub's; the address is in `NOTICE`
