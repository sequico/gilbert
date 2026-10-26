# ADR 0029 — The conversation is the chat, and a mail is a change

Status: Accepted

Implementation: Built. **The conversation is the group's own chat**
(`server/src/agent/tools/chat.ts`, reached through `say`): `say` posts a message,
`ask` posts a question and parks the run on a person's answer until
`QUESTION_TTL_MS` passes, and a
message that replies to the question a run recorded, sent by somebody other than
the agent, is that run's answer and is worked on as its own next step, rather than
as a change that opens a run of its own (`server/src/agent/loop.ts`,
`repliesToAuthor` in `server/src/shared/chat.ts`). **Nothing is sent by mail**: an
outward message leaves as a draft a person sends (ADR 0038), a question is
asked in the chat and nowhere else, and a mail **continues no run and authorises
nothing**: a run's answer is a reply in the conversation (`runAnsweredBy`), and a
mail opens one as a change like any other. The pass reads a mail for its sender,
its subject and its words (`readMessageForPass`,
`server/src/agent/tools/mail.ts`) and records them on the run; what a `From:` line
says about itself is never proof of anything.

## Context

The person the agent works for is not always in front of the application, and mail
reaches them from a phone. That boundary is the product's to accept: mail is a
channel anybody can write into, nothing in it is proved to be the word of the
person it names, and an agent that speaks outward on its own is the thing ADR 0038
refuses. So the conversation that can ask, answer and authorise is the chat.

A chat message and a mail still both carry a person's words into the same turn:
each is a change in the account, and what differs is only where the sentence sits.

## Decision

**One conversation, in the chat.** A question, an answer, an authorisation and a
report are the group's own chat (ADR 0004). Mail is the group's correspondence: a
message **arrives as a change** like any other and opens a run the instruction
covers, and nothing in a message is read as an answer or an authorisation.

- **A question is said in words.** A question says what it needs, with the values
  the agent proposes; an answer is a sentence — "sì, rispondi che non è
  possibile", "autorizzo override", "no, aspetta" — and the agent interprets it.
  No link to click, no signed token, no form.
- **A mail is data, not a word.** A message's sender is recorded as the message
  states it, and nothing it says about itself is evidence: the turn that decides
  the change reads its words fenced as data (ADR 0038), and the message can ask
  for nothing.
- **A message the agent wrote is not an instruction.** Nothing the agent composes
  leaves the account — what a run writes is a draft a person reads and sends (ADR
  0038) — so its own words never reach a turn.
- **The correlation is the channel's own.** A question is asked in the chat, where
  the node carries a `replyTo` (ADR 0004), because a chat is a flat list and two
  runs may be waiting in it at once; the message also carries the one line that
  tells the person a reply is what answers it, because a live question sat
  unanswered for hours beside a person who had no way of knowing. A mail answers
  no run, so there is no correlation to make in mail.
- **A question has a deadline** — 72 hours from the ask, in the run's own wait
  (`QUESTION_TTL_MS`, `shared/run.ts`), never a timer in a process. The answer is
  still the conversation's own event; the deadline is what a run does about a
  person who never answers: it goes on without the answer, with a step on the
  record saying what did not come, so no run waits for ever and no question sits
  on a list for months.
- **A run reports where its work is read**: its ending is said in the group's
  conversation, and the answer's own message id goes into the trace (ADR 0030).
- **The agent writes as itself and acts in the group's account.** Its own mail is
  its own; a message that belongs to the group's correspondence goes out as the
  group's identity (ADR 0005). It never writes as a person.

## Consequences

- The product must be usable entirely in text: an interaction that exists only in
  the UI is a defect, and the chat is where that is kept honest.
- An authorisation names the message it arrived in: a person can read back what
  they authorised.
- Mail from a stranger that asks for something is the ordinary case, and the
  design's answer is silence plus information — never action.
