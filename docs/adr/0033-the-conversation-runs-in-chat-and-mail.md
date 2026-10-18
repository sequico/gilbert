# ADR 0033 — The conversation runs in chat and mail

Status: Accepted

Implementation: Built.
(`server/src/agent/tools.ts`: `chat.say`, `chat.ask`, `chat.read`, `chat.find`)
over the group's own chat (ADR 0005), with `replyTo` as the correlation and a
question leaving the run waiting on a person's answer with no date — and the
answer **continuing the run that asked for it**: a message that replies to the
question a run recorded, sent by somebody other than the agent, is that run's
answer and is worked on as its own next step, rather than a change that opens a
run of its own (`server/src/agent/loop.ts`, `repliesToAuthor` in
`server/src/shared/chat.ts`). **The mail half is built**: `mail.ask` (`server/src/agent/tools.ts`) sends a
question from the group's own identity to a **principal with access** to the group
— read from the directory (`groupMembers`), and nobody else, because a question to
anybody outside is an act outward and asking for it is not this tool's — and parks
the run on that message with no date. The answer is the message whose thread names
it (`inReplyTo`, `references`), read by `mailAnsweredBy` in
`server/src/agent/loop.ts`: the sender must not be the group itself, and the run
that asked is the one whose question is in that thread. Whether a message is a
person's word at all is `personWord` (`server/src/agent/trust.ts`), and the answer
read asks it before anything is taken from the message
(`readMessageForAnswer`, `server/src/agent/tools.ts`, handed the roster of who may
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
report are the same in the group's chat (ADR 0005) and in mail; what changes is
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
- **The agent signs its own sends.** Every message it sends carries
  `X-Gilbert-Run: <id>`, and a message that returns with that mark is never an
  instruction: the agent's own words cannot drive it, and two runs cannot
  ping-pong.
- **The correlation is the channel's own.** In mail, the thread
  (`In-Reply-To`/`References`); in chat, a `replyTo` on the node (ADR 0005),
  because a chat is a flat list and two runs may be waiting in it at once.
- **A run waits where it asked and reports where it asked**: a question put in
  mail is answered in mail, and the answer's own message id goes into the trace
  (ADR 0034).
- **The agent writes as itself and acts in the group's account.** Its own mail is
  its own; a message that belongs to the group's correspondence goes out as the
  group's identity (ADR 0007). It never writes as a person.

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
