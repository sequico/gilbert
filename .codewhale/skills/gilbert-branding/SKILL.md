---
name: gilbert-branding
description: The ihasmail → gilbert rename map for the Gilbert mail core: what the 2026-09-06 rename changed, where `ihasmail` still legitimately appears (upstream and AGPL attribution only), and the upstream contribution boundary. Use for any rebranding or renaming task in this repo.
metadata:
  short-description: mail core's ihasmail → gilbert rename state & rules
---

# Gilbert — the mail core's ihasmail → gilbert rename

## The mail core was renamed (2026-09-06)

Gilbert is not a rebrand of ihasmail: it is a different product, of which the
mail client is one part. That mail client's code and build identifiers came
from ihasmail and now say "gilbert"; docs must match them:

- Visible shell: `<title>`/meta in `web/index.html`, the manifest
  (`name`/`short_name`/`description` in `web/public/manifest.webmanifest`),
  the login tagline ("General-purpose Intelligent Lifecycle Butler for
  Enterprise Resource Traceability"), every user-visible string that named the
  product (all nine locale catalogs follow the English keys).
- `APP_NAME` default is "Gilbert": `DEFAULT_APP_NAME` in
  `web/src/lib/brand.ts` and the server config default. The About/version
  line and the login version line show the instance name dynamically.
- `SOURCE_URL` default is this repository (`server/src/config.ts`,
  `web/src/lib/source.ts`) — the AGPL section-13 offer points at Gilbert's own
  tree, never upstream's.
- Packages: root `gilbert`, `@gilbert/server`, `@gilbert/web` (lockfile
  updated). The version build arg/env is `GILBERT_VERSION` (Dockerfile,
  `scripts/version.mjs`, `server/src/version.test.ts`), the Vite build define
  is `__GILBERT_VERSION__`.
- The CSRF header value is `X-Requested-With: gilbert` (client, server check
  and tests moved together); the settings export file is
  `gilbert-settings.json`; the MDN reporting UA says `Gilbert 2.0`; the sieve
  script preamble says `# Gilbert filters v1`; the image-proxy UA is
  `gilbert-image-proxy`; the TOTP issuer falls back to `Gilbert`.
- Everything internal that once said `ihasmail` now says `gilbert`: the
  per-account app folder, the sieve script name (`GILBERT_SCRIPT`), device
  storage keys (`gilbert:*`), drag-drop MIME types (`application/x-gilbert-*`),
  the Web Push device-id prefix and `gilbert-push-verification` path, the
  `[gilbert]` log prefix, the `session.gilbert` extension, the crypto sealing
  context `gilbert-session-v1`, the stored `gilbert` theme/palette id, the
  signature HTML marker `<!--gilbert:sig=…-->`, and the docker service/volume
  (`gilbert`, `gilbert-data`) and deploy script (`GILBERT_*` envs).
- The CI/CD pipeline is this repository's own since commit `6cfb614`:
  `publish.yml` publishes `ghcr.io/sequico/gilbert` (multi-arch, never
  upstream's org), `cleanup.yml` prunes `gilbert`, `release.yml` is the
  manual release flow (user calls it; it tags, creates the GitHub release and
  calls publish). `ci.yml` builds `gilbert:ci`. Only `sync-upstream.yml`
  touches upstream — it mirrors upstream releases onto the `ihasmail` branch.

## What still says `ihasmail` (upstream and AGPL attribution only)

`ihasmail` remains only where upstream's real name must stay — it is never
brand surface and never ours:

- upstream URLs: ihasmail.org, docs.ihasmail.org, demo.ihasmail.com,
  github.com/Coffey-Labs/ihasmail (issues, PRs, releases);
- the lineage and AGPL attribution in `README`, `LICENSE`, `NOTICE`,
  `FEATURES`, `KNOWN-ISSUES`, `ROADMAP`, ADR 0002 and the legal lines in
  upstream-owned docs ("relicensed from GPL-3.0…", "If you run a modified
  ihasmail, set `SOURCE_URL`…");
- `SECURITY.md`/`CONTRIBUTING.md`/`CODE_OF_CONDUCT.md` (upstream's process and
  contacts — ask before changing or acting on them);
- the `ihasmail` branch that `sync-upstream.yml` mirrors upstream releases
  onto.

## Where upstream stops

Upstream is **download-only** (ADR 0002): `sync-upstream.yml` mirrors
upstream releases onto the `ihasmail` branch, and the mail core merges them
in. Nothing is contributed back — no upstream-shaped fork, no un-renaming
patches, no PRs to Coffey-Labs/ihasmail; common work simply lives here.
Upstream's rebranding guide
(docs.ihasmail.org/rebranding/) is the reference for the licence obligations
that survive: Gilbert is AGPL, users are owed *this* tree's source, and
running it as a service counts as distribution — `SOURCE_URL` is the offer
and already defaults here.

## Rules for any future rename

1. Search first, layer by layer, judge every hit rather than assuming a
   category: `grep -rn gilbert .github Dockerfile docker-compose.yml
   deploy.example.sh scripts server/src web/src web/index.html web/public
   .env.example Caddyfile.example nginx.example.conf settings-policy.example.json`.
2. Identifiers move in pairs (client + server + tests + deploy + docs) inside
   one change set; never write a doc line that names something the code does
   not produce.
3. After any rename: `npm run typecheck`, `npm test`, read the diff.
   Brand/config tests may assert old defaults and must move in the same
   change.
4. Only the upstream/AGPL list above may keep saying `ihasmail` — everything
   else is a rename that is simply incomplete, not "kept on purpose".
