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

**The design.** Seven records, all `Accepted`: **0031** a described catalogue of
tools and one model per installation; **0032** what the agent decides and what
only a person decides; **0033** one conversation in chat and mail; **0034** a run
is a document, and the record is the product; **0035** a group's engagement is a
rule in prose; **0036** one agent per installation, held by a claim; **0037** its memory is a graph of facts it recalls.

**The body.**

| piece | where |
| --- | --- |
| the run document: shape, parser, transitions, budget, waits | `server/src/shared/run.ts` |
| where a run lives, and how it is written whole | `server/src/agent/runs.ts` |
| the installation's one claim | `server/src/agent/claim.ts` |
| changes and waits: what woke the agent, and when to look again | `server/src/agent/{events,timers,accountEvent}.ts` |
| the catalogue: the tools, their descriptions, the authority guard | `server/src/agent/tools.ts` |
| a group's rules in prose, and the one builder of the prose the model is told | `server/src/agent/{rule,rules,prose}.ts` |
| the model: the decision turn and the choosing turn, over one OpenAI-compatible call with the zero-retention opt-out | `server/src/agent/model.ts` |
| the loop: claim, due runs, change logs, the batch of calls, the endings | `server/src/agent/loop.ts` |
| the process: the server's own boot starts it, a pass every 10 s, the Master's groups re-read every pass | `server/src/agent/supervisor.ts`, `server/src/index.ts` |
| whether a received message is a person's word | `server/src/agent/trust.ts` (nothing calls it yet) |
| reading inside a document, and a picture through the model | `server/src/documentText.ts`, `agent/model.ts` (`readImage`) |
| the reserved `G-` labels: applied by `mail.keyword`, refused by the catalog's write, shown in two sections | `server/src/shared/labels.ts`, `server/src/account.ts`, the two surfaces in `web/` |

**What is running, and what is not.** The server boots, resolves the Master's
groups, and works what the rules cover; a change no rule covers costs nothing. No
deployment has to be told to start it, because it is part of the server. The
conversation runs in chat and in mail, a person's authorisation arrives in the
sentence that answers a run, and Administration shows what the agent did. What
remains is in section 2 and in the deferred list.

---

## 2. The to-do, in the order the owner decided it

### 2.1 Several rules may answer one change — **built** (`bed8ade`)

- **The record:** 0035, whose decision says every rule that fits a change opens
  or continues its own run, and whose `Implementation` line now says so.
- **Built:** the decision turn answers every rule that applies beside the facts of
  the change, and the loop opens or continues one run per rule, reading the run's
  own document to recognise a change it has already answered.
- **Proof:** two rules over one change produce two runs, and removing one of them
  from the answer leaves the other running.

### 2.2 A plan carries order and conditions — **built** (`ec8a066`)

- **The record:** 0034, whose decision says a plan may say what waits on what and
  what follows from an outcome, and whose `Implementation` line says the tree
  carries it.
- **Built:** the choosing turn's answer is a plan whose steps may name an earlier
  step and the outcome they need; the loop runs the steps whose dependencies have
  ended together, reads each outcome and takes the branch that outcome names, and
  leaves a step no branch reaches unrun with the record naming which step and
  which outcome left it.
- **Proof:** a plan whose two later steps wait on the first, one per outcome, runs
  the branch its outcome names in two runs; a step whose dependency was refused is
  left unrun, and the record names the step and the outcome.

### 2.3 The mail channel — the conversation's other half — **built**

- **The record:** 0033, whose `Implementation` line says the mail half is built.
- **Built (2026-10-18):** the question by mail (`mail.ask`, to a **principal with
  access** read from the directory with `groupMembers`, sent through
  `EmailSubmission/set`) and the answer that continues the run (`mailAnsweredBy`,
  matched on `inReplyTo` / `references` against the question's `Message-ID`, and
  refusing a sender that is the group itself). One pass asks and parks the run
  with no date; the next is continued by the reply on that thread
  (`agent/loop.test.ts`).
- **Also built — reading inside a document:** `files.read` and
  `mail.readAttachment` go through one reader (`server/src/documentText.ts`): a
  PDF's text layer, Word, a spreadsheet, OpenDocument, text; and an image — or a
  page with no text layer, rendered by pdfium and encoded as a PNG — is
  transcribed by the installation's model (`readImage`), because no OCR engine is
  installed.
- **A finding worth keeping:** the account `agent/loop.test.ts` works by default
  is the **shared** one, which carries no mail in the mock, so a message created
  there is a change event with no message behind it. The mail test names an
  account with mail instead; the "server bug" was that.
- **Proof:** a run parked on a mail question is unblocked by a reply that carries
  the same thread; a stranger's reply is information, never an instruction.

