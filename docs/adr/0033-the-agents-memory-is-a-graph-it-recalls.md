# ADR 0033 — The agent's memory is a graph, and it recalls it on every call

Status: Accepted

Implementation: Built.
is about, the relation it states, one sentence of what is held true of it, where it
came from and the **interval it is true for** — whose shape, parser and the
**selection** a call carries are `server/src/shared/memory.ts`; where the entity
and the fact documents live, how the store is read and the writes are
`server/src/agent/memory.ts`, writing `memory/entity-<id>.json` and
`memory/<id>.json` under the **Master's** own app folder, one memory for the
installation (ADR 0038 states the model: entities with a normalized name and
explicit aliases, typed relations, a fact closed by the one that contradicts it,
retrieval by exact subject then similarity then recency with relations one hop,
the pass's TTL, and the "since when" read). Both turns are handed the selection —
the entities the change names, their facts valid at that moment and one hop of
their relations, inside a ceiling of facts and of characters — fenced as data like
every other block of text somebody outside the group decided
(`server/src/agent/model.ts`), and the loop makes it and reads the store from the
Master's account (`server/src/agent/loop.ts`). The run records which facts its
calls carried and which retrieval found them, as references to the documents
(`recalled`, `retrieval`, `server/src/shared/run.ts`), so a conclusion is traceable
to the fact behind it — and the surface that draws a run resolves each of those ids
to its fact. The agent's write is the catalogue's `act` with `what: "fact"`
(`server/src/agent/tools/memory.ts`), an act of the class the agent decides alone:
it records a fact, and against one a person holds it writes its conclusion
**beside** the person's sentence as a proposal (`FactProposal`), never in place of
it. Behind the installation's own door (ADR 0038) an administrator reads those
facts and answers for them: a correction replaces the sentence in place, keeping
its id, its interval and the entity it is about, and keeping the origin it had —
where the conclusion came from and when — while recording the person who made the
correction beside it (`FactCorrection`, `isInForce`), which puts the fact in force
and is also what **accepts** a proposal, the document it writes carrying none; a
dismissal drops the proposal and leaves everything else as it was; and a removal
takes the document out entirely — all four written against the state the reading
saw (`server/src/agent/memory.ts`, `server/src/routes/agent.ts`,
`web/src/views/admin/agents/AgentMemory.tsx`). The knowledge base stays a second
store, which is this record's decision and not work owed.

## Context

An agent that starts from nothing on every change relearns the same things
forever: which shipper this installation calls "the usual one", that a client's
orders arrive on Fridays, that last week a person corrected the way a booking is
read. The knowledge a group has written reaches every call already (ADR 0020,
ADR 0038) — but what the *agent itself* came to know while working is written
down nowhere, so it is lost the moment the run ends.

The owner's decision: the agent **always** has memory, maintained as a graph and
recalled on every call, and an installation administrator can see and change
those facts from Administration.

## Decision

- **The memory is a graph of facts**, not a transcript: what the agent read and
  concluded, as small facts with the relations between them, so one fact can be
  recalled without the whole story around it.
- **It is recalled on every call** — the decision turn and the choosing turn both
  read it — so the agent's understanding of a change starts from what it knows.
- **It is durable like everything else** (the architecture law — no database of
  our own): it lives in Stalwart, in the **Master's own account**, in its own
  store, written the way this product writes its own documents.
- **One memory for the installation, and that is the point.** A group's agent
  reaches facts about activity that is **not that group's** — the branches, the
  customers and the correspondence of the whole installation — because a decision
  taken in one group is better when it knows what the rest of the installation
  knows. The group owns its own mail, files and KB (ADR 0004); the memory of what
  the agent learned is the installation's, and it is the Master's account that
  holds it.
- **It is a second store, not the knowledge base.** What a group writes for
  people to read is a page with revisions and approval (ADR 0020); what the agent
  learned is a fact with a provenance. They are different things with different
  readers and different lifetimes, and the memory is its own store beside the
  installation's other documents. What it must never become is a second copy of a
  page: a fact that belongs to the KB is a reference to it, never a paraphrase of
  it.
- **A fact is one small thing, with the interval it is true for**: the entity it
  is about (an address, a mailbox, a file, a customer, a shipper, a group), the
  typed relation it states, what the agent holds to be true of it in one sentence,
  where it came from (the run that wrote it, or a person), when, and
  `validFrom`/`validTo` — an entity is identified by its normalized name, an alias
  is an explicit fact, and a relation is a fact whose value is another entity
  (ADR 0038). A contradicting fact **closes** the one it replaces rather than
  overwriting it, and a duplicate is not written again; the document is what the
  store's own parser refuses to read when it is malformed.
- **A call recalls a selection, never the whole graph.** What reaches a call is
  what the change at hand is about: the entities its words name, their facts valid
  at that moment and one hop of their relations, ranked by subject, then
  similarity, then recency, inside a ceiling of facts and of characters the call
  carries — and only the top few reach the turn. A fact about a subject the memory
  does not hold creates the entity. What was recalled, and which retrieval found
  it, is written into the run's record, so a wrong conclusion can be traced to the
  fact that carried it (ADR 0030).
- **A fact is information, never an instruction.** It is read and reasoned over;
  it grants nothing and authorises nothing. The authority classes (ADR 0028) and
  the trust of a sender (ADR 0029) are untouched by anything a fact says, and a
  fact that reads like an order does not become one by being remembered.
- **The agent writes to it** as it works, within the authority classes like any
  other act: a correction a person gave, a mapping it established, a conclusion a
  rule's prose implies.
- **A person sees and edits it, and a person's fact is in force.** An
  installation administrator has a surface where the facts are read, corrected
  and removed; a fact a person has written or corrected is knowledge the agent
  reasons from, and the agent does not overwrite it silently — what it concludes
  against one it proposes, as a person's approval is what puts a KB page in force
  (ADR 0020). The memory is not a black box, and a wrong fact is corrected where
  it lives rather than worked around in a rule's prose.

## Consequences

- The agent's reasoning becomes inspectable: a wrong conclusion traces to the fact
  that carried it, and is corrected in the memory rather than in the prompt.
- The graph needs the discipline of a page — written deliberately, closed when it
  stops being true, deleted when it should never have been written — because it is
  recalled on every turn: what is not worth saying is not worth remembering.
- A selection is what keeps the memory from becoming a cost on every call, and it
  is measured by its precision and recall rather than by how much is stored
  (`server/src/agent/eval/memory.ts`): a wrong fact recalled is worse than a
  missing one.
- The Master's account becomes the place where the installation's agent has its
  understanding, which is one more reason the Master is the principal everything
  belongs to (ADR 0009).
- A fact is **standing knowledge, not a log**: the door refuses a sentence that
  carries a date or a record's id, and a subject that is one record rather than a
  thing a later change names again (`server/src/agent/tools/memory.ts`). What
  happened once belongs to the run's own record, which is where a reader looks
  for it.
- What the memory still owes is **pruning by hand**: a closed fact leaves the live
  retrieval and keeps its document, and the facts no run ever recalled are the ones
  a person is shown first when the store is pruned from Administration.
<!-- owed: memory-pruning -->
