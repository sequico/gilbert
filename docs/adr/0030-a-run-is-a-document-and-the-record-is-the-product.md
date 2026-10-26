# ADR 0030 — A run is a document, and the record is the product

Status: Accepted

Implementation: Built. The run document — its shape, its parser and the
transitions over it — is `server/src/shared/run.ts`, and where a run lives, how
it is read and how it is written whole is `server/src/agent/runs.ts`. The plan
carries **order and conditions**: each step names what it waits on — a step named
before it in the same answer, and the outcome it needs that step to end with —
and the loop that works a run (`server/src/agent/loop.ts`) runs the steps whose
dependencies have ended **together**, reads each outcome, takes the branch that
outcome names, and leaves a step no branch reaches unrun, its record naming which
step and which outcome left it. The plan is the choosing turn's answer
(`server/src/agent/model.ts`), which refuses a step waiting on a name the answer
does not carry, or on an outcome no step can end with, and resolves each name to
the step it holds. The model reasons the order and the conditions from the
group's knowledge, its checklists and its workorders, which it reaches with the
catalogue's reading tools (ADR 0027); the tools the catalogue still lacks are
`ROADMAP.md`'s. A pass takes the installation's claim, arms every wait each
account's runs carry, works the runs whose wait has come due, and opens or
continues and works a run for each rule a change fits (ADR 0031). Where an
installation administrator reads them, a run is drawn as the record carries it:
`server/src/agent/runs.ts` answers one walk of a folder in two shapes —
`listRuns` for the loop, which refuses the first document it cannot read, and
`listRunsForReading` for `server/src/routes/agent.ts`, which carries that run as
a problem the view says out loud rather than drawing it blank
(`web/src/views/admin/agents/GroupRuns.tsx`, behind the installation's own door,
ADR 0027). The ending a run says is one message of the group's own conversation
(`endRun` in `server/src/agent/loop.ts`, over `postChatMessage` in
`server/src/groupChat.ts`), a reply to the message that woke the run when a
person wrote in the conversation. The records a run writes next to a person's
already exist — a workorder step's `state`/`by`/`at`/`note`
(`server/src/shared/workorder.ts`) and a KB page's revisions (ADR 0020).

## Context

Gilbert's name ends in Enterprise Resource **Traceability**: the record is what a
company is buying. Its intent lives in the KB and the workorders and people write
it; what an agent does has to be as durable, as readable and as attributable as
what a person does, or the record is true of only half the work. The process, in
the meantime, is disposable by law: the container may vanish between two steps of
a run.

## Decision

**A run is a document in the group's account**, and it is the whole of the
agent's durable state.

- It carries which rule or which instruction started it, the surface matrix that
  rule had when the run opened (ADR 0031), the plan (the steps the model chose,
  or the rule declared, and what each of them waits on), the outcome of each one,
  what it is waiting
  for — and until when, when there is a date — every authorisation with the
  message it arrived in and the authority given, the evidence behind every claim,
  and the budget it has spent. A step keeps the line a person reads **and** the
  digest of the whole call it asked (`ask`): the line is clipped, so it cannot
  tell two calls apart, and a repeat is recognised by the call rather than by
  its beginning.
- **One change of the server is one event.** The agent reads a group's activity
  from the server's own change logs, and a node written twice in one batch —
  created and then written again — reaches them as two changes for one address,
  which is one event, not two: a rule watching that surface opens one run for one
  document and the agent cannot answer one message twice. Two changes are of one
  event when they name the same **address**, the surface and the path (or the id
  a removal has no path left for); the folded event is named **`created`**,
  because the node did not exist before the read and exists now, and a removal is
  never folded behind a creation.
- **A turn may carry several calls, and the independent ones run together.** The
  model decides what a change needs and may ask for one tool or several in one
  answer — the same tool twice among them — and the calls of one answer that wait
  on nothing are made together. Each call is its own step in the plan, with its
  own outcome and its own spend, and one of them leaving a wait has it honoured
  after the whole answer. **The answer is written before it is acted on**: the
  plan and each step's intent are on the run while the steps are still to run, and
  each step's outcome is written on the same document after the wave. The process
  is disposable, so a record held only in memory is a record a container can take
  with it — leaving an effect in the account with nothing that says what asked for
  it. A message whose attachment must be saved and which must then be filed in a
  folder is one such turn: neither act waits on the other, so both are asked for
  at once — and the same turn may ask a person in chat about what follows, the
  acts and the question being one answer, whose wait begins once they are done.
- **A plan carries order and conditions, and it is the exception.** The common
  path is the role's workflow — read, act, report — and a run takes a plan only
  when its rule declares that it needs one (ADR 0038). When it does: the model may
  ask for a step that
  waits on an earlier one, and for a later step to depend on how an earlier one
  ended — if that call filed the message, do this; if it was refused, do that —
  reasoned from the group's knowledge, its checklists and its workorders, and
  never compiled at write time. A step waits on a step named before it **in the
  same answer**, and on the outcome it needs, so a plan cannot cycle; the loop
  runs what is ready, reads
  each outcome, and takes the branch that outcome names, and a step no branch
  reaches is left unrun with its record saying which step and which outcome left
  it.
