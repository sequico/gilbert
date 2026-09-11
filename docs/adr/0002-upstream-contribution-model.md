# ADR 0002 — Upstream is download-only

Status: Accepted (2026-09-07; amended 2026-09-11)

> **Owner decision (2026-09-07):** "upstream contribution is download-only —
> we contribute nothing back to upstream" — upstream is consumed, never
> contributed to.

## Context

Gilbert's mail client is based on
[Coffey-Labs/ihasmail](https://github.com/Coffey-Labs/ihasmail). Upstream is
consumed here and never contributed to: releases arrive, work goes one way.

Something has to notice when upstream cuts a release, and two facts bound how
this repository's own automation can do it. GitHub refuses a push that creates
or updates a file under `.github/workflows` from the token a workflow is given
— at any setting of its `permissions`, because `workflows` is not a scope
`GITHUB_TOKEN` can carry — and a copy of an upstream release inside this
repository necessarily carries upstream's workflows. And this repository is
public, where the trust boundary of a credential in Actions is everyone who
may write to it.

## Decision

1. **Upstream is download-only, and it is fetched rather than mirrored.** A
   merge that takes a release in adds
   `https://github.com/Coffey-Labs/ihasmail.git` as a remote, fetches its tags
   into a namespace of their own (`refs/upstream/tags/*`, never `refs/tags` —
   this repository carries its own release tags), and merges the release it is
   taking; the mail core lands with Gilbert's identifiers applied by the rename
   layer (see `gilbert-branding`). There is no mirror branch, so nothing has to
   be pushed to keep upstream close and no credential is kept to push it.
2. **Noticing is automated; taking is not.** `.github/workflows/upstream-watch.yml`
   runs the same fetch once a day, takes the newest upstream release, and asks
   one question: is that release's commit an ancestor of `main`? If it is,
   nothing has been missed; if it is not, the watch opens an issue that
   mentions the owner and closes it once the commit is an ancestor. Nothing is
   written down to compare against, so no bookkeeping can disagree with the
   history. It pushes nothing, so it holds no secret.
3. **No contributions back.** No upstream-shaped fork, no un-renaming
   patches, no PRs to Coffey-Labs/ihasmail. Common work that upstream might
   once have accepted simply lives here, renamed or not.
4. Attribution is unchanged: the mail core is a derivative work of ihasmail;
   `NOTICE` carries Coffey Labs' **attribution** — the copyright in this
   derivative is Sequi Company's — and upstream URLs stay linked.

## Consequences

- No fork maintenance, no extraction projects, no upstream review cycle.
- Divergence from upstream is accepted and can grow; sync conflicts are
  Gilbert's own to resolve at merge time.
- The upstream-shaped working area disappears from every workflow and skill.
- The watch reports a release as untaken **by ancestry**, which holds for as
  long as upstream arrives by merge. Were a release ever taken in by
  cherry-pick instead, the watch would keep reporting it after it had been
  taken — a false alarm, which is the direction to be wrong in.
- Nothing about the lineage changes: attribution is stated above, and the
  rename layer still runs over the merged delta before it lands.

## References

- `.github/workflows/upstream-watch.yml` — the download path, and the watch on it
- `https://github.com/Coffey-Labs/ihasmail` — the remote a merge fetches from directly
