---
name: gilbert-upstream-rebrand
description: Checklist for taking in upstream (coffey-labs/ihasmail) merges into the Gilbert repository. Two hazards, one pass: upstream code arrives with ihasmail identifiers, log prefixes, wire strings and prose that violate Gilbert's naming law, and an upstream hunk applied verbatim can silently undo a decision our tree already made. Load after any upstream merge or before reviewing one.
metadata:
  short-description: Rebrand upstream merges, and decide the collisions
---

# Gilbert — taking in an upstream merge

Two things are checked in one pass, and neither is the other's job:

1. **The naming law** — every `ihasmail` the delta introduces is renamed to
   `gilbert`/`Gilbert`, except the upstream mentions that must stay.
2. **The collisions** — where upstream's change lands on ground our tree already
   decided, someone has to *choose*, with both versions in view. Which side wins
   is the outcome of that reading, not a rule: upstream is often right, and its
   version may well be the better one. What this forbids is neither side — it is
   the change that happens **without anyone choosing it**.

## When this applies

Upstream releases are fetched directly by the merge that takes them into
`main` (ADR 0002), and a daily watch reports a release main has not taken in.
Upstream code is written for ihasmail: it ships `ihasmail` identifiers,
`[ihasmail]` log prefixes, `ihasmail-…` device/header strings, ihasmail.example
fixtures and prose that calls the product ihasmail. Gilbert's naming law
(gilbert-branding) forbids all of that except the upstream/AGPL mentions. The
mail core is based on ihasmail, not named after it.

The second hazard is not about naming at all and is the more expensive one.
Upstream moves fast and its decisions are usually reasoned ones — it is the
larger project, it sees the real deployments, and a security pass there is worth
taking seriously. But Gilbert's tree has also diverged on purpose, and a commit
touching such a spot carries *its* version of it. Applied verbatim, that hunk is
a choice nobody made: our decision is gone, and the only trace is an ADR, a key
or a comment that is now false. It does not conflict, it does not fail a test,
and it arrives looking like upstream tidying.

So the job is not to defend our version. It is to turn each collision into a
decision — read both sides, judge them on their merits, take the better one, and
leave the record saying what was chosen and why. Upstream winning is a normal
outcome; the ADR is then rewritten in the same change, because we are
*deliberately* changing our decision.

A merge of upstream code is therefore **not done** when conflicts are resolved
and tests pass. It is done when the merged delta has been rebranded **and** every
hunk that landed on ground we had already decided flatly has been chosen rather
than inherited. This skill is that checklist.

## Rules of thumb

- **A merge takes a change, not a file — and a collision is a fork in the road,
  not a verdict.** Before accepting an upstream hunk, read what our tree already
  decided in that spot, and what the upstream change was actually *for*. Then
  pick, on merit: our version, theirs, or one built from both — which is often
  the honest answer, and is what happened to the body cap (`loginBody` below):
  take the new bound upstream introduced, keep the tighter number we had already
  chosen for sign-in.
- **What is refused is the silent application, not the direction.** Holding our
  side out of habit is as much a failure as taking theirs out of habit: a tree
  that never absorbs a better idea from upstream is not being careful, it is
  calcifying. An upstream fix that is simply better — a real bug we also have, a
  simpler shape, a fact about Stalwart we got wrong — is taken, and our ADR and
  our comment are corrected in the same commit.
- **An upstream hunk that falsifies a claim in our tree is a decision, not a
  cleanup.** If the hunk would make an ADR sentence, a `FEATURES.md` bullet or a
  comment false, that is the signal to stop and read both sides: either our
  version stays where it is, or we are changing our decision and the claim is
  rewritten in the same change to say what the code now does. Silence is the one
  option that is not on the table — landing the hunk and leaving the claim
  standing is the defect this rule exists to prevent (repo rule: *a change that
  makes a claim false fixes the claim in the same diff*,
  `.opencode/skills/gilbert-upstream-rebrand/SKILL.md`).
