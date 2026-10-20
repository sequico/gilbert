# ADR 0023 — The CodeQL analysis runs with the release

Status: Accepted

Implementation: Built. `.github/workflows/codeql.yml` (the
`javascript-typescript` analysis, its two actions pinned to a commit) is called
by `.github/workflows/release.yml` as a pre-check, and runs weekly and on
dispatch besides. **It is the only place the analysis runs**: there is no local
CodeQL, no bundled toolchain and no script that installs one
(owner decision 2026-10-18). The hosted run reads the SARIF it produced and fails
on any result rather than publishing it.

## Context

- **A 686 MB toolchain and minutes of analysis** are what CodeQL costs, so it
  was deliberately kept out of the per-push gate (`check:ci`) — a gate that
  cannot run on a fresh clone is not a gate.
- **It was left to GitHub's default setup** (owner decision 2026-09-17), named
  by no file here, and that setup was no longer running: the newest analysis
  was dated 2026-09-17, and a push on 2026-09-28 produced no CodeQL run at all,
  while the documents still described one on every push and pull request. A
  claim standing beside a mechanism that had stopped is the defect this record
  closes.
- **The analysis is a pre-release fact.** Whether a release carries a finding is
  a question asked when a release is prepared, and the toolchain's cost is one a
  release path can carry where a per-push path cannot.

## Decision

- **The analysis is a release pre-check.** `.github/workflows/codeql.yml` is
  called by `release.yml` beside `ci.yml`, and `cut` waits for it: nothing is
  cut on an analysis that is not clean, and a dry run carries it too.
- **A file names it, not a repository setting.** The workflow is in the tree so
  it is reviewed like any other change and moves under the pin rule of ADR 0021;
  advanced setup and default setup cannot both be configured on one repository,
  and the one that is a file is the one this repository can read.
- **It also runs weekly and on dispatch**, so a query added upstream surfaces
  without a release.
- **The analysis runs on GitHub and nowhere else.** There is no local script, no
  bundled toolchain and no command that installs one: a machine-local analysis is
  a second suite that can disagree with the one a release uses, and the gate a
  push meets is `check:ci`. A finding from the hosted run is still work to do in
  the same change.

## Consequences

- A release ships a clean analysis, and the per-push gate stays fast and
  offline.
- The analysis is **not published** to GitHub code scanning. The workflow reads
  the SARIF it produced and **fails on any result** instead — nothing is cut on
  an unclean analysis.
- A finding is work to do in the same change, like every other gate this
  repository runs; there is one suite, the one the workflow runs, so no local
  result can disagree with a release's.

## References

- `.github/workflows/codeql.yml` — the hosted analysis
- `.github/workflows/release.yml` — the pre-check that calls it
- `package.json` — `check:ci`, the one gate a push meets
- ADR 0021 — the one gate, the release pre-check and the pin rule
