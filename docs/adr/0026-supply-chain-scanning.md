# ADR 0026 — Supply-chain scanning in CI

Status: Accepted

Implementation: Built. `.github/workflows/ci-security.yml` runs Semgrep at
ERROR level with the `p/typescript`, `p/nodejs`, `p/security-audit` and
`p/owasp-top-ten` packs on every push and pull request and once a night, and
Gitleaks (the official action, pinned to a commit) over the history.
`.gitleaks.toml` is the allowlist for project identifiers that are not
secrets, and `.semgrepignore` scopes the scan to the code that ships: test
files reach the local mock over http and carry fixtures, which the packs' HTTP
patterns fire on by construction.

## Context

The gate ADR 0025 describes answers whether the tree builds and behaves. It
does not answer whether the tree carries something it should not. Three
kinds of finding live outside it:

- **A code pattern that is a known weakness** — an injection, an unsafe
  deserialisation, a missing bound — which the TypeScript and Node rule packs
  name but a test suite does not.
- **A credential committed to the history**, which no build, test or type
  check will ever refuse.
- **A dependency advisory**, which ADR 0025 places in the release pre-check
  (`npm run audit`).

The first two need a second toolchain and the whole history, so neither belongs
in a gate that must run before every push; the third is already placed.

## Decision

- **A separate workflow, not the fast gate.** `.github/workflows/ci-security.yml`
  runs on every push to `main`, on every pull request and once a night
  (`workflow_dispatch` too, for a re-run). It is deliberately absent from
  `check:ci`: Semgrep is a second toolchain and Gitleaks wants the full history,
  and a gate that carries them is a gate that people work around.
- **Semgrep at ERROR level only.** The four packs also carry advisory rules; a
  job that fails on advisories is a job nobody reads. Only ERROR-level findings
  fail it. Test files are scoped out (`.semgrepignore`) because they reach the
  local mock over http and carry fixtures — that is where the scan points, not
  a finding silenced.
- **Gitleaks over the history**, through the official action pinned to a commit
  (the pin rule of ADR 0025 applies to this workflow like any other). A project
  identifier that is not a secret is allowlisted in `.gitleaks.toml`, and the
  allowlist names what each entry is and why it is not a secret.
- **A finding is work to do in the same change.** Like every other gate this
  repository runs, these two report zero or they have not passed; an allowlist
  entry is for a positive proof that something is not a secret, never for
  silencing a finding.

## Consequences

- A committed credential or a known-weak pattern stops the security workflow;
  the shared history a single push to `main` already carries is scanned again
  nightly, so a rule added upstream surfaces without a new commit.
- The fast gate stays fast and offline: this workflow is the place those two
  tools live, and the release path is untouched by them.
- The Gitleaks action asks for a (free) license on repositories owned by an
  organization; the workflow passes `GITLEAKS_LICENSE` when the organization
  holds one, and the line is a harmless no-op while the action enforces
  nothing.

## References

- `.github/workflows/ci-security.yml` — the two scans
- `.gitleaks.toml` — the non-secret identifiers the scan is told about
- `.semgrepignore` — the code the SAST scan points at
- Semgrep rule packs — <https://semgrep.dev/explore>
- Gitleaks — <https://github.com/gitleaks/gitleaks>
- ADR 0025 — the one gate, the release pre-check and the audit this record
  completes
