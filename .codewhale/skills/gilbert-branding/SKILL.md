---
name: gilbert-branding
description: The ihasmail → Gilbert rename map for the Gilbert repository: what the 2026-09-06 rebrand changed, which identifiers deliberately still say "ihasmail" (data or deployed surface) and why, what remains to do (the hidden data folder), and the upstream contribution boundary. Use for any rebranding or renaming task in this repo.
metadata:
  short-description: ihasmail → Gilbert rename state & rules
---

# Gilbert — the ihasmail → Gilbert rename

## Rebrand executed (2026-09-06)

The coordinated code rename landed in layers; these identifiers now say
"Gilbert" and docs must match them:

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
- The CI/CD pipeline is this repository's own since commit `6cfb614`:
  `publish.yml` publishes `ghcr.io/sequico/gilbert` (multi-arch, never
  upstream's org), `cleanup.yml` prunes `gilbert`, `release.yml` is the
  manual release flow (user calls it; it tags, creates the GitHub release and
  calls publish). `ci.yml` builds `gilbert:ci`. Only `sync-upstream.yml`
  touches upstream — it mirrors upstream releases onto the `ihasmail` branch.
- Reverse-proxy examples and `.env.example` prose name Gilbert;
  `settings-policy.example.json` prose follows. Docker runtime identifiers are
  unchanged (below).

## Still `ihasmail` — do not rename (data or deployed surface)

Renaming any of these costs real data or breaks an external agreement, and
none of them is brand surface. Docs must keep saying `ihasmail` for them:

- the hidden `ihasmail` folder in every account's JMAP Files (holds
  `settings.json` and the signature images) — **renaming it is still a TODO**:
  it is a per-account data migration needing read and back-compat, never a
  silent move;
- its storage keys: localStorage `ihasmail:lastUser` / `ihasmail-theme` /
  `ihasmail:deviceTrusted`, the drag-and-drop MIME types
  (`application/x-ihasmail-emails`, `-folder`, `-sieve-rule`), the sieve
  script name "ihasmail", the stored `"ihasmail"` theme/palette value in
  `settings.json` (only the CSS palette block under
  `[data-palette="ihasmail"]` is visual and retunable), the crypto sealing
  context `ihasmail-session-v1` and the Web Push device-id prefix
  `ihasmail-<uuid>` (both would strand existing sessions/devices), and the
  signature HTML marker `<!--ihasmail:sig=…-->` written into stored
  identities (old stored signatures must stay readable);
- `sw.js`: `VERSION`/`VERIFY_KEY`, the `ihasmail-push-verification` path and
  notification tags (renaming invalidates every cached shell at once);
- the `[ihasmail]` server log prefix and the session extension object
  (`session.ihasmail.*` — server and client payload shape);
- docker deployment surface, deliberately left as-is: `docker-compose.yml`
  (service `ihasmail`, `image: ihasmail:2`/`ghcr.io/coffey-labs/ihasmail`,
  volume `ihasmail-data`), `deploy.example.sh` (its `IHASMAIL_*` envs and
  script names), `/etc/ihasmail` and `/srv/ihasmail` example paths;
- upstream URLs (ihasmail.org, docs.ihasmail.org, demo.ihasmail.com,
  github.com/Coffey-Labs/ihasmail) — real endpoints, link them, never present
  them as Gilbert's own; historical and legal lines keep upstream's name
  ("relicensed from GPL-3.0…", "If you run a modified ihasmail, set
  `SOURCE_URL`…" in upstream-owned docs); `LICENSE`/`NOTICE` keep Coffey Labs'
  attribution; `SECURITY.md`/`CONTRIBUTING.md`/`CODE_OF_CONDUCT.md` stay
  upstream's process and contacts (ask before touching).

## Where the rename stops

Upstream-shaped work offered to Coffey-Labs/ihasmail is prepared on a fork
branch cut from `upstream/main` with `ihasmail` identifiers intact
(ADR 0002) — never by un-renaming patches from this tree. Do not fold a
rename edit into a change that upstream could receive; the two shapes live in
two places on purpose. Upstream's rebranding guide
(docs.ihasmail.org/rebranding/) is the reference for the licence obligations
that survive: a rebranded Gilbert is AGPL, users are owed *this* tree's
source, and running it as a service counts as distribution — `SOURCE_URL` is
the offer and already defaults here.

## Rules for any future rename

1. Search first, layer by layer, judge every hit rather than assuming a
   category: `grep -rn ihasmail .github Dockerfile docker-compose.yml
   deploy.example.sh scripts server/src web/src web/index.html web/public
   .env.example Caddyfile.example nginx.example.conf settings-policy.example.json`.
2. Identifiers move in pairs (client + server + tests + deploy + docs) inside
   one change set; never write a doc line that names something the code does
   not produce.
3. After any rename: `npm run typecheck`, `npm test`, read the diff.
   Brand/config tests may assert old defaults and must move in the same
   change.
4. A rename that touches the "still `ihasmail`" list above is a data
   migration or a sync conflict in the making — say so before doing it.