- **A wait is a date in the run** — the instant an appointment or a window comes
  due, and the **deadline a question to a person carries** — not a timer in a
  process. A question is answered as the conversation's own event, but its
  deadline is what covers the person who never answers: when it comes due the run
  goes on without the answer, with a step that says what did not come, rather than
  waiting for ever. On boot the agent re-arms the waits it
  finds, so a restart in the middle of a run loses nothing and a container that
  dies is not an incident.
- **A run ends in one of four ways** — the work is done, it is blocked on a
  person, its budget (ADR 0027) is spent, or a member of the group stopped it —
  and its ending is written down, so a run that stops says why. **The budget is
  the only ceiling a refusal reaches**: an answer the parser cannot read, an
  answer asking for more steps than the run has left, and a call the account
  refuses are each a step that ended, and each spends a step — a model that
  repeats a refused call stops on the twenty steps the run declares, not on a
  counter of refusals the record cannot show. The one that ends
  blocked on a person keeps the question it left, and the sentence it asked it
  in, so the answer that comes back can be recognised as addressed to it. The
  one a person stopped is `cancelled` with the words it was stopped with, and the
  pass that was working it leaves that ending alone rather than writing its step
  over it. A guardrail that fires ends the run as `refused`, with the check that
  fired and what it found (ADR 0038): it is not an out-of-budget, which would blame
  the clock for a decision.
- **An ending is said, not only recorded.** A run that could not finish says so
  in the group's own conversation, with the sentence its ending carries; a run
  that finished says so when a person woke it there **and it has not spoken
  there** — a report of its own is the word, and repeating the ending beside it
  would be two messages for one piece of work. **The ending is written before it
  is said**, so the record is the arbiter: a run a person stopped during its last
  call says nothing at all, because its ending never landed. The debt to speak is
  on the record (`said: false` until the words have left), so an ending is said
  exactly once, and a pass that finds an unpaid debt says it. **One request, one
  answer**: the notice is a reply in the thread that woke the run, and a mention
  opens one run rather than one per rule that watches the conversation (ADR
  0031). A question it asked and a stop a person took are already words between
  them, so those endings do not repeat themselves, and a background run that
  finished keeps its record. The notice is the ending's own `why`, so the
  conversation and the record cannot tell two stories; a notice that cannot be
  posted leaves the debt on the record and is reported as the pass's own gap —
  never a silence, and never a step appended to a run that has already ended —
  and the debt is marked paid only when the words have left, so a run that
  already spoke is not read as owing them. A run that dies without a word is the
  defect this closes: the person whose request woke it saw nothing, and the
  installation looked like a queue that had stopped. A run woken by mail is said
  in the group's conversation **when it closes out of budget**: an answer to that
  person's message is mail sent outward, which only a rule that declares it sends
  may do (ADR 0028), so a `done` run woken by mail answers where it was asked and
  the group's conversation is not a second place for it.
- **A member of the group reads its runs and stops one that is in flight** —
  the one being worked and the one waiting on a person's answer, which nothing
  else moves; a group's every run in flight can be stopped at once, because a
  group with nineteen of them is nineteen presses otherwise. The gate is
  the person's own grant on the group whose account holds the runs — not the
  administrator's — so a member of one group neither sees nor stops another
  group's run, and the administrator has no reach beyond the groups they are in.
  A person can read a run and undo by hand what can be undone: it names what it
  touched, as references rather than copies, and the objects themselves are
  Stalwart's.
- **What the agent settles goes into the record that carries the work**: a
  workorder step changes state with the agent as its signer and the evidence in
  its note; a KB change is a proposal awaiting approval (ADR 0020).
- **An unreadable run is a defect**, and the agent says so rather than guessing at
  what it meant.

## Consequences

- There is no separate audit ledger and no per-action journal: the run is the
  ledger and the workorder is the record of the work. An accounting of its own
  has nothing to count that these do not.
- Reading a company's history is reading its own documents — which is also what
  makes the agent's proposals (ADR 0028, ADR 0020) rest on something real: it
  learns a practice from the work that is already written down.
- A run is a stored document, so its shape is versioned and a change to it is a
  change to what installations have already written.
- The trace is the product's answer to "what did it do, why, and who allowed it" —
  which is what makes an override, a reopen or a refused step auditable rather
  than merely asserted.
- The change log is read through its paging and its `changes_max_results`
  ceiling, both modelled in the mock and **never seen on a live server**: the
  probe is owed before the loop trusts a page boundary it has only been told
  about.
<!-- owed: change-log-cap -->
