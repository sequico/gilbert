# Gilbert — working law for this repository

## Identity
The project is **Gilbert** — backronym for **G**eneral-purpose **I**ntelligent
**L**ifecycle **B**utler for **E**nterprise **R**esource **T**raceability. The
codebase is still upstream ihasmail (Coffey-Labs) at heart; Gilbert is the
direction, not yet the implementation. Canonical statement: README.md top.

## Naming rule
Prose about the product may say "Gilbert". Operational identifiers still say
`ihasmail` (envs, images, service names, the hidden `ihasmail` mailbox folder,
`X-Requested-With`, package names, sw.js keys, UI defaults) and must not be
renamed in docs alone. Upstream URLs (ihasmail.org, docs.ihasmail.org,
github.com/Coffey-Labs/ihasmail) are real endpoints, never ours. Historical and
legal lines keep upstream's name. Details: skills/gilbert-branding.

## Architecture law
JMAP only, to Stalwart; no own database; everything durable lives in Stalwart;
container disposable; `IMMUTABLE=1` = no writable filesystem. Values: fail
loudly, degrade gracefully by capability, sanitise HTML, settings follow the
account (localStorage is only a cache).

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
release pre-check.
No commit or push unless the user's message in the current turn says so.
`origin/main` is **not branch-protected** (private repo): direct commit + push
to main is the normal flow.
**Releases are called manually by the user — for now there are none and none are
automated.** Never tag, publish, or trigger release/publish workflows on your
own (see `.github/workflows/release.yml`, `publish.yml`).
SECURITY.md / CONTRIBUTING.md / CODE_OF_CONDUCT.md are still upstream's process
and contacts — ask before changing or acting on them.

Full law: load skills/gilbert-project. Renames: load skills/gilbert-branding.
