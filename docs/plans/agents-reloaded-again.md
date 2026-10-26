# Plan — the agent, reloaded again

Status: **proposed, not started**. Nothing here is built. The decisions behind it
live in ADR 0027 (tools), 0030 (the run is a document), 0034 (a burst is one
drop), 0038 (areas, jobs, budgets) and 0029 (the conversation); each step below
revises those records **in place**, and no record is minted without the owner's
authorisation.

This plan supersedes nothing: it is the current shape of the work, written after
the three failed runs of 2026-10-26 were read step by step.

## 1. What the record says

Three runs, one group (`freight`), one day, **zero acts** (no `place`, no `draft`,
no `say` in any plan). Two ran on the build before the window and identity fixes
(`43fdaf4`), one on the build after them (`168f43d`, installed at 12:49):

| run | build | started | ended | calls | plan steps | spent ms | prompt tok | completion tok | cached | ending |
|---|---|---|---|---|---|---|---|---|---|---|
| `d4144cf0` | before | 07:59:03 | 08:00:34 | 14 | 19 | 88 491 | 86 644 | 18 474 | 61 696 | **stall**: the same calls twice |
| `b6053e8f` | before | 10:41:57 | 10:44:24 | 23 | 39 | 143 814 | 167 418 | 24 540 | 101 632 | token ceiling (200 000) |
| `b2a8ceb8` | after | 13:35:04 | 13:40:11 | 11 | 21 | 301 581 | 82 374 | 22 487 | 50 816 | time ceiling (300 000 ms) |

- **Model**: `deepseek-flash` (provider `deepseek`, `api.deepseek.com`), declared
  output ceiling **393 216** tokens. Per call today: **6.2 s, 6.3 s, 27.4 s**;
  output 1 320 / 1 067 / **2 044** tokens.
