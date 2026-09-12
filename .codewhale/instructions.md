# Gilbert — working law for this repository

## Identity
The project is **Gilbert** — a distinct application, backronym for
**G**eneral-purpose **I**ntelligent **L**ifecycle **B**utler for
**E**nterprise **R**esource **T**raceability. Its mail client is based on
upstream ihasmail (Coffey-Labs), which is download-only (ADR 0002): releases
sync in, nothing goes back. Canonical statement: README.md top.

## Snapshot mode
Files and comments describe the code as it is now. Never write "it used to
be X, then it became Y", never narrate a rename, a migration or any
before/after. If somebody wants history, it is in git.

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
paths. `ihasmail` appears only where upstream's real name must stay: the URLs
(ihasmail.org, docs.ihasmail.org, github.com/Coffey-Labs/ihasmail), the
lineage and the AGPL attribution in `LICENSE`/`NOTICE`/`README`/ADR 0002.
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
with a `Status` line (Proposed / Accepted / Superseded) and Context, Decision
and Consequences sections.
Write the ADR when the change is designed, before or alongside the
implementation, so the design is reviewable first; an implementation must
match the standing (newest non-superseded) ADR that covers it. Changing a
standing decision means a new ADR that supersedes the old one — never edit an
accepted ADR's history. ADRs stay `Proposed` until the owner accepts them.
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
Dependabot bump. `npm run dev` · `dev:mock` (demo@example.com /
demo) · `dev:mock:no-future-release` · `typecheck` · `test` · `build`.
**Lint + format gate: Biome** (`biome.jsonc` — calibrated to this repo's
actual style, with deliberate, commented rule exceptions; a11y off). Run with
`npm run lint` / `npm run lint:fix`; it is part of `prepush` and of the CI
release pre-check.
**The gate reports zero, or it has not passed (global user rule, active here).**
"Pre-existing" is not a category: every error, warning and informational finding
the gate prints is fixed, whoever wrote the line and whenever it arrived — and a
non-zero count is work to do, never context to report. Biome 0/0/0, no failing
test, no skipped test, a dependency audit at zero.
**Tests assume the runner's local timezone is UTC** (GitHub's default); on a
non-UTC machine run them as `TZ=UTC npm test` — `prepush` already forces it so
the local gate matches CI.
Version from git at build time (`node scripts/version.mjs`).

## Language
Code comments, documentation, commit messages and every other file in the repo
are written in **English**. Never write or translate repo content into another
language. Chat replies follow the user's language — the chat is not repo
content.

## Workflow
Read the affected area first; smallest coherent diff.
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
lint + tests); a pre-push hook enforces it — hook in `.githooks/pre-push`,
enabled per clone with `git config core.hooksPath .githooks`, bypass only
deliberately with `--no-verify`. Remote CI does not run on push: it is the
release pre-check, with one exception -- pull requests opened by Dependabot run
it automatically (their branches never pass through the local hook).
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
**The public docs lead with Gilbert's own.** `README.md` and `FEATURES.md`
open with what this project owns — groups, chat, and above all the agents,
whose section is the detailed one — and treat the upstream client as a
pointer: a line saying it is upstream's and where its documentation lives,
with its detail kept afterwards for completeness and never as the lead. A
change that makes a sentence in any public doc false fixes it in the same
commit, and a new Gilbert feature is written where the reader starts, not
only in the section that happens to own it.
`origin/main` is **not branch-protected** (private repo): direct commit + push
to main is the normal flow.
**Releases are called manually by the user — for now there are none and none are
automated.** Never tag, publish, or trigger release/publish workflows on your
own (see `.github/workflows/release.yml`, `publish.yml`).
SECURITY.md / CONTRIBUTING.md / CODE_OF_CONDUCT.md are still upstream's process
and contacts — ask before changing or acting on them.
**Upstream is download-only (ADR 0002):** upstream releases are fetched
directly by the merge that takes them in (ADR 0002) — there is no mirror
branch — and the mail core merges them in. Nothing flows the other way — no contributions, no PRs, no upstream-shaped
fork. Common work stays here, renamed or not.
**Excluded upstream files (never absorbed; Gilbert's version always wins):**
upstream `CLAUDE.md` and `.github/FUNDING.yml` (owner decision 2026-09-06).
`CONTRIBUTING.md`, `SECURITY.md` and `CODE_OF_CONDUCT.md` are upstream's
process and contacts — ask before changing or acting on them.

Full law: load skills/gilbert-project. Renames: load skills/gilbert-branding.
UI strings & languages: load skills/gilbert-i18n. Settings & policy: load
skills/gilbert-settings. Stalwart internals, quirks & integration: load
skills/gilbert-stalwart. Upstream merges: load skills/gilbert-upstream-rebrand.
