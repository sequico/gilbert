---
name: gilbert-branding
description: Rename map and rules for turning "ihasmail" into "Gilbert" coherently in this repository: what the runtime-visible name is controlled by, where every remaining occurrence lives, which identifiers must move together, and what must never be renamed in docs alone. Use for any rebranding or renaming task in this repo.
metadata:
  short-description: Coherent ihasmail → Gilbert rename map
---

# Gilbert — renaming ihasmail → Gilbert

## Decided scope (2026-09-06) — full rebrand, before execution

- `APP_NAME` default becomes "Gilbert" (`DEFAULT_APP_NAME` in `brand.ts`);
  package scope becomes `@gilbert/*`; ops envs (`IHASMAIL_VERSION` build arg,
  `IHASMAIL_*` in `deploy.example.sh`) are renamed. Docs move in the same
  changes as the code that produces the names.
- The logo exists (`web/public/img/logo.png`, upstream asset) and is fine on a
  white background — it stays in the header and About until Gilbert artwork
  exists; no icon set is replaced in this pass.
- The publishing workflows stay upstream's (`ghcr.io/coffey-labs/ihasmail`)
  — Gilbert publishes no image, and editing them conflicts with upstream
  syncs, so they are left alone. `docker-compose.yml` is left as-is for now.
- **TODO — not executed:** the hidden per-account data folder (`ihasmail`,
  holding `settings.json` and the signature images) keeps its name in the
  rebrand. Renaming it is a per-account data migration needing read and
  back-compat (see Layer D), and is documented here as pending work rather
  than silently moved.

## Upstream's rebranding guide (docs.ihasmail.org/rebranding/) — binding points

- **Licence (AGPL):** a rebranded Gilbert is a derivative work, users are owed
  *this* tree's source, and running it as a service counts as distribution
  (section 13). `SOURCE_URL` is the offer: Gilbert instances must point it at
  this repository, never at upstream — check the code default and the
  examples and set them in the rebrand.
- `APP_NAME` (runtime) covers the sign-in heading, the brand in the top bar,
  the tab title after sign-in, `/api/health` and app-password labels (since
  upstream 2026.9.2+pr243, which this tree has). The startup log line keeps
  its `[ihasmail]` prefix — it names the software in a log, not the instance.
