# ADR 0029 — The conversation runs in chat and mail

Status: Accepted

Implementation: Built. **The conversation is the group's own chat**
(`server/src/agent/tools/chat.ts`, reached through `say`): `say` posts a message,
`ask` posts a question and parks the run on a person's answer with no date, and a
message that replies to the question a run recorded, sent by somebody other than
the agent, is that run's answer and is worked on as its own next step, rather than
as a change that opens a run of its own (`server/src/agent/loop.ts`,
`repliesToAuthor` in `server/src/shared/chat.ts`). **Nothing is sent by mail**: an
outward message leaves as a draft a person sends (ADR 0038), and a question is
asked in the chat and nowhere else. The reader for an answer that arrives in a
mailbox is still in the tree, for a run an older build parked on a mail question:
the answer is the message whose thread names it (`inReplyTo`, `references`), read
by `mailAnsweredBy` in `server/src/agent/loop.ts`, where the sender must not be
the group itself and the run that asked is the one whose question is in that
thread. Whether a message is a
person's word at all is `personWord` (`server/src/agent/trust.ts`), and the answer
read asks it before anything is taken from the message
(`readMessageForAnswer`, `server/src/agent/tools/mail.ts`, handed the roster of who may
speak). A **submission** is trusted on the server's record of **which account
authenticated**, and that address must be the sender: the hop is the one place
`From:` is not evidence. A message from **outside** is refused until the
`authserv-id` of a live server's own verdict is recorded — the probe the record
owes — because a header is as writable as a `From:` line.

## Context

The person the agent works for is not always in front of the application. Away
from it, the only channel that reaches them — and the only one they can answer
from a phone — is mail. An agent that only speaks in chat therefore serves the
person at their desk and nobody else.

For the agent's purpose mail and chat are the same thing: a place where a
sentence arrives from a person and a sentence goes back. Built as two features,
they would be two sets of rules for one act.

## Decision

**One conversation, two channels.** A question, an answer, an authorisation and a
report are the same in the group's chat (ADR 0004) and in mail; what changes is
where the sentence sits.

- **Everything is in words.** A question says what it needs, with the values the
  agent proposes; an answer is a sentence — "sì, rispondi che non è possibile",
  "autorizzo override", "no, aspetta" — and the agent interprets it. No link to
  click, no signed token, no form: a person away from the product has a mail
  client and nothing else.
- **Trust is the sender and the receiving server, in that order.** An instruction
  by mail is honoured only when the sender is a principal the installation knows
  — a user, a group mailbox — or is on the installation's own list, **and** the
  server that received the message vouches for how it arrived. That vouching has
  two shapes, and they differ by who was watching. A message handed over by
  another server is trusted only when the receiving server's own authentication
  result on it passes: that is where a forged `From:` lives, and refusing there is
  the point. A message the receiving server itself accepted from one of its own
  accounts — an account of the installation writing to a mailbox of the
  installation — never crossed a boundary and has no SPF, DKIM or DMARC to verify,
  so it is trusted on the server's own record of that submission, which is the
  **stronger** of the two facts and not the weaker one: nobody had to be believed,
  because the server was there. Anything else is information, never an
  instruction; and a message that reads like an instruction without that trust is
  answered as such, because a person who meant to instruct it deserves to know why
  nothing happened.
- **A message the agent wrote is not an instruction.** Nothing the agent composes
  leaves the account — what a run writes is a draft a person reads and sends (ADR
  0038) — so it signs no send. A message that carries `X-Gilbert-Run: <id>`,
  written by a build that did send, is never an instruction: the agent's own words
  cannot drive it, and two runs cannot ping-pong (`RUN_MARK`, `trust.ts`).
- **The correlation is the channel's own.** A question is asked in the chat, where
  the node carries a `replyTo` (ADR 0004), because a chat is a flat list and two
  runs may be waiting in it at once; the message also carries the one line that
  tells the person a reply is what answers it, because a live question sat
  unanswered for hours beside a person who had no way of knowing. In mail, the
  thread (`In-Reply-To`/`References`) is what names the run an answer belongs to,
  for a question an older build asked there.
- **A question has a deadline** — 72 hours from the ask, in the run's own wait
  (`QUESTION_TTL_MS`, `shared/run.ts`), never a timer in a process. The answer is
  still the conversation's own event; the deadline is what a run does about a
  person who never answers: it goes on without the answer, with a step on the
  record saying what did not come, so no run waits for ever and no question sits
  on a list for months.
- **A run waits where it asked and reports where it asked**: a question put in
  mail is answered in mail, and the answer's own message id goes into the trace
  (ADR 0030).
- **The agent writes as itself and acts in the group's account.** Its own mail is
  its own; a message that belongs to the group's correspondence goes out as the
  group's identity (ADR 0005). It never writes as a person.

## Consequences

- The product must be usable entirely in text: an interaction that exists only in
  the UI is a defect, and designing for the mail channel is what keeps the chat
  honest.
- The mail channel is exactly as trustworthy as the server's own account of how a
  message arrived, and not one bit more. What a real Stalwart writes on a message
  it received, and on one it took from an account of the installation, is owed as
  a probe before the channel is trusted, not after.
<!-- owed: arrival-record-shape -->
- An answer by mail is an authorisation with a message id in it: a person can read
  back what they authorised.
- Mail from a stranger that asks for something is the ordinary case, and the
  design's answer is silence plus information — never action.
