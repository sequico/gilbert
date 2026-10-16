# ADR 0031 — The agent's tools are described and composable

Status: Accepted

Implementation: Not built. The catalogue and the loop that reads it are to be
written with `gilbertagents`; nothing in the tree carries them.

## Context

An agent that acts inside a company's mail, file storage, chat and knowledge has
to work in that company's own vocabulary — bookings, containers, shippers,
whatever its KB calls them — and those vocabularies are unbounded and are written
in prose by the company itself. A catalogue of business actions compiled into
the product would need code for every practice in every installation: a product
that does only what its authors thought of, and a release for every customer
that does something else.

What is bounded is the surface the agent acts on. Stalwart offers a closed set of
objects through JMAP — messages, mailboxes, keywords, files, folders, chat nodes
— and Gilbert keeps a few documents of its own in an app folder: KB pages,
workorders, runs. Every practice in every company is some sequence of reading
and writing those.

## Decision

The agent's capabilities are **tools**: a small set, each with a description and
typed arguments, each acting on one of those objects.

- **The model chooses the tools, and the order.** It reads what each one is for,
  acts, looks at the result, and chooses again. There is no list of permitted
  business actions and no plan compiled at write time.
- **The agent works on five surfaces, and has all of them.** They are the
  group's **chat**, its **mail**, its **KB** — its pages and the **checklist
  templates** among them — and its **workorders**, with its own **runs** beside
  them as the record of what it did. Every one is both readable and writeable
  within the authority classes (ADR 0032): an agent that could file mail but not
  read a template, or settle a workorder step but not say so in the chat, would be
  half of the product. They are the objects the catalogue is built over.
- **A tool does a task, not a step of the protocol.** No tool mirrors a JMAP
  method: there is one that finds messages by the search grammar the mail client
  already speaks, one that reads a page, one that files a message, one that puts
  a document where a convention says, one that says something in the
  conversation, one that asks a person, one that settles a step of a workorder,
  one that proposes a change to a KB page. Two tools that do one thing are a
  defect: they make the choice a lottery.
- **A tool's description is the product's interface to the model** and is written
  and reviewed as such, and a tool that returns more context than the caller
  needs is a defect like any other.
- **The catalogue grows freely.** A new tool over an object the product already
  works on is not an architectural decision: it lands with its description, its
  test and the sentence in `FEATURES.md`. What is an architectural decision is a
  new **object** — a Stalwart surface nothing works on today — or a change to the
  authority classes (ADR 0032).
- **The agent runs with a budget**: steps, time and model calls, so a loop that
  cannot finish stops and says so (ADR 0034).
- **One model serves the installation** — provider, model and a write-only key,
  chosen in Administration — and an installation with no model has no agent.
  Which model a kind of work deserves is not a question the administration is
  asked.

## Consequences

- A company's practice arrives as prose in its KB and as workorders, never as
  code: the product does not grow a feature per industry.
- What bounds the agent is the authority classes and the reversibility it reaches
  for (ADR 0032), not the catalogue. The catalogue's job is to make the right way
  easy, not to make the wrong one impossible.
- The tool set is where the agent's ergonomics live: too many tools, or two that
  overlap, degrade it the way a bad API degrades a client, and that is a defect
  with a test rather than a taste.
- The agent carries no capability allowlist of its own, and neither does a rule.
- Every tool is exercisable against the mock, and the mock is what must agree
  with a real Stalwart.
