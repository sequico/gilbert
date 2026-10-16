# ADR 0037 — The agent's memory is a graph, and it recalls it on every call

Status: Proposed

Implementation: Not built. What the tree carries today is the run document
(`server/src/shared/run.ts`), which is the memory of *one* run and nothing else:
what the agent learned while working a change is not kept anywhere the next call
can read.

## Context

An agent that starts from nothing on every change relearns the same things
forever: which shipper this group calls "the usual one", that a client's orders
arrive on Fridays, that last week a person corrected the way a booking is read.
The knowledge a group has written belongs to it and reaches every call already
(ADR 0024, ADR 0035) — but what the *agent itself* came to know while working is
not written down anywhere, so it is lost the moment the run ends.

The owner's decision: the agent **always** has memory. It is maintained as a
graph and recalled on every call, and an installation administrator can see and
change those facts from Administration.

## Decision

- **The memory is a graph of facts**, not a transcript: what the agent read and
  concluded, as facts with the relations between them, so a fact can be recalled
  without the whole story around it.
- **It is recalled on every call** — the decision turn and the choosing turn both
  read it — so the agent's understanding of a change starts from what it already
  knows.
- **It is durable like everything else**: it lives in Stalwart, in an account's
  own app folder, and never in the process (the container is disposable, ADR 0011
  and the architecture law — no database of our own).
- **A fact is information, never an instruction.** What the memory holds is read
  by the model and reasoned over; it grants nothing and authorises nothing. The
  authority classes (ADR 0032) and the trust of a sender (ADR 0033) are untouched
  by anything a fact says, and a fact that reads like an order does not become
  one by being remembered.
- **The agent writes to it** as it works — a correction a person gave, a mapping
  it established, a conclusion a rule's prose implies — within the authority
  classes like any other act.
- **A person sees and edits it.** An installation administrator has a surface
  where the facts are readable and editable: the memory that drives the agent's
  reasoning is not a black box, and a fact that is wrong is corrected where it
  lives rather than worked around in a rule's prose.

## Open — to settle before this is built

1. **Whose account owns the graph.** The Master's account makes it one memory for
   the installation; a group's own account makes each group's memory its own,
   which matches the ownership law ("everything a group owns belongs to the
   group") and would not let one group's facts reach another's call.
2. **Whether it is the knowledge base's own graph or a second one.** ADR 0024's KB
   already holds pages, their revisions and their relations; the agent's facts
   could be pages of a kind (one home, one search, one editor) rather than a new
   store. This is the question of duplication, and it decides the shape of
   everything else here.
3. **What "recalled on every call" costs.** All of it in every call does not
   scale; a selection — by the change at hand, by the group, by the surfaces
   involved — is what the KB's search already offers. The bound must be chosen
   and written down, and what a call carries said out loud.
4. **What a fact is, in the document.** A triple, a short prose note, a page with
   links. It decides what the editor in Administration edits and what the model is
   shown.
5. **Who may write besides the agent**, and whether an administrator's edit is
   final against the agent's own later correction of the same fact.

## Consequences

- The agent's reasoning becomes inspectable: a wrong conclusion can be traced to
  the fact that carried it, and corrected in the memory rather than in the
  prompt.
- A memory that grows without a bound becomes a cost on every call and a
  liability in a prompt. It needs the discipline of a page: written deliberately,
  corrected in place, and deleted when it stops being true.
- The graph must not become a second knowledge base: two stores of the same
  fact, in the same product, is the duplication this repository refuses.
