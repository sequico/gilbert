# ADR 0041 — What leaves waits for a person

Status: Proposed

Implementation: Not built. A rule declares `sends` and the run carries it
(`server/src/shared/run.ts`, `startedBy.sends`), so the model is told it may send
outward in the same turn in which it composes the words.

## Context

The `done` of a run is the model's own claim, and a live installation measured what
that is worth: 67 of 132 runs that ended `done` had refused a step, one of them
declaring a filing audit complete while its own report admitted it had checked one
side and never read a mail. The same runs show the licence being spent in the
prompt: `sends: true` and a `wakeFrom` address the model can read, and a `wakeFrom`
that was wrong on one run (the `.com` address of a sender whose messages carry
`.company`).

A licence in the prompt is a permission the model holds. A permission a person
holds is a different thing: a draft and a yes.

## Decision

**An act that leaves the installation is a draft, and a person says yes.**

- `mail.reply`, `mail.forward` and every outward message create a **draft** in the
  run's account, and the run's ending says the draft is waiting.
- The run records the draft as its **outcome and its evidence**; the surface that
  shows the run shows what was drafted, and a person sends it from the draft.
- `startedBy.sends` stops being a licence the model sees: it becomes the rule's
  declaration that a draft is wanted at all, and a rule without it produces no
  draft.
- A **run that ends `done` with a refused step** is refused once by the loop and
  asked to finish or to say what it could not do (ADR 0027's repair); its second
  `done` stands with the refusal on the record, and the review of the draft is what
  a person acts on.
- Nothing in a run sends: the account's own submit is a person's act, in the
  interface.

## Consequences

- The product owns the last check, so a false claim cannot leave the installation;
  it can only disappoint the person who reads it.
- A run's ending and its drafts are one story on the surface: "it read, it filed, it
  drafted this, waiting for you".
- The agent's authority for outward mail is no longer a string in the prompt, so a
  misread `wakeFrom` cannot send to the wrong correspondent.
- Sending costs the person a step; that is the point of the decision, and a rule
  whose work is routine correspondence still saves every step before it.
