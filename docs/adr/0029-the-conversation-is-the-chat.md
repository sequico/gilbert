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
asked in the chat and nowhere else, and a mail **continues no run**: a run's
answer is a reply in the conversation (`runAnsweredBy`), and a mail opens one as
a change like any other. What a mail is trusted for is `personWord`
(`server/src/agent/trust.ts`), read on every received message
(`readMessageForAnswer`, `server/src/agent/tools/mail.ts`). A **submission** is
trusted on the server's record of **which account
authenticated**, and that address must be the sender: the hop is the one place
`From:` is not evidence. A message from **outside** is read as nobody's word
until the `authserv-id` of a live server's own verdict is recorded — the probe the
record owes — because a header is as writable as a `From:` line.

## Context

The person the agent works for is not always in front of the application. Away
from it, the only channel that reaches them — and the only one they can answer
from a phone — is mail. An agent that only speaks in chat therefore serves the
person at their desk and nobody else.

For the agent's purpose a chat message and a mail both carry a person's words into
the same turn: each is a change in the account, and what differs is only where the
sentence sits. The conversation that can ask, answer and authorise is the chat.

## Decision

**One conversation, in the chat.** A question, an answer, an authorisation and a
report are the group's own chat (ADR 0004). Mail is the group's correspondence: a
message **arrives as a change** like any other and opens a run the instruction
covers, and nothing in a message is read as an answer or an authorisation — its
words are data to the turn that decides it, fenced as such (ADR 0038).

- **A question is said in words.** A question says what it needs, with the values
  the agent proposes; an answer is a sentence — "sì, rispondi che non è
  possibile", "autorizzo override", "no, aspetta" — and the agent interprets it.
  No link to click, no signed token, no form.
- **Trust is the sender and the receiving server, in that order.** A message's
  sender is an address the installation knows — a user, a group mailbox — or one
  on the installation's own list, **and** the server that received the message
  vouches for how it arrived. That vouching has
  two shapes, and they differ by who was watching. A message handed over by
  another server is trusted only when the receiving server's own authentication
  result on it passes: that is where a forged `From:` lives, and refusing there is
  the point. A message the receiving server itself accepted from one of its own
  accounts — an account of the installation writing to a mailbox of the
  installation — never crossed a boundary and has no SPF, DKIM or DMARC to verify,
  so it is trusted on the server's own record of that submission, which is the
  **stronger** of the two facts and not the weaker one: nobody had to be believed,
  because the server was there. Anything else is information, never an
  instruction.
- **A message the agent wrote is not an instruction.** Nothing the agent composes
  leaves the account — what a run writes is a draft a person reads and sends (ADR
  0038) — so it signs no send. A message that carries `X-Gilbert-Run: <id>`,
  written by a build that did send, is never a person's word: the agent's own
  words cannot drive it (`RUN_MARK`, `trust.ts`).
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
- The mail channel is exactly as trustworthy as the server's own account of how a
  message arrived, and not one bit more. What a real Stalwart writes on a message
  it received, and on one it took from an account of the installation, is owed as
  a probe before the channel is trusted, not after.
<!-- owed: arrival-record-shape -->
- An authorisation names the message it arrived in: a person can read back what
  they authorised.
- Mail from a stranger that asks for something is the ordinary case, and the
  design's answer is silence plus information — never action.
