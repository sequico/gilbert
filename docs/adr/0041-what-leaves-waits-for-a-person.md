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

- `mail.reply` and every outward message **create a draft** in the run's account
  and return its id; there is no tool that submits.
- The run records the draft id as its **outcome and its evidence**, and its ending
  says the draft is waiting. A person opens the run, reads the draft, and sends it
  from the draft itself.
- `startedBy.sends` stops being a licence the model reads: it is the rule's
  declaration that a draft is wanted at all, and a rule without it produces none.
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

## The ending is judged before it is believed

A draft is the product's check on the **words**; the ending needs a check on the
**work**, and the model cannot be its own judge. So:

- When a run is about to end `done`, a second call — cheap, the same model, a
  short question — is given the ask (`startedBy.about`), the plan with each step's
  state and the `evidence` the run recorded, and answers one of two things: the
  work covers the ask, or it names what is missing.
- A "missing" answer is the same refusal the loop already gives (ADR 0027's
  repair): the run is asked once more, with the missing thing named. The second
  `done` stands, and what the judge said is written on the ending, so the person
  who reads it sees what the agent claimed and what the check found.
- The judge never runs for a run with no `evidence`: a claim with nothing under it
  is refused without spending a call.
