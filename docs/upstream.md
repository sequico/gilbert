# Upstream, commit by commit

Gilbert's mail core is based on upstream ihasmail, and upstream is
**download-only** (ADR 0002): releases are fetched by the merge that takes them
in and nothing goes back. `.github/workflows/upstream-watch.yml` asks, once a
day, whether the newest release is accounted for: its commit an ancestor of
`main`, **or** every work commit it adds carrying a row here. The second
question is what a hand-take needs — a hand-take never makes the release's own
commit an ancestor, so ancestry alone would report a release whose useful
commits were taken one by one as missing forever.

This file is the record that answers it: one row per upstream commit, with what
became of it. It is not a mirror and not a second history — the commits are
upstream's own (its shas), and the disposition is what a reader needs so that
what is already decided is not re-decided.

## The convention that keeps it true

A change that takes an upstream **commit** rather than a whole release records
the upstream sha in its own message:

    Upstream: <sha>

The mapping then lives in the history, and this table can be rebuilt from
`git log --grep='^Upstream: '` instead of being maintained by hand. Where a row
and the trailers disagree, the trailers are what is true.

## What is taken, and what is deliberately not

- **Taken**: security and hardening, performance, and client UX — brought in
  commit by commit, rebranded (`gilbert-upstream-rebrand`), with each collision
  decided rather than inherited.
- **Not taken, by decision**: upstream's own CI (this repository runs GitHub
  Actions), dependency bumps (its own Dependabot), upstream's docs and process
  files, and the **Administration surface** — ADR 0014 makes administration a
  door rather than a menu, so upstream's dashboard, tenants, roles and domains
  work is deliberately not the shape here. Refactors of upstream's internals
  are not taken either where they would collide with this tree's structure.

## The audited range

Every upstream commit since the last wholesale merge — release `v2026.9.10-pr328`
(`3c4f6a9f`) — up to release `v2026.9.27-ge5709b4` (`e5709b4`): 107
commits, of which 44 are in this tree (33 near-verbatim, 11 adapted), and the
rest are CI/infra (29), the administration surface (19), docs/i18n/process (8),
dependency bumps (5) and upstream's internal refactors (2).

`upstream/main` is ahead of that release by a further 30 commits (15 work
commits, the rest pull-request merges), listed under *After the newest release*
below.

The percentage is how much of a commit's added identifiers already exist in this
tree — a signal, not a proof: a hand-take that rebranded or adapted its code
reads lower than one applied near-verbatim. Nothing in security, performance or
UX is left to read.

