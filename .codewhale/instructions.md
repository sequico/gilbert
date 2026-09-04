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
Version from git at build time (`node scripts/version.mjs`).

## Workflow
Read the affected area first; smallest coherent diff; verify with typecheck +
tests and read the diff. English in all repo content; chat follows the user.
No commit or push unless the user's message in the current turn says so.
`origin/main` is **not branch-protected** (private repo): direct commit + push
to main is the normal flow.
**Releases are called manually by the user — for now there are none and none are
automated.** Never tag, publish, or trigger release/publish workflows on your
own (see `.github/workflows/release.yml`, `publish.yml`).
SECURITY.md / CONTRIBUTING.md / CODE_OF_CONDUCT.md are still upstream's process
and contacts — ask before changing or acting on them.

Full law: load skills/gilbert-project. Renames: load skills/gilbert-branding.
