# Gilbert — working law for this repository

## Repository map

npm workspaces: the root coordinates, the two packages hold the code.

- `web/` — `@gilbert/web`, the React 19 + TypeScript SPA (Vite): `web/src/jmap`
  (client, push, types), `store/` (zustand, one per feature: session, mail,
  compose, contacts, calendar, files, sieve, settings, mdn, scheduled, agents,
  chat, groupLabels), `lib/`, `views/`, `ui/`, `locales/`. Entry:
  `web/src/main.tsx`.
- `server/` — `@gilbert/server`, Node + Hono: `server/src/index.ts` serves the
  SPA and `/api/*`; `server/src/agent/agent.ts` is the agent fleet's entrypoint;
  `server/src/mock/` is the in-memory fake Stalwart; `server/src/shared/` is the
  tree both tiers read.
- **One definition, two readers.** The client imports the server's shared tree
  as `@gilbert/shared/*` (and `@gilbert/agent/*`), aliased in
  `web/tsconfig.json` and `web/vite.config.ts`. Never copy a shape or helper
  into `web/`; import it.
- `scripts/` — the checks `prepush` runs (`adr-owed`, `adr-cite`, `config:dead`,
  `i18n-*`), plus `version.mjs` and `codeql.mjs`.
- `docs/adr/` — one decision per file, indexed by `docs/adr/README.md`.
  `FEATURES.md` is the feature inventory; `KNOWN-ISSUES.md` and `ROADMAP.md` are
  the product docs.

## Identity
The project is **Gilbert** — a distinct application, backronym for
**G**eneral-purpose **I**ntelligent **L**ifecycle **B**utler for
**E**nterprise **R**esource **T**raceability. Its mail client is based on
upstream ihasmail (Coffey Labs), which is download-only (ADR 0002): releases
sync in, nothing goes back. Canonical statement: README.md top.

## Snapshot mode
Files and comments describe the code as it is now. Never write "it used to
be X, then it became Y", never narrate a rename, a migration or any
before/after. **A document is edited in place**: when what it describes
changes, the sentence changes with it in the same diff, and the version it
replaced is left to git rather than kept beside it or pointed at. If somebody
wants history, it is in git.

## Naming rule
The product has four blocks, named once in `README.md`: **gilbertmailer**,
**gilbertserver**, **gilbertagents** and **gilbertstalwart**. Every doc, ADR
and skill names them that way and does not redefine them; a new document links
to the README rather than restating it. Only `gilbertmailer`, and inside
`gilbertserver` the layer that serves it, come from upstream — the rest is
Gilbert's own, and the README states that line once.
Prose about the product says "Gilbert", and every code and build identifier
is `gilbert`: `APP_NAME` default "Gilbert", packages `gilbert`/`@gilbert/*`,
`GILBERT_VERSION`, `X-Requested-With: gilbert`, UI strings and catalogs, the
app folder, the sieve script name, storage keys, the `[gilbert]` log prefix,
the `session.gilbert` extension, MIME types, docker/deploy identifiers and
paths. `ihasmail` appears only where upstream's real name must stay: the AGPL
attribution in `LICENSE`/`NOTICE` — `NOTICE` being the only file that carries
its addresses (ihasmail.org, docs.ihasmail.org, git.coffeylabs.org/coffey-labs/ihasmail,
and its GitHub-era ihasmail-github-archive) — and the lineage prose in
`README`/ADR 0002, which names upstream and points at `NOTICE`. No public doc
carries a link to upstream: `README`, `FEATURES.md`, `KNOWN-ISSUES.md`,
`ROADMAP.md` and the ADRs name it plainly, cite an issue number as a plain
number, and send the reader to `NOTICE` for the address.
An upstream merge delta that introduces `ihasmail` identifiers, strings or
prose is renamed to `gilbert`/`Gilbert` during the merge, automatically and
without asking — including user-visible names such as a shipped theme or
palette id. Only the upstream-name exceptions above may stay.

