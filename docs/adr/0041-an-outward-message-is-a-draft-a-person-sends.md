# ADR 0041 — An outward message is a draft a person sends

Status: Proposed

Implementation: Built. The `draft` job (`server/src/agent/tools/jobs.ts` →
`mail.draft`/`mail.editDraft` in `agent/tools/mail.ts`) composes a reply into the
group's own Drafts; no tool in the catalogue submits a message. ADR 0038 dropped
`mail.send` and `mail.ask`, and a question is asked with `say` (`action: ask`) in
the conversation.

## Context

A run can read a message that was written by somebody outside the group, and that
message can say anything — including "send this to me". The one act whose
consequence cannot be undone is a message that leaves: it reaches a person who is
not in the group, in the group's name, and no later step can call it back. A tool
that submits is therefore a tool a document can talk the agent into using, and
every defence around it is a filter that will one day miss.

The product's answer before this record was a submission tool that a person's
recorded word — or a group's declaration that it sends — licensed. That bound one
message to one word, but it still made the agent the sender: the word was given
before the words were written, and the thing that left could differ from the
thing the person pictured.

## Decision

**A run writes a draft; a person sends it.**

- The `draft` job composes a reply to everyone in the group's own Drafts — the
  sender in To, the rest of the message's recipients in Cc, the group's own
  addresses left out, the thread carried, marked `$draft`. It never submits.
- **No tool submits a message.** The catalogue holds no submission endpoint, and
  adding one would be a new decision rather than a field.
- The instruction's `sends` declaration says a draft is **wanted**, not that one
  is sent: it is the group saying outward words are part of its work, and the
  draft is the most it obtains.
- A question is asked in the conversation (`say` with `ask`), which parks the run
  on a person's answer; it is never asked by mail, because a mail that leaves is
  the act this record forbids.
- A person reads the draft in their own client, changes what they mean to, and
  sends it with the client's own submission. The agent's part ends at the draft.

## Consequences

- **The worst a malicious mail obtains is a draft somebody reads.** The
  structural defence of ADR 0038 — what arrives is data, the grants bound the act
  — has a second wall behind it: even an act inside the grants cannot reach
  outside the group without a person.
- The agent cannot answer a correspondent on its own. Work that a group wants
  answered within the hour is answered by a person reading the draft; the product
  chooses that over an agent that speaks in the group's name unsupervised.
- The draft is the record: what the run wrote is in the account's Drafts, beside
  the run that wrote it, so what a person sends can be compared with what the
  agent proposed.
- The `sends` declaration loses its outward meaning and keeps only "a draft is
  wanted"; a surface that showed it as a licence to send is wrong and is fixed
  where it is drawn.