- **Some collisions are the owner's call — but read them before escalating
  them.** Two deliberate designs that both work, ours and theirs, are not
  something to settle inside a merge: name both, say what each costs, and put the
  choice to the user. That is the last resort rather than the first, though,
  because a collision read only from our side *looks* like taste. Reading what
  upstream's change was for, and what our own code was actually doing, is what
  turns most of them into a defect, a fact, or a synthesis — the push
  subscription below was escalated first as two designs and turned out to hold a
  bug of ours, an upstream fact we were wrong about, and one genuine collision.
  A merge is still the wrong place to redesign a feature, in either direction.
- **Prefer taking a delta to merging the release.** When the change we want sits
  in a handful of upstream commits and the merge would drag in hundreds of files
  we have diverged from, hand-take it (the way `84dea39` took four fixes out of
  `v2026.9.15-pr369` rather than merging 227 files). A hand-take is where this
  rule is easiest to obey: each hunk is read on its own, against ours.
- Excluded upstream files (CLAUDE.md, .github/FUNDING.yml, …) stay at
  Gilbert's version, never absorbed: rule and ask-first list live in
  `.opencode/skills/gilbert-upstream-rebrand/SKILL.md` (Upstream section) — read it before merging.
- Rename the delta, not the repo. Only files the merge touched need a look:
  new upstream files, files whose upstream hunks added strings, and tests
  that assert on them. `git diff <merge-base>..HEAD --stat` bounds it.
- `ihasmail` may stay only where upstream's real name must stay: AGPL lineage
  in `README`/`LICENSE`/`NOTICE`/ADR 0002, and upstream-owned legal lines
  ("If you run a modified ihasmail…"). Upstream's addresses
  (ihasmail.org, docs.ihasmail.org, demo.ihasmail.com,
  git.coffeylabs.org/coffey-labs/ihasmail, the GitHub-era issues and PRs in
  ihasmail-github-archive) live in `NOTICE` and nowhere else: a merged doc hunk
  that links to one arrives as prose naming upstream, or as a plain issue
  number, with the reader sent to `NOTICE` for the address.
- Everything else says `gilbert`/`Gilbert`: prose about the product says
  "Gilbert"; identifiers are lowercase `gilbert`.
- Snapshot mode: comments describe the merged code as it is, never
  "upstream says X but here Y". Do not narrate the rename in a comment.
- Keep upstream behaviour identical *as far as the change goes*: the rename
  pass is not a review pass. Real changes are the collisions above, decided on
  purpose — not a licence to "improve" upstream code on the way through.
- Renames are automatic and never a question: any `ihasmail` the delta
  introduces outside the stay-list above is renamed during the merge —
  including user-visible identifiers such as a shipped theme or palette id.
  Judgment applies only to the stay-list, never to the user.

## Worked collisions

Four real ones, from the `v2026.9.15-pr369` → `v2026.9.18` range. Read them as
*how the call was made*, not as precedents — and note that they went four
different ways: one is a bound taken from upstream with our tighter number kept
on top, one ends the other way with the record rewritten, one is settled by the
one-source-of-truth rule rather than by preference, and one took upstream's
diagnosis, kept our design and turned up a defect on our own side. None of them
is "upstream was wrong"; in every one, upstream's change was worth taking and
the question was only what it was worth taking *over*. Where upstream is simply
right — and often it is, being the larger project with the real deployments in
front of it — the reading ends that way, and the ADR, the inventory bullet or
the comment changes with it.

- **`loginBody`: a third version, built from both.** We cap sign-in at 16 KiB
  (`d45f011`) — the one endpoint that reads a body from somebody not yet signed
  in — and scope limits by name (`/account/*`, `/admin/*`). Upstream caps every
  JSON route at 64 KiB and exempts the data path by pattern. Neither side's
  file is taken: the *change* is (a bound on every JSON route, an exemption
  shaped like the route), and our tighter number and clearer scoping stay on top
  of it. Reconciling is not always choosing.
