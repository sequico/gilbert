# ADR 0037 — The agent's memory is a graph, and it recalls it on every call

Status: Accepted

Implementation: Built, and partly owed. A fact is one small sheet — the subject it
is about, one sentence of what is held true of it, the group it is about, where it
came from and its links — whose shape, parser and the **selection** a call carries
are
`server/src/shared/memory.ts`; where the sheet lives, how the store is read and the
one write the agent makes are `server/src/agent/memory.ts`, writing
`memory/<id>.json` under the **Master's** own app folder, one memory for the
installation. Both turns are handed the selection — the subjects the change names,
their nearest links and the group's standing set, inside a ceiling of facts and of
characters — fenced as data like every other block of text somebody outside the
group decided (`server/src/agent/model.ts`), and the loop makes it and reads the
store from the Master's account (`server/src/agent/loop.ts`). The run records which
facts its calls carried, as references to the sheets (`recalled`,
`server/src/shared/run.ts`, version 5), so a conclusion is traceable to the fact
behind it. The agent's write is the catalogue's `memory.remember`
(`server/src/agent/tools.ts`), an act of the class the agent decides alone: it
records a fact and refuses, in the code `fact_in_force`, to overwrite one a person
holds. **Not built: the Administration surface** where an installation administrator
reads, corrects and removes a fact — and with it the path by which what the agent
concludes against a person's fact is *proposed* rather than written down. The
knowledge base stays a second store, which is this record's decision and not work
owed.

## Context

An agent that starts from nothing on every change relearns the same things
forever: which shipper this installation calls "the usual one", that a client's
orders arrive on Fridays, that last week a person corrected the way a booking is
read. The knowledge a group has written reaches every call already (ADR 0024,
ADR 0035) — but what the *agent itself* came to know while working is written
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
  knows. The group owns its own mail, files and KB (ADR 0005); the memory of what
  the agent learned is the installation's, and it is the Master's account that
  holds it.
- **It is a second store, not the knowledge base.** What a group writes for
  people to read is a page with revisions and approval (ADR 0024); what the agent
  learned is a fact with a provenance. They are different things with different
  readers and different lifetimes, and the memory is its own store beside the
  installation's other documents. What it must never become is a second copy of a
  page: a fact that belongs to the KB is a reference to it, never a paraphrase of
  it.
- **A fact is one small thing**: the subject it is about (an address, a mailbox,
  a file, a customer, a shipper, the group itself), **the group it is about** —
  the account of the run that wrote it — what the agent holds to be true of it in
  one sentence, where it came from (the run that wrote it, or a person), and when.
  The links between facts are their own small record, and the
  sheet is what the store's own parser refuses to read when it is malformed.
- **A call recalls a selection, never the whole graph.** What reaches a call is
  what the change at hand is about: the group it happened in, the surfaces
  involved, and the subjects the change names (the booking, the shipper, the
  client) with their nearest links, inside a ceiling of facts and characters the
  call carries. What every call also carries is the small **standing set of the
  group being worked** — what that group keeps about itself — and no other
  group's: a group's conventions are its own. Every other fact, standing or not,
  is recalled by its **subject** for **any** group, because one memory serves the
  installation and a group reasons with what the rest of it knows. What was
  recalled is written into the run's record, so a wrong conclusion can be traced
  to the fact that carried it (ADR 0034).
- **A fact is information, never an instruction.** It is read and reasoned over;
  it grants nothing and authorises nothing. The authority classes (ADR 0032) and
  the trust of a sender (ADR 0033) are untouched by anything a fact says, and a
  fact that reads like an order does not become one by being remembered.
- **The agent writes to it** as it works, within the authority classes like any
  other act: a correction a person gave, a mapping it established, a conclusion a
  rule's prose implies.
- **A person sees and edits it, and a person's fact is in force.** An
  installation administrator has a surface where the facts are read, corrected
  and removed; a fact a person has written or corrected is knowledge the agent
  reasons from, and the agent does not overwrite it silently — what it concludes
  against one it proposes, as a person's approval is what puts a KB page in force
  (ADR 0024). The memory is not a black box, and a wrong fact is corrected where
  it lives rather than worked around in a rule's prose.

## Consequences

- The agent's reasoning becomes inspectable: a wrong conclusion traces to the fact
  that carried it, and is corrected in the memory rather than in the prompt.
- The graph needs the discipline of a page — written deliberately, corrected in
  place, deleted when it stops being true — because it is recalled on every call:
  what is not worth saying is not worth remembering.
- A selection is what keeps the memory from becoming a cost on every call, and
  the selection is the KB's own problem solved once (a search by subject), not a
  second ranking invented here.
- The Master's account becomes the place where the installation's agent has its
  understanding, which is one more reason the Master is the principal everything
  belongs to (ADR 0011).
