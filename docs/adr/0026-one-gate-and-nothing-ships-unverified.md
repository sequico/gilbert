# ADR 0026 — One gate, and nothing merges or ships unverified

Status: Accepted

Implementation: Built. The pipeline is `check:ci` in `package.json`, with
`scripts/workflow-pin-check.mjs` among its checks; the pre-push hook is
`.githooks/pre-push` and the release pre-check is `.github/workflows/ci.yml`,
called by `.github/workflows/release.yml`. The dependency audit is `npm run
audit` in that release pre-check, and the release's own verification is the
`verify` job in `release.yml`. A Dependabot pull request merges through
`.github/workflows/dependabot-auto-merge.yml`. The procedure and the rollback
are `docs/releasing.md`.

## Context

Four facts about how this tree was verified, and each one is a place where a
claim in the law and the mechanism did not meet.

- **The gate was listed twice.** The pre-push hook ran `prepush` and `ci.yml`
  spelled the same checks out again, so they had already drifted: the release
  pre-check ran no `adr:owed`, `adr:cite` or `config:dead` check, and ran the
  tests without the `TZ=UTC` the suite assumes. A release could therefore ship a
  tree the local gate would have refused, and a change to a gate had two places
  to remember.
- **The pin rule was a reviewer's memory.** The law says an action's `uses:`
  names a full commit SHA with the version beside it, because a repointed tag
  runs in the release path with the repository's token. Nothing checked it.
- **The dependency audit was named and absent.** The law lists "a dependency
  audit at zero" among what the gate must report; no script ran one.
- **Nothing verified the artifact.** After a release pushed a multi-architecture
  image, nothing confirmed that the tag resolved on both platforms or that
  `:latest` named it. A half-failed digest push looked like a release.
- **A pull request could merge before its CI.** `main` requires no status check
  (branch protection guards force-push and deletion, nothing else), so a
  Dependabot pull request could enter before the job that verifies it had
  concluded.

## Decision

- **One pipeline, one source.** `npm run check:ci` is the gate. The pre-push
  hook runs it, and `ci.yml` — the release pre-check — runs the same script. The
  only part of CI that is not in it is the Docker smoke build, which a local gate
  cannot assume has a daemon. A gate change is one edit, and the release
  pre-check cannot be weaker than a push.
- **The pin rule is a check.** `workflow:pin` fails an action named by a tag, or
  pinned with no version beside it; `./.github/…` workflow references and
  `docker://` images are not actions and are not pinned.
- **The audit runs where a release is prepared, not on every push.**
  `npm run audit` (`npm audit --omit=dev`) is network-bound and
  advisory-driven: a new advisory should refuse a release, not a push that
  changed nothing. Keeping it off the push path is also what keeps an offline
  push possible.
- **A release is verified after it publishes.** The `verify` job reads the
  manifest back from the registry and fails unless the tag resolves on
  `linux/amd64` and `linux/arm64` and `:latest` names the same index. A release
  is what the registry serves, not what the workflow pushed.
- **A Dependabot pull request merges only after the CI that verified it is
  green.** It triggers on the CI run's completion (`workflow_run`) rather than on
  the pull request — which also settles the token, since the read-only
  restriction applies to runs Dependabot triggers itself — and merges the exact
  commit the CI verified (`--match-head-commit`). A major update, or one the
  workflow cannot classify, waits for a person. Nothing is checked out of the
  pull request, so no code from it runs.
- **The procedure and the rollback are written down**, in `docs/releasing.md`.

## Consequences

- The release pre-check and a developer's push run the same checks; the Docker
  smoke build and the audit are the only deliberate differences, each for a
  reason stated here.
- A release is a verified artifact: a half-failed image push fails the release
  rather than passing as one, and `:latest` is proven to name the verified
  index.
- The Dependabot merge needs no personal token and no repository setting, and it
  is fail-safe — any conclusion but `success`, or none, is no merge.
- The dependency audit is not part of the offline gate; a machine with no
  network can still push. The audit is where a release is, and the owner decides
  when a release is cut.

## References

- `.githooks/pre-push` — the hook that runs the gate
- `.github/workflows/ci.yml` — the release pre-check, a caller of `check:ci`
- `.github/workflows/release.yml` — the manual release, its audit and `verify`
- `.github/workflows/dependabot-auto-merge.yml` — the merge that waits
- `scripts/workflow-pin-check.mjs` — the pin rule as a check
- `docs/releasing.md` — the procedure and the rollback
- ADR 0023 — the phone's bridge, whose host tarball the release publishes