- **`ApiKey` went upstream's way, and the record moved with it.** Upstream's
  security pass (`dfe885a`) removes the object from the self-service allowlist
  while adding the real fix — a refusal of every `x:` `set` — and this tree had
  copied the list from upstream's own draft, so `ApiKey` was never a decision
  here, only an inheritance. Two things settled it: upstream is the side that
  re-thought it, and no surface in Gilbert mints or shows an API key, so an
  entry for it was reach nobody had asked for. It came off the list, ADR 0017's
  sentence lost the name and gained the reason, and `adminGate.test.ts` now
  asserts the refusal. **This is the shape a collision takes when upstream is
  right**: the change is taken and the claim that named the old behaviour is
  rewritten in the same commit.
- **`staleBuild`: a duplicate module, which is not a matter of taste.** We have
  `web/src/lib/staleBuild.ts`; upstream has `web/src/lib/sw/staleBuild.ts`, and
  its `sw/` changes (#394–#396) touch theirs. This one is decided by the
  one-source-of-truth rule rather than by preference: two implementations of one
  behaviour is a defect whatever upstream says. Two further things in the same
  hunk are not judgement calls at all — the storage key reverting to
  `ihasmail:reloaded-for` from `gilbert:reloaded-for` (naming law), and a
  comment stating that **a deploy signs everyone out because an immutable
  instance holds sessions in memory**, which is false here, where sessions live
  in the account's own document (ADR 0001). Reconcile by taking the *behaviour*
  into our file; never by landing their module beside ours.
- **The push subscription: upstream's diagnosis won, our design was kept, and
  the third thing was ours to fix.** ADR 0016 owns this surface. At the time of
  the merge it said `types: ["Email"]` and planned `["Email", "FileNode"]` so a
  group's chat would wake the device; upstream's `4054f82` subscribes to
  `EmailDelivery` instead, and that is a better answer to the question the type
  list was there for — a delivery is the only thing worth waking a closed client
  for, and `Email` changes on every read and move from any client. So the type
  list moved to upstream's, and the *plan* was not dropped but deferred: naming
  `FileNode` before the worker can read what changed would render a chat write as
  "New mail", so the chat wake-up stays owed on the record with the reason
  written down.

  Three findings in that one collision, of three different kinds, which is why
  it is worth reading as a case rather than as a precedent:

  1. a fact upstream was simply right about, where the record changed with the
     code (`EmailDelivery`);
  2. a decision of ours that upstream had not made, where a first reading said
     "the owner's call" and a second one — reading what each subscription
     actually consumes — showed the loudest symptom was a bug we shared, not two
     designs to choose between (the payload asked for no `id`, so the Archive
     and Mark-read buttons the worker draws could never appear);
  3. a genuine collision, neither side's to settle alone: gilbertserver told a
     browser's row from its own by the types it asked for, so *changing* that
     type list turned a browser's registration into a candidate for deletion on
     a full quota. Both sides now decide it by the shape of the device id, in
     `server/src/shared/push.ts`, which both tiers already import.

  The lesson worth keeping: **a collision read only from our side looks like a
  matter of taste.** Reading what upstream's change was *for* — and what our own
  code was actually doing — is what turned two of these three from an opinion
  into a defect. Enumerate the collisions, then read them.

**The pattern**, and the reason this list exists: a hunk is hardest to judge
exactly when *both* sides are deliberate. `grep` the ADR index and
`FEATURES.md` for the surface it touches *before* deciding — a record naming the
symbol usually settles it, and a record naming the *other* design means you have
found a question for the user rather than a fix to apply.

## Checklist — run this before committing the merge

1. **List the collisions, before applying anything.** For every file the merge
   touches, compare the two sides of the change:
   `git diff <merge-base>..<upstream-ref> -- <file>` against
   `git diff <merge-base>..HEAD -- <file>`. Where both changed the same region,
   that region is a fork: name it, read both versions *and what each was for*,
   and say which one goes in and why. "Ours" is a defensible answer and so is
   "theirs" — an undeclared one is not. This is the step whose omission is
   invisible in the diff and expensive a month later. Worked cases above.
2. **For every collision, decide and record.** The choices are: take upstream's
   version and rewrite the claim it falsified; keep ours and note why it is
   still better; build the one that takes the change without losing our half;
   or, where both designs are deliberate and working, put it to the user with
   both named and do not land it in the meantime.
3. **Grep the merged delta for `ihasmail`** (case-insensitive). Judge every
   hit against the allowed list above — that judgment is mechanical and never
escalated to the user; do not bulk-replace.
4. **Log prefixes** `[ihasmail]` → `[gilbert]`. These are operator-visible;
   the naming law pins the `[gilbert]` prefix.
5. **Wire and storage identifiers** the client/server exchange or persist:
   `deviceClientId` prefixes, MIME types, storage keys, sieve script names,
   the Web Push device-id prefix and its verification path. `ihasmail-…` →
   `gilbert-…` etc.
6. **Fixture values in tests** (`https://ihasmail.example`, sample
   addresses/URLs that are not the real upstream) → `gilbert.example` or
   equivalent. Real upstream URLs stay.
7. **Prose in comments and docs** describing the product ("the server holds
   a stream to ihasmail") → "Gilbert". Keep mentions of upstream ihasmail
   only when the sentence is about the upstream project itself.
8. **UI strings**: if the merge adds or changes user-visible copy, follow
   gilbert-i18n — keys are English source; add or update catalogue entries
   in every language (de, es, fr, it, ja, nl, pt-BR, ru, uk, zh-Hans) when
   the key is new. A missing key degrades to English by design, but new
   admin/feature copy should ship translated like its neighbours.
9. **App name in copy**: the product's own name appears as the runtime name
   (`APP_NAME`) where possible; where a key embeds "Gilbert", translations
   keep it untranslated.
10. **ADR and claim check**: for every collision, grep the sentence it changes —
   an ADR, a `FEATURES.md` bullet, a comment naming the symbol. Whatever the
   choice was, the sentence says what the code now does in the same change.
   A claim left standing beside code that no longer matches it is the defect,
   whichever side won.
11. **Feature inventory**: a merge is not done when it compiles — reconcile
   `FEATURES.md` with the merged delta (features the merge adds, removes or
   changes are reflected) and make sure the Gilbert-added sections survive
   intact. Repo rule: the inventory stays current on every change and every
   merge (`.opencode/skills/gilbert-upstream-rebrand/SKILL.md`, "The feature inventory stays
   current").

## Verification

- **Every collision has a decision.** Re-read the list from checklist step 1
  against the final diff: each entry says which version went in and why, and no
  entry is there by habit in either direction. An undeclared collision is the
  failure mode this skill exists for — as is a tree that took nothing from
  upstream because "we had already decided".
- **Every claim still true.** For each collision, the ADR / `FEATURES.md` /
  comment that describes it matches the code that landed. Where upstream's
  version won, that sentence was rewritten — and git holds the version before
  it, so nothing needs saying about what it used to be.
- `git diff <merge-base>..HEAD -- server web | grep -i ihasmail` — expect
  only the allowed mentions (or none).
- TypeScript/JSON: `npm run typecheck`.
- Biome: `npm run lint:fix` then `npm run lint` — upstream code arrives
  unformatted; conformance is part of the merge commit.
- Tests: `TZ=UTC npm test` (server and web) — renamed log/device strings
  are often asserted in tests; fix those assertions in the same change.
- UI copy: `npm run i18n:check` — no stale keys, literals quiet.
- Read the final diff once, hunks in order, before committing.
