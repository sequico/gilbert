# Gilbert — working law for this repository

## Identity
The project is **Gilbert** — a distinct application, backronym for
**G**eneral-purpose **I**ntelligent **L**ifecycle **B**utler for
**E**nterprise **R**esource **T**raceability. Its mail client is based on
upstream ihasmail (Coffey-Labs), which is download-only (ADR 0002): releases
sync in, nothing goes back. Canonical statement: README.md top.

## Snapshot mode
Files and comments describe the code as it is now. Never write "it used to
be X, then it became Y", never narrate a rename, a migration or any
before/after. If somebody wants history, it is in git.

## Naming rule
Prose about the product says "Gilbert", and every code and build identifier
is `gilbert`: `APP_NAME` default "Gilbert", packages `gilbert`/`@gilbert/*`,
`GILBERT_VERSION`, `X-Requested-With: gilbert`, UI strings and catalogs, the
app folder, the sieve script name, storage keys, the `[gilbert]` log prefix,
the `session.gilbert` extension, MIME types, docker/deploy identifiers and
paths. `ihasmail` appears only where upstream's real name must stay: the URLs
(ihasmail.org, docs.ihasmail.org, github.com/Coffey-Labs/ihasmail), the
lineage and the AGPL attribution in `LICENSE`/`NOTICE`/`README`/ADR 0002, and
the `ihasmail` branch that mirrors upstream releases.

## Architecture law
JMAP only, to Stalwart; no own database; everything durable lives in Stalwart;
container disposable; `IMMUTABLE=1` = no writable filesystem. Values: fail
loudly, degrade gracefully by capability, sanitise HTML, settings follow the
account (localStorage is only a cache).

## Architecture decisions (ADR)
Decisions that shape the architecture — where durable state lives, a protocol
surface, a trust boundary, an enforcement door, or a documented invariant —
are recorded as Architecture Decision Records under `docs/adr/`, one file per
decision: `NNNN-kebab-case-title.md` starting at `0001`, written in English,
with a `Status` line (Proposed / Accepted / Superseded) and Context, Decision
and Consequences sections.
Write the ADR when the change is designed, before or alongside the
implementation, so the design is reviewable first; an implementation must
match the standing (newest non-superseded) ADR that covers it. Changing a
standing decision means a new ADR that supersedes the old one — never edit an
accepted ADR's history. ADRs stay `Proposed` until the owner accepts them.

## Toolchain
Node ≥ 20.10, npm workspaces. `npm run dev` · `dev:mock` (demo@example.com /
demo) · `dev:mock:no-future-release` · `typecheck` · `test` · `build`.
**Lint + format gate: Biome** (`biome.jsonc` — calibrated to this repo's
actual style, with deliberate, commented rule exceptions; a11y off). Run with
`npm run lint` / `npm run lint:fix`; it is part of `prepush` and of the CI
release pre-check.
**Tests assume the runner's local timezone is UTC** (GitHub's default); on a
non-UTC machine run them as `TZ=UTC npm test` — `prepush` already forces it so
the local gate matches CI.
Version from git at build time (`node scripts/version.mjs`).

## Language
Code comments, documentation, commit messages and every other file in the repo
are written in **English**. Never write or translate repo content into another
language. Chat replies follow the user's language — the chat is not repo
content.

## Workflow
Read the affected area first; smallest coherent diff.
**Dispatched sub-agents are health-checked automatically, never on request:**
poll each running agent at least every ~60 s (steps advancing, live tool
calls, processes, worktree writes / file mtimes). An agent with no progress
across consecutive polls, or that dies or is cancelled, is investigated and
replaced or recovered immediately — never left until the user notices.
**Cost and time discipline (global user rule, active here):** agents read only
the diff hunks under review plus the functions they directly call — targeted
grep/sed/read slices, never whole large files; review agents do not run full
test suites (the parent runs the gate); large reviews are split into small
parallel reviewers by area; deep reasoning is reserved for security-critical
surfaces. An agent that drifts into wide exploration gets a converge-now
instruction rather than being left to widen scope.
**Every push is gated by the fast CI** (`npm run prepush`: typecheck + Biome
lint + tests); a pre-push hook enforces it — hook in `.githooks/pre-push`,
enabled per clone with `git config core.hooksPath .githooks`, bypass only
deliberately with `--no-verify`. Remote CI does not run on push: it is the
release pre-check, with one exception -- pull requests opened by Dependabot run
it automatically (their branches never pass through the local hook).
No commit or push unless the user's message in the current turn says so.
`origin/main` is **not branch-protected** (private repo): direct commit + push
to main is the normal flow.
**Releases are called manually by the user — for now there are none and none are
automated.** Never tag, publish, or trigger release/publish workflows on your
own (see `.github/workflows/release.yml`, `publish.yml`).
SECURITY.md / CONTRIBUTING.md / CODE_OF_CONDUCT.md are still upstream's process
and contacts — ask before changing or acting on them.
**Upstream is download-only (ADR 0002):** `sync-upstream.yml` mirrors
upstream releases onto the `ihasmail` branch and the mail core merges them
in. Nothing flows the other way — no contributions, no PRs, no upstream-shaped
fork. Common work stays here, renamed or not.

Full law: load skills/gilbert-project. Renames: load skills/gilbert-branding.
UI strings & languages: load skills/gilbert-i18n. Settings & policy: load
skills/gilbert-settings. Stalwart internals, quirks & integration: load
skills/gilbert-stalwart. Upstream merges: load skills/gilbert-upstream-rebrand.