The agent vocabulary is three words and they are not synonyms. One **Master**
is the principal everything belongs to: the account in Stalwart
(`gilbert@…`), its address, its password, its grants, and the model it uses. Its
**agents** — **Group Agents** where the surface lists them for one group — are
the processes that act as it: what a deployment starts, what claims a group's
account by lease and runs its automations, and what the administration counts
and shows. **Worker** is kept for what is technically one: the browser's
service worker. So prose and UI say "agent" where they used to say "worker",
and an unqualified "worker" means the browser's.

**The identifiers follow the same three words, in a sweep listed where the work
is read (`ROADMAP.md`)** — the file, the types and the functions on one side, and
on the other the things that are contracts rather than names: a field in a
document an installation has already written, a refusal code a client composes a
sentence from, an environment variable an operator set. Each moves with every
reader and writer of it in the same change, or it does not move at all.
## Architecture law
JMAP only, to Stalwart; no own database; everything durable lives in Stalwart;
container disposable; `IMMUTABLE=1` = no writable filesystem. Values: fail
loudly, degrade gracefully by capability, sanitise HTML, settings follow the
account (localStorage is only a cache).

## Architecture decisions (ADR)
Decisions that shape the architecture — where durable state lives, a protocol
surface, a trust boundary, an enforcement door, or a documented invariant —
are recorded as Architecture Decision Records under `docs/adr/`, one file per
decision: `NNNN-kebab-case-title.md` starting at `0001`, written in English,
with a `Status` line (Proposed / Accepted) and an `Implementation` line, then
Context, Decision and Consequences sections.
**`Status` is where the decision stands; `Implementation` is where the tree
stands.** One line each, both required. `Status` moves only when the owner
accepts a decision — it is a judgement, not a build state — and it never carries
a date or a note about what an earlier version said. `Implementation` says
whether the tree carries the decision and names the files that do:
`Built.` with the paths, `Partly built.` naming what is carried and what is
not, or `Not built.` A record whose implementation is owed the live probe it
depends on says so in its body, and `ROADMAP.md` carries what is planned.
Neither line is a changelog: the version before this commit is git's.
Write the ADR when the change is designed, before or alongside the
implementation, so the design is reviewable first; an implementation must
match the ADR that covers it. ADRs stay `Proposed` until the owner accepts them.
**A record is edited in place, and the history is git's.** Changing a standing
decision means rewriting the record that carries it, in the change that alters
it, until it states the decision as it now stands: never a second record that
supersedes the first, never a `Superseded` status, never a sentence narrating
what the earlier version said or what used to be true. A number is minted for a
decision that is new, not for a version of one already here. The single
exception is the owner asking for otherwise, explicitly and in the turn: only
then does a decision get a record beside the existing one instead of a rewrite
of it.
**Snapshot mode applies to the ADRs too, and a resolution carries no
back-reference.** It states the decision and the facts it rests on — never the
conversation that produced it: no "the first/second/third branch review found",
no "the review raised", no "as the reviews recommended". Resolution numbers,
dates, `Owed:` markers and every fact stay exactly as they are; what goes is the
reference to the round that argued it. A reader of the record is reading
decisions, not a diary — the history is in git.

## Toolchain
Node ≥ 24, npm workspaces. **Node runs on the latest LTS line, and the line is
the one the deployment pins** (`Dockerfile` and `.github/workflows/ci.yml` say
24). A Current release is never supported, and `@types/node` follows the pinned
line rather than the newest published one: typing against a release nobody
deploys describes a Node this project does not run. Moving the line is a
deliberate change of all of it at once (image, CI, engines, types), never a
Dependabot bump.

```bash
npm run dev:mock        # full stack, mock Stalwart, demo@example.com / demo
npm run dev:mock:agent  # the same, with an agent process
npm run dev             # a real Stalwart (STALWART_URL in .env)
npm run typecheck       # tsc, both packages
npm test                # vitest (web) + node:test (server)
npm run build           # web/dist, then server/dist
```

