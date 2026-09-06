# Gilbert — working law for this repository

## Identity
The project is **Gilbert** — backronym for **G**eneral-purpose **I**ntelligent
**L**ifecycle **B**utler for **E**nterprise **R**esource **T**raceability. The
codebase descends from upstream ihasmail (Coffey-Labs); the visible-shell
rebrand and the identifier renames landed 2026-09-06, the core still syncs
upstream, and the product direction is not yet the full implementation.
Canonical statement: README.md top.

## Naming rule
Prose about the product says "Gilbert". The 2026-09-06 rebrand renamed the
visible shell and the code/build identifiers: `APP_NAME` default "Gilbert",
packages `gilbert`/`@gilbert/*`, `GILBERT_VERSION`, `X-Requested-With: gilbert`,
UI strings and catalogs. A second set still says `ihasmail` **on purpose** —
it is data or deployed surface, and renaming it costs real data or a sync
conflict: device storage keys, sw.js
keys, drag-drop MIME types, the sieve script name, the stored `"ihasmail"`
theme value, the `[ihasmail]` log prefix, the `session.ihasmail` extension,
docker/deploy identifiers, `/etc/ihasmail` and `/srv/ihasmail` paths. Upstream
URLs (ihasmail.org, docs.ihasmail.org, github.com/Coffey-Labs/ihasmail) are
real endpoints, never ours; historical and legal lines keep upstream's name.
The per-account app folder is the exception that has been renamed: it is now
`gilbert`, migrated in place from a leftover `ihasmail` folder on first open
(the one data migration carried out so far). The lists and the next open
item (the single-host deploy script, ROADMAP.md): skills/gilbert-branding.

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
**Upstream contributions (ADR 0002):** common work offered to Coffey-Labs/
ihasmail is prepared on a branch cut from `upstream/main` in an upstream-shaped
contribution fork — never from the rebranded `main`, never carrying Gilbert
identifiers or features. The sync direction stays upstream → main; the
`ihasmail` branch mirrors upstream releases. Rebranding is the Gilbert layer
and stays in this repo.

Full law: load skills/gilbert-project. Renames: load skills/gilbert-branding.
UI strings & languages: load skills/gilbert-i18n. Settings & policy: load
skills/gilbert-settings. Stalwart internals, quirks & integration: load
skills/gilbert-stalwart.
