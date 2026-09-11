---
name: gilbert-branding
description: Naming law for the Gilbert repository: what says "Gilbert", where `ihasmail` legitimately appears (upstream and AGPL attribution only), and the download-only upstream relationship. Load for any naming or renaming task in this repo.
metadata:
  short-description: naming state & rules
---

# Gilbert — naming

## Snapshot mode

Files and comments describe the code as it is now. Never narrate a rename or
a migration ("it used to be X, then it became Y"); history lives in git.

## What the names are

- Prose about the product says "Gilbert", and every code and build identifier
  is `gilbert`: `APP_NAME` default "Gilbert", packages
  `gilbert`/`@gilbert/*`, `GILBERT_VERSION`, `X-Requested-With: gilbert`, UI
  strings and catalogs, the app folder, the sieve script name
  (`GILBERT_SCRIPT`), device storage keys (`gilbert:*`), drag-drop MIME types
  (`application/x-gilbert-*`), the Web Push device-id prefix and
  `gilbert-push-verification` path, the `[gilbert]` log prefix, the
  `session.gilbert` extension, the `gilbert` theme/palette id, the signature
  HTML marker `<!--gilbert:sig=…-->`, the crypto sealing context
  `gilbert-session-v1`, and the docker service/volume and deploy script
  (`gilbert`, `gilbert-data`, `GILBERT_*` envs).
- `ihasmail` appears only where upstream's real name must stay: the URLs
  (ihasmail.org, docs.ihasmail.org, demo.ihasmail.com,
  github.com/Coffey-Labs/ihasmail — issues, PRs, releases), the lineage and
  AGPL attribution in `README`/`LICENSE`/`NOTICE`/ADR 0002, the legal lines
  in upstream-owned docs ("If you run a modified ihasmail, set
  `SOURCE_URL`…").

## Relationship to upstream

Gilbert is its own product, of which the mail client is one part. The mail
client is based on [Coffey-Labs/ihasmail](https://github.com/Coffey-Labs/ihasmail).
Upstream is **download-only** (ADR 0002): releases are fetched directly by the
merge that takes them in (ADR 0002), the mail core merges them in,
and nothing is contributed back. Upstream's docs (docs.ihasmail.org) are the
reference for the licence obligations that survive: Gilbert is AGPL, users are
owed *this* tree's source, and running it as a service counts as
distribution — `SOURCE_URL` is the offer and already defaults here.

## Rules

1. Never write a doc line or comment that narrates a rename or migration —
   describe the current state; history lives in git.
2. Only the upstream/AGPL mentions above may say `ihasmail`; everywhere else
   `gilbert` is simply the name.
3. An upstream merge delta is renamed without asking: `ihasmail` outside the
   mentions above becomes `gilbert` during the merge, including user-visible
   identifiers such as a shipped theme or palette id.
4. Before any future rename: search repo-wide, judge every hit, move
   identifiers in pairs (code + tests + docs + deploy) in one change set,
   then `npm run typecheck`, `npm test`, and read the diff.