One test, not the suite: `npm run test -w web -- src/lib/<name>.test.ts`
(vitest), or from `server/` `npx tsx --test src/<name>.test.ts` (node:test).
**Lint + format gate: Biome** (`biome.jsonc` — calibrated to this repo's
actual style, with deliberate, commented rule exceptions; a11y off). Run with
`npm run lint` / `npm run lint:fix`; it is part of `prepush` and of the CI
release pre-check.
**The gate reports zero, or it has not passed (global user rule, active here).**
"Pre-existing" is not a category: every error, warning and informational finding
the gate prints is fixed, whoever wrote the line and whenever it arrived — and a
non-zero count is work to do, never context to report. Biome 0/0/0, no failing
test, no skipped test, a dependency audit at zero, `npm run codeql` at zero
result(s).
**Tests assume the runner's local timezone is UTC** (GitHub's default); on a
non-UTC machine run them as `TZ=UTC npm test` — `prepush` already forces it so
the local gate matches CI.
**`npm run prepush` is the fast gate**, in order: typecheck, Biome, `adr:owed`,
`adr:cite`, `config:dead`, `i18n:check`, then `TZ=UTC npm test`;
`npm run prepush:full` appends `codeql`. The pre-push hook runs it.
Version from git at build time (`node scripts/version.mjs`).

## Language
Code comments, documentation, commit messages and every other file in the repo
are written in **English**. Never write or translate repo content into another
language. Chat replies follow the user's language — the chat is not repo
content.

## Workflow
Read the affected area first; smallest coherent diff.
**Load the skill that governs the work before the first edit of it (global user
rule, active here — owner decision 2026-09-18).** The list at the end of this
file says which skill a kind of work belongs to, and `gilbert-project` is loaded
at the start of any task here. A skill read afterwards is a skill that did not do
its job: it is where a convention this file states once is written out in full,
and the cost of skipping it is a change rewritten against rules that were already
written down.
**A unit of work is committed when it is finished (global user rule, active here
— owner decision 2026-09-18):** within a turn that authorises commits at all (see
the rule below), each unit lands as it is finished — not at the end of the turn,
and not once a review has been answered. A unit is one coherent change — a rule
with its guard and its test, a document with the sentences the change falsified,
an i18n fix with the catalogs it emptied — and it lands with its own message.
Work held back until a review or a turn's end becomes a mega-commit whose message
cannot say what it did and whose parts cannot be read apart. What is **not** part
of the unit is its check: the gates run once, at the end of the coding (the rule
below), so a unit commit is the change and its message and nothing else.
**Single source of truth, no code duplication (global user rule, owner-confirmed
2026-09-08):** every concept, constant, classifier, schema and helper has one
canonical definition; everything else imports or derives from it. Before
writing a new definition, search for the existing one; a found duplicate is
deleted and routed through the canonical source in the same change.
**Dispatched sub-agents are health-checked automatically, never on request:**
poll each running agent at least every ~60 s (steps advancing, live tool
calls, processes, worktree writes / file mtimes). An agent with no progress
across consecutive polls, or that dies or is cancelled, is investigated and
replaced or recovered immediately — never left until the user notices.
**Cost and time discipline (global user rule, active here):** agents read only
the diff hunks under review plus the functions they directly call — targeted
grep/sed/read slices, never whole large files; review agents do not run full
test suites (the parent runs the gate); large reviews are split into small
parallel reviewers by area; deep reasoning is reserved for security-critical
surfaces. An agent that drifts into wide exploration gets a converge-now
instruction rather than being left to widen scope.
**Reviewer dispatch (owner decision 2026-09-09):** every review is split into small parallel reviewers by
area, each with an explicit bounded file list, a diff range limited to the
change under review (never a stale merge-base that drags unrelated history
in), a tool-call budget stated in the prompt (~12), and the read-only grammar
preamble. Poll reviewer agents and act on the first anomalous poll — one past
budget or burning tokens on wide exploration gets converge-now or cancel
immediately; sunk cost is never a reason to let it finish. The parent runs all
gates; reviewers never do.
**Agent lifecycle (owner decision 2026-09-09):** never end a turn while
turn-owned sub-agents are still running: join them first (`agent` wait with
`until="all"` per owned id) or detach them deliberately (`detached=true`). A
child parked as interrupted is a continuable checkpoint: resume the same lane
with `resume_from`, never re-dispatch a fresh agent over it. Re-dispatch is
justified only when the base has moved so far that the parked work is
worthless — cancel the parked record then, and say so. Terminal records cost
nothing to keep; a new wave never starts while the previous one's lanes are
still open.
**Reviewer budgets are input bounds (owner decision 2026-09-09):** the runtime
config sets no per-role step/token budget (only `max_subagents`,
`max_concurrent`, model strength), so a "~12 tool calls" limit is prose and
will be exceeded. The enforceable guarantee is what the parent puts in front
of the child: hand each reviewer per-file diff slices or a file list whose
combined diff output is small — never a directory-level diff. Tool output is
capped; a truncated diff gets re-read and re-run, which is what burns
hundreds of k tokens. A reviewer whose output was truncated narrows with
`read_file`/single grep — it never re-issues the same wide command.
**Claims, docs and parallel writers (owner decision 2026-09-10):** a comment, an ADR sentence and a FEATURES bullet are **claims about
the code**. Three rules follow, and they bind parent and child alike.