| upstream | disposition | overlap | subject |
|---|---|---|---|
| `4517d154` | in | 99% | Split the extractable parts out of the mail store |
| `5b85c254` | in | 98% | Split the mock server along the section markers it already had |
| `d38dee7e` | in | 98% | Save contact photos inline, and load cards so avatars show |
| `dfe885a9` | in | 98% | Close the smaller gaps from the security review |
| `5855da0b` | in | 97% | Paint a full-screen composer above the others |
| `abb07acc` | in | 97% | Let the sidebar be resized by dragging its edge |
| `e158ebac` | in | 97% | Fold a push's follow-up requests together (#393) |
| `98e105ef` | in | 96% | Bound what a request can make the server hold |
| `f627bfc1` | in | 96% | The toolbar above an open message acts on that message (#414) (#417) |
| `36042040` | in | 95% | Sync contacts by what changed, and hold fewer calendar windows |
| `a607450a` | in | 95% | Keep the service worker's cache to the current build |
| `e2b4cc18` | in | 94% | Keep list refreshes within the server's limits and stop repeating them |
| `191c4e7e` | in | 93% | Ask before opening a shared item in a message |
| `4054f82c` | in | 93% | Stop duplicate push notifications and piling up subscriptions |
| `55fcbf72` | in | 93% | Harden the email sanitizer's CSS handling |
| `d992442b` | in | 93% | Offer the message's own format when replying (#407) (#408) |
| `ea034066` | in | 93% | List folders in sidebar order in the move-to picker |
| `05df758d` | in | 92% | Open the composer full screen, as a setting (#401) (#404) |
| `71d211a1` | in | 92% | Precompress the bundle, validate the shell, and pass byte ranges on |
| `ac4c4bd2` | in | 92% | Check component props for untranslated literals, and fail on a finding |
| `76cc2dee` | in | 91% | Point links at the new git host |
| `8a08c3d6` | in | 90% | Advertise byte ranges on downloads, and record the live checks |
| `bc366ac0` | in | 90% | Reorder folders by dragging, with special folders first (#402) (#405) |
| `01dc322a` | in | 100% | A reply to a self-addressed message follows its Reply-To (#415) (#416) |
| `0859936f` | in | 100% | Move a folder from its menu, with the same picker as moving mail |
| `4c7b2ec3` | in | 100% | Ask shared accounts together, and about files only when Files opens |
| `61390316` | in | 100% | Load the composer, previews, dialogs and other sidebars on demand |
| `8e9ca049` | in | 100% | Ignore a keydown that carries no key |
| `95395200` | in | 100% | Let the contact list be resized, and give the contact the rest of the page |
| `b5c07395` | in | 100% | Send account requests to the account's own Stalwart |
| `de71572b` | in | 100% | Follow Stalwart 0.16.22 in the mock |
| `f1234678` | in | 100% | Let go of old message bodies and of exported files |
| `f79915aa` | in | 100% | Drop a wrong issue reference from a comment |
| `c6dbcaef` | in (adapted) | 86% | Render only the message rows that changed |
| `82dc877f` | in (adapted) | 84% | Start at once on a device marked as your own (#395) |
| `07b39eb9` | in (adapted) | 83% | Call the app by its name in every sentence that names it (#406) |
| `88f9e6c5` | in (adapted) | 83% | Switching format keeps the original quote, not a flattened copy (#409) (#409) |
| `091782ae` | in (adapted) | 82% | Drag calendar events to another day in the week grid (#400) |
| `54b316ae` | in (adapted) | 81% | Report the stale keys that are stale, and remove them |
| `78697631` | in (adapted) | 80% | Open conversations in one request, and start them early (#392) |
| `2740129c` | in (adapted) | 78% | Keep only the app page as the app page (#396) |
| `c1181849` | in (adapted) | 78% | Match Shift+letter shortcuts (Shift+I, Shift+U) (#399) |
| `4c674604` | in (adapted) | 77% | Fetch the rest of a new build in the background (#394) |
| `f1638b2f` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 95% | Offer administration only on a device marked as your own |
| `7c0e278e` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 83% | Move Administration's section list into the folder pane |
| `15b1838e` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 78% | Say every Administration refusal in the reader's language |
| `ce5eb04c` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 78% | Show only the Enterprise notice on Tenants when the server is not Enterprise |
| `5f70e5e8` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 76% | Say tenants are Enterprise only where the installation asks, as the demo will |
| `2e2724c5` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 74% | Find Stalwart's administration instead of asking for it |
| `627422d7` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 72% | Add Mailing lists to Administration |
| `82e21715` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 72% | Add Administration, starting with accounts |
| `e2a531b6` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 69% | Add Groups to Administration |
| `0054b8a3` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 66% | Open Administration on a dashboard of what the role can read |
| `4787e8bf` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 66% | Point from the dashboard to Stalwart's own administration |
| `79afc334` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 66% | Record the groups run on the live server, and match its refusal shape |
| `7e46ddeb` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 64% | Record the roles run on the live server, and drop the mock's made-up permission |
| `1dafb4bc` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 63% | Add Domains to Administration |
| `fd104a1f` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 61% | Add Tenants to Administration, and let an account be put in one |
| `430fc267` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 56% | Filter accounts on @type, the name Stalwart uses |
| `40df0f65` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 53% | Follow what the live server does with tenants and domains |
| `a00d07b4` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 32% | Add Roles to Administration, with Stalwart's permissions in every language |
| `d279fe8f` | admin surface — not taken (ADR 0014/0017: a door, not a menu) | 100% | Let an operator turn administration off |
| `ce683f94` | CI / infra — not taken (GitHub Actions here) | 97% | Bring FEATURES and KNOWN-ISSUES up to 0.16.22 |
| `d329b339` | CI / infra — not taken (GitHub Actions here) | 93% | Quoting follows the message's own image decision (#410) (#411) |
| `28acad68` | CI / infra — not taken (GitHub Actions here) | 90% | Say 0.16.22 in the README, and what it changed for a client |
| `64dbb30e` | CI / infra — not taken (GitHub Actions here) | 90% | Credit the testing to 0.16.22, where it was done |
| `e1f09041` | CI / infra — not taken (GitHub Actions here) | 90% | Move the weekly release off the top of the hour |
| `23557a72` | CI / infra — not taken (GitHub Actions here) | 89% | Quote images through the proxy, and unproxy them on the way out (#412) (#413) |
| `74982068` | CI / infra — not taken (GitHub Actions here) | 85% | Record the schema route working on production |
| `5027bd1e` | CI / infra — not taken (GitHub Actions here) | 81% | Record what Administration proved on the live server |
| `2c6df11e` | CI / infra — not taken (GitHub Actions here) | 80% | Point image references at the new registry |
| `8ce8f059` | CI / infra — not taken (GitHub Actions here) | 79% | Cut the README down to an introduction and links |
| `bb27501d` | CI / infra — not taken (GitHub Actions here) | 78% | Take the production server's domains out of KNOWN-ISSUES |
| `2441e473` | CI / infra — not taken (GitHub Actions here) | 76% | Give CI jobs IPv6 rather than a Node flag that did not help |
| `1ec9579d` | CI / infra — not taken (GitHub Actions here) | 71% | Add the pull request template CONTRIBUTING.md already refers to |
| `f3ee4ff6` | CI / infra — not taken (GitHub Actions here) | 71% | Document the fork CI approval gate in CONTRIBUTING.md |
| `9647ead8` | CI / infra — not taken (GitHub Actions here) | 70% | Point to the companion tools near the top of the README |
| `67aab801` | CI / infra — not taken (GitHub Actions here) | 64% | ci: add Gitea Actions workflows ported from .gitlab-ci.yml |
| `6e23c141` | CI / infra — not taken (GitHub Actions here) | 63% | Make the CI job environment match what the tests assume |
| `795fe43c` | CI / infra — not taken (GitHub Actions here) | 62% | Fetch the registry token from the public address, not the runner's |
| `0e63c5d9` | CI / infra — not taken (GitHub Actions here) | 58% | Cut the weekly release on GitLab |
| `bb133b88` | CI / infra — not taken (GitHub Actions here) | 57% | Let root jobs use a checkout the node job chowned |
| `6bfd105a` | CI / infra — not taken (GitHub Actions here) | 55% | Run CI on the self-hosted GitLab |
| `441fb07c` | CI / infra — not taken (GitHub Actions here) | 53% | Pin every action to a commit SHA |
| `a7d05217` | CI / infra — not taken (GitHub Actions here) | 50% | Announce releases on the community forum |
| `d7be002c` | CI / infra — not taken (GitHub Actions here) | 50% | ci: fail clearly when PACKAGE_TOKEN is missing |
| `540554c1` | CI / infra — not taken (GitHub Actions here) | 42% | Build published images with the version they report |
| `724ff0b0` | CI / infra — not taken (GitHub Actions here) | 25% | Let the deploy compute its version without node |
| `874d25a4` | CI / infra — not taken (GitHub Actions here) | 100% | Look tags up by exact ref in the weekly release |
| `8acb1b66` | CI / infra — not taken (GitHub Actions here) | 100% | Publish with a builder on the host's network |
| `d215d4e2` | CI / infra — not taken (GitHub Actions here) | 100% | ci: run socket-free jobs on the light label |
| `6ba89696` | docs/i18n/process — not taken (ours) | 94% | Spell license the US way |
| `05d1645a` | docs/i18n/process — not taken (ours) | 90% | Update nl.ts (#403) |
| `8bd7904a` | docs/i18n/process — not taken (ours) | 84% | Update nl.ts |
| `9840a537` | docs/i18n/process — not taken (ours) | 84% | Link Michael's profile from the Dutch credits |
| `aaa86e96` | docs/i18n/process — not taken (ours) | 84% | Credit Michael (mbjboon82) for the Dutch review |
| `fecae2ac` | docs/i18n/process — not taken (ours) | 84% | Translate English built from template literals in attributes |
| `d1731efd` | docs/i18n/process — not taken (ours) | 81% | Use American English spelling throughout |
| `4cb1945e` | docs/i18n/process — not taken (ours) | 78% | Update nl.ts |
| `e30fd73d` | in (adapted) | 64% | Take Dutch out of Beta with the native speaker's final review |
| `860e89fa` | dependency bump — not taken (own Dependabot) | 40% | Bump lucide-react from 0.477.0 to 1.45.0 |
| `30775292` | dependency bump — not taken (own Dependabot) | 30% | Bump @tanstack/react-virtual in the minor-and-patch group |
| `1a4377de` | dependency bump — not taken (own Dependabot) | 14% | Bump vitest from 4.1.11 to 5.0.0 |
| `61916b3a` | dependency bump — not taken (own Dependabot) | 11% | Bump concurrently from 9.2.4 to 10.0.5 |
| `b7b24559` | dependency bump — not taken (own Dependabot) | 11% | Bump jsdom from 26.1.0 to 30.0.1 |
| `bd6a605d` | refactor — not taken (collides with our structure) | 99% | Group six more clusters out of web/src/lib |
| `f7712b1c` | refactor — not taken (collides with our structure) | 38% | Group the admin and calendar modules, and stop calling screenshots docs |

## The newest release, `v2026.10.5-g20c32ed`

Between `v2026.9.27-ge5709b4` (`e5709b4`) and the newest release,
`v2026.10.5-g20c32ed` (`20c32ed`), upstream carries 36 commits, 18 of them work
commits (the rest are pull-request merges). Each row records where the reading
stands, and a decision moves the row.

| upstream | disposition | overlap | subject |
|---|---|---|---|
| `ee9ede87` | in | 100% | Let mail wider than the pane scroll sideways |
| `05f406b1` | CI / infra — not taken (GitHub Actions here) | 97% | ci: a cancelled GitHub run no longer reports failure to Gitea |
| `7619777a` | docs/process — not taken (ours) | 96% | Docs: eleven languages, with Turkish contributed by Hakan Arslan |
| `290cce57` | in | 95% | Keep an open message unread after Mark as unread |
| `ef33c0b1` | settings load — not taken (this tree's settings-sync design already prevents the reported failure) | 95% | Finish the settings load when the tree remounts mid-load |
| `4fe51f43` | CI / infra — not taken (GitHub Actions here) | 94% | ci: make the image digest artifacts re-runnable |
| `1ebb1866` | process — not taken (upstream sends its issue reports to Gitea) | 92% | Send GitHub issue reports to Gitea |
| `e9f8c7bb` | docs/process — not taken (ours) | 89% | docs: point issues and discussions at Gitea and the forum |
| `13716952` | CI / infra — not taken (GitHub Actions here) | 89% | ci: run the github wait job on its own runner label |
| `d9fd0225` | CI / infra — not taken (GitHub Actions here) | 88% | ci: build on GitHub via the mirror, switchable with BUILD_ON |
| `a09bca80` | client UX — not taken (the composer's editor resizes images itself, so this is a second implementation) | 85% | Resize images in the composer |
| `eeebfb5c` | CI / infra — not taken (GitHub Actions here) | 84% | ci: copy each release image to GHCR as a replica |
| `8cb14571` | CI / infra — not taken (GitHub Actions here) | 83% | ci: copy each release to GitHub after the tag build |
| `c725ba5c` | in (adapted to this tree's key set) | 39% | feat(i18n): add Turkish translation |
| `d03a9595` | i18n — not taken (the strings belong to the image resize that was not taken) | 38% | Turkish: the three image size strings |
| `22490d8` | in | 95% | Keep a narrow list's labels inside the row, on the sender's line |
| `33dc8be` | in (adapted: the same rule moved Dutch too) | 64% | Turkish out of Beta: it comes from a native speaker |
| `f8d282e` | in (adapted to this tree's send flow) | 90% | Never send a message twice; two small composer and sidebar fixes |

## After the newest release

`upstream/main` is ahead of `v2026.10.5-g20c32ed` (`20c32ed`) by 6 commits, 3 of
them work commits (the rest are pull-request merges). Each row records where the
reading stands, and a decision moves the row.

| upstream | disposition | overlap | subject |
|---|---|---|---|
| `c1c4740` | in (this tree already counts ten translations) | 90% | Ten translations: count Turkish where the repo states the number |
| `c6ae1bd` | attribution — not taken (our `NOTICE` names Coffey Labs) | 50% | Name Coffey Labs LLC as the copyright holder |
| `78eafdb` | process — not taken (SECURITY/CONTRIBUTING/CODE_OF_CONDUCT are ours) | 50% | Send security and conduct reports to Coffey Labs LLC addresses |

## Keeping it current

A merge or a hand-take appends its row in the same change that lands the code
(or records the sha in its message and lets the table be rebuilt). A row is
never edited to say what it used to be: the disposition moves with the code, and
git holds the version before it.
