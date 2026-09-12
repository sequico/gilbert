# ADR 0010 — An automation is an instruction a model carries out

Status: Proposed (2026-09-11; rewritten 2026-09-12)

## Context

An automation is a document the fleet executes (ADR 0003): a trigger, the
material a run works from, a capability allowlist and a review policy. The
document is exact by design — the executor, the matcher, the review gate, the
consent floor and the audit trail are all built on it — and the question this
record answers is what the material should be.

Authoring an automation means deciding *how* as well as *what*. The person with
the intent — "when a client mails the group, file the attachment under their name
and tell the group" — holds an intent, not a classification of how much model the
decision costs or how confident the outcome will be. Two facts follow. The
classification is a decision a model can make from the intent, and one the person
should not have to make. And the intent is prose: it is more legible than any
assembly of fields, both to the person who wrote it and to whoever reads the
group's automations a month later.

**The model stopped being the expensive part.** Read from DeepSeek's published
pricing on 2026-09-12 (`deepseek-flash`, per 1M tokens): input that hits the
context cache costs **$0.003** off-peak ($0.006 at peak), input that misses costs
**$0.15** ($0.30), and output costs **$0.60** ($1.20). A cache hit is therefore
**50× cheaper than a miss and 200× cheaper than the answer**. Context caching is
on by default and works in **prefix units**: a request hits only where it fully
matches a prefix the service already persisted, and *the output is never cached*.
What a run pays for is the volatile tail — the message it reads — and the answer
it writes; the stable head (the product's system prompt, the capability
catalogue, the group's own instruction) is nearly free to resend, provided the
prompt is built so that head is byte-identical from run to run. Off-peak is also
two thirds of the week: peak is 01:00–04:00 and 06:00–10:00 UTC, Monday to
Friday, and every other hour is half price. An image is billed the same way and
is bounded: the Vision guide (read 2026-09-12) puts a ceiling of **1024 tokens
per image** after resizing — a 2000×2000 and a 5000×5000 image cost the same — so
a page of a scan is a rounding error beside any answer about it, and no separate
vision price exists.

**A model has no memory and its cache is not state.** Every call resends what we
choose to send; the provider's disk cache is a billing optimisation that expires
within hours or days and cannot be read back. Whatever the fleet remembers has to
be a document, in the account it belongs to.

## Decision

**An automation is one shape: a trigger, an instruction, a capability allowlist
and a review policy.** The instruction is the prose its administrator wrote.
There is no separate compiled form and no fixed action plan: every run asks a
model what to do, and the model answers with actions from the catalogue.

**The allowlist and the consent floor are the enforcement.** The catalogue is in
the prompt so the model knows what it may do; every action it answers with is
checked against the rule's own capabilities before anything runs; an action that
leaves the process or cannot be undone still pauses for a person; the audit still
records the rule, its version and what happened. The model proposes and the
allowlist disposes — what the decision changes is who chooses the actions, never
what an automation is allowed to do.

**The call is one shape too.** `temperature: 0` and `response_format:
json_object` stay, because they are what make an answer parseable and a run
repeatable, and the request gains a **maximum output tokens**, because the
provider's own ceiling is enormous and an uncapped answer is an uncapped bill.

**Thinking is a parameter of an agent, set beside its timings.** The provider
reasons by default; whether a run pays for that is the deployment's decision,
configured per agent the way the poll interval and the lease are
(`GILBERT_AGENT_THINKING`), so one agent can be the careful one and another the
cheap one. A group is held by one agent at a time, so the setting is stable for a
group while its holder lives — and a takeover can change it, which is why every
run records the setting it used beside the tokens it spent: a behaviour that
changed with the machine that ran it has to be readable in the trail rather than
inferred from a deployment's log. **The reading of a draft is not a run and
follows no agent**: it runs with thinking off, because "is this prose coherent"
is a question about text and its answer is a sentence, not a chain of thought.

**One model serves the installation.** The configuration is a single entry —
provider, model, base URL and API key — rather than one per classification, so
nothing in the product asks an administrator to decide which model a *kind* of
work deserves. The key stays write-only (stored, never read back, like an app
password) and is read by the executor through the Master's own session. An
installation that has more than one configured keeps one of them, and which one
is a person's choice rather than a silent pick.

**Nothing is compiled.** The rule document *is* the instruction plus its
envelope, so the instruction is never translated: it is copied. What takes
judgement is the envelope — which trigger, which capabilities (the grant), which
review policy — and a model may **suggest** those three fields from the prose;
the suggestion proposes, a person accepts or rejects it, and nothing else of the
document is touched. The form remains as the exact path, for the administrator who knows what
they want field by field and for an installation that runs no model.

**The review policy belongs to the rule, and the suggestion proposes it.** With
a model in every run, confidence is universal, and a policy left at a default
would make routine work ask a person in the group's chat for nothing.

**A field that takes prose says how to write it, and can read it back.** Beside
the group's instruction and beside each automation's instruction the surface
carries **notes** — what the prose is for, what the automation reacts to, what it
may do, that it steers inside the grant and never widens it, and that it is read
as data rather than obeyed — because a bare text box produces prose that guesses,
and guessing is the one thing the executor will not repair. Beside the same field
the author can ask for a **reading**: the helper sends the draft, with the
envelope it belongs to, the group's instruction and the group's notebook, and
asks one question — is this coherent, and where are the gaps — answering in words
in the same place. That is neither of the two things this record does not have
and does not want: it compiles nothing, produces no document, stores nothing, and
the suggestion of an envelope stays what it is. It is a reader for the person
writing, so its answer is model prose shown as prose, unlike a refusal, which is
a code in the reader's language; its own failures — no provider, a spent budget,
an unreachable endpoint — travel as those codes like any other refusal.

**Authoring spends tokens too, and says so.** The reading is a call to the
installation's provider made from the web tier rather than as a job: nothing
runs, no claim is taken, and there is nothing to pick up on a pass — so it
carries a timeout and no lease. Its tokens are counted in the **Master's
own account**, marked as authoring, and not in the group's: a run's record
belongs to the group it works in and is written by the agent holding it, while an
administrator reading a draft is the installation's own work, belongs to no
group's ledger, and leaves the group's usage document with a single writer.

**A run can be asked for by a person, and it is a job like any other.** Three of
a rule's four triggers a person can bring about deliberately — mail the group,
mention the agent in its chat, set a clock — while mail arriving is the one
nobody can stage, and a rule that never ran reads exactly like a rule that cannot
run. So the Automations tab carries **Run now**: the ask resolves the group, the
rule and a message (the one named, or the newest in the group's own inbox,
drafts excluded), evaluates the rule's own filter against it, and writes a
**job** — the same document, in the same states, every other trigger writes,
picked up by the agent holding the group's claim and run on the rule's own
terms. The allowlist, the review policy, the version pin and the audit are the
ones already in force: a run asked for by a person meets the automation it names
and does not replace it.

**The ask is a job's provenance, never a rule's trigger.** The trigger record
carries a fifth value, `manual`, while what a rule may be woken by keeps its
four. An automation that only runs when somebody asks is a habit, not a
document, and a rule able to carry it would have to say what it acts on — which
is what its trigger already says.

**A refusal is answered to whoever asked, and written nowhere else.** An
automation that is not armed, one that is not about mail, no message to run on, a
message the filter passes over: each is a sentence for the person who asked, who
can act on it. None of them is a run that happened, so none of them enters the
group's audit — the audit is the record of what the agent did, not of what
somebody tried.

**An ask is its own event.** The deduplication key for a run a person asked for
is the instant it was asked at rather than the message it names, so the same
message can be run twice on purpose; every other trigger keeps the identity of
the thing that woke it, because a re-read change is not a second event and a
person pressing a button twice is two asks.

**One automation's work can wake another, and a chain is bounded at five hops.**
This is the point of automations rather than a side effect of them: "file the
invoice where the client's name says, then read it and tell the group" is two
automations passing work along, not one automation doing two things, and the
hand-off travels through the group's own documents — a file written into its
Files wakes a file rule, a decision answered in its chat closes the run that was
waiting, and a chat rule wakes when a person addresses the agent, which is the
one hop that always has somebody in it. What a chain needs is a **lineage and a
bound**: every job's trigger records the job that woke it, a chain runs **five
hops**, and the sixth is **refused loudly** rather than quietly dropped — the
group's chat is told which automation could not run and that it is because the
chain passed five hops, the log carries the same line, and the audit records the
refusal as its own entry, because nothing failed: a run that must not happen is
a fact about the agent, and a reader of the trail is entitled to see it. Five is
chosen to be far more than a useful chain needs and far less than a runaway one:
a cycle of automations that wake each other therefore ends by itself, at the
bound, with a line in the group's chat that says why. The number is carried in
the installation's configuration rather than compiled in, so a deployment with a
legitimately longer pipeline raises it instead of waiting for a release.

**The count starts at the trigger.** What wakes a rule by itself — an arrival, a
file, a request in the group's chat, the clock — is **hop one**, and a run woken
by another run's effect is one more; an ask a person made is hop one like any
other trigger, because it is one. It is what makes the refusal reproducible: the
same message, the same chain, the same sixth hop. The audit records that refusal
under **`refused`**, an outcome of its own beside `missed` (a due run nothing
could fire) and `timeout` (a holder that stopped reporting), because a run that
must not happen is neither of those.

**A group has a notebook, and that is what memory means here.** Beside the
documents a group already keeps in Stalwart — its chat, its audit, its decisions
— an automation's prompt carries a **notebook**: the facts the group's agent
should hold in every call, such as how this group's mail is filed, what its
clients are called, which language the group works in, and the exceptions its
administrator wrote down. It is a document in the group's own account, so it
survives a container, a deploy and a replacement agent; a person can read and
correct it; and it lives in the prompt's stable head, so carrying it into every
call costs a cache hit rather than a miss.

**Caching is a declared constraint on the prompt, not an optimisation to hope
for.** The prompt is built in one order and stays that way: the fixed system
prompt (the data-not-instructions preamble), the capability catalogue, the
group's notebook, the group's standing instruction, the rule's instruction, and
last the volatile content — the message, its thread, the chat slice. Nothing
volatile goes before that tail, and no clock or run id enters the head.

**What a run costs is metered where it was spent.** Every call records the tokens
the provider reports — input that hit the cache, input that missed, and the
answer — into the group's own account, beside the work that spent them: one
document per month, carrying the agent that spent each count and whether that run
reasoned. The readings the surface needs are readings of that one record, which
is what keeps them from disagreeing: the group's meter is its own document, the
installation's total is the sum over the groups the administrator can reach, and
an agent's share is the same record grouped by agent. The **Master's own
account** holds the authoring counts, one document per month as well, and the
installation total adds them while the per-agent split shows them as a line that
is nobody's run.

Counting in **tokens and not in money** is deliberate. A price list belongs to a
vendor and changes without asking, so a figure in currency would be a claim the
product cannot keep; a deployment that wants money can multiply what it is
charged. A provider that reports no usage is shown as unknown rather than as
zero, and the retention follows the audit's — a meter that outlives the trail it
belongs to is a number nobody can check.

**Where a group's automations are, its trail is too.** The Group agents section
carries a window on that group's own audit: the most recent entries, newest
first — when it ran, which automation and which version, what woke it, who asked
when a person did, the actions it took and how it ended. It reads the same
bounded document the member panel reads, so "what has my agent been doing in this
group" is answered where an administrator writes and runs its automations,
instead of costing a download of a month's JSON to find out.

**Deterministic document work is a tool the fleet runs, not a question it asks.**
Cutting the pages out of a PDF, merging them, or reading a `.docx` a client sent,
is not judgement: a model asked

to cut pages invents page
numbers and can be wrong in a way nobody sees. So the capability catalogue grows
a document family — page work (`document.split`, and the companions it implies:
merge, extract, and editing the pages), and documents in (`document.read` for a
PDF's own text layer or a `.docx`) — and the executor is what runs them, on the
blob that is already in the group's own Files: the file is read, the work happens
**in memory**, and the result is written back as files or handed to the run as
text. Nothing in the family *produces* a `.docx`: reading one a client sent is
worth a library, writing one is a job for a person's word processor. A page that is only pixels is
deliberately not in that family: it is the model's to read.

**The model names the tool; it never runs code.** "The model calls the library"
means the answer carries an action from the catalogue and the executor performs
it — the allowlist still bounds every action, so a rule that was not granted
`document.split` cannot cut a page out of anything, and the audit names what it
did. A model that
executed code a prompt asked for would move the whole boundary into the prompt.

**A page that is only pixels is read by the model, because it has eyes.**
Reading a scan is a judgement about what the page says, and the configured model
does it directly: the page travels as an image (bounded at 1024 tokens) instead
of through a local OCR engine, which is one fewer dependency, one fewer thing to
install in an immutable container, and no second vocabulary for how a page is
read. The trade is stated rather than hidden: what comes back is the model's
reading, not a deterministic extraction, and text an automation can search,
store or cite exists only if the run is instructed to write it out as one of its
actions — there is no OCR artifact behind it to fall back on. The page is
volatile content like any other: it sits in the tail, so the prompt's stable head
is unaffected, and an image is never a cache hit.

**What such libraries have to be, given the container keeps nothing.** Pure
JavaScript or WASM under a permissive licence, with no native build step, because
the deployment is `IMMUTABLE=1` — no writable filesystem — and disposable. Per
job: `pdf-lib` for a PDF's pages (split, merge, extract, and the page editing
that goes with them), `pdfjs-dist` for a PDF's own text layer, and `mammoth` for
reading a `.docx` — the shapes that fit,
each confirmed by building the image and running the action on a real file with
no scratch directory, rather than by reading its README. Two engines are
deliberately absent from that list: no OCR, because a page with no text layer is
the model's to read, and no `.docx` writer, because producing one is not work the
fleet has.

**A provider is required.** A rule that cannot call a model has nothing to decide
with, so an installation with no provider configured has no automations — a state
the admin surface says where it already says what is missing.

**A group is told when its agents cannot work, and so is the administration.**
A run that cannot reach the model — a refused or expired key, a provider that is
unreachable, a budget that is spent, an answer that comes back malformed — is not
only a failed run: it is a **state** its members and its administrator have to be
able to see without opening an audit. Two states are stated, and they are
different ones: *nobody is serving this group* (no agent holds its account) and
*the model is refusing* (the most recent run ended on one of those causes). Both
are raised in the two places a person looks — the indicator beside the group's
chat, and the administration (Master, and the group's own row) — each
naming the cause from a code in the reader's language, with what the provider
actually said carried beside it as the diagnostic it is. The state is **derived
from the trail** rather than kept as a second document: the most recent run's
outcome is the fact, a run that succeeds clears it, and there is nothing to keep
in step. A group nobody has run anything in yet has no state to report, which is
not the same as one whose agents are broken.

## Consequences

- Determinism is traded deliberately, and bought back in three parts: temperature
  0, a JSON answer, and an allowlist that refuses everything the rule was not
  granted. What is no longer deterministic is *which* granted action a run
  chooses.
- Every run costs a call and its latency. A group that receives a hundred
  messages a day makes a hundred calls; with a warm cache and off-peak pricing
  the money is a rounding error, and the seconds are the visible cost.
- The provider configuration is one entry for the installation — its form loses
the per-classification slots and the tab that held them — and the admin surface
stops asking an author to classify what they want.
- The rule schema and its checks simplify: the fields a rule must carry no longer
  depend on a classification, so a rule is validated one way rather than three.
- The products' descriptions change with the code: the feature inventory's tier
  bullet, the README's tier sentence, the rule form's tier section, the member
  panel that names a tier.
- An installation that runs no model loses the automations it could have had.
  That is the trade, and it is said plainly rather than discovered.
- A run a person asks for is executed by the fleet like any other: it needs a
  agent holding the group, and the surface says which groups are held. Its
  outcome is readable the same day — a failure tells the group's chat, a run
  asked for says what it did there too, and the audit keeps the line.
- The agent's settings grow a thinking switch, and what it did is recorded:
  the trail and the meter both say whether a run reasoned, so a change in cost or
  behaviour can be read against the machine that produced it.
- The dependency set grows for the first time on the agent side: page work and
  editing, a PDF's own text layer, and reading a `.docx`, all held to the
  in-memory constraint above — and no OCR engine, and no `.docx` writer. A deployment
  that refuses them loses those two actions and nothing else — every other
  automation runs unchanged, and a rule that names one gets the refusal in its
  own audit line rather than a silent skip.
- The web tier makes a provider call for the first time, on the authoring path:
  a request that can be slow, that needs a timeout, and that answers with a code
  when the installation has no provider or no budget — the same vocabulary the
  runs use, one call out of a fleet that had none.
- The trigger record gains a lineage (which run woke this one) and the audit
  gains an outcome for a run refused at the bound, so a chain is readable end to
  end — and a cycle, which nothing else would have stopped, ends at the fifth
  hop with the group told.
- The admin surface gains the meter: the group's own use where its automations
  are, and the installation's total with the split per agent where the fleet is
  read. The installation-wide total is as complete as the administrator's reach —
  a group they are not a member of cannot be counted — and it says so, the same
  way the approvals queue does.

## Alternatives considered

- **A fixed action plan that calls no model** (a rule whose actions are listed
  and run on match). Rejected: its reason to exist was cost, and the cost is
  gone; what it protected — an installation that runs no model, and a run whose
  outcome is the same every time — is bought by temperature 0, a JSON answer and
  the allowlist, and by saying plainly that a provider is required. Keeping it
  would also keep the classification the author cannot make, since a fixed plan
  and a model-decided run are two kinds of document.
- **A closed set of categories, each with its own fixed actions.** Rejected: it
  is the most expensive shape to author — a second vocabulary of categories
  before anything runs — and a model answering with actions from the catalogue
  covers the same ground without it.
- **A model call that compiles prose into a rule document.** Rejected: it exists
  to produce a shape the executor no longer needs, and the four fields of a rule
  are a person's decisions rather than a translation.
- **Keeping the classification as something internal, chosen for the author.**
  Rejected: it would exist only to decide whether to call a model, and one shape
  answers that question once.
- **Session state held by the provider** (a conversation the model remembers).
  Rejected: the fleet's state is Stalwart's documents, and state held by a
  provider is state we cannot read, audit, export or correct — in a product whose
  rule is that everything durable lives in the mail server.
- **A helper that rewrites the prose for the author.** Rejected: an automation's
  instruction steers inside a grant, and a model that edits it silently is a
  model editing what the grant is asked to do. It reports the gaps; the author
  writes the prose.
- **Treating the disk cache as memory.** Rejected as a category error: it holds
  prefixes, it expires, it is best-effort, and it cannot be read back. Memory is
  a document.
- **No chains at all** (an automation is never woken by another one's effect).
  Rejected: it kills the hand-off that lets two small automations do what one
  large one would have to — and it cannot be enforced cleanly, since the group's
  Files, its chat and its decisions are shared by members and agents alike.
- **A chain with no bound.** Rejected: a cycle of automations that wake each
  other would run until somebody noticed, spending the installation's model
  budget in a loop; the bound and the refusal are what make chains safe to have.
- **The bound as a constant in code.** Rejected: a deployment whose paperwork
  pipeline is legitimately six steps deep would have to wait for a release to run
  it.

## References

- ADR 0003 — the fleet: the claim, the review gate, the consent floor, the audit.
  Its automation model, with a classification per rule, is superseded by this
  record
- DeepSeek, *Models & Pricing* and *Context Caching* (`api-docs.deepseek.com`,
  read 2026-09-12) — the prices and the prefix-unit rule quoted above
- `server/src/agent/llm.ts` — `callModel`: temperature 0, `response_format:
  json_object`, the timeout, and the missing output cap
- `server/src/agent/executor.ts` — the capability check, `reviewOutcome`, and the
  context a run is given
- `server/src/agentAdmin.ts` — `runRuleNow`: the ask that writes a job, and the
  refusals it answers with
- `server/src/app.ts` — `POST /api/admin/groups/:name/agent/run`
- `web/src/views/admin/agent/RuleEditor.tsx` — *Run now*
