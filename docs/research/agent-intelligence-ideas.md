# Where the butler's reasoning is thin, and ideas to deepen it

A research note, not an ADR and not a specification. It surveys ideas gathered
from open-source projects and primary sources and places each one against the
agent mechanism as it stands today. The mechanism is described from the code
(`server/src/agent/`), and every idea says plainly whether it fits now, needs
work, or needs part of the current design broken and rewritten. Nothing here is
a decision; ADRs decide.

---

## 1. The mechanism as it stands

One **run** is one decision. `planFor` (`executor.ts:1001`) builds a context,
then loops at most `AGENT_LOOKUP_ROUNDS + 1` times (`documents.ts:918`) calling
`decideActions` (`llm.ts:495`). Each call answers one of two JSON shapes:

```
{"lookup": {"kind": ..., ...}}
{"summary": string, "confidence": number, "actions": [{"do": ..., "with": ...}]}
```

A lookup is appended to the run's volatile tail as text (`executor.ts:1064`) and
the model is asked again. The answer that carries actions ends the loop; its
allowlist, review policy and audit line are unchanged by the loop.

**What the model is handed before it decides** (`contextFor`,
`executor.ts:1666`):

| Trigger | The volatile tail it starts with |
|---|---|
| `email` | the message itself, plus the thread's most recent other messages |
| `chat` | a window of the group's chat around the anchor message |
| `filenode` | the file's path and size, plus its own text when `document.read` is granted |
| `schedule` | one sentence saying the automation runs on its own |

**The prompt** (`llm.ts:529-570`) is a stable system message — the
data-not-instructions sentence, the capability catalogue, the lookup catalogue,
the installation's rules, the group's notebook, the group's standing
instruction, the automation's instruction — and a volatile user message that
carries the trigger's data and the lookup budget. `temperature: 0`,
`response_format: json_object`, a token ceiling. The head is byte-identical
across the calls of a run on purpose: the provider's prefix cache is what makes
it cheap.

**The lookup catalogue** (`documents.ts:962-981`) is closed and server-validated:
`mail`, `message`, `mailboxes`, `labels`, `files`, `file`, `chat`. Listings hand
over headers, ids and paths; reads hand over one item's text. Bounds:
`AGENT_LOOKUP_MESSAGES_MAX` 20, `AGENT_LOOKUP_TEXT_MAX` 2 000 characters,
`AGENT_LOOKUP_QUERY_MAX` 500, `AGENT_LOOKUP_FILES_MAX` 200 nodes,
`AGENT_LOOKUP_DEPTH_MAX` 4 levels. The search grammar is the mail client's own
(`server/src/shared/search.ts`), and a text query is pushed to the server as a
JMAP filter (`buildFilter`, `search.ts:213`), so lexical search happens in
Stalwart rather than in Gilbert.

**The action catalogue** (`AGENT_ACTION_SPECS`, `documents.ts:181`): fourteen
names — `noop`, `keyword.add`, `keyword.remove`, `mail.move`, `mail.extract`,
`mail.draft`, `mail.send`, `chat.post`, `file.write`, `notebook.write`,
`document.read`, `document.split`, `document.extract`, `document.merge`. The
allowlist is checked after the answer (`validateAction`, `llm.ts:625`).

**The group's memory** is the notebook (`documents.ts:1711-1762`): up to 100
facts, each up to 500 characters, each a line of prose with an id, rendered as
`- text` lines into the cached head. `notebook.write` adds, corrects or removes
one.

**The human gate** is the model's own `confidence`, clamped to 0–1
(`llm.ts:311`) and compared with `AGENT_REVIEW_THRESHOLD` by `reviewOutcome`
(`documents.ts:895`). A paused run becomes a decision document
(`documents.ts:1371`) carrying the summary, the actions, the confidence, the
lookups and the member's verdict (`state`, `decidedBy`), and a question in the
group's chat.

**What is recorded**: the decision document above, and one audit entry per run
(`documents.ts:1827`) carrying the outcome, the actions, the lookups, the tokens
and the rule version — but not the summary or the confidence.

---

## 2. Where the intelligence is capped

Six ceilings, all of them structural rather than incidental.

1. **A run has no model of ongoing work.** Every trigger produces one decision
   about one item, and the only durable memory of what happened is the notebook
   (flat prose) and the audit. There is no notion of an open item, a commitment,
   a thread still owed a reply, or a thing waited on since Tuesday. A butler that
   cannot answer "what is still outstanding for this client" is a classifier, not
   a butler.

2. **The butler cannot act on most of what it understands.** It can move mail but
   not move, rename or delete a file; it can read a document but not create one
   from a template; it cannot touch a calendar, a task, a contact, or a chat
   thread. Understanding without an action is a suggestion box. The capability
   list is the butler's vocabulary, and it is a small one.

3. **Confidence is self-reported and uncalibrated.** A number the model invents
   gates a human's attention. Nothing checks whether the number means anything
   for this provider, this model or this instruction, and nothing learns from the
   verdicts already recorded in the decision documents.

