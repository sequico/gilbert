---
name: gilbert-branding
description: Rename map and rules for turning "ihasmail" into "Gilbert" coherently in this repository: what the runtime-visible name is controlled by, where every remaining occurrence lives, which identifiers must move together, and what must never be renamed in docs alone. Use for any rebranding or renaming task in this repo.
metadata:
  short-description: Coherent ihasmail → Gilbert rename map
---

# Gilbert — renaming ihasmail → Gilbert

## What is already done

- Docs prose (README.md, FEATURES.md, KNOWN-ISSUES.md, ROADMAP.md, CONTRIBUTING.md) says "Gilbert"; URLs, identifiers, docker command lines, the `` `ihasmail` `` folder literal, the "ihasmail" palette, and historical/legal lines keep `ihasmail`. SECURITY.md was deliberately left untouched (it is upstream's process and contact).
- The visible name is runtime-configurable already: `APP_NAME` (default constant `DEFAULT_APP_NAME = "ihasmail"` in `web/src/lib/brand.ts`; the server exposes it on `/api/config`; docker-compose and `.env.example` set the default). Running with `APP_NAME=Gilbert` brands an instance with no code change.

## Rename map (verified by grep on 2026-09-04)

Layer A — user-facing shell (safe to change together; tests may assert defaults):
- `web/index.html` — title and meta description
- `web/public/manifest.webmanifest` — name / short_name
- `web/public/sw.js` — header comment, `VERSION "ihasmail-v2"` (cache-bust), `${BASE}/ihasmail-push-verification`, notification tags `ihasmail-mail` / `ihasmail-${id}`; check server and test counterparts with grep before moving the push path
- `web/src/lib/brand.ts` — `DEFAULT_APP_NAME`
- logo assets in `web/public/img/`; the "ihasmail" palette in `web/src/lib/palette.ts`, `.palette-sources/`, `scripts/build-palettes.py`

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
- any storage/localStorage key prefixes in `web/src/lib/storage.ts`, `settingsSync.ts` and similar (cache keys only, but check)

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
