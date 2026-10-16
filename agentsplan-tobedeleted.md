# The agent's remaining plan — temporary

This file is a working list, accessory to the architecture decisions and not a
decision itself. **Delete it when the list is empty.** Each item names the record
that owns it: the record is where the decision lives, this is only where the
remaining work is kept.

Read `docs/adr/0031`–`0036` first, and each record's `Implementation` line for
what the tree carries: those lines are the truth about the tree, and where this
file and a record disagree, the record is right and this file is stale.

---

## 1. The fact — what the tree carries today

**The design.** Six records, all `Accepted`: **0031** a described catalogue of
tools and one model per installation; **0032** what the agent decides and what
only a person decides; **0033** one conversation in chat and mail; **0034** a run
is a document, and the record is the product; **0035** a group's engagement is a
rule in prose; **0036** one agent per installation, held by a claim.

**The body.**

| piece | where |
| --- | --- |
| the run document: shape, parser, transitions, budget, waits | `server/src/shared/run.ts` |
| where a run lives, and how it is written whole | `server/src/agent/runs.ts` |
| the installation's one claim | `server/src/agent/claim.ts` |
| changes and waits: what woke the agent, and when to look again | `server/src/agent/{events,timers,accountEvent}.ts` |
| the catalogue: eleven tools, their descriptions, the authority guard | `server/src/agent/tools.ts` |
| a group's rules in prose, and the one builder of the prose the model is told | `server/src/agent/{rule,rules,prose}.ts` |
| the model: the decision turn and the choosing turn, over one OpenAI-compatible call with the zero-retention opt-out | `server/src/agent/model.ts` |
| the loop: claim, due runs, change logs, the batch of calls, the endings | `server/src/agent/loop.ts` |
| the process: the server's own boot starts it, a pass every 10 s, the Master's groups re-read every pass | `server/src/agent/supervisor.ts`, `server/src/index.ts` |
| whether a received message is a person's word | `server/src/agent/trust.ts` (nothing calls it yet) |
| the reserved `G-` labels: applied by `mail.keyword`, refused by the catalog's write, shown in two sections | `server/src/shared/labels.ts`, `server/src/account.ts`, the two surfaces in `web/` |

**What is running, and what is not.** The server boots, resolves the Master's
groups, and works what the rules cover; a change no rule covers costs nothing. No
deployment has to be told to start it, because it is part of the server. What no
installation has yet is the conversation by mail, a person's authorisation
reaching a run, and any surface that shows what the agent did.

---

## 2. The to-do, in the order the owner decided it

### 2.1 Several rules may answer one change — **the next unit**

- **The record:** 0035, whose decision now says every rule that fits a change
  opens or continues its own run, and whose `Implementation` line says this is
  not built.
- **Today:** `loop.ts` puts a change to the decision turn once and opens one run.
- **To do:** the decision turn answers **every** rule that applies, and the loop
  opens or continues one run per rule; the change's own record names them all.
- **Proof:** two rules over one change produce two runs, and removing one of them
  from the answer leaves the other running.

### 2.2 A plan carries order and conditions

- **The record:** 0034, whose decision now says a plan may say what waits on what
  and what follows from an outcome, and whose `Implementation` line says the plan
  cannot carry it yet.
- **Today:** the calls of one answer run together, and a dependent step waits for
  the model's next turn.
- **To do:** the model's answer may name order and conditionals — this call first,
  then that one; if that call filed the message do this, if it was refused do
  that — reasoned from the group's KB, its checklists and its workorders. The loop
  runs what is ready, reads each outcome, and takes the branch the outcome names.
- **Open, and the owner should rule before it is designed:** the answer's shape
  (a plan of steps with dependencies, or a list the loop reads in the order
  given), and whether an outcome's branch is written by the model per step or
  deduced by the loop from each step's recorded outcome.
- **Proof:** a two-step plan whose second step differs by the first's outcome runs
  both branches in two runs; a plan whose first step is refused does not run the
  step that depends on it landing.

### 2.3 The mail channel — the conversation's other half (0033)

- **The record:** 0033; its `Implementation` line says the mail channel is not
  built.
- **To do:** sending and receiving the conversation by mail — a question the run
  asked leaves as mail, the answer comes back into the same run, correlated by
  the thread (`In-Reply-To`/`References`), with the answer's message id in the
  trace; the agent writes as itself and acts in the group's own account.
- **Depends on:** 2.4 (who a message is from) — which is built but inert — and the
  owed probe below.
- **Proof:** a run parked on a question is unblocked by a reply that carries the
  same thread, and a stranger's reply is information, never an instruction.

### 2.4 A person's authorisation is law

- **The record:** 0032 — an override is an administrator's, and once an operator
  or an administrator authorises one according to the authority class, that is
  the law and is not re-opened.
- **Today:** the authority classes and the guard exist (`mayRun`, ADR 0032) and a
  refusal is a recorded step; **what is not settled is who writes a run's
  authorisations, and whether anything does yet.** Verify in
  `server/src/shared/run.ts` (`RunAuthorisation`) and `agent/loop.ts` before
  designing this — do not assume.
- **To do:** the path by which a person's word reaches a run's authorisations —
  through the conversation (chat already, mail when 2.3 lands) or through a
  surface — and the record that it happened.
