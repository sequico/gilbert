# ADR 0028 — What the agent decides, and what only a person decides

Status: Accepted

Implementation: Built. The five classes and the guard that asks
them — `ToolAuthority`, `authorityNeeded` and `mayRun` in
`server/src/agent/tools.ts` — are built, and an authorisation names the act it is
for (`RunAuthorityAct`), so a class alone answers for no act. **A person's word arrives in the conversation**: the sentence that answers a
run's question is read once (`readAnswerAuthority`, `server/src/agent/model.ts`)
for the act it authorises, and each act it names is recorded on the run
(`RunAuthorisation`: the words verbatim, the class, the act, the address it came
from and the message it arrived in) by the loop (`authoriseAnswer`,
`server/src/agent/loop.ts`). What bounds that reading is the act: `mayRun`
compares target and content exactly, so a sentence read too generously licenses
nothing the step does not match. An **override** (class 4) is an installation
administrator's and is proved by the **directory**, not by the sentence: before an
answer is read, the agent presents the sender's account to the server and reads
whether it is a Stalwart administrator (`isAdministrator`, `server/src/agent/loop.ts`),
and only then may the reading report the class. **No catalogue act sends**: an
outward message leaves as a draft a person sends (ADR 0038), so `act` with
`what: "reply"` writes a draft in the group's own Drafts and a draft is class 1 —
reversible and inside the account — while class 3 is the licence an instruction's
own **declaration** that it sends carries, travelling on the run
(`startedBy.sends`). A person's word still names the act it is for, and `mayRun`
compares target and content exactly, so a word for one message licenses no other.
**Trash is class 2**: `act` with `what: "trash"` **moves** a message to the account's Deleted
Items, where it can be recovered, and the act it asks a person to license is the
message's id (owner decision 2026-10-18). The same class covers the acts that
destroy or rewrite what was there — `overwrite`, `delete`, `mailFolderDelete`,
`reschedule` and `cancel` — each naming the object the person's
word is for. `write`, `move`, `rename` and `schedule`
are reversible and the agent's. The policy the agent reads is a KB page (ADR
0020).

## Context

An agent with a model's judgement and a catalogue of tools can do anything the
account can. The bound cannot be a list of permitted business actions: the
practices are unbounded (ADR 0027), and such a list would be the product's
authors deciding, in advance, what every company may do. What can be bounded is
**how much can be undone, and who is answerable**.

## Decision

Five classes, and the agent's freedom is exactly the first.

1. **Reversible, inside the group's account** — filing a message, a keyword, a
   label, a folder, writing, moving or renaming a file, creating an event in the
   group's own calendar, opening a workorder, drafting a text, saying something in
   the conversation, settling a step of a workorder, proposing a change to a KB
   page, setting a wait. **The agent decides.**
   Everything it creates is the group's from creation; every effect is in the
   trace (ADR 0030) and can be undone by hand.
2. **Irreversible or destructive** — destroying a message, a folder or a page,
   emptying a folder, deleting or overwriting a document, changing or removing a
   calendar event. **A person, always**, and never by
   default: the product's own preference is that nothing disappears, because the
   record is what it is for.
3. **Outward** — anything that reaches a person outside the mandate. **A person's
   word, or an instruction that declares it sends.** An instruction that sends
   says so in its own text, where its owner reads it; the declaration authorises
   that send and no other.
4. **Beyond the policy** — an act the written policy forbids. The agent does not
   do it: it **names the policy and the page** and asks, and **only an
   installation administrator may override**. The trace carries the name, the
   moment and the message the authorisation arrived in. An override is a decision
   by a person, recorded — never a silence.
5. **The intent** — which policy is right, which steps a workorder should carry,
   whether a KB change is accepted. **Never the agent's**: it proposes, and the
   approval stays where ADR 0020 puts it.

Two standing behaviours, whichever class is at hand:

- **The agent reopens a settled step when the evidence says it is not settled** —
  a reversal, a returned delivery, a document that changes what was thought done
  — and the reopen carries who did it and why.
- **What the agent asserts is its own.** A step it settles records the agent as
  its signer with the evidence beside it, never a person's name on a thing that
  person did not do.
- **Where a run may act is its matrix** (ADR 0038), and the guard refuses
  a write on a surface the matrix keeps `off` before the class is asked. That is a
  scope, not a sixth class: a person's word cannot widen a surface the matrix keeps
  off, and a surface the matrix allows does not replace the word a class requires.

## Consequences

- The design does not depend on the model being right. It depends on what is
  reversible, what a person must say, and what the trace would reveal: a wrong
  classification costs a wrong filing, not a wrong send.
- Confirmation fatigue is the risk of the other direction, so class 1 never asks.
  What protects a reversible act is that it can be undone and that it is written
  down — not a prompt per step.
- The surfaces owe the reader the authority: an instruction that sends says so where it
  is read, an override names who and when, a step names who signed it.
- Class 2's preference — nothing disappears — has a cost the product accepts: the
  agent does not empty a mailbox, and a cleanup always ends with a person.
