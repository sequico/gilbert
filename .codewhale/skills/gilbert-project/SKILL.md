---
name: gilbert-project
description: Project law and working conventions for the Gilbert repository (origin sequico/gilbert, codebase derived from Coffey-Labs/ihasmail). Covers the Gilbert name and acronym, which identifiers still say "ihasmail" and why, architecture constraints, toolchain commands, and the change workflow. Load for any task in this repository.
metadata:
  short-description: Gilbert repo law & conventions
---

# Gilbert — project law

## 1. Identity

- The project is **Gilbert**, a backronym for **G**eneral-purpose **I**ntelligent **L**ifecycle **B**utler for **E**nterprise **R**esource **T**raceability. The canonical statement lives at the top of `README.md`; keep this skill and that file in sync.
- History: this repo descends from [Coffey-Labs/ihasmail](https://github.com/Coffey-Labs/ihasmail) — remote `upstream` is no_push, `origin` is `sequico/gilbert`. The code is a rebranded and diverging descendant (rebrand executed 2026-09-06, see `gilbert-branding`); upstream merges keep flowing in, and common work is contributed back from an upstream-shaped fork (ADR 0002). Ask before inventing product behaviour the acronym implies but the code does not have.
- Licence AGPL-3.0-or-later; `LICENSE` and `NOTICE` keep Coffey Labs' copyright. Do not strip attribution.

## 2. Naming rule (the one that keeps every doc coherent)

- **Prose** about the product says "Gilbert".
- **Renamed in the 2026-09-06 rebrand** — docs must match: `APP_NAME`
  default "Gilbert", package names `gilbert`/`@gilbert/*`, `GILBERT_VERSION`
  build arg, `X-Requested-With: gilbert`, the visible shell
  (title/manifest/login copy) and every product-naming UI string and catalog
  key. Full list: `gilbert-branding`.
- **Still `ihasmail` on purpose** — data or deployed surface, renamed costs
  real data and gains nothing: device storage keys, sw.js keys, drag-drop MIME
  types, the sieve script name,
  the stored `"ihasmail"` theme value, the `[ihasmail]` log prefix, the
  `session.ihasmail` extension, docker/deploy identifiers, `/etc/ihasmail`
  and `/srv/ihasmail` paths, upstream URLs, legal/historical lines. These are
  never renamed in docs alone.
- **The per-account app folder is the one rename that has happened** (done
  2026-09-06): it is now `gilbert`; a leftover `ihasmail` folder is renamed in
  place on first open (`web/src/lib/appFolder.ts`). Its device storage keys
  and the signature HTML marker stay `ihasmail`.
- **Upstream URLs are real endpoints, not ours**: ihasmail.org,
  docs.ihasmail.org, demo.ihasmail.com, github.com/Coffey-Labs/ihasmail
  (issues, PRs, releases). Link them, never present them as Gilbert's own.
- Renaming anything in the still-`ihasmail` list is a coordinated task
  (data migration or sync cost) — load the `gilbert-branding` skill and say
  so before doing it.

## 3. Architecture law

- JMAP only, to Stalwart. No IMAP/POP3/SMTP fallback and no database of its own: everything durable lives in Stalwart; the container is disposable; with `IMMUTABLE=1` there is no writable filesystem (`SESSION_FILE` is the one optional write path).
- `web/` = React 19 + TypeScript SPA (Vite): `src/jmap` (client/push/types), `src/store` (zustand: session, mail, compose, contacts, calendar, tasks, files, sieve, settings, mdn, scheduled), `src/lib` (incl. `src/lib/smime`: pure-TS S/MIME verification over WebCrypto), `src/views`, `src/ui`, `src/locales`. `server/` = Node + Hono proxy (`/api/jmap`, blob, upload, EventSource, image, ics) — responses compressed, the data path per-session rate-limited (`apiRateLimited`), with an optional `rawPushRelay` — and an in-memory mock Stalwart in `server/src/mock` (which serves really-signed S/MIME fixtures from `signedMessages.ts`).
- Standing values: graceful degradation per JMAP capability; fail loudly rather than quietly; sanitised HTML with remote images blocked; strict CSP; settings follow the account (`settings.json` in the account's Files) with localStorage only as a cache.
- The mock reproduces real-server quirks on purpose (per-account `urn:stalwart:jmap`, 2047-byte signatures, Stalwart's calendar vocabulary, renumbering synthetic ids). Where mock and server disagree, ask a real server.

## 4. Toolchain and gates

- Node ≥ 20.10 (22 recommended), npm workspaces. `npm install` once.
- `npm run dev` (real Stalwart) · `npm run dev:mock` (demo@example.com / demo, mock on :8788) · `npm run dev:mock:no-future-release` · `npm run dev:mock:no-keyword-sort` · `npm run typecheck` · `npm test` (vitest for web, node:test for server) · `npm run build` · `npm start`.
- i18n: `npm run i18n:coverage`, `npm run i18n:check`; catalogs in `web/src/locales/*.ts`.
- Lint + format: **Biome** (`biome.jsonc`) via `npm run lint` / `npm run lint:fix`; part of `prepush` and of the CI release pre-check. The config is calibrated to this repo's measured style and its off-rules are deliberate and commented — never re-enable a disabled rule just to silence a file; adjust the code or argue the rule.
- Version comes from git at build time: `node scripts/version.mjs`; nothing writes a version into the tree.
- Done means: typecheck passes, the relevant tests pass, the diff has been read, and claims are verified against tests or a live server — not exit codes alone.
- Code comments, documentation and every commit message are written in **English** (repo-wide rule set by the owner). Chat replies follow the user's language — the chat is not repo content.

Companion skills: string/i18n work loads `gilbert-i18n`; anything settings- or policy-shaped loads `gilbert-settings`.

## 5. Change workflow

- Read `README.md` and the affected area before editing; smallest coherent diff; report adjacent issues rather than silently expanding scope.
- No commit and no push unless the user's message in the current turn says "commit" or "push".
- **Releases are manual.** The user calls releases by hand; for now there are none and none are automated. Never tag, create a release, or trigger the upstream release/publish workflows (`.github/workflows/release.yml`, `publish.yml`) on your own.
- `SECURITY.md`, `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` still describe upstream's process and contacts (Coffey Labs, johnellisATlinuxDOTcom). Before rewriting them or acting on them, ask the user.
- A deep rename diverges from upstream and complicates every future sync — state that cost before doing one (see `gilbert-branding`).
- **Upstream contributions (ADR 0002).** Common work is contributed from an
  upstream-shaped fork branch cut from `upstream/main`, never from the
  rebranded main and never carrying Gilbert identifiers or features; the sync
  direction stays upstream → main, and the `ihasmail` branch mirrors upstream
  releases. Do not fold a rebranding edit into a common change: rebranding is
  the Gilbert layer and stays here.
- Syncing upstream: upstream's locale catalogs are a key-superset of Gilbert's trimmed ones and more complete — when catalog files conflict, adopt the upstream catalog wholesale rather than merging entries, then run `npm run i18n:check`. Upstream's `CLAUDE.md` and `.github/FUNDING.yml` stay excluded (owner decision); monitor `CLAUDE.md` for agent guidance worth porting into this file or the skills.