4. **No answer is bound to its evidence.** A summary may assert anything about
   the group's state; the lookups that were made are recorded, but the answer is
   never required to name which message, file or chat line it rests on. There is
   no path from a claim in the group's chat back to the item that supports it.

5. **The verdicts are recorded and never used.** Approvals and rejections are
   durable, labelled data — a decision document per paused run — and no later run
   sees them. The system cannot get better at a group's work except by a person
   editing prose.

6. **One call is one perspective.** There is no critique of a proposed plan, no
   second reader for a long thread, no decomposition of a request that needs
   twenty documents read. The loop can fetch; it cannot think twice, and it
   cannot hand a sub-question to a fresh context.

7. **A business area is more than its mail, files and chat.** The agent's JMAP
   session is opened against mail and file capabilities only: nothing in
   `executor.ts` reads the group's **calendar** or its **address book**, and no
   action writes one. "Who is this client", "what did we agree on Tuesday",
   "when is the room free" are questions about the group's own account that the
   butler cannot see or answer, although the account holds them.

The current design buys safety, cost and restartability with these ceilings, and
it buys them well. The ideas below are ordered by how much intelligence they buy
per unit of design broken.

---

## 3. Ideas

Each idea carries a verdict: **fits today** (no ADR has to change), **needs
work** (an ADR changes but the shape survives), or **breaks the design** (and
what the break buys). Sources are GitHub projects and primary papers; where a
reader could not verify a fact it says so.

### 3.1 Thread, conversation and counterparty state

