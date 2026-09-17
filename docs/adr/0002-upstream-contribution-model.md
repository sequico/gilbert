# ADR 0002 — Upstream is download-only

Status: Accepted

Implementation: Built, and carried by the repository's own shape rather than by
code: the `upstream` remote is fetch-only (`no_push`), no mirror branch exists,
and a release is fetched by the merge that takes it in.

Gilbert's mail client is based on
[Coffey-Labs/ihasmail](https://github.com/Coffey-Labs/ihasmail). Upstream is
consumed here and never contributed to: releases arrive, nothing goes back.

## How it works

A merge that takes a release in adds `https://github.com/Coffey-Labs/ihasmail.git`
as a remote, fetches its tags into a namespace of their own
(`refs/upstream/tags/*`, never `refs/tags` — this repository keeps its own
release tags), and merges the release; the mail core lands with Gilbert's
identifiers applied by the rename layer (`gilbert-branding`). There is no
mirror branch: nothing has to be pushed to keep upstream close, and no
credential is kept to push it.

`.github/workflows/upstream-watch.yml` runs the same fetch once a day, takes
the newest upstream release, and asks one question: is that release's commit
an ancestor of `main`? If it is, nothing has been missed. If it is not, the
watch opens an issue that names the owner and closes it once the commit lands.
Nothing is written down to compare against, so there is no bookkeeping that
can fall out of step with the actual history; the workflow pushes nothing and
holds no secret.

No upstream-shaped fork is kept, no un-renaming patches exist, and nothing is
proposed back to Coffey-Labs/ihasmail: work that upstream might once have
accepted simply lives here, renamed or not. Attribution stays intact — the
mail core is a derivative work of ihasmail, `NOTICE` carries Coffey Labs'
attribution, the copyright in this derivative is Sequi Company's, and upstream
URLs stay linked.

Two GitHub facts shape the mechanism rather than a preference for it: a
workflow's own token cannot create or update a file under `.github/workflows`
at any permission setting, and a copy of an upstream release necessarily
carries upstream's own workflow files — so fetch-and-merge, not a mirror
branch, is what a public repository's token model allows. The watch's
ancestry check holds only for as long as upstream keeps arriving by merge; a
release taken in by cherry-pick instead would keep being reported as missing
— a false alarm, which is the direction the check is built to fail in.

## Consequences

- No fork maintenance, no extraction projects, no upstream review cycle.
- Divergence from upstream is accepted and can grow; sync conflicts are
  resolved at merge time.
- The rename layer runs over every merged delta.

## References

- `.github/workflows/upstream-watch.yml` — the fetch, the ancestry check, the issue
- https://github.com/Coffey-Labs/ihasmail — the remote a merge fetches from
