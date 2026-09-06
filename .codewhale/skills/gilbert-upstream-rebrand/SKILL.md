---
name: gilbert-upstream-rebrand
description: Checklist for taking in upstream (Coffey-Labs/ihasmail) merges into the Gilbert repository. Upstream code arrives with ihasmail identifiers, log prefixes, wire strings and prose that violate Gilbert's naming law; every merged delta must be re-checked and renamed before it lands. Load after any sync-upstream merge or before reviewing one.
metadata:
  short-description: Rebrand upstream merges to Gilbert
---

# Gilbert — rebranding an upstream merge

## When this applies

`sync-upstream.yml` mirrors upstream releases onto the `ihasmail` branch, and
the mail core merges them into `main`. Upstream code is written for ihasmail:
it ships `ihasmail` identifiers, `[ihasmail]` log prefixes, `ihasmail-…`
device/header strings, ihasmail.example fixtures and prose that calls the
product ihasmail. Gilbert's naming law (gilbert-branding) forbids all of
that except the upstream/AGPL mentions. The mail core is based on ihasmail,
not named after it.

So a merge of upstream code is **not done** when conflicts are resolved and
tests pass — it is done when the merged delta has been rebranded. This skill
is that checklist.

## Rules of thumb

- Rename the delta, not the repo. Only files the merge touched need a look:
  new upstream files, files whose upstream hunks added strings, and tests
  that assert on them. `git diff <merge-base>..HEAD --stat` bounds it.
- `ihasmail` may stay only where upstream's real name must stay: the URLs
  (ihasmail.org, docs.ihasmail.org, demo.ihasmail.com,
  github.com/Coffey-Labs/ihasmail), AGPL lineage in
  `README`/`LICENSE`/`NOTICE`/ADR 0002, upstream-owned legal lines
  ("If you run a modified ihasmail…"), and the `ihasmail` branch name.
- Everything else says `gilbert`/`Gilbert`: prose about the product says
  "Gilbert"; identifiers are lowercase `gilbert`.
- Snapshot mode: comments describe the merged code as it is, never
  "upstream says X but here Y". Do not narrate the rename in a comment.
- Keep upstream behaviour identical: this is a rename pass, not a review
  pass. If the delta needs real changes, do them separately.

## Checklist — run this before committing the merge

1. **Grep the merged delta for `ihasmail`** (case-insensitive). Judge every
   hit against the allowed list above; do not bulk-replace.
2. **Log prefixes** `[ihasmail]` → `[gilbert]`. These are operator-visible;
   the naming law pins the `[gilbert]` prefix.
3. **Wire and storage identifiers** the client/server exchange or persist:
   `deviceClientId` prefixes, MIME types, storage keys, sieve script names,
   the Web Push device-id prefix and its verification path. `ihasmail-…` →
   `gilbert-…` etc.
4. **Fixture values in tests** (`https://ihasmail.example`, sample
   addresses/URLs that are not the real upstream) → `gilbert.example` or
   equivalent. Real upstream URLs stay.
5. **Prose in comments and docs** describing the product ("the server holds
   a stream to ihasmail") → "Gilbert". Keep mentions of upstream ihasmail
   only when the sentence is about the upstream project itself.
6. **UI strings**: if the merge adds or changes user-visible copy, follow
   gilbert-i18n — keys are English source; add or update catalogue entries
   in every language (de, es, fr, it, ja, nl, pt-BR, ru, uk, zh-Hans) when
   the key is new. A missing key degrades to English by design, but new
   admin/feature copy should ship translated like its neighbours.
7. **App name in copy**: the product's own name appears as the runtime name
   (`APP_NAME`) where possible; where a key embeds "Gilbert", translations
   keep it untranslated.

## Verification

- `git diff <merge-base>..HEAD -- server web | grep -i ihasmail` — expect
  only the allowed mentions (or none).
- TypeScript/JSON: `npm run typecheck`.
- Biome: `npm run lint:fix` then `npm run lint` — upstream code arrives
  unformatted; conformance is part of the merge commit.
- Tests: `TZ=UTC npm test` (server and web) — renamed log/device strings
  are often asserted in tests; fix those assertions in the same change.
- UI copy: `npm run i18n:check` — no stale keys, literals quiet.
- Read the final diff once, hunks in order, before committing.