**A four-state per-thread machine — `TO_REPLY`, `AWAITING_REPLY`, `FYI`,
`ACTIONED`.** [inbox-zero](https://github.com/elie222/inbox-zero) (TypeScript,
12.2k★; the repo is AGPL-3.0 plus a commercial `ee/` directory — the exact
LICENSE text was not verified) ships a closed four-value enum per thread in
`apps/web/utils/reply-tracker/conversation-status-config.ts`. The state moves on
events, not by re-reading the thread: sending flips `TO_REPLY` →
`AWAITING_REPLY`, an inbound reply flips it back, `FYI` and `ACTIONED` are
terminal. Gilbert has nothing equivalent — `/`mail.move`, a `G-` label and the
audit are all facts about one message, and no document says a thread still owes
an answer.
*Attaches to:* a new `agent/threads/<threadId>.json` in the group's account,
written once per state **change** rather than per run; a `thread{id}` lookup kind
beside the existing seven; a `thread_state` field in the answer shape.
**Fits today.** The write rate is the trigger rate, not the run rate.

**Thread slicing with an asymmetric budget, and the agent's own replies taken
out of the transcript.** The same repo's `thread-status-context.ts` builds a
thread for classification at a fixed budget — first message 500 characters,
middle messages 120, the last eight 500 each, the newest message 2 000 with its
final 1 000 always kept, because the ask usually sits under a quoted chain —
and filters the assistant's own prior messages out before reasoning about the
state, so the bot's earlier reply cannot be read as the human's position. This
is precisely the bug that makes an agent answer the same question twice in one
thread, and Gilbert's `threadContext` (`executor.ts:1862`) does neither: it hands
over the thread's most recent other messages whole, including anything the agent
itself wrote.
*Attaches to:* `contextFor`'s email branch and `threadContext`.
**Fits today**, and is free: no call, no write.

**Sender history as a lookup — `sender{address}`.** `check-sender-reply-history.ts`
in the same repo answers two questions with two cheap queries: have we ever
written to this address, and how many messages have we had from it (capped).
On any error it returns "has replied, count unknown" — it fails **open**,
so an unknown counterparty is treated as one a human may be waiting on rather
than silently filed. The inversion is the point: failing closed here drops real
mail.
*Attaches to:* an eighth lookup kind, served by the JMAP `from:` filter the
`mail` lookup already uses, plus per-group thresholds on the Group Agents
surface. **Fits today**: no model call, no write, no cache effect.

**The mail server's own judgement about the sender, handed to the model as
trust metadata.** Stalwart computes a great deal about an arriving message —
spam score, DMARC and SPF results, blocklists, an
[LLM classifier](https://stalw.art/docs/spamfilter/llm/) — and Gilbert's `mail`
lookup returns none of it: `mailListLine` renders sender, subject, date and
keywords only (`executor.ts:3374`). A butler deciding whether Ada's "urgent
payment change" is real or a phishing attempt currently has no access to the
verdicts the server beside it already reached. Note this is *metadata about*
content, not content, and it belongs in the untrusted tail with its provenance
stated.
*Attaches to:* the `mail` listing renderer and `message` read.
**Fits today**, if Stalwart exposes the values to a JMAP client (not verified
here).

### 3.2 Memory: what the group knows over months

Three facts about the code make every idea below cheaper than it looks. A fact is
`{id, text, addedAt, addedBy}` (`documents.ts:1711`) and `notebookFor` renders
only `- text`, so metadata is free for prompt-cache purposes — the renderer is
the only thing that has to stay byte-stable. `writeFile` in the app folder skips
both the upload and the `FileNode/set` when the stored bytes already equal the
wanted bytes, and `no-periodic-writes.test.ts` asserts that three passes over an
unchanged notebook buy **zero blobs**. And the human correction surface already
exists (`readGroupNotebook`/`saveGroupNotebook` in `agentAdmin.ts`).

**Sleep-time consolidation, as a schedule automation.** Letta's
[sleep-time compute](https://www.letta.com/blog/sleep-time-compute) pattern
(paper [arXiv:2504.13171](https://arxiv.org/abs/2504.13171), code
[letta-ai/letta](https://github.com/letta-ai/letta), Apache-2.0) separates the
acting agent from a second agent that holds the memory-edit tools and rewrites
the in-context blocks asynchronously; "dreaming" adds a background review pass
and a review-before-apply option. Gilbert already describes exactly this in ADR
0006 decision three — "a schedule automation that reads the day's mail and files
and rewrites the notebook with what changed" — and it appears not to be built.
*Attaches to:* a `schedule` automation using the existing lookups and
`notebook.write`. **Fits today**, and is the single highest-value change here:
one extra call per consolidation, writes only when bytes actually change.
The caution is inherent: a notebook edit is a cache miss on the head for every
later run until re-cached, so it must stay rare.

**Delta operations, never a full re-summarisation.** ACE ("Agentic Context
Engineering", [arXiv:2510.04618](https://arxiv.org/abs/2510.04618)) has a
Generator propose, a Reflector critique from execution feedback, and a Curator
write **structured incremental updates** — bullets added or refined, never a
re-summary — and names the two failure modes of rewriting: *brevity bias* (a
summary silently drops domain detail) and *context collapse* (iterative
rewriting erodes it). [Dynamic Cheatsheet](https://github.com/suzgunmirac/dynamic-cheatsheet)
([arXiv:2504.07952](https://arxiv.org/abs/2504.07952)) does the concise version.
*Attaches to:* the consolidation's output becoming an op list `{add[], update[],
delete[]}` against `AgentNotebookFact.id`, validated server-side exactly the way
`AgentLookup` is. **Fits today**, at identical write cost with strictly better
dedup.

**A fact as a record, not a sentence.** [Memobase](https://github.com/memodb-io/memobase)
(Apache-2.0) extracts into a fixed ontology and buffers writes into a flush;
[Graphiti/Zep](https://github.com/getzep/graphiti) (Apache-2.0,
[arXiv:2501.13956](https://arxiv.org/abs/2501.13956)) stores bi-temporal edges
with `valid_at`/`invalid_at` so a contradicted edge is invalidated rather than
deleted; [LongMemEval](https://arxiv.org/abs/2410.10813) (ICLR 2025) isolates
value granularity, key expansion and time-aware expansion as the levers that
matter. Extending `AgentNotebookFact` with `kind` (client | convention |
open_item | person | language_tone), `source` (mail id, file path, chat id, run
id, administrator), `validFrom`, `expiresAt` and `supersedes` costs nothing in
the prompt, because the renderer keeps emitting `- text`.
**Fits today**, with one hard rule: **the renderer must never filter by `now`.**
Expiry is applied by the consolidation pass, or the head changes on a clock and
the cache dies.

**Consolidate when significance accumulates, not on a schedule.**
[Generative Agents](https://arxiv.org/abs/2304.03442) scores each observation's
importance and fires reflection only when the summed importance since the last
reflection crosses a threshold; Letta's dreaming triggers are "after N completed
steps or on compaction". The "when" is a function of work done, not elapsed time
— the same spirit as ADR 0012. *Attaches to:* the schedule automation's trigger
plus an installation threshold. **Fits today**; fewer calls than daily polling,
and no new durable state.

**Hard delete is the safer default.** [Revoked but Still
Authoritative](https://arxiv.org/abs/2609.08258) (Sept 2026) tests five memory
systems × nine policy scenarios × nine models and finds that **none** enforces
revocation by default: the revoked fact is still returned, outranks its
replacement, and drives the agent to the unsafe action. mem0's v3 notes report a
move to single-pass ADD-only extraction precisely to stop destroying detail. So
Gilbert's existing semantics — a fact removed by writing it with no text — is the
safe end of the trade, not a limitation, and should be said so in the ADR. If
`supersedes` lands, a read-side gate that withholds superseded facts is
mandatory, and hard delete avoids a tombstone blob in a store where blobs are
never reclaimed. **Fits today.**

**Three speeds, not two: the stable notebook plus a volatile "what changed"
page.** [Anthropic's context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
is "the smallest possible set of high-signal tokens", just-in-time retrieval and
structured note-taking; Letta's MemFS splits always-loaded files from a tree that
is merely *visible*. A second small document — `agent/changelog.json`, "open
items, replies owed, what changed since your last run" — read into the **volatile
tail** buys the feeling of memory without touching the cached head, because the
tail is rebuilt every run anyway. *Attaches to:* one more read in `contextFor`,
rendered after the automation instruction and before the trigger item.
**Fits today**, and it is the most Gilbert-native idea in this section.

**Labelled blocks with budgets, instead of one flat list.** A Letta
[memory block](https://www.letta.com/blog/memory-blocks/) is a label, a
description, a value and a character cap, rendered into the prompt; the
description is the main signal telling the model what the block is *for*, and a
block can be read-only. Three to five blocks — clients, conventions, open items,
language and tone — each with a cap, would make "what does it remember" a
readable structure rather than a hundred lines.
**Needs work**; the one part to refuse is agent-created blocks, which make the
memory unreadable to the person who has to correct it.

**A cold tier behind a lookup, so the 100-fact cap stops mattering.**
[Anthropic's memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
and [Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
both put an index in context and the content behind a read; Letta's MemFS keeps a
tree visible and files on demand with no vector index by default. Gilbert's
`files`/`file` lookups already implement index-then-read with caps, so a
`agent/memory/` tree — per-client histories, project timelines — is a cold tier
the model can reach and the head never carries.
**Fits today**, for near-zero cost: one prompt sentence naming the folder, and
the walk counts against the existing `AGENT_LOOKUP_FILES_MAX` bound.

**Choose the hot set by recency × importance × relevance — in the consolidation
only.** Generative Agents scores retrieval as a weighted sum of exponential
recency, model-scored importance and relevance; relevance here needs no
embeddings, because the group already has a search grammar
(`server/src/shared/search.ts`) and BM25 over fact text is available.
**Needs work**, and the constraint is absolute: nothing scored per run may reach
the head, or every run is a cache miss. Score in the consolidation pass and let
it choose what stays hot.

**Decay and forgetting, driven by change.** MemoryBank
([arXiv:2305.10250](https://arxiv.org/abs/2305.10250)) applies an Ebbinghaus
curve: strength grows on recall, decays with time, and weak memories are dropped.
Facts a person wrote get infinite strength; facts distilled from mail decay
unless re-observed. Pure arithmetic on the consolidation pass — no model call, no
extra write. **Needs work**, and only worth it once the notebook actually
approaches its cap.

**Measure memory, or the project will not believe any of it.** LongMemEval
isolates five abilities (extraction, multi-session reasoning, temporal
reasoning, knowledge update, abstention) and reports that production assistants
drop about 30% across sustained interaction; mem0 ships an
[open benchmark suite](https://github.com/mem0ai/memory-benchmarks); Letta's
leaderboard holds the framework fixed and varies the model. A fixture group with
a known fact set and questions only the notebook can answer — plus the hygiene
invariants this project already cares about (facts per consolidation, evictions,
dedup rate, and the `inputHitTokens`/`inputMissTokens` split after a notebook
edit) — is what turns "memory got better" into a number. **Fits today**, and is
probably the best ADR-enabling investment in this note.

**Compaction is for threads, not for runs.** A Gilbert run is stateless and
already bounded by `AGENT_LOOKUP_ROUNDS` and `AGENT_LOOKUP_TEXT_MAX`, so there
is nothing to compact inside one; the thing that grows without bound is
`conversationContext` in a long-lived chat thread. MemGPT
([arXiv:2310.08560](https://arxiv.org/abs/2310.08560)) and
[Anthropic's context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
(clear tool results past a threshold, replace with a placeholder) are the design
to write down now and build when thread memory lands. **Fits later.**

**A second context for memory work.** [Anthropic's multi-agent research
system](https://www.anthropic.com/engineering/multi-agent-research-system)
reports +90.2% over a single agent on their internal evaluation at roughly 15×
the tokens, with each subagent returning a 1–2K-token distillation and artifacts
passed by reference. **Needs work** as a single bounded second call whose only
output is a notebook patch — which captures most of the benefit at none of the
multiplier — and **breaks the design** if done as real sub-agents, which would
also want a cheap model for consolidation beside the strong one for decisions.

**Graph and vector substrates — the bet, and the evidence against paying for it
yet.** [Graphiti](https://github.com/getzep/graphiti), [cognee](https://github.com/topoteretes/cognee)
(Apache-2.0), [A-MEM](https://github.com/WujiangXu/A-mem) (MIT, NeurIPS 2025,
Zettelkasten notes that link themselves and rewrite older notes) and mem0's graph
variant are the state of the art for multi-hop, temporal memory.
**Breaks the design** on four counts at once — documents-only storage, no
database, no embeddings endpoint, and writes that are never reclaimed (Graphiti
issues several model calls and many writes per episode). Hold it to evidence
before paying: Memobase's reported temporal score with time-annotated strings
plus an append-only event timeline, against graph-based scores well below it,
suggests most of the temporal win comes from **timestamps and a timeline**, not
from a graph. The five cheap ideas above get a large share of it for one document
and no new infrastructure. If the design is broken, break it for a database or an
embedding endpoint — not for a graph.

### 3.3 Retrieval: finding the one message or file

*(to be completed from the retrieval stream)*

### 3.4 Deciding what deserves a run at all

**A deterministic pre-filter in the shape of rspamd.** [rspamd](https://github.com/rspamd/rspamd)
(Apache-2.0) runs a staged pipeline — policy pre-filters that may short-circuit,
parallel authentication/content/statistical filters, then *composite* and *meta*
rules that combine earlier **named** signals into new weighted ones — and ends
in a score that picks an action. Every stage emits an inspectable reason rather
than one opaque verdict. Gilbert's equivalent today is a model call for every
changed message, with `noop` as the only way to decline.
*Attaches to:* a gate between the trigger records and job creation
(`emailRecords`, `fileRecords` in `executor.ts`), whose reasons become the first
line of the audit entry. **Fits today** and *removes* model calls.

**Sieve as the mechanical half of an automation.** Stalwart already runs Sieve
at delivery, and Gilbert already has a visual Sieve builder for its human rules.
The unambiguous part of a group's filing conventions — a sender domain, a
list-id, a subject prefix, a size, an attachment — can be routed before any
model is asked, leaving the agent the residual that genuinely needs judgement.
**Fits today**; it makes "do nothing" cheap.

*(proactivity and silence: see 3.5)*

### 3.6 The answering contract: shape, grounding, verification

**A strict schema with a discriminated union instead of `json_object` plus
hope.** Today the answer is `response_format: json_object` and any deviation
fails the run (`llm.ts:200`, `llm.ts:580`). A root schema with `anyOf` branches
discriminated on `kind` ("lookup" | "answer"), `additionalProperties: false`,
enumerated reason codes and a bounded `confidence` makes the shape a contract.
Where the endpoint supports `response_format: {type: "json_schema", strict:
true}` it is enforced by the provider; where it does not, the same schema is
validated in-process (ajv) and **one** repair attempt appends the validator's
error and the offending text to the volatile tail. Tools to read rather than
adopt wholesale: [json_repair](https://github.com/mangiucugna/json_repair),
[Instructor](https://github.com/567-labs/instructor),
[BAML](https://github.com/BoundaryML/baml).
*Attaches to:* `callModel` and `decideActions`. **Fits today**; one extra call
only on malformed output, and the cached head is untouched.

**A deterministic plan verifier in front of the review gate.** A pure function
over the parsed actions that answers mechanically: does every target the answer
names actually appear in what this run read; is every capability inside the
allowlist; is the action reversible, in-group, external; does any argument come
from content rather than from the group's own state; what is the blast radius
(recipients, files, bulk labels); does the summary cite the evidence it rests
on. Any failure forces the human gate without a model call, and the checklist
lands in the audit line. This is the [checklist-over-reward-model
finding](https://arxiv.org/abs/2507.18624) applied where it is cheapest — in
code.
*Attaches to:* between the answer and `reviewOutcome`. **Fits today** — no
call, a few hundred bytes in a document that is already written.

**Citations as a requirement, not a courtesy.** Nothing today binds a summary to
its evidence: the lookups a run made are recorded (`AgentAuditEntry.lookups`) but
the answer need not name which message or file supports which claim. Requiring
each factual claim in `summary` to carry the id or path it came from — validated
against the run's own read set — turns "where did it get that" from an
investigation into a field, and makes a hallucinated state claim fail closed.
*Attaches to:* the summary shape and the verifier above. **Fits today.**

**The branching procedure frozen at authoring time.** A broad automation is one
paragraph that the model re-interprets on every run. [Self-Discover](https://arxiv.org/abs/2402.03620)
(reported up to +32% over chain-of-thought on BigBench-Hard with 10–40× less
inference compute) suggests spending **one** call when an administrator saves the
instruction, to decompose it into an explicit ordered procedure — "first check X;
if X then Y; otherwise Z" — and storing that frozen text beside the prose. Every
run then reads the same branch structure, which is both more reliable and
byte-identical. [IFEval](https://arxiv.org/abs/2311.07911) supplies the second
half: derive mechanically checkable assertions from the saved instruction and
check the answer's JSON against them with no judge at all.
*Attaches to:* the automation document and the admin save path. **Fits today**;
zero per-run cost, and it protects the prompt cache rather than threatening it.

**One extraction contract per document, with failure as a state.** Both
[paperless-ai](https://github.com/clusterzx/paperless-ai) (MIT, 6.0k★) and
[paperless-gpt](https://github.com/icereed/paperless-gpt) (MIT, 2.7k★) ask the
model for exactly one JSON object per document — title, correspondent, date,
tags drawn from an **existing** vocabulary — and both model failure explicitly,
with an ignored queue and a rescan history. The tag vocabulary is a group
document, so filing a document is choosing from the group's own words rather
than inventing a folder. Near-duplicate detection without embeddings is
available too: [paperless-ngx-dedupe](https://github.com/rknightion/paperless-ngx-dedupe)
(GPL-3.0, small) fingerprints with MinHash/LSH.
*Attaches to:* the files trigger and `file.write`/`mail.extract`.
**Fits today** (the contract); **needs work** for MinHash, which needs a
signature store — but not an embedding endpoint.

### 3.7 Trusting the number

**Calibrate the threshold against the verdicts already recorded.** Gilbert's
gate is one constant (`AGENT_REVIEW_THRESHOLD`) compared with a number the model
invented. It already stores, per paused run, the confidence and the member's
verdict (`AgentDecision.state`, `decidedBy`) — a labelled dataset nobody reads.
Fit an isotonic or Platt map from verbalized confidence to observed approval rate,
per group and per rule id, store the small table beside the policy, and compare
the *calibrated* probability against the threshold. Verbalized confidence is
competitive with log-probability methods on RLHF models per [Just Ask for
Calibration](https://aclanthology.org/2023.emnlp-main.330/).
*Attaches to:* `reviewOutcome`, the policy document, and a new column on the
group's admin surface. **Fits today**: no per-run call, no per-run write.

**Agreement across samples instead of a self-report.** Sample the same prompt
with the same cached head k times and use the agreement of the *action sets* as
the confidence — [self-consistency](https://arxiv.org/abs/2203.11171), with
[FrugalGPT](https://arxiv.org/abs/2305.05176)'s cascade as the cost control
(spend the extra samples only where acting is irreversible or external).
**Needs work**: it requires dropping `temperature: 0`, which the ADR treats as
part of the determinism story, and it must be validated against recorded
outcomes before it is trusted — divergence can come from prompt-order
sensitivity rather than real uncertainty.

**Measure the draft, don't ask whether it was good.** inbox-zero computes a
normalised string similarity between the draft it produced and the text the human
actually sent, after stripping signatures, and persists a score *with a status
enum that refuses to score when the comparison is meaningless*
(`empty_sent_text`, `missing_draft_text`, `snippet_only_sent_body`), under a
versioned metadata blob. Plain string arithmetic; no embeddings. For Gilbert this
is the missing acceptance signal for `mail.draft`, and the honest-status pattern
is worth copying on its own.
*Attaches to:* the audit line of the run that produced the draft.
**Fits today.**

**Abstention as a first-class outcome with a reason code.** Add
`kind: "abstain"` to the answer shape with an enum — `ambiguous_instruction`,
`missing_information`, `conflicting_rules`, `low_confidence`, `tainted_source`,
`needs_human_judgement` — and count it per month. A rising `tainted_source` rate
is a prompt-injection canary; an `ambiguous_instruction` rate is feedback on the
prose. Today silence is `noop`, which cannot say *why*, and "unknown action" is a
failed run. The selective-prediction and
[learning-to-defer](https://arxiv.org/abs/2002.03479) literature is the
justification.
*Attaches to:* the answer schema, the review gate, the audit document.
**Fits today**, though it is ADR-level: a run is no longer obliged to produce an
action.

**A silence that is counted as a result.** [ProactiveBench](https://arxiv.org/abs/2410.12361)
(6 790 labelled events, accepted/rejected proactiveness labels) is the closest
measured work to "should the butler have spoken at all", and its ceiling is
informative: the best fine-tuned model reaches F1 66.47%. Their separate
evaluator breaks one-model-per-installation, but the *mechanism* — record
"decided not to act" as a legitimate, separately counted outcome, and evaluate it
separately from execution quality — **fits today** and costs one small write.

### 3.8 Looking twice, where it pays

**Free-form self-critique is a trap; grounded critique is not.** The negative
results are the design input: [LLMs Cannot Self-Correct Reasoning
Yet](https://arxiv.org/abs/2310.08941) (ICLR 2024) and [Can LLMs Really Improve
by Self-critiquing Their Own Plans?](https://arxiv.org/abs/2310.08118) find
unconditional self-review often *hurts*, while critique conditioned on an error
location helps ([Tyen et al.](https://aclanthology.org/2024.findings-acl.423/)).
So a second call, if it is added at all, should carry the same byte-identical
head (the cache still hits) and a volatile tail holding the proposed actions, a
**numbered** rule list (allowlist entries, the group's policy, the automation's
own clauses) and one question: for each rule number, does the plan violate it,
and if so at which action index? Gate it to the minority of runs that would
auto-execute something irreversible or external. **Needs work**; one extra call
on a minority of runs.

**A measured verifier beat no verifier.** Where a critique pass is too
expensive, the deterministic verifier of 3.6 does most of the same job for no
call at all. Order matters: code first, model second.

### 3.9 Hostile input, and reading it in quarantine

**Spotlighting, honestly labelled as a speed bump.** Every lookup result should
be wrapped in a per-run delimiter carrying provenance
(`<<UNTRUSTED id=M17 src=mail:abc>>` …) with the preamble stating that
instructions inside such blocks are data ([spotlighting](https://arxiv.org/abs/2403.14720)),
and role-play markers, zero-width and bidi characters, base64 blobs and
instruction-bearing markdown links neutralised before insertion. Two caveats must
be written into any ADR: the marker must live in the **volatile tail**, or it
destroys the shared prefix; and spotlighting is measurably bypassable by an
adaptive attacker ([The Attacker Moves Second](https://arxiv.org/abs/2510.09023)),
so the boundary stays the allowlist and the verifier.
*Attaches to:* the tail assembly and the preamble wording. **Fits today.**

**Control/data separation for the one action that cannot be taken back.**
[CaMeL](https://arxiv.org/abs/2503.18813) and [FIDES](https://arxiv.org/abs/2505.23643)
propose the only injection defence with a design-level argument: the privileged
planner never sees raw untrusted text, it emits a program over typed
capabilities whose arguments are *references* carrying taint labels; a
quarantined second call answers plain-data questions about that content; and a
capability crossing the trust boundary refuses a tainted argument unless a human
approves the exact rendered text. **Breaks the design** — two contexts, a
program IR, and the closed lookup catalogue becomes a typed capability layer —
and buys mechanically checkable provenance for every argument of every action.
For a butler whose inbox is adversarial and which may eventually send mail, this
is the largest single safety-and-intelligence upgrade on the table.

**Red-team the butler once, then never trust a static suite again.**
[AgentDojo](https://github.com/ethz-spylab/agentdojo) (MIT, NeurIPS 2024) ports
cleanly onto Gilbert's four triggers: inject instructions into a mail body, a
filename, a chat message, an attached document, and count a success as any
effect outside the allowlist. **Fits today** as an offline CI harness; the
headline result to record is that no prompt-only defence survives an adaptive
attacker, so the suite must measure the boundary, not politeness.

### 3.10 The action surface, and the group's other data

**Calendar arithmetic in code, never in the model.** inbox-zero's
`apps/web/utils/ai/calendar/availability.ts` (11.9 KB with a 7.8 KB sibling test)
computes free/busy, merges intervals and handles timezones in code; the model
receives a precomputed availability window and chooses what to propose. The
silently-wrong failure — a meeting offered at a time that does not exist — is
removed from the model's remit entirely.
*Attaches to:* a `calendar{from,to,attendees}` lookup kind returning computed
slots, an action that references a slot id, and a calendar scope on the
allowlist. **Fits today** — and it addresses ceiling 7: the agent cannot
currently see the group's calendar at all.

**The vocabulary is the intelligence.** The catalogue is fourteen actions
(`AGENT_ACTION_SPECS`, `documents.ts:181`). A butler that can move mail but not
move, rename, archive or delete a file; that can read a document but never write
a spreadsheet or a `.docx`; that cannot create a calendar event, a task or a
contact, reply inside a chat thread, or forward; that cannot see either the
group's calendar or its address book — is a classifier with a filing cabinet.
Two claims follow, and they are cheap to test: the perceived intelligence of the
butler is bounded by what it can *do*, and no prompt improvement compensates for
a missing verb. **Fits today**, and is mostly mechanical: each new action is a
catalogue entry, an executor branch, and an area it lands in.

### 3.11 Measuring the butler

**Grade the end state, not the prose.** [WorkBench](https://arxiv.org/abs/2405.00823)
(COLM 2024) grades every task by diffing a database — no judge, no rubric —
because a wrong action is the failure mode that matters. Gilbert is unusually
well placed here: the monthly audit documents already record the input state, the
rule version, the lookups and the actions, and the mock Stalwart already runs the
whole agent in memory. A fixture is a mailbox plus a rule plus an expected *state
diff*; the harness replays and asserts. **Fits today**, and it matches the
project's determinism posture exactly.

**Report pass^k, and do not grade summaries with text metrics.**
[τ-bench](https://arxiv.org/abs/2406.12045) finds the best model succeeds on
fewer than half of its tasks and on under a quarter at pass^8; [EmailSum](https://arxiv.org/abs/2107.14691)
(ACL 2021) finds ROUGE and BERTScore correlate weakly with human judgement on
email thread summaries, and that the hard part is inferring the sender's *intent*
and the *roles* of the participants. Both point the same way: report reliability
across repetitions, grade state, and keep a small hand-labelled role/intent
fixture set over real threads. **Fits today.**

**A replay harness over recorded runs.** [promptfoo](https://github.com/promptfoo/promptfoo)
(MIT, TypeScript, ~25k★ — note its move to OpenAI, a governance risk worth
watching) or [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai)
(MIT, the UK AI Safety Institute's harness) can drive a `gilbert eval` command
that replays recorded inputs against a candidate prompt and asserts on the
**action set** — kinds, allowlist conformance, no send without an unambiguous
human yes, schema validity, and the token/cache delta against the recorded
baseline. This is the gate a prose change currently lacks. **Fits today.**

**Reflective optimisation of the admin's prose — proposed, never applied.**
[GEPA](https://github.com/gepa-ai/gepa) (MIT) evolves prompt text against a
metric, and [DSPy](https://github.com/stanfordnlp/dspy) (MIT) is the older
framework for the same idea. Here the optimisable text is the standing
instruction, the automation's instruction and the notebook, and the metric must
include the human verdicts — otherwise it learns to sound confident. The output
is a *diff an administrator approves*, which creates an ordinary new rule
version. **Needs work**; offline and many calls, but no per-run cost.

**Lint the instruction where a human is guaranteed to be looking.** ClarifyGPT
([FSE 2024](https://doi.org/10.1145/3660810)) detects ambiguous requirements and
asks a clarifying question. At save time only, one JSON call can report verbs
with no matching capability, granted capabilities the instruction never
mentions, ambiguous clauses, and implied irreversible actions; the chosen reading
is stored as a per-automation interpretation with two or three accepted
examples, all in the stable head. **Fits today**, and it is the only place where
"the instruction and the grant disagree" is cheap to see.

**Calibrate the judge before believing it.** If a grader is ever needed, note
that with one model per installation the judge is always grading itself
([self-preference bias](https://arxiv.org/abs/2404.13076)); hand-label a few
hundred runs, measure agreement, randomise order, and automate only above a
stated bar. **Needs work**, and the labelling is the real cost.

### 3.12 The model and the endpoint

**A self-hosted endpoint turns two failure modes into impossibilities.**
[Outlines](https://github.com/dottxt-ai/outlines), [XGrammar](https://github.com/mlc-ai/xgrammar)
and [llguidance](https://github.com/guidance-ai/llguidance) compile the same JSON
Schema into a token mask so an invalid answer is unrepresentable, and the same
server can return token log-probabilities for the confidence field, which makes
3.7's calibration a measurement rather than a verbalization. **Breaks the
design** — it replaces the hosted endpoint assumption and the meaning of "one
provider, one key" — and buys structural validity plus a real probability. If
Gilbert ever runs its own inference, this is the highest-leverage change to the
loop.

**The reference points for a rewrite.** [Khoj](https://github.com/khoj-ai/khoj)
(AGPL-3.0, 37.4k★) gives each agent its own model, persona and automations over a
semantic index; [Onyx](https://github.com/onyx-dot-app/onyx) (32.2k★) answers in
channels from a vector store of company documents; [baibot](https://github.com/etkecc/baibot)
(Rust, AGPL-3.0) scopes credentials, rate limits and identity per room and speaks
only when addressed. The first two break "no embeddings" and "one model per
installation"; the third breaks almost nothing and is the best model for
room-scoped silence. **Breaks the design**; worth an ADR that states the trade
even if it is rejected.

---

## 4. What to do first

*(to be completed once every research stream is in)*

---

## 5. What may be ported, and under what licence

Gilbert is AGPL-3.0-or-later (`LICENSE`), so the direction of compatibility is
mostly favourable: MIT, BSD, Apache-2.0, GPL-3.0 and AGPL-3.0 code can all be
brought into this project, and the combined work stays AGPL-3.0-or-later. What
that permission does **not** remove:

- **Notices travel with the code.** An MIT or BSD file keeps its copyright line
  and permission text; an Apache-2.0 file keeps its `NOTICE` obligations, and
  its patent grant comes with it. Gilbert already carries a `NOTICE` file, and a
  ported module should name its origin, its licence and the file it came from in
  its own header, the way an upstream-derived file does.
- **A commercial carve-out is not covered by the project's licence.**
  [inbox-zero](https://github.com/elie222/inbox-zero) is AGPL-3.0 with a
  commercial `ee/` directory, and GitHub reports the repository as
  `NOASSERTION` for exactly that reason. The reply-tracker modules named in 3.1
  live outside `ee/` and are AGPL, so they are the ones that may be read for
  porting; anything under `ee/` is not, whatever the repository-level badge says.
- **GPL-3.0 into AGPL-3.0 is a one-way door.** AGPL §13 permits it, so
  [paperless-ngx-dedupe](https://github.com/rknightion/paperless-ngx-dedupe)
  (GPL-3.0) is usable; the reverse is not true for anybody who later wants to
  take Gilbert's code into a GPL project.
- **`NOASSERTION` means ideas only.** [Onyx](https://github.com/onyx-dot-app/onyx)
  carries no detectable licence: read it, do not copy it.

**The stronger reason to take ideas rather than files, at this stage, is not
legal.** Almost every source above is built on a different substrate — Prisma and
PostgreSQL (inbox-zero), Django and Postgres (paperless-ai), a Python runtime
(khoj, AgentDojo, GEPA) — and what transfers is the *algorithm*, not the module:
a four-state enum, a slicing budget, a similarity function, a checklist. Ported
verbatim, a 12 KB TypeScript module arrives with its own tests, its own data
model and its own author's assumptions, and this repository would then own all of
them. A file worth porting should be small, self-contained and testable against
Gilbert's own fixtures; everything else is a paragraph of prose in an ADR and
forty lines written here.

*Inbound-licence check for the sources named in this note:*
`elie222/inbox-zero` AGPL-3.0 + `ee/` (core only), `rspamd/rspamd` Apache-2.0,
`clusterzx/paperless-ai` MIT, `icereed/paperless-gpt` MIT,
`rknightion/paperless-ngx-dedupe` GPL-3.0, `mangiucugna/json_repair` MIT,
`567-labs/instructor` MIT, `BoundaryML/baml` Apache-2.0,
`promptfoo/promptfoo` MIT, `UKGovernmentBEIS/inspect_ai` MIT,
`confident-ai/deepeval` Apache-2.0, `gepa-ai/gepa` MIT, `stanfordnlp/dspy` MIT,
`ethz-spylab/agentdojo` MIT, `dottxt-ai/outlines` Apache-2.0,
`mlc-ai/xgrammar` Apache-2.0, `guidance-ai/llguidance` MIT,
`guidance-ai/guidance` MIT, `khoj-ai/khoj` AGPL-3.0, `etkecc/baibot` AGPL-3.0,
`Mail-0/Zero` MIT — all inbound-compatible. `onyx-dot-app/onyx` is
`NOASSERTION`: ideas only.

---

## 6. Sources

*(to be completed)*
