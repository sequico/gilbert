# ADR 0035 — A group's engagement is a rule in prose

Status: Accepted

Implementation: Not built. The rules' documents and the builder that orders the
prose for the model are to be written with `gilbertagents`; the group's own
account (ADR 0005) is where they live.

## Context

A group's work has patterns: a message from a shipper means an answer is owed; a
set of container documents means a folder and a filing; a booking confirmation
means a step of its workorder is now done. Those patterns are the group's own
and they change, and a product that compiled them into features would need a
release for every group that works a little differently (ADR 0031).

What a group can always do is write: a sentence saying what it watches and what
should happen. What the product owes is a place to write it and an agent that
reads it.

## Decision

**One rule is one document, in the group's own account**, and it says two things:
**what it watches** — the activity of that account, mail in and out, its Files,
its chat, and the writes to its own workorders — and **in prose, what should
happen** when that activity is met.

- The prose is the instruction. Nothing about a rule is compiled, and a rule
  carries **no list of permitted actions**: what bounds the agent is the
  authority classes (ADR 0032), not the rule.
- **A rule may declare that it sends.** That is the one power a rule carries of
  its own (ADR 0032 class 3), and it is written in the rule itself, where its
  owner reads it.
- **The prose that reaches the model has three levels**, outermost first: the
  **installation's own line** (one document in the Master's account, carried
  into every call), the **group's standing instruction** (in the group's
  account), and the **rule's own instruction** (in the rule). One builder
  produces that order for every caller, so what the agent is told is one thing
  however it was reached.
- **A rule belongs to the group that wrote it**, like everything else the group
  owns: a member reads it, and changing it is a member's act, the same as
  editing the KB.
- **An instruction from a person is a plan, not a rule** (ADR 0031, ADR 0033):
  a rule is what a group decided in advance, and a sentence in the chat or in
  the mail is what it decided now.

## Consequences

- A group's practice is written, read and corrected in prose, and the agent's
  behaviour stays reviewable by the people it works for.
- The rules are the group's documents, so they follow the group: a member added
  later reads them, and the agent reads them with the group's own access.
- Prose that does not say what it means is the failure mode, not a missing
  feature: a rule whose instruction is vague makes the agent vague, and that is
  visible to whoever owns it.
- There is no per-rule capability to administer, and no place in the product
  where an administrator grants a permission per pattern of work.
