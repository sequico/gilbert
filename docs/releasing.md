# Releasing Gilbert

How a change reaches `main`, and how a version of Gilbert leaves it. The law
lives in `AGENTS.md`; this is the procedure the law points at, in one place.

## The gate

One pipeline verifies the tree, and it has one source: **`npm run check:ci`** in
`package.json` — typecheck, Biome, `adr:owed`, `adr:cite`, `config:dead`,
`workflow:pin`, `i18n:check`, the tests under `TZ=UTC`, and the build.

The **pre-push hook** (`.githooks/pre-push`, enabled once per clone with
`git config core.hooksPath .githooks`) runs it before every push, so a push that
fails it is refused; `git push --no-verify` bypasses it deliberately and never
by accident. `.github/workflows/ci.yml` runs the same script and adds only a
Docker smoke build, which a local gate cannot assume; because `release.yml`
calls `ci.yml` as its pre-check, the check that prepares a release is the check
a push met, not a weaker second list (ADR 0025).

Two checks the pipeline does not carry, on purpose:

- **`npm run audit`** (`npm audit --omit=dev`) is network-bound and
  advisory-driven, so it runs in the release pre-check: a new advisory refuses a
  release, not a push that changed nothing.
- **`npm run codeql`** is a 686 MB toolchain and minutes of analysis. Locally it
  is `npm run check:release` (`check:ci` then `codeql`), which is what
  `npm run prepush:full` runs; on a release it is `.github/workflows/codeql.yml`,
  called by the Release workflow so nothing is cut on an unclean analysis
  (ADR 0027).

## Committing and pushing

`main` is the only branch that carries releases; a change is committed in units
and pushed when the owner says push, per `AGENTS.md`. A push is gated by the
hook above. Dependabot's pull requests merge themselves once the CI is green and
only then, and a major update waits for a person
(`.github/workflows/dependabot-auto-merge.yml`).

## Cutting a release

**Releases are manual.** They are cut from the Actions tab by running the
**Release** workflow (`workflow_dispatch`), whose only input is `dry_run`. There
is no tag to remember and nothing to bump: the version is derived from git at
build time (`scripts/version.mjs`), and `package.json` stays at `0.0.0`.

What the run does, in order:

1. **Decide** whether a release is due. A release with no commits in it is worse
   than no release, so a run with nothing new since the last release, or whose
   tag already exists, stops with a written reason and cuts nothing.
2. **Pre-check.** The full `ci.yml` gate, the dependency audit, and the CodeQL
   analysis (`codeql.yml`).
3. **Cut.** A GitHub release is created at the verified commit, with notes
   generated from the commits since the previous release. Those notes are the
   changelog; there is no `CHANGELOG.md` to keep in step.
4. **Publish** the container image to `ghcr.io/sequico/gilbert`, for
   `linux/amd64` and `linux/arm64` natively, and move `:latest` to it.
5. **Verify** the release: the published tag must resolve on both architectures
   and `:latest` must name the same index. A release that pushed a half-failed
   image fails here rather than being discovered on a `docker pull`.
6. **Prune** old image versions from GHCR, keeping the ten most recent tagged
   ones. Releases themselves are never deleted — their notes are the only
   changelog there is.

`dry_run` reports what a release would do and stops before anything is cut,
published or moved.

## Version numbers

A version is `YYYY.M.D` of the commit, with its provenance after a `+`:
`2026.9.28+pr129` for a commit that arrived through a pull request, or
`2026.9.28+g1fa6578` otherwise. The date leads so a version is never borrowed
from Stalwart's own numbering; the provenance is build metadata, because where a
build came from is not a position in a sequence. The git tag and the Docker tag
are the same string with `+` written `-`, since a Docker tag may not carry a
`+`.

## Rolling back

Every deployment may pin an image tag, and that is the rollback: redeploy the
previous `YYYY.M.D-…` tag. `:latest` moves only when a release moves it, so a
deployment that follows `:latest` rolls back by pinning the tag it wants. The
tagged images for the last ten releases are kept for exactly this; older
releases stay, their images do not. Nothing in Gilbert holds durable state of
its own — everything lives in Stalwart — so rolling the image back moves the
code and leaves the data where it is.
