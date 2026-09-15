---
name: gilbert-project
description: Project law and working conventions for the Gilbert repository (origin sequico/gilbert, mail core based on Coffey-Labs/ihasmail). Covers the Gilbert name and acronym, where ihasmail still legitimately appears (upstream and AGPL attribution only), architecture constraints, toolchain commands, and the change workflow. Load for any task in this repository.
metadata:
  short-description: Gilbert repo law & conventions
---

# Gilbert — project law

## 1. Identity

- The project is **Gilbert**, a backronym for **G**eneral-purpose **I**ntelligent **L**ifecycle **B**utler for **E**nterprise **R**esource **T**raceability. The canonical statement lives at the top of `README.md`; keep this skill and that file in sync.
- Gilbert is its own product, of which the mail client is one part. The mail
  client is based on [Coffey-Labs/ihasmail](https://github.com/Coffey-Labs/ihasmail)
  — remote `upstream` is no_push, `origin` is `sequico/gilbert`. Upstream is
  download-only (ADR 0002): releases are fetched directly by the merge that
  takes them in (ADR 0002) and the mail core merges them in, and nothing is
  contributed back.
  Ask before inventing product behaviour the acronym implies but
  the code does not have.
- **Snapshot mode**: files and comments describe the code as it is now; never
  narrate a rename or a migration — history lives in git.
- Licence AGPL-3.0-or-later; `LICENSE` and `NOTICE` keep Coffey Labs' copyright (the mail core is their derivative work). Do not strip attribution.

## 2. Naming rule (the one that keeps every doc coherent)

- **Prose** about the product says "Gilbert".
- **Every code and build identifier is `gilbert`** — docs must match:
  `APP_NAME`
  default "Gilbert", package names `gilbert`/`@gilbert/*`, `GILBERT_VERSION`
  build arg, `X-Requested-With: gilbert`, the visible shell
  (title/manifest/login copy) and every product-naming UI string and catalog
  key, the app folder, the sieve script name, storage keys, MIME types, the
  `[gilbert]` log prefix and the `session.gilbert` extension. Full list:
  `gilbert-branding`.
- **`ihasmail` remains only where upstream's real name must stay**: the URLs
  (ihasmail.org, docs.ihasmail.org, demo.ihasmail.com,
  github.com/Coffey-Labs/ihasmail — issues, PRs, releases), the lineage and
  AGPL attribution (`LICENSE`/`NOTICE`/`README`/ADR 0002). Never rename those,
  and never present them as Gilbert's own.

## 3. Architecture law

- JMAP only, to Stalwart. No IMAP/POP3/SMTP fallback and no database of its own: everything durable lives in Stalwart; the container is disposable; with `IMMUTABLE=1` there is no writable filesystem, and nothing Gilbert keeps durably is on it anyway (sessions included).
- **The installation's configuration is one document in Stalwart** (ADR 0012): `installation.json` in the Master account's own `gilbert` app folder, read whole at boot (`bootstrap.ts` → `config.ts`'s `useConfiguration`), created on the first boot with the defaults and a generated app secret, and edited at Administration → Installation. The environment carries the handshake, the container's own facts, the image's facts and the operator's own switch — and nothing that the document decides for a booted process. `BASE_PATH` is the image's fact rather than a document field (the build argument and the container's copy are the same value), and a production process that states no prefix refuses to serve; a key that must not be the installation's (`BASE_PATH`, `GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER`) is read from the environment and nowhere else — see `.env.example` for the list in a deployment's own words.
- `web/` = React 19 + TypeScript SPA (Vite): `src/jmap` (client/push/types), `src/store` (zustand: session, mail, compose, contacts, calendar, files, sieve, settings, mdn, scheduled), `src/lib` (incl. `src/lib/smime`: pure-TS S/MIME verification over WebCrypto), `src/views`, `src/ui`, `src/locales`. `server/` = Node + Hono proxy (`/api/jmap`, blob, upload, EventSource, image, ics) — responses compressed, the data path per-session rate-limited (`apiRateLimited`), with an optional `rawPushRelay` — and an in-memory mock Stalwart in `server/src/mock` (which serves really-signed S/MIME fixtures from `signedMessages.ts`).
- Standing values: graceful degradation per JMAP capability; fail loudly rather than quietly; sanitised HTML with remote images blocked; strict CSP; settings follow the account (`settings.json` in the account's Files) with localStorage only as a cache.
- The mock reproduces real-server quirks on purpose (per-account `urn:stalwart:jmap`, 2047-byte signatures, Stalwart's calendar vocabulary, renumbering synthetic ids). Where mock and server disagree, ask a real server.

## 4. Toolchain and gates

- Node on the latest LTS line (24 today — the Dockerfile, CI, engines and @types/node all say the same one), npm workspaces. `npm install` once.
- `npm run dev` (real Stalwart) · `npm run dev:mock` (demo@example.com / demo, mock on :8788) · `npm run dev:mock:no-future-release` · `npm run dev:mock:no-keyword-sort` · `npm run typecheck` · `npm test` (vitest for web, node:test for server) · `npm run build` · `npm start`.
- i18n: `npm run i18n:coverage`, `npm run i18n:check`; catalogs in `web/src/locales/*.ts`.
- Lint + format: **Biome** (`biome.jsonc`) via `npm run lint` / `npm run lint:fix`; part of `prepush` and of the CI release pre-check. The config is calibrated to this repo's measured style and its off-rules are deliberate and commented — never re-enable a disabled rule just to silence a file; adjust the code or argue the rule.
- Version comes from git at build time: `node scripts/version.mjs`; nothing writes a version into the tree.
- Done means: typecheck passes, the relevant tests pass, the diff has been read, and claims are verified against tests or a live server — not exit codes alone.
- Code comments, documentation and every commit message are written in **English** (repo-wide rule set by the owner). Chat replies follow the user's language — the chat is not repo content.

## 4b. Claims, documents and tests

A comment, an ADR sentence and a `FEATURES.md` bullet are **claims about the
code**, and this repo's recurring defect is a true sentence standing beside
code that stopped matching it. Three habits keep the two together:

- **Write only what you read.** Documentation written beside code that is still
  being written — by a peer agent or by you — describes the tree, never the
  work in flight. Verify the line you are describing; if it is not there yet,
  either wait or say nothing about it.
- **A change that falsifies a claim fixes the claim in the same diff.** Grep the
  sentence you just invalidated: the old behaviour usually survives in another
  file, a test's comment or an ADR. (When the ADR is `Proposed` it may be
  amended; an `Accepted` one is superseded, never edited.)
- **Every mechanism the ADR names has a test that fails if the mechanism is
  removed.** A test that only shows the code runs proves nothing about the
  guarantee. When a review names something as untested, the fix includes the
  test. A mock standing in for a server behaviour pins that assumption with a
  test next to the simulation, and the live probe it owes is written down as
  owed (see `gilbert-stalwart`).
- Reordering an effect against its intent line is a change to what a stored
  document means: run that area's tests before calling it safe.

Parallel writers (fleet work): one writer per file, disjoint `write_roots`, and
expect a peer's writes in the same checkout to cost a read-only child its
`bash` — that child verifies by reading and says what it could not run, and
**every gate stays in the parent**.

Companion skills: string/i18n work loads `gilbert-i18n`; anything settings- or policy-shaped loads `gilbert-settings`.

## 3b. The agent vocabulary and what an automation is

- **Three words, and they are not synonyms.** One **Master** is the principal
everything belongs to: the account in Stalwart (`gilbert@…`), its address, its
password, its grants and the model it runs on. Its **agents** are the processes
that act as it — what a deployment starts, what claims a group's account by
lease and runs its automations, and what the administration counts. The
group-facing surface calls them **Group Agents**; **automations** are the rules,
one document per group. An unqualified **"worker"** means the browser's service
worker and nothing else.
- **An automation is one shape (ADR 0003).** A trigger, an **instruction** in
prose, a **capability allowlist** and a **review policy** — and nothing else.
There is no tier, no category, no compiled plan: every run hands the instruction
to the model, and the model's answer is checked against the rule's own
allowlist before anything runs. **One model serves the installation** — provider,
model, base URL and a write-only key — so nothing asks an administrator which
model a kind of work deserves; an installation with no model has no automations.
The determinism that matters is the JSON answer plus the allowlist, never the
temperature: a provider reasoning in thinking mode accepts the sampling
parameters and ignores them.
- **Identifiers follow those words**, in the sweep listed in `ROADMAP.md`. Two
halves: the names (`agent.ts`, `WorkerHandle`, …) and the things that are
contracts rather than names — a field in a document an installation has already
written, a refusal code a client composes a sentence from, an environment
variable an operator set. A contract moves with every reader and writer of it in
one change, or it does not move at all; the agent environment variables
(`GILBERT_AGENT_*`) stay as they are.
- The tier vocabulary is gone from the product: what still spells it is two
test fixtures that fill a retired parameter
(`server/src/agent/scheduler.test.ts`, `web/src/lib/__tests__/agentErrors.test.ts`),
the record of what it was (ADR 0003) and in German words like
"exportiert".

## 5. Change workflow

- Read `README.md` and the affected area before editing; smallest coherent diff; report adjacent issues rather than silently expanding scope.
- No commit and no push unless the user's message in the current turn says "commit" or "push".
- **Releases are manual.** The user calls releases by hand; for now there are none and none are automated. Never tag, create a release, or trigger the upstream release/publish workflows (`.github/workflows/release.yml`, `publish.yml`) on your own.
- `SECURITY.md`, `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` still describe upstream's process and contacts (Coffey Labs, johnellisATlinuxDOTcom). Before rewriting them or acting on them, ask the user.
- A deep rename diverges from upstream and complicates every future sync — state that cost before doing one (see `gilbert-branding`).
- **Upstream is download-only (ADR 0002).** Upstream releases are fetched
  directly by the merge that takes them in (ADR 0002) — there is no mirror
  branch — and the mail core merges them in. Nothing flows back — no PRs to
  Coffey-Labs/ihasmail, no upstream-shaped
  fork, no un-renaming. The sync direction stays upstream → main.
- Syncing upstream: upstream's locale catalogs are a key-superset of Gilbert's trimmed ones and more complete — when catalog files conflict, adopt the upstream catalog wholesale rather than merging entries, then run `npm run i18n:check`. Upstream's `CLAUDE.md` and `.github/FUNDING.yml` stay excluded (owner decision); monitor `CLAUDE.md` for agent guidance worth porting into this file or the skills.
