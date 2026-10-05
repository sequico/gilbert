# Contributing to Gilbert

Gilbert is a self-hosted mail suite — mail, calendars, contacts, files — with AI
agents inside it, built on [Stalwart](https://stalw.art) over JMAP. Bug reports,
feature requests, code, documentation and testing are all welcome.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

- **JMAP only.** Gilbert speaks JMAP to Stalwart; there is no IMAP/POP3/SMTP
  fallback. Features should not add one.
- **No database of its own.** Every durable byte lives in Stalwart, under the
  account it belongs to. A new persistence layer needs discussion first.
- **AGPL-3.0-or-later.** Contributions are distributed under this licence,
  including in hosted deployments.
- **Signed-off commits.** Every commit is certified under the
  [Developer Certificate of Origin](DCO): a `Signed-off-by: Name <email>` line,
  added with `git commit -s`, matching the commit's author or committer. The
  `DCO` workflow refuses a pull request whose commits are not signed off.

## Development setup

Requirements: Node ≥ 24 on the **latest LTS line** — 24 is what the image and CI
pin, and a Current release is not supported — and npm ≥ 10.

```bash
git clone https://github.com/sequico/gilbert.git && cd gilbert
npm install

npm run dev            # a real Stalwart (STALWART_URL in .env) — server :8080, Vite :5173
npm run dev:mock       # built-in mock Stalwart (demo@example.com / demo), mock on :8788
npm run dev:mock:agent # the same plus an agent process

npm run typecheck      # tsc for both packages
npm test               # vitest (web) + node:test (server)
npm run build          # web/dist + server/dist
npm start              # serve the production build
```

Open http://localhost:5173 in dev, or http://localhost:8080 for the production
build. Installing Gilbert for real is [INSTALL.md](INSTALL.md).

The tests assume the runner's local timezone is **UTC** (GitHub's default); on a
non-UTC machine run them as `TZ=UTC npm test`.

### The mock

The in-memory fake Stalwart 0.16 is enough JMAP to develop and demo against
without a real mailbox. It reproduces the quirks a naive fake gets wrong
(`urn:stalwart:jmap` advertised per-account, identity signatures capped at 2047
bytes, Stalwart's calendar vocabulary), and it tracks the current release. Four
switches:

| Name | Effect |
| --- | --- |
| `MOCK_NO_FUTURE_RELEASE=1` | advertises FUTURERELEASE and then drops every hold |
| `MOCK_NO_REGISTRY=1` | omits the Stalwart capability, so the sign-in refusal can be tested |
| `MOCK_NO_SCHEDULING_SEND=1` | refuses a calendar write that asks for scheduling messages |
| `MOCK_NO_KEYWORD_SORT=1` | serves a server without keyword sorting, so the fallback can be developed against |

Each behaviour is confirmed against a real server before it is copied here; the
comments say which version and on what date.

## The gate

`npm run check:ci` is the one gate, in order: typecheck, Biome, the check scripts
(`adr:owed`, `adr:cite`, `config:dead`, `workflow:pin`, `i18n:check`), the tests
in UTC and the build. The pre-push hook runs the same pipeline as
`npm run prepush`; enable it once per clone:

```bash
git config core.hooksPath .githooks
```

A push that fails the gate is refused. Bypass it (`--no-verify`) only
deliberately and knowingly. `main` is branch-protected: a force push and a
branch deletion are refused, but no review or status check is required.

`npm run check:release` is `check:ci` then `codeql`; `npm run prepush:full` runs
it. **The gate reports zero, or it has not passed:** every error and warning a
gate prints is fixed, whoever wrote the line.

### Code scanning

The **CodeQL** analysis runs where a release is prepared, not on every push — a
686 MB toolchain and minutes of analysis. It is `.github/workflows/codeql.yml`,
called by the release workflow as a pre-check and run weekly and on demand
besides. `npm run codeql` runs the same JavaScript/TypeScript suite on this
checkout. The CLI is found through `CODEQL_CLI`, on `PATH`, or in
`~/.cache/gilbert/codeql`; without one the run fails with the install
instructions rather than reporting a clean tree. An alert is work to do in the
same change.

## Code style

- Formatting and linting are **Biome's** (`biome.jsonc`, calibrated to this
  repo's style): `npm run lint` to check, `npm run lint:fix` to apply.
- Match the surrounding naming and structure; keep changes to the smallest
  coherent diff.
- Prefer clarity over cleverness. Comment non-obvious JMAP interactions,
  especially around state/`changes` handling.

## Translations

Eleven languages ship alongside English in `web/src/locales/`: German, Spanish,
French, Italian, Dutch, Portuguese (Brazil), Russian, Ukrainian, Simplified
Chinese, Japanese and Turkish. A missing key renders its English source rather
than failing, so an untranslated string is invisible until somebody reading that
language finds it.

**Any change that adds or alters a user-visible string adds work in every
catalogue.** State in the PR how many keys, and the fallback count before and
after — and say so explicitly when a change adds none.

```bash
npm run i18n:check                    # literals wrapped, and catalogue health
node scripts/i18n-catalog-check.mjs   # per-language: translated / used / falling back
```

Compare the "falling back to English" number against `main` before and after: it
should not rise. Do not read the percentage instead — adding keys moves the
denominator, so it can hold steady while new strings go untranslated.

The catalogue key for a plural is the **`other`** form: `plural()` looks the
entry up by `forms.other`, so a site written
`plural(n, { one: "Deleted {n} contact", other: "Deleted {n} contacts" })` is
keyed on `"Deleted {n} contacts"`. Keying it on `one` type-checks, builds, passes
every test and silently falls back to English everywhere. Plural forms are per
language, from `Intl.PluralRules`: `one`/`other` for most,
`one`/`few`/`many`/`other` for Russian and Ukrainian, `other` alone for Japanese
and Chinese.

## Verifying UI work

Store tests do not exercise the component: a value measured inside a `setState`
updater is applied after React has moved the anchor that measured it, so every
store assertion can pass while the built app does the wrong thing. If a change is
visible on screen, run it (`npm run dev:mock`, credentials printed on start) and
drive the real thing; then add a component test for what you find, with examples
in `web/src/views/*/__tests__/`.

## Reporting bugs and suggestions

Search [existing issues](https://github.com/sequico/gilbert/issues) first. A
useful report has a clear title, steps to reproduce, expected versus actual
behaviour, your environment (browser/OS, Stalwart version, how Gilbert is
deployed) and any logs or screenshots. Feature requests should describe the
problem being solved, not only the proposed solution. For larger changes, open
an issue to discuss the approach before writing a pull request.

## Pull requests

1. Branch from `main` with a descriptive name (`fix/thread-view-scroll`).
2. Keep one logical change per PR; write clear commit messages, each signed off
   (`git commit -s`).
3. Test against a real (or the mock) Stalwart instance where the change touches
   protocol behaviour.
4. Update documentation when setup, configuration or user-facing behaviour
   changes.
5. Fill in the pull request template with a summary, related issues, screenshots
   for UI changes and the manual testing performed.

A maintainer reviews the PR and may request changes; PRs with no activity for an
extended period may be closed and reopened once updated.

## Reporting security issues

**Do not open a public issue for a vulnerability.** Report it privately — see
[SECURITY.md](SECURITY.md) for the route and what happens next.

## Questions

If you are unsure whether something fits, open an issue and ask before investing
time in a PR.