- **The cache works**: 71 %, 61 %, 62 % of the prompt was served from it.
- **The mail server is not the cost**: the two calls measured answered in
  **49 ms** (a knowledge page's text) and **51 ms** (a 146 KB PDF). Tool time is
  noise against 27 s of model per call.
- **The catalogue is the majority of every prompt**: 8 jobs whose JSON
  definitions are **12 315 characters** plus **1 807** of signature lines — about
  4 000 of the 6 200-7 500 prompt tokens of a turn (`place` alone is 3 161).
- **A drop of seven emails is worked as seven independent runs**:
  `startedBy.about` reads `280228874 7X20 26.27 CNT MRSU0039101 (1 of 7)` and
  `… MRKU7862150 (2 of 7)`, `woke` names one message id, `rule`/`instruction`/
  `wakeFrom` are null. Same shipper, same booking, same folder, same convention,
  re-derived from scratch each time, at 105-192 k tokens each.
- **The day spent 401 937 of the 4 000 000 daily tokens for nothing.** At this
  rate the installation can afford about twenty runs, i.e. **three drops a day**.
- **The harness discards what it already fetched**: the decision turn carries the
  message itself (`question.detail.text`, up to 16 KB) and the choosing turn does
  not (`StepQuestion` has no `detail`). Every run therefore opens with
  `read {"kind":"message"}` as step 0.
- **The runs that fail are not confused, they are underequipped**: the 13:35 run
  read the message three times (not twelve), read the PDF attachment, found the
  booking folder and the convention page, and was stopped by the clock with
  117 000 tokens and 26 calls unspent. The pre-fix 10:41 run read one message
  **twelve** times and never acted.
- **The 07:59 run is the stall, and it is the same message and the same sentence
  that opened this work**: `the model chose the same calls twice (read {"kind":
  "message","id":"c0iaaaaxk"}) and made no progress`. Its plan opens with the root
  folder, the knowledge search and the convention page, reads the message four
  times, pages the same convention at four offsets, invents a run id (`b355cfbf`)
  to consult its own record, ends with a `read` of the message that **fails** (the
  message moved while the run worked), and its last two answers are the same single
  call. Zero acts. The guard did its job; the window fix is what removes the reason.
- **The 13:35 run is the one after the fix, and it is a different animal**: three
  reads of the message instead of twelve, the PDF attachment read, the booking
  folder and the convention found — and the clock stopped it with 117 000 tokens
  and 26 calls unspent.
- **No per-step cost exists in the document**: `spent` is a single total, and an
  ending names a ceiling without the value it had. Where a failed run's seconds
  and tokens went cannot be read from it.
- **A budget can change silently**: `readInstallationForPass` falls back to
  `installationDefaults()` when the installation document cannot be read in a pass,
  and the defaults are 120 000 tokens and a twenty-step plan. A transient read
  failure therefore halves an installation's budget for a pass without leaving a
  line anywhere.

## 2. Diagnosis

The agent is built as a **remote-procedure planner**: the model orchestrates raw
endpoints one object per call, the harness re-sends the plan every turn, and
three counters decide when the work is over. Everything measured above follows
from that:

1. **The unit of work is the message, not the case.** Seven messages of one
   shipment are seven sessions that each rediscover the same booking, folder and
   convention. ADR 0034 already made a burst of files one drop and one run; the
   same rule is not applied to mail.
2. **The harness does not carry the case.** It fetches the message for the
   decision turn and drops it; it clips every answer to 240 characters after three
   steps; there is nowhere to write down what was learned. The model's only
   defence is to fetch again, which is why it fetches in loops.
3. **The model is the fetcher.** One object per call, a page of a knowledge page
   per call, no thread tool, no batch read — the shapes an agent harness exists to
   compose.
4. **The tool surface is an RPC catalogue, not an agent interface.** Eight names
   over ~forty endpoints and sixteen kilobytes of schema, every turn, to express
   intentions the harness could express in four verbs.
5. **The counters are the only stop.** The time ceiling measures the provider, not
   the agent; the cost ceilings arrive before the act; and no counter is a product
   decision a person made.

## 3. Principles taken from the field

| principle | source | what it means here |
|---|---|---|
| workflow where the path is known, agent where it is not | Anthropic, *Building effective agents* | filing a delivery note follows a path; deciding what a letter is about does not |
| context is a finite budget: select, write, compress, isolate | Anthropic, *Effective context engineering*; LangChain, *Context engineering* | hand the case in; let the agent write notes; summarise; isolate reading |
| the harness moves the data, not the model | Anthropic, *Code execution with MCP* (150 k → 2 k tokens) | prefetch, filter and compose inside the loop, hand the turn a small result |
| few, high-level tools that express intentions | Anthropic, *Writing effective tools* | four verbs, not forty endpoints |
| a session is a shift with handoff artifacts | Anthropic, *Effective harnesses for long-running agents* | the case note is the handoff between runs of a drop |
| one context, one decision thread | Cognition, *Don't build multi-agents* | no parallel decision-makers over one shipment |
| keep the prefix stable; the file system is the memory; recite the plan | Manus, *Context engineering* | stable system turn, notes in Files, progress in the chat |
| own your context and your control flow; small focused agents | *12-factor agents* | the loop prepares and decides the stops; the model works |
| evals from real failures, read the transcripts | Anthropic, *Demystifying evals* | the three failures become the first three tasks |

## 4. Recommendations

Each one states what changes, where, why, and the proof that closes it. The
order in §6 is the order of work.

### R1 — A mail drop is one case, through the queue that already exists

ADR 0034 already folds a burst of **files** into one change and one run: a queue
document (`gilbert/pending.json`), a quiet window, a key of folder and instant, and
`startedBy.batch` on the run. **Mail uses the same queue, not a second one**: a
message is noted against its sender — the mailbox's own "folder" — and answered
once, when that sender has been quiet for `DROP_QUIET_MS` or the burst has been
open for `DROP_CAP_MS`. One change names the messages and the instant it opened,
one decision, one run.

For mail the `batch` the turn is shown carries, per message: subject, sender and
attachment names (R2). Each message is worked as a **step**, so the record keeps one
outcome per message — the audit is not coarser than seven runs, it is one document
instead of seven. A reply that answers a message of the drop joins the case through
its `threadId`; an answer arriving days later opens its own run, which finds the
case's note (R3) and the facts in the memory.

What does not change: one message that arrives alone is one run, as today. A wrong
fold — two unrelated deliveries from one sender inside the window — costs a longer
run, not a wrong filing: where each message is filed is decided per message, from
its own attachments.
*Where*: `agent/queue.ts` (the key and the window it already has), `agent/changes.ts`
(the fold), `agent/loop.ts` (the run's opening), ADR 0034 and 0038 rewritten on the
point; `startedBy.batch` already exists.
*Why*: one shipment of seven messages costs 7 × 105-192 k tokens and seven
rediscoveries of the same booking, folder and convention, and the group reads seven
reports for one delivery.
*Proof*: the seven-message drop of `280228874` opens **one** run that files all
seven, each with its own step and outcome, at no more than one message costs today —
and the group reads one report. The owner confirms the group wants that (see §7).

### R2 — The turn starts with the case

Before the first choosing call, the loop assembles what the case needs and the
model would otherwise fetch by hand. What the turn gets is what a person would
have open on the desk — names and text, never a verdict:

- the message the change names — its text and its attachments' names and sizes
  (**the decision turn already has this**: `question.detail`; carry it, do not
  re-read it);
- the thread it belongs to, when it answers one: subjects, senders and dates, one
  line each, no bodies — the booking reference and the shipper of a delivery live
  across the thread, not in one message;
- **the titles of the knowledge pages, not their text**: the standing instruction
  is prose and names no page (`InstructionDoc` is `instruction`, `areas`,
  `surfaces`), so the turn is told what the base holds and opens the one it needs —
  one lookup, and the note (R3) keeps the rule it read;
- the skeleton of the customer's folder, two levels, names only;
- the facts the memory recalled (already carried).

Every part is bounded and says when it was cut, like every other block of the
prompt. For a drop (R1) the turn gets the list of items — subject, sender,
attachment names — and the case note (R3), not seven bodies.
*Where*: `agent/loop.ts` (the question), `agent/prompt.ts` (`stepData`), ADR 0038
"the turn's context".
*Why*: the first ten of the 13:35 run's twenty-one steps were exactly this, at
27 s and ~7.5 k tokens each, and the run then had to page one convention page at
six offsets because it had nowhere to keep what the page said.
*Proof*: on the drop's first item the prompt holds the message, the thread's lines,
the page titles and the folder skeleton, and the run's **first act is the right
one** on the eval task — not merely an act by step 3.

### R3 — The case keeps a scratchpad, and the turn carries it

The run keeps a **note**: a Markdown file under the agent's own bookkeeping
(`gilbert/cases/`, beside the queue of ADR 0034), written and rewritten by the
agent, carried **whole** in every turn of the case. It is the working memory of
the work: the booking reference, the folder the delivery belongs to, the naming
rule, what the group still owes. It is Claude Code's checklist-and-scratchpad and
Manus's `todo.md`.

Two stores, and the difference is the life they have:

- **the note** is the case's working memory — it lives and dies with the case,
  and every item of a drop reads it (R1 is what makes the items one case);
- **the memory** is the installation's long-term store (ADR 0033): anything that
  must outlive the case — "the folder of booking 280228874 is …" — is a fact
  written with `remember` and recalled by the loop on the next case. It is
  already built, and two of the three runs tried to read it.

No boundary is policed on the note: a note that grows is rewritten by the model
that owns it, the way a team curates a `CLAUDE.md`, and the harness only tells the
turn what it is carrying.
*Where*: `agent/run.ts`/`shared/run.ts` (where the note is stored and read),
`agent/prompt.ts` (rendered before the plan), `agent/tools/jobs.ts` (the `note`
verb in R4 — updating it is part of a call the agent is already making, never a
turn of its own).
*Why*: the 13:35 run paged the same convention at six offsets because the rule it
needed had nowhere to live; the 10:41 run read one message twelve times; and the
memory the installation already has was read as five different subjects because
nothing wrote the booking's folder down once.
*Proof*: on a drop, the second item reaches its act with the note holding the
reference, the folder and the rule, and no knowledge page is opened twice in the
same drop.

### R4 — Four verbs instead of eight jobs

`open` (a message and its attachments, a thread, a folder, a page), `act` (file
it, draft it, send it, settle the step), `note` (R3), `say` (say it). The
endpoints stay where they are; the verbs are a façade whose arguments are
intentions, not endpoints.
*Where*: `agent/tools.ts` and `agent/tools/jobs.ts` (the façade over the existing
endpoint modules), `agent/model.ts` (the catalogue the turn is given), ADR 0027
rewritten on the point.
*Why*: 12 315 characters of definitions and 1 807 of signatures per turn, ~4 000
of 6 200-7 500 prompt tokens, to choose among forty endpoints; and the model
still picks the wrong one (`read {"kind":"run"}` with an invented id, twice).
*Proof*: the schema the turn is given is under 4 000 characters; the eval's
refusals for an unknown name or a wrong argument stay at zero.

### R5 — No ceiling on a run; safety stays per call, cost stays per day

A run ends **done**, **waiting on a person**, **stopped by a person**, or
**failed**. `RUN_MS_MAX`, `RUN_CALLS_MAX`, `RUN_STEPS_MAX` and `limits.maxRunSteps`
stop being endings: the per-call timeout (60 s) remains, and the daily token
ceiling remains as the installation's commercial alarm.
*Where*: `agent/loop.ts` (`overBudget`, the endings), `shared/installation.ts`
(the limits the admin sees), ADR 0038's ceiling section.
*Why*: the clock killed a converging run at eleven calls with 117 k tokens
unspent, because the provider took 27 s per call; a provider's latency is not a
decision the agent made. The cost ceilings arrived before the act in every run.
*Proof*: a run over the seven-message drop completes with no ceiling reached, and
its duration is recorded, not enforced.

### R6 — The pass is hygiene, not a wall

A run longer than a pass is resumed by the next pass, from its document — the
mechanism already exists. The pass takes a slice of work per account and returns;
nothing in the product depends on a run finishing inside one interval.
*Where*: `agent/loop.ts` (`workPass`), `agent/supervisor.ts` (the interval's
description), ADR 0030/0038.
*Why*: today a 346-second pass makes every other group wait — the log says
"what came after it waited".
*Proof*: a long run leaves the next pass working other groups within the interval.

### R7 — The chat is the terminal

A run that works longer than a few steps says one line of progress in the group's
conversation (what it is doing, not the report), so a person can see and
intervene; the report still ends the run.
*Where*: `agent/loop.ts` (the progress line), ADR 0029/0030.
*Why*: today the group sees one message at the end, and only when the run ends;
a person cannot intervene before the budget is spent. Mainstream harnesses show
the trace live.
*Proof*: a run of more than N steps leaves at least one progress line, and the
report still ends it.

### R8 — A run explains itself

Per step: milliseconds and tokens (the two numbers the turn cost), and the tool
time of its wave; on the run: the limits **in force when it opened** (token,
step, call, time, daily), so a budget that fell back to a default is visible in
the run that paid for it; in the ending: which ceiling fired and the value it had.
*Where*: `shared/run.ts` (`RunStep` and a `limits` fact on the run),
`agent/loop.ts` (spending per step, the fallback), `agent/model.ts` (the meter),
`agent/supervisor.ts` (a gap line when the installation could not be read), the
admin run view.
*Why*: `spent` is a total today, so a failed run cannot say where its 27 s and its
7 500 tokens a turn went; and a failed installation read silently lowers the budget
to the defaults (120 000 tokens, twenty steps) for that pass.
*Proof*: the run view answers "where did the 27 s and the 7 500 tokens go" for
every step, and "which budget was in force" for the run.

### R9 — The failures are the eval

The three runs of 2026-10-26 become the first three tasks of the eval, with
anonymised fixtures: the seven-message drop of `280228874`, the Tarros thread
`c...l` (BL 010 532SPEIST004), and the run with nineteen steps. `pass@1` on that
set is the gate every later change is measured against, and the number reported
in the plan's status line.
*Where*: `agent/eval/tasks/`, `agent/eval.ts`.
*Why*: the eval has eleven mock tasks today and none came from a real failure; two
of the three changes shipped yesterday were hygiene and the third was measured on
a synthetic plan.
*Proof*: the three tasks fail on today's tree and pass on the final one.

### R10 — The judge gets the same budget as any reader

`judgeRun` renders every step of the plan at four kilobytes each — up to 160 KB on
a forty-step run, in a single call. It renders the plan's tail and the report's
claims, not every outcome whole.
*Where*: `agent/model.ts` (`judgeRun`).
*Why*: a suspect plan of forty steps is a call larger than any the loop makes, for
a verdict that reads the states and the sentence.
*Proof*: the judge's prompt on a forty-step plan stays under the prompt bound.

## 5. Not taken, and why

- **A lookup budget** (six looks, then act): it would have killed the 13:35 run
  before it found the booking folder. The problem is not the number of looks; it
  is that each look costs a turn and returns four kilobytes where two hundred
  characters were needed.
- **A per-turn output ceiling**: it treats the symptom of a slow provider and
  truncates a drafted letter. The clock (R5) is the one to remove; output is a
  provider fact recorded by R8.
- **Step or call ceilings as endings**: the same cage in smaller numbers.
- **A `progress` ending**: with no ceilings (R5) a run has no need to report in
  order to continue.
- **More tools** (a thread tool, a batch read, a mail-specific tool per case):
  each is a variant of R2. The case is assembled by the loop, once.
- **A bigger carried-whole window**: three answers is a heuristic; the case note
  (R3) is the mechanism that replaces it. The window stays as recency.
- **A different model first**: the 13:35 run followed the right path at 6 s a
  call; the harness, not the model, spent the money.
- **Parallel decision-makers over one shipment**: Cognition's two principles —
  share the context, and remember that actions carry decisions — are why this
  stays one thread.

## 6. Order of work

| step | what | proof that closes it |
|---|---|---|
| 0 | rotate the agent's credential and remove its copies from `/tmp` (owner's call) | a leak repeats no more; nothing left on disk outside `/etc/gilbert` |
| 1 | R5 — no run ceilings; per-call timeout; daily alarm | the 13:35 run, replayed, reaches its act instead of the clock |
| 2 | R8 — per-step cost in the document | one failed run explains its own 27 s and 7 500 tokens |
| 3 | R2 — the case in the turn | the first act by step 3 on a one-message case |
| 4 | R1 + R3 — one run per drop, with the case note | the seven-message drop files seven, under 250 k tokens |
| 5 | R4 — four verbs | the turn's schema under 4 000 characters, zero refusals in the eval |
| 6 | R9 — the three failures as eval tasks | they fail before, pass after; `pass@1` recorded |
| 7 | R6, R7, R10 | a long run blocks no group; a run narrates; the judge stays bounded |

Steps 1 and 2 are small and make the rest measurable. Steps 3 and 4 carry the
gain; 5 makes it cheap per turn; 6 is the instrument; 7 is polish that can wait.

## 7. What is still unknown

- **The group's standing instruction**: whether it asks for a filing under the
  conventions (R2 is enough) or for the whole shipment handled (R1 and R3 carry
  more weight). The document is `gilbert/instruction.json` in `freight`.
- **Whether the window fix ends the stall for every body**: the 07:59 run ended on
  two identical reads of one message, on the build before the fix. The next
  production runs answer whether a case holding more than three objects still
  forces a re-fetch — which is what R2 and R3 are for.
- **Whether the seven messages are truly one case**: the subjects say "(1 of 7)"
  and "(2 of 7)" of one booking; a person should confirm that filing them
  together is what the group wants, because R1 changes what the group sees (one
  run, seven outcomes, instead of seven runs).
- **What the model writes as output**: 2 044 tokens a call on a slow call suggests
  reasoning that the harness never sees. The provider bills it; R8 should record
  it.
- **The installation is switched off**: `agent/switch.json` = `{"enabled":false}`,
  written at **13:43:26Z** — three minutes after the third run ended. No further
  evidence comes from production until the owner turns it back on.

## 8. What this plan does not change

The run document stays the record (ADR 0030) — it is the one thing mainstream
harnesses do not have and this product does: a readable, attributable,
resumable account of what an agent did, with its authorities and its evidence.
The authority guard (ADR 0028), the group's ownership of its data, the memory
graph (ADR 0033) and the mail-only JMAP law are untouched.