- Compiled in (own tree, own build): the sign-in tagline and footer
  (`web/src/views/Login.tsx`), `<title>` before sign-in (`web/index.html`),
  the installed-app name/description (`manifest.webmanifest`), `theme_color`
  in the manifest and `<meta name="theme-color">` in `index.html` (set both
  deliberately — upstream's two currently disagree), and the artwork/icons
  (logo, icon-192/512, icon-maskable, apple-touch-icon, favicons).
- **Do not rename** — they contain the name but are not brand surface, and
  renaming costs real data: `VERSION`/`VERIFY_KEY` in `sw.js` (invalidates
  every cached shell and stored push verification), the localStorage keys
  (`ihasmail:lastUser`, `ihasmail-theme`), the drag-and-drop MIME types
  (`application/x-ihasmail-emails` · `-folder`), and the stored
  `"ihasmail"` theme value in `settings.json` (the value is saved data; only
  the CSS palette block under `[data-palette="ihasmail"]` is visual and
  retunable). This supersedes any plan to migrate or rename storage keys and
  palette values in the rebrand.

## Where the rename stops

A full repo-wide rename is planned as the Gilbert layer. It stops at the
contribution boundary: upstream-shaped work offered to Coffey-Labs/ihasmail is
prepared on a fork branch cut from `upstream/main` with `ihasmail`
identifiers intact (ADR 0002) — never by un-renaming patches from this tree.
Do not fold a rename edit into a change that upstream could receive; the two
shapes live in two places on purpose.

## What is already done

- Docs prose (README.md, FEATURES.md, KNOWN-ISSUES.md, ROADMAP.md, CONTRIBUTING.md) says "Gilbert"; URLs, identifiers, docker command lines, the `` `ihasmail` `` folder literal, the "ihasmail" palette, and historical/legal lines keep `ihasmail`. SECURITY.md was deliberately left untouched (it is upstream's process and contact).
- The visible name is runtime-configurable already: `APP_NAME` (default constant `DEFAULT_APP_NAME = "ihasmail"` in `web/src/lib/brand.ts`; the server exposes it on `/api/config`; docker-compose and `.env.example` set the default). Running with `APP_NAME=Gilbert` brands an instance with no code change.

## Rename map (verified by grep on 2026-09-04; re-verified 2026-09-05)

Layer A — user-facing shell (safe to change together; tests may assert defaults):
- `web/index.html` — title and meta description
- `web/public/manifest.webmanifest` — name / short_name
- `web/public/sw.js` — header comment, `VERSION "ihasmail-v2"` (cache-bust), `${BASE}/ihasmail-push-verification`, notification tags `ihasmail-mail` / `ihasmail-${id}`; check server and test counterparts with grep before moving the push path
- `web/src/lib/brand.ts` — `DEFAULT_APP_NAME`
- logo assets in `web/public/img/`; the "ihasmail" palette in `web/src/lib/palette.ts`, `.palette-sources/`, `scripts/build-palettes.py` — the palette *id* and its stored value stay `ihasmail`; only the CSS colour values under `[data-palette="ihasmail"]` are visual (see the guide section)

Layer B — packages, defaults, examples (docs must move in the same change):
- package names: root `package.json` name field, `@ihasmail/server`, `@ihasmail/web`
- `docker-compose.yml` — service `ihasmail`, `image: ihasmail:2`, volume `ihasmail-data`, `APP_NAME` / `SOURCE_URL` defaults
- `.env.example` — `APP_NAME`, `SOURCE_URL`, comments
- `Dockerfile` — comments and build-arg references
- `Caddyfile.example`, `nginx.example.conf` — comments

Layer C — ops, deploy, CI:
- `deploy.example.sh` — `IHASMAIL_APP` / `IHASMAIL_NAME` / `IHASMAIL_VOLUME` / `IHASMAIL_IMMUTABLE` / `IHASMAIL_IMAGE` envs and script-name mentions
- comments in `scripts/version.mjs` (references `ihasmail-deploy.sh`)
- `.github/workflows/` — publish.yml `IMAGE: ghcr.io/coffey-labs/ihasmail`, cleanup.yml `package: ihasmail`, ci.yml build tag `ihasmail:ci`
- `IHASMAIL_VERSION` build arg (Dockerfile, workflows, docs, `scripts/version.mjs`) — a code + ops pair

Layer D — protocol and mailbox data (highest risk; never alone):
- the hidden `ihasmail` folder in every account (`settings.json`, signature images): renaming it is a per-account data migration that needs read and back-compat, never a silent move
- the `X-Requested-With: ihasmail` header — client + server + tests together
- any storage/localStorage key prefixes in `web/src/lib/storage.ts`, `settingsSync.ts` and similar — **do not rename**: they are saved data or cache identity, not brand surface (see the guide section)

Layer E — upstream and legal (do not touch without the user):
- `LICENSE`, `NOTICE` — AGPL attribution to Coffey Labs
- the historical and AGPL source-offer sentences in README.md / FEATURES.md
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` — ownership, process, contacts
- URLs to ihasmail.org / docs.ihasmail.org / demo.ihasmail.com / github.com/Coffey-Labs/ihasmail

## Rules

1. Search first, layer by layer, and judge every hit rather than assuming a category: `grep -rn ihasmail .github Dockerfile docker-compose.yml deploy.example.sh scripts server/src web/src web/index.html web/public .env.example Caddyfile.example nginx.example.conf`.
2. Identifiers move in pairs (client + server + tests + deploy + docs) inside one change set; never write a doc line that names something the code does not produce.
3. The About display is APP_NAME plus a git-derived version (`2026.8.30+pr129`); backticked version strings in docs are examples, not code.
4. After any rename: `npm run typecheck`, `npm test`, read the diff. Brand/config tests (`web/src/lib/__tests__/brand.test.ts` and friends) may assert old defaults and must be updated in the same change.
5. A deep rename diverges from upstream ihasmail — state the sync cost and confirm with the user before landing it. Keep AGPL attribution either way.