- **Proof:** a run refused for want of authority, authorised by a person, then
  carrying out the act on the next pass; and an authorisation for one act that
  does not license another.

### 2.5 The surfaces — the run visible, and the model chosen (0031, 0034)

- **To do:** the administration surface where the installation's model is chosen
  — today it is a field in the installation document, read at boot — the surface
  where an installation administrator sees the agent, the claim and the runs it
  has worked, with each run's plan and outcomes readable; the workorder panel's
  attribution of a step the agent settled (ADR 0028).
- **Then:** `FEATURES.md` and the public docs, in the same change as each.
- **Proof:** a run worked in the mock is readable from the surface alone, and
  choosing a model there takes effect at the next boot (ADR 0011).

### 2.6 The tools the inventory still lacks

- **Draft a reply.** `README`'s own paragraph promises the agent will draft
  replies, and no tool does it: a tool that writes a draft into the group's
  account, within the authority classes.
- **Propose a KB page** (ADR 0024) and **settle a workorder step** (ADR 0028):
  both are named in `ROADMAP.md` as absent.
- **Then:** the KB and the checklists the plan's conditions are reasoned from are
  read through the reading tools; check that a conditional's evidence is
  reachable before writing the conditional.

### 2.7 The two outer levels of prose have no reader

- **The record:** 0035 — three levels, outermost first: the installation's own
  line, the group's standing instruction, the rule's own.
- **Today:** the builder exists; nothing reads the first two, so a call carries
  the rule's instruction alone (said in 0035's `Implementation`).
- **To do:** the two documents and their readers, in the Master's account and the
  group's, so every call carries all three.

### 2.8 A quiet log

- **Decided:** a repeated warning is a useless log. `probeMailStore`
  (`server/src/groupAccess.ts`) writes one per unreadable candidate — read once
  at boot before, six times a minute now that the groups are resolved every pass.
- **To do:** say it once when the state begins and once when it changes, the same
  shape the supervisor uses for the claim and for the groups.

---

## 3. Owed live probes — what no test in this repository can answer

These are written down as `owed:` markers where they belong; they stay owed until
someone asks a real server.

1. **The arrival record's shape** (`<!-- owed: arrival-record-shape -->`, ADR
   0033): what the supported Stalwart writes on a received message — the verdict
   and the first hop line, in particular whether a submission by one of its own
   accounts carries the submission marker. If it does not, local mail is refused
   until the reading learns that shape.
2. **A provider never probed live.** The client's contract is pinned against a
   stub; no real provider has answered it.
3. **`Authentication-Results` answers the receiving server's own** rather than a
   sender's — the same probe, read from the other side.
4. **Paging and the change log's cap** (`hasMoreChanges`, `changes_max_results`):
   modelled in the mock, never seen on a real server.

---

## 4. Deferred, from the audit and the debt ledger — do not lose them

- **Six dependencies no shipping code imports** (`server/package.json`): the
  audit's only *Must fix*, deferred by the owner to a later pass. Six manifest
  lines, one of them a test-only library to move to `devDependencies`.
- **`refundCredentialAttempt`** (`server/src/routes/shared.ts`) spells the
  4xx/5xx test that also exists as `isOwnRefusal` (`server/src/account.ts`): one
  predicate, two spellings.
- **`forgetRememberedFor`** (`server/src/requestMemory.ts`) is exported and called
  by nobody.
- **The translation ceiling** (`scripts/i18n-catalog-check.mjs`): `MISSING_MAX`
  is at the count of the day, 154 strings per language.
- **`moveMailboxPatch`** is spelled in both tiers (`server/src/agent/tools.ts`,
  `web/src/store/mail/mutations.ts`): hoist into `@gilbert/shared` when a unit may
  touch the client.
- **`isInstant`** lives in `shared/run.ts`; `shared/json.ts` is its natural home.
- **The vocabulary sweep:** "agent" is used for the Master principal in 0005,
  0007, 0023 and 0024, where the law reserves it for the process.
- **`CONTRIBUTING.md`** (the owner's file) still names `dev:mock:agent` with
  "the same plus an agent process": the name is an alias for `dev:mock` now, and
  the line may go with it.
- The full ledger of `shortcut:` markers is `/ponytail-debt`; what is still
  cuttable is `/ponytail-audit`.

---

## 5. Standing hazards, learned the hard way

1. **A test that spawns git must scrub the environment git hands a hook.** A
   fixture here inherited `GIT_DIR` while the gate ran, initialized *this*
   repository, and reset the branch it was gating; the guard is in
   `server/src/gate-prepush.test.ts` (`gitEnv`), and the pin is the test that
   caught it.
2. **A true sentence beside code that stopped matching it is this repository's
   recurring defect** — again and again in the last two days, in files nobody was
   looking at, and no gate catches it. When a unit lands, re-read the sentences it
   falsifies rather than only its diff.
3. **The mock is a second Stalwart.** A green suite is not evidence about a real
   server; each simulation's assumption is pinned next to it, and the probes in
   section 3 are what closes the gap.
4. **One writer per file.** Two writers in one checkout have cost this work a
   lost branch's tip, an invalidated push, and two failed gates.