### 2.4 A person's authorisation is law — **built** (the conversation's word)

- **The record:** 0032 — an override is an administrator's, and once an operator
  or an administrator authorises one according to the authority class, that is
  the law and is not re-opened.
- **Built** (owner decision 2026-10-18: the conversation, not a surface): the
  sentence that answers a run's question is read once for what it authorises
  (`readAnswerAuthority`, `agent/model.ts`), and the loop records each act it
  names on the run (`authoriseAnswer`) with the person's words verbatim, the
  class, the act, the address it came from and the message it arrived in. The
  guard is the fence: an authorisation licenses the act it names and no other.
  An **override is refused by name** — class 4 is an installation
  administrator's, and a sentence in a group's chat does not prove that marker —
  and a reading this build cannot use is a failed step that grants nothing.
- **Proof:** a person's answer that names a send records exactly that act and the
  step whose act it matches runs; a sentence that authorises nothing records
  none; an override is refused by the reading (`agent/model.test.ts`,
  `agent/loop.test.ts`).
- **The acts:** `mail.send` is in the catalogue as class `outward` (the address
  and the words are the act, and the guard compares them exactly — pinned in
  `agent/tools.test.ts`). A **destroy stays out of the catalogue on purpose**
  (ADR 0032, owner decision 2026-10-18): class 2 is a person's act on the surface,
  because an act a person can only name by an id is not one a sentence can
  authorise.

### 2.5 The surfaces — the run visible — **built**

- **Built** (`bc2198a`, `5802abd`, `2e041df`): the installation's model is chosen
  from Administration → Installation over the document the surface already
  publishes — provider, model, base URL and a write-only key whose states are
  told apart by the request itself: absent or empty keeps the stored one, the
  switch clears it, a value writes it — with the private-address switch left
  where it belongs, in the operator's
  environment, and the surface saying plainly that an installation with no model
  has no agent.
- **Built** (`ca67f92`, `47308b6`, `9587649`): Administration → Agent, where an
  installation administrator sees the agent as it stands — the claim it holds on
  the **Master's** account, how long that claim lives, and the model it runs on,
  answered from the claim document the agent itself writes and linked to the one
  place the model is chosen — and the runs each group has worked, drawn as the
  record carries them: the plan, each step's dependencies and the outcome it needs
  and the outcome it ended with, the branch taken, what the run recalled, and a
  document that cannot be read said out loud instead of drawn blank.
