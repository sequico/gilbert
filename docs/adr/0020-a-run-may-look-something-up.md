# ADR 0020 — A run may look something up

Status: Proposed

Implementation: Built. The closed catalogue, its validation and the lookup
renderer are in `server/src/agent/documents.ts` (`AgentLookup`,
`AGENT_LOOKUP_*`, `isAgentLookup`, `lookupLabel`); the answer that may name one
is in `server/src/agent/llm.ts` (`decideActions`); the bounded loop and the
reads are in `server/src/agent/executor.ts` (`planFor`, `lookupSlice`, the
`mail`/`message`/`mailboxes`/`labels`/`files`/`file`/`chat` readers); and what a
run read rides its job and its audit line (`AgentJob.lookups`,
`AgentAuditEntry.lookups`).

## Context

A run reads one context, built by `contextFor` before the deciding call, and
then asks the model once: the trigger's item, the conversation around it, the
group's notebook and standing instruction, and — when a person's chat message
names a folder — one slice of that folder. Everything a run might need must
therefore be in the prompt already, and the model has no way to ask for what is
not.

That is the hole behind "it has no context". A member asks what the starred
messages are about, and the run's context carries neither the starred messages
nor any way to reach them; the model, asked to decide, reasons about a fact it
cannot check and answers that starring lives in each member's client. The stars
are in fact the group's own `$flagged` keyword, in the account the agent
already holds.

ADR 0006 decision three settles where new context belongs — distilled and
infrequent in the stable head, or named and narrow in the volatile tail, never
raw and wholesale — and leaves the named half to build. The folder slice is
that half attempting to exist before the model can ask: it is decided by a
pattern in the person's message, and it hands over headers rather than text,
so a run told to read a folder still cannot answer about what is in it.

## Decision

**The deciding call may answer with a lookup instead of actions, and the run
performs it and asks again.**

One answer is one of two shapes:

```
{"lookup": {"kind": "mail", "unread": true}}
{"summary": string, "confidence": number, "actions": [...]}
```

A lookup names something to read from a **closed catalogue**; the run performs
it as a read in the group's own account, appends what came back to the run's
context, and calls the model again with the same head and the widened tail. The
run decides once, at the end, and everything after that — the review gate, the
allowlist, the audit — is untouched.

The catalogue is closed and the server validates every request against it. The
model never writes a query, a filter or a JMAP method: it chooses a kind and its
parameters, and nothing else. The catalogue is **the group's own state**, not
one label of it, because the context a butler needs is the group's:

- `mail` `{ mailbox?, keyword?, from?, text?, unread?, limit? }` — the newest
  messages matching what it says, **headers and ids only**.
- `message` `{ id }` — one message's own text, by the id a `mail` lookup listed.
- `mailboxes` `{}` — the account's folders, so a run can name one.
- `labels` `{}` — the group's label catalog.
- `files` `{ folder? }` — the group's visible Files, at the top level or in a
  folder: names, kinds and sizes.
- `file` `{ path }` — one file's own text, by the path a `files` lookup listed.
- `chat` `{ text?, from?, limit? }` — the group's chat, narrowed by sender or by
  what a message says.

**The listing is an index and the read is bounded.** What lists hands over names,
ids and headers; what reads hands over one item's own text. That split is what
keeps a broad question ("what is unread in the inbox") from paying for every
body: the index is cheap, and the content is bought only for the one item the
run actually needs. A mail listing therefore carries the id a `message` lookup
names back, and a Files listing the path a `file` lookup names back.

A lookup is a **read** and nothing else. It writes no document, takes no claim,
changes no state and is not an action: it is not offered against the capability
allowlist and it cannot be an effect on its own.

**Every bound is stated, and the model is told it.** A run may look things up
`AGENT_LOOKUP_ROUNDS` times; each listing hands over at most
`AGENT_LOOKUP_MESSAGES_MAX` items, and each read at most `AGENT_LOOKUP_TEXT_MAX`
characters of one item's text. On the last call the prompt says the lookups are
spent, so the answer is a decision rather than a request the run would refuse. A
lookup whose kind this build does not know, or whose parameter is missing or of
the wrong shape, is a malformed answer and fails the run the same way an unknown
action does.

**What a run looked up is part of its record.** The job carries the lookups it
made, in order, and every audit line written from that job carries them too, so
"what did this run read" is a question about a document rather than about a log.

**The prompt is built for the provider's cache.** A lookup's result is appended
to the volatile tail, and the budget the call is given travels in that same
tail rather than in the system message: the system message — the data-not-
instructions sentence, the capability catalogue, the lookup catalogue, the
installation's rules, the group's facts and its standing instruction — is
byte-identical on every call of a run. A head that said "one lookup left" would
make the second call a cache miss on the whole preamble, which is exactly the
cost this architecture exists to avoid (ADR 0003, ADR 0006).

The same reasoning bounds *how much* is fetched: nothing broad is ever attached,
the notebook stays in the cached head because it changes rarely, and a run pays
for one listing plus at most one read of what it names, not for a mailbox.

## Consequences

- A butler can answer about the group's mail it was not handed: it asks. The
  question a member asks in words becomes a read whose kind the server chose
  the vocabulary for, and the catalogue covers the group's mail, its labels, its
  folders, its Files and its chat alike.
- The chat's own pre-filtered folder slice stays what it is — a person who names
  a folder gets it without the run spending a round — and the loop is what
  covers everything the pattern did not anticipate.
- Cost is bounded by construction: a run's extra calls are at most
  `AGENT_LOOKUP_ROUNDS`, each answer is capped by the installation's own token
  ceiling, listings carry no bodies, and each read is capped twice. The meter
  counts every call, so the price of a butler is readable.
- The lookups are reads the agent's grant already allows. Nothing here widens a
  run's permissions: the allowlist still bounds what it may *do*, and a lookup
  can only ever put more data in front of the model.
- A model that asks for lookups for ever is bounded rather than trusted: the
  round cap is the whole answer, and the last call is told so.
- The published rule schema does not carry the lookup vocabulary: it is the
  run's decision surface, not the automation document's shape, and the editor
  has nothing to offer from it.

## References

- ADR 0003 — the run's shape, the deciding call, the review gate, the prompt's
  fixed order and why the stable head is cache-friendly
- ADR 0006 — one enabled automation per trigger; decision three, the two speeds
  of context and what building the named tail costs
- ADR 0019 — the three levels of prose an agent carries
- `server/src/agent/documents.ts` — `AgentLookup`, `AGENT_LOOKUP_*`,
  `isAgentLookup`
- `server/src/agent/llm.ts` — `decideActions`, the lookup answer and the prompt
  that offers it
- `server/src/agent/executor.ts` — `planFor`, the bounded loop, the lookup
  reads and their rendering
