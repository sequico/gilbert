---
name: gilbert-project
description: Project law and working conventions for the Gilbert repository (origin sequico/gilbert, codebase derived from Coffey-Labs/ihasmail). Covers the Gilbert name and acronym, which identifiers still say "ihasmail" and why, architecture constraints, toolchain commands, and the change workflow. Load for any task in this repository.
metadata:
  short-description: Gilbert repo law & conventions
---

# Gilbert — project law

## 1. Identity

- The project is **Gilbert**, a backronym for **G**eneral-purpose **I**ntelligent **L**ifecycle **B**utler for **E**nterprise **R**esource **T**raceability. The canonical statement lives at the top of `README.md`; keep this skill and that file in sync.
- History: this repo tracks [Coffey-Labs/ihasmail](https://github.com/Coffey-Labs/ihasmail) — remote `upstream` is no_push, `origin` is `sequico/gilbert`. The code is still upstream ihasmail; Gilbert is the direction the user is building toward, not yet the implementation. Ask before inventing product behaviour the acronym implies but the code does not have.
- Licence AGPL-3.0-or-later; `LICENSE` and `NOTICE` keep Coffey Labs' copyright. Do not strip attribution.

## 2. Naming rule (the one that keeps every doc coherent)

- **Prose** about the product may say "Gilbert".
- **Operational identifiers still say `ihasmail`** and must not be renamed in docs alone, because docs must match the code. They stay until a coordinated code rename: env vars and build args (`IHASMAIL_VERSION`, `APP_NAME` default, `IHASMAIL_*`), images (`ghcr.io/coffey-labs/ihasmail`, `ihasmail:2`), container/service/volume names, `/etc/ihasmail` and `/srv/ihasmail` paths, the hidden `ihasmail` JMAP folder in every account (settings + signature images), the About/version string (`ihasmail v2026.8.30+pr129` is an example of APP_NAME + version), `X-Requested-With: ihasmail`, `@ihasmail/*` package names, sw.js cache keys/push-verification path/notification tags, `web/index.html` and manifest defaults.
- **Upstream URLs are real endpoints, not ours**: ihasmail.org, docs.ihasmail.org, demo.ihasmail.com, github.com/Coffey-Labs/ihasmail (issues, PRs, releases). Link them, never present them as Gilbert's own.
- **Historical and legal lines keep upstream's name**: "ihasmail was relicensed from GPL-3.0 to AGPL-3.0…", "If you run a modified ihasmail, set `SOURCE_URL`…".
- Renaming an identifier is a coordinated task — load the `gilbert-branding` skill.

## 3. Architecture law

- JMAP only, to Stalwart. No IMAP/POP3/SMTP fallback and no database of its own: everything durable lives in Stalwart; the container is disposable; with `IMMUTABLE=1` there is no writable filesystem (`SESSION_FILE` is the one optional write path).
- `web/` = React 19 + TypeScript SPA (Vite): `src/jmap` (client/push/types), `src/store` (zustand: session, mail, compose, contacts, calendar, files, sieve, settings), `src/lib`, `src/views`, `src/ui`, `src/locales`. `server/` = Node + Hono proxy (`/api/jmap`, blob, upload, EventSource, image) with an in-memory mock Stalwart in `server/src/mock`.
- Standing values: graceful degradation per JMAP capability; fail loudly rather than quietly; sanitised HTML with remote images blocked; strict CSP; settings follow the account (`settings.json` in the account's Files) with localStorage only as a cache.
- The mock reproduces real-server quirks on purpose (per-account `urn:stalwart:jmap`, 2047-byte signatures, Stalwart's calendar vocabulary, renumbering synthetic ids). Where mock and server disagree, ask a real server.

## 4. Toolchain and gates

- Node ≥ 20.10 (22 recommended), npm workspaces. `npm install` once.
- `npm run dev` (real Stalwart) · `npm run dev:mock` (demo@example.com / demo, mock on :8788) · `npm run dev:mock:no-future-release` · `npm run typecheck` · `npm test` (vitest for web, node:test for server) · `npm run build` · `npm start`.
- i18n: `npm run i18n:coverage`, `npm run i18n:check`; catalogs in `web/src/locales/*.ts`.
- Version comes from git at build time: `node scripts/version.mjs`; nothing writes a version into the tree.
- Done means: typecheck passes, the relevant tests pass, the diff has been read, and claims are verified against tests or a live server — not exit codes alone.
- English everywhere in the repo (code, comments, docs, commits). Chat language follows the user.

## 5. Change workflow

- Read `README.md` and the affected area before editing; smallest coherent diff; report adjacent issues rather than silently expanding scope.
- No commit and no push unless the user's message in the current turn says "commit" or "push".
- **Releases are manual.** The user calls releases by hand; for now there are none and none are automated. Never tag, create a release, or trigger the upstream release/publish workflows (`.github/workflows/release.yml`, `publish.yml`) on your own.
- `SECURITY.md`, `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` still describe upstream's process and contacts (Coffey Labs, johnellisATlinuxDOTcom). Before rewriting them or acting on them, ask the user.
- A deep rename diverges from upstream and complicates every future sync — state that cost before doing one (see `gilbert-branding`).