1. **Write only what you have read.** A docs/ADR writer dispatched beside code
   writers describes the code that is **in the tree**, verified by reading it —
   never the work in flight. If the code has not landed, the docs writer either
   waits for it or writes nothing about it; an ADR that records a decision the
   tree does not implement is a false claim on the most authoritative document
   in the repo. Prefer dispatching the docs pass **after** the code pass, and
   have the parent re-check the ADR against the diff before committing.
2. **A change that makes a claim false fixes the claim in the same diff.** Grep
   for the sentence you just invalidated (the old behaviour often survives in a
   sibling file's comment, a test comment or the ADR) and correct it there and
   then. This is the recurring defect of this repo: code that is right beside
   prose that is not.
3. **One writer per file, and expect the checkout to be shared.** Parallel
   writers get disjoint `write_roots`; a child whose role is read-only or
   docs-only may lose `bash` entirely while a peer writes in the same checkout
   (`Tool bash cannot prove a bounded file target …`). That is not a failure to
   retry: instruct such children to verify by `read`/`edit` and to say what they
   could not run, and keep **all gates in the parent**.

**Invariant tests (owner decision 2026-09-10):** a mechanism the ADR names has at
least one test that **fails when the mechanism is removed** — not a test that
the code merely runs. The list is not decorative: it is how "we implemented X"
stays true a month later. When a review names a mechanism as untested (claim
epoch and fencing, the `missed` entry, two agents racing one claim, the
recovery of an abandoned run, the per-action ledger, an unreadable document),
the fix includes the test. A mock that stands in for a server behaviour the code
depends on pins that assumption with a test **next to the simulation**, and the
live probe it owes stays written down as owed. Reordering effects against their
intent line (or the reverse) means running the affected area's tests before
claiming the reorder is safe — that reorder is exactly what a stored document
has to keep agreeing with.

**Every review ends with the owner's decisions (owner decision 2026-09-09):**
the fixed deliverable is numbered findings (BLOCKER/MAJOR/MINOR/NIT) with
file:line evidence, a five-line summary, a VERDICT, and a closing **"Open
decisions for the owner"** section mapping each actionable finding to a
concrete choice with a recommendation. The parent forwards that section
verbatim; findings without a decision line are how reviews stopped being
actionable.
**Rules layering (owner decision 2026-09-09):** rules that must bind
dispatched sub-agents live, self-contained, in this file — children load the
repo's project instructions and nothing else. Owner-global counterparts live
in global memory and are labelled "(global user rule, active here)" when
mirrored here. Change the global entry first, then mirror; never keep a third
copy (skills and dispatch prompts restate the recipe by reference only).
**Merge/edit hygiene (owner decision 2026-09-09):** when resolving a conflict with the edit tool, the
oldText span must include the full `<<<<<<<`/`=======`/`>>>>>>>` marker lines
— never start below the opening marker; when taking a whole side wholesale,
strip markers with sed in the same command. No file is staged or committed
until a marker grep on that file (`<<<<<<<`, `>>>>>>>`, `^=======$`) returns
zero in the same shell invocation. Verification is per write step, never
batched at the end of a long run. Whole-tree rename scans (e.g. for
`ihasmail`) are never truncated with head/tail — scan per file with bounded
output instead.
**Every push is gated by the fast CI** (`npm run prepush`: typecheck + Biome
lint + the check scripts + tests); a pre-push hook enforces it — hook in `.githooks/pre-push`,
enabled per clone with `git config core.hooksPath .githooks`, bypass only
deliberately with `--no-verify`. `ci.yml` does not run on push: it is the
release pre-check, and only Dependabot's pull requests start it, because their
branches never pass through the local hook.

**An action's `uses:` names a full commit SHA**, with the version it is in a
comment beside it (owner decision 2026-09-23): a tag is a moving target, and
one that is repointed runs in this repository's release path with its token.
A `./.github/workflows/…` reference is a workflow here rather than an action,
and is not pinned. Dependabot's `github-actions` updates are what move these —
a bump that moves the SHA without the version comment beside it is a review
finding. The workflows this repository owns are ours; upstream's CI is not
taken.

**Code scanning runs on every push and pull request** (owner decision
2026-09-17): GitHub's default setup, configured in the repository's settings
and by no file here, analysing the tree with the JavaScript/TypeScript
code-scanning suite. It stays out of the fast gate — a 686 MB toolchain and an
analysis of minutes — so `npm run codeql` is that same analysis on demand and
`npm run prepush:full` is the fast gate plus it; the toolchain is found through
`CODEQL_CLI`, on `PATH`, or in the bundle cache, and a run without one **fails
with the install instructions** rather than reporting a clean tree. An alert it
prints is work to do in the same change, like any other finding a gate prints.
**Coding first, gates once, at the end of the turn (global user rule, active
here — owner decision 2026-09-18):** a task that carries a plan of several units
does **all** of its work first — coding, docs and the claim fixes that go with
them — landing one commit per finished unit, and runs **no test, no typecheck, no
lint and no check script between units**. The gates run **once, at the end, on a
tree whose work has stopped moving**: the checks that would gate a commit, then
`npm run prepush` (once; the push hook runs it too), and `prepush:full`/`codeql`
where the turn calls for them — and everything they report is fixed in one pass
before the turn closes. A dispatched child runs no gate at all. A check run in
the middle of a plan reports a tree that is still moving and shatters one pass of
fixes into a queue of interruptions; it is not evidence of anything. What this
moves is **when** the checks run, never **whether**: a turn does not close on an
unchecked tree, and what the end-of-turn run finds is fixed in that same turn.
No commit or push unless the user's message in the current turn says so.
**The feature inventory stays current.** `FEATURES.md` is the inventory of
what Gilbert does (its upstream text arrives by merge, renamed); every
feature Gilbert implements beyond upstream is written there, in the same
change that implements it, and updated whenever later work changes it. An
upstream merge is not done when it compiles — it is done when the merged
delta has been rebranded (gilbert-upstream-rebrand) **and** the inventory
has been reconciled: features the merge adds/removes/changes are reflected
in `FEATURES.md`, and the Gilbert-added sections survive intact. ADRs record
the decisions behind features; the inventory records the features.
**A merge takes a change, not a file — and a collision is decided, not
assumed.** Where the tree diverged on purpose, an upstream hunk applied
verbatim undoes a decision nobody re-opened — silently, since it neither
conflicts nor fails a test. What is forbidden is the silence, not the
direction: read both sides, take the better one, and rewrite the ADR or
comment in the same change — including when upstream's version is the better
one, which it often is. Two deliberate designs that both work are the user's
choice, not the merge's. Recipe: `gilbert-upstream-rebrand`.
**The public docs lead with Gilbert's own.** `README.md` and `FEATURES.md`
open with what this project owns — groups, chat, and above all the agents,
whose section is the detailed one — and treat the upstream client as a
pointer: a line saying it is upstream's and where its documentation lives,
with its detail kept afterwards for completeness and never as the lead. A
change that makes a sentence in any public doc false fixes it in the same
commit, and a new Gilbert feature is written where the reader starts, not
only in the section that happens to own it.
`origin/main` carries **branch protection** (private repo, set through the
API): it refuses a force push and a branch deletion, with `enforce_admins` off
so the owner can still bypass it — the point is to guard the two pushes that
cannot be undone, not to bind the owner. Nothing else is required of it: no
review, no status check, since the gate a push meets is the local pre-push hook
— so direct commit + push to main is still the normal flow. Lifting or widening
the protection is the owner's call, never a side effect of another change; when
it moves, this sentence and `CONTRIBUTING.md` are what state it.
**Releases are called manually by the user — for now there are none and none are
automated.** Never tag, publish, or trigger release/publish workflows on your
own (see `.github/workflows/release.yml`, `publish.yml`).
**Upstream is download-only (ADR 0002):** upstream releases are fetched
directly by the merge that takes them in (ADR 0002) — there is no mirror
branch — and the mail core merges them in. Nothing flows the other way — no contributions, no PRs, no upstream-shaped
fork. Common work stays here, renamed or not.
**Excluded upstream files (never absorbed; Gilbert's version always wins):**
upstream `CLAUDE.md` and `.github/FUNDING.yml` (owner decision 2026-09-06).
`CONTRIBUTING.md`, `SECURITY.md` and `CODE_OF_CONDUCT.md` are upstream's
process and contacts — ask before changing or acting on them.

Full law: load `.opencode/skills/gilbert-project/SKILL.md`. Renames: load
`.opencode/skills/gilbert-branding/SKILL.md`. UI strings & languages: load
`.opencode/skills/gilbert-i18n/SKILL.md`. Settings & policy: load
`.opencode/skills/gilbert-settings/SKILL.md`. Group-owned data & features: load
`.opencode/skills/gilbert-groups/SKILL.md`. Stalwart internals, quirks &
integration: load `.opencode/skills/gilbert-stalwart/SKILL.md`. Upstream merges:
load `.opencode/skills/gilbert-upstream-rebrand/SKILL.md`. The skill that governs
a kind of work is loaded before the first edit of it.

## Shell: nothing unbounded in the foreground (global user rule, active here)

- A command that is not bounded to a few seconds goes to the background at
  launch (`background=true` / `task_shell_start`) and is polled. The runtime's
  own tool text puts the line at >5 s; there is no global default and no
  auto-promotion, and `Ctrl+B → /jobs` is the owner's manual override, never
  the recovery path for a command an agent launched.
- If a foreground command is already sitting with no output, move it to `/jobs`
  yourself and poll it, or kill it and relaunch it in the background — the
  owner must never be the one who unsticks it.

## Worktrees

- A worktree of this repository lives in `.worktree/` — the canonical name, here
  and in every repository: `<repo>/.worktree/<slug>`. Not `.worktrees/`, not
  `<name>.worktree/`, no per-tool spelling.
- Create one with `git worktree add .worktree/<slug>`.
- A worktree is a checkout, not content. `/.worktree/` is ignored — in a
  repository whose `.gitignore` belongs to upstream, the pattern lives in
  `.git/info/exclude` instead — so `git add -A` can never stage one.