- **Built** (`workorder.settle`, then the panel's stamp): a step the agent
  settled reads in the workorder panel as **"Set by the agent on …"**, not as
  the stored `gilbert-agent` signature — one predicate
  (`isAgentSignature`, `shared/agent.ts`) and one sentence choice
  (`web/src/lib/workorderStamp.ts`), so no surface shows the agent as a name.
- **Then (done):** `FEATURES.md` and the public docs, in the same change as each.
- **Proof:** a run worked in the mock is readable from the surface alone, and
  choosing a model there takes effect at the next boot (ADR 0011).

### 2.6 The tools the inventory still lacks

- **Draft a reply — built.** `mail.draft` writes a reply into the group's own
  Drafts and it is **always a reply to everyone**: the sender (or the message's
  reply-to) in To, the rest of the message's recipients in Cc, and the group's
  own addresses out of both. It carries the thread (`inReplyTo` and
  `references`), is marked `$draft` and filed in the Drafts folder, and its
  `from` is the **identity the group has configured** for the address the
  message reached — a group with no identity is refused with `no_identity`
  rather than written as a draft nobody could send. It is `reversible`: it
  reaches nobody and sends nothing. `replySubject` moved to
  `server/src/shared/text.ts` so the agent's draft and the client's reply cannot
  disagree about what "Re:" means.
- **Propose a KB page — built.** `knowledge.propose` writes the page's draft in
  the group's own account through the same writer a person's save uses
  (`writeDraft`, and `proposeArticle` as the agent's door), keeping the page's
  title, tags and checklist and replacing the words; approval is still a
  person's, so nothing is in force.
- **Settle a workorder step — built.** `workorder.settle` reuses `applyStep` and
  the gate latch through `settleStepAsAgent`, so a closed workorder is refused
  and an opened gate is latched exactly as the administration's check does it,
  and the step is signed `gilbert-agent` (ADR 0028: the agent is not a person).
- **Then:** the KB and the checklists the plan's conditions are reasoned from are
  read through the reading tools; check that a conditional's evidence is
  reachable before writing the conditional.

### 2.7 The two outer levels of prose have no reader — **built**

- **The record:** 0035 — three levels, outermost first: the installation's own
  line, the group's standing instruction, the rule's own.
- **Built:** the installation's line is `agent.instruction` in the installation's
  own document, read at the boot and handed to the loop
  (`supervisor.ts` → `loop.ts`); the group's standing instruction is
  `instruction.json` in the group's own account (`agent/instruction.ts`), read
  once per pass and refiled when a group edits it. The decision turn and every
  choosing turn carry all three, in the builder's order; a level that says nothing
  contributes nothing.
- **Proof:** one run's decision turn and choosing turn are read for the
  installation's line, then the group's instruction, then the rule's own, in that
  order, and a document the parser refuses fails the pass with its path rather
  than being read as silence (`agent/loop.test.ts`, `agent/instruction.test.ts`,
  `installation-admin.test.ts`).
- **Built:** a member writes a group's prose from the rules launcher in the top
  bar (`web/src/views/agent/RulesDialog.tsx`, `web/src/lib/agentProse.ts`): the
  group is chosen, the standing instruction is one field, and a rule is its name,
  the surfaces it watches, its prose and whether it may send — with the group's
  own session, each document validated by the server's parser before it is filed,
  and an unreadable document reported with its reason rather than dropped. The
  installation's line is published as the JSON of the document it belongs to.
- **One definition, both tiers:** `@gilbert/agent/*` is aliased in the client
  (`web/tsconfig.json`, `web/vite.config.ts`) as `AGENTS.md` already claimed, and
  the standing instruction's **shape** has moved to `shared/instruction.ts`, so a
  surface reads one definition instead of spelling a second. Pinned by
  `web/src/lib/__tests__/agentShapes.test.ts`, which imports the shape from both
  trees through the alias. A rule's **address** is reachable too: `RULES_DIR`,
  `rulePath` and the refusal a bad name raises are in `shared/rule.ts`
  (`agent/rules.ts` re-exports them), so the client files a rule where the server
  looks for it instead of spelling the path a second time.

### 2.8 A quiet log

- **Decided:** a repeated warning is a useless log. `probeMailStore`
  (`server/src/groupAccess.ts`) writes one per unreadable candidate — read once
  at boot before, six times a minute now that the groups are resolved every pass.
- **Built** (`b3ae60a`): the line is said once per account while the answer stays
  the same, and forgotten the moment the account answers again, so a later
  failure is a new state and is said.

### 2.9 The agent's memory — a graph it recalls (ADR 0037, Accepted)

- **The record:** 0037, `Accepted`, whose `Implementation` line now says what the
  tree carries.
- **The decision:** the agent **always** has memory; it is a graph of facts in the
  **Master's own account** — one memory for the installation, so a group reasons
  with what the whole installation knows — in a **second store**, not the
  knowledge base; recalled on **every** call as a **selection** (the change's own
  subjects and their nearest links, plus the group's standing set), inside a
  ceiling, with what was recalled written into the run's record. A fact is one
  small thing with a provenance; the agent writes them within its authority
  classes; an administrator reads and edits them from Administration, and **a
  person's fact is in force** — the agent proposes against it, never overwrites it.
- **Built:** the store and its parser (`server/src/shared/memory.ts`, one sheet per
  fact in the Master's `memory/` folder, refused when malformed and never
  guessed); the write the agent makes while working (`memory.remember`); the recall into both turns
  with its ceiling of facts and characters, fenced as data, and the facts a run
  carried written into its own record (`recalled`); the `FEATURES.md` paragraph and
  the index line.
- **Built** (`ca67f92`, `47308b6`, `9587649`): the Administration surface alone —
  Administration → Agent lists the installation's memory with what each fact is
  about, what is held true of it and who holds it; an administrator reads a fact,
  **corrects** it in place (the sheet keeps its id, so every link that pointed at
  it still does, and the correction stamps the person who made it, which puts it
  in force against the agent's own `fact_in_force` refusal), or **removes** it —
  both written against the state the reading saw, so a correction decided against a
  stale list is refused rather than landing over a fact the writer never saw.
- **Built** (the proposal): an agent's conclusion against a person's fact is
  written **beside** it as `FactProposal` instead of being refused, the model is
  told what its conclusion is and what the person's sentence still is, and
  Administration accepts it (the correction path, whose write carries no
  proposal) or dismisses it (`DELETE /api/admin/memory/:id/proposal`).
- **Proof:** a fact the agent learned in one run changes what it does in the next,
  and an administrator's correction changes it again — with no restart between
  them; and a fact the agent concluded against one a person wrote is a proposal,
  not an overwrite.

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

- **The translation backlog is paid down but not empty**
  (`scripts/i18n-catalog-check.mjs`): `MISSING_MAX` is pinned at 195 and the worst
  language now has **183** keys with no entry, so the check passes. What remains
  is real and counted; the pin is not moved to silence it, and the next strings
  added are translated in all eleven catalogues with the change that adds them.
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
