# ADR 0027 — The agent's tools are described and composable

Status: Accepted

Implementation: Built.
each tool names its arguments, its authority class, the surface it writes and
what it spends, the
arguments are validated before its executor runs, and the half a reading caller
is handed (`readingTools`) is the one that cannot write. The installation's one
model is `server/src/agent/model.ts`, and it is chosen at Administration →
Installation (`web/src/views/admin/AdminInstallation.tsx`, whose fields write
the document's `agent.provider`): the key is write-only in the installation's
own document (`shared/installation.ts`, `installationAdmin.ts`) — a save that
states no key, or states an empty one, keeps the stored one, and the `null` a
save states for a provider that needs none clears it — the call is one
OpenAI-compatible chat completion with the zero-retention
opt-out and the operator's private-address switch, the **decision turn** answers
which rules apply and what the facts are over the reading tools, and the
**choosing turn** (`chooseStep`) answers a plan of one or more steps — each a
call and what it waits on — over the whole catalogue. The loop that
works a run is `server/src/agent/loop.ts`: its budget is the ceilings on the
steps, the model calls and the milliseconds a run may spend, and a run that
reaches one ends `out-of-budget` saying so. The agent is started by the server's
own boot (`server/src/index.ts`, `server/src/agent/supervisor.ts`): it runs on
the installation's model and works the groups its principal holds. A pass is
asked for **when Stalwart pushes a change**: the server holds its own event
stream to Stalwart with the Master's credential (`server/src/agent/wake.ts`),
open and independent of any browser, and a `StateChange` on it is the reason
for a pass. The interval is the floor,
not the clock: **ten seconds** without a working stream, **thirty** while one is
connected — a pushed change is immediate and a dated wait kicks a pass as it
comes due — and a stream that drops is reopened with a growing pause while the
interval covers the gap. The groups are **resolved from the mail server on every pass**,
so a group the Master is added
to is worked by the next one with no restart, and a Master who works no group at
this moment is an idle agent, said once (`supervisor.ts`), rather than one that
does not exist. The catalogue writes in the group's own
account and signs its own acts: `mail.draft` drafts a **reply to everyone** into
the group's Drafts — addressed from the group's own identity, which must exist,
threaded and marked `$draft`, reaching nobody — `workorder.settle` settles a step
of a workorder as the agent (`gilbert-agent`, ADR 0024), and
`knowledge.propose` writes a page's **draft** for a person to approve
(ADR 0020). A document in Files is read **inside** (`files.read`): a PDF's text
layer, a Word file, a spreadsheet, an OpenDocument or a text file, through
`server/src/documentText.ts`. An attachment of a message is read the same way
(`mail.readAttachment`): one reader, whether the file came in Files or with a
message. An image, or a **page of a PDF with no text layer**, is transcribed by
the installation's own model (`readImage`, an image part of the user turn), and a
scanned page is first rendered to a bitmap by pdfium and encoded as a PNG
(`SCANNED_PAGES_MAX` pages per document), because no OCR engine lives in this
tree.

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
  decides what the change needs, and asks for **one or more calls in a single
  answer** — several tools, or the same tool twice — which the loop then makes
  **together where they are independent**, shows it what each answered, and asks
  again. A call that needs what another answered says so and waits for it
  (ADR 0030). There is no list of permitted business actions and no plan compiled
  at write time.
- **The agent works on every surface the group's account offers, and has all of
  them.** They are the group's **chat**, its **mail**, its **files**, its **KB**
  — its pages and the **checklist templates** among them — its **calendars**,
  and its **workorders**, with its own **runs** beside them as the record of
  what it did. Every one is both readable and writeable
  within the authority classes (ADR 0028): an agent that could file mail but not
  read a template, or settle a workorder step but not say so in the chat, would be
  half of the product. They are the objects the catalogue is built over.
- **The agent works in a group's account and never in a person's.** Every
  surface above is the group's, and so is everything the agent reads or writes:
  an installation's agent is what carries a group's work, and a personal account
  — which no group's work lands in — has none of it, not even the labels that
  name the agent's acts.
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
  authority classes (ADR 0028).
- **A tool that writes names the surface it touches.** The run's rule matrix
  decides whether that run may write it (ADR 0031), and the guard refuses the
  write on a surface the rule keeps `off`; the catalogue itself decides nothing
  about authority.
- **The agent runs with a budget**: steps, time and model calls, so a loop that
  cannot finish stops and says so (ADR 0030).
- **One model serves the installation** — provider, model and a write-only key,
  chosen in Administration — and an installation with no model has no agent.
  Which model a kind of work deserves is not a question the administration is
  asked.

## Consequences

- A company's practice arrives as prose in its KB and as workorders, never as
  code: the product does not grow a feature per industry.
- What bounds the agent is the authority classes and the reversibility it reaches
  for (ADR 0028), not the catalogue. The catalogue's job is to make the right way
  easy, not to make the wrong one impossible.
- The tool set is where the agent's ergonomics live: too many tools, or two that
  overlap, degrade it the way a bad API degrades a client, and that is a defect
  with a test rather than a taste.
- The agent carries no capability allowlist of its own: a rule's matrix says
  where a run may act (ADR 0031), and the authority classes still decide what it
  may do there.
- Every tool is exercisable against the mock, and the mock is what must agree
  with a real Stalwart.
- The wake is the server's own event stream: a StateChange asks for a pass, and
  the interval is the floor for a mail server that offers none and for the
  pause while a dropped stream is reopened — ten seconds without a working
  stream, thirty with one, because a dated wait kicks a pass directly. A burst
  of changes is one pass, and a change that arrives while a pass runs asks for
  one more.
- The provider's contract is pinned against a stub, and **no real provider has
  answered it**: the first live call is owed before the model path is trusted.
<!-- owed: model-provider-live -->
