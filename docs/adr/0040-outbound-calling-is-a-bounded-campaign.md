# ADR 0040 — Outbound calling is a bounded campaign, not a customer record

Status: Proposed

Implementation: Not built. No area, route, document or view of this area
exists: `shared/areas.ts` names eight areas and `outbound` is not one of them,
and the `gilbert` app folder holds no campaign or row. The primitives the
decision rests on are built and are named in its Context: the app folder's
documents (`server/src/appFolder.ts`), the workorder's root, parts, states and
claim (`server/src/workorder/`, ADR 0036), the knowledge base's two tiers
(`server/src/knowledge/scope.ts`), and the agent's declared areas (ADR 0038).

## Context

Every company runs bounded outbound calling: a list of numbers, one reason to
call it, a script, a handful of outcomes and a handoff. Booking appointments,
qualifying a list for a sales team to work afterwards, asking suppliers for a
quote, and proposing something to customers already known are the same
operation under different words, and it is the one commercial activity that is
an operation rather than a relationship: it starts, it runs for a window and it
closes.

Gilbert is for operations, not for customer relationships. The record a CRM
keeps — a person who stays, a pipeline that grows, quotes and products that
accumulate — is the thing this product deliberately does not own. What a
campaign produces is a **screened list that leaves**, worked further in whatever
CRM the company already has.

The infrastructure it needs already exists and is the installation's own: a group
owns its data and its members reach it through Stalwart's own access; an
account's `gilbert` app folder holds every durable document; the workorder shows
a record collection with states, parts and a claim; the knowledge base shows a
two-tier document area reached by membership; and the agent already works in a
declared set of areas.

## Decision

**Outbound is the fifth block of the product — `gilbertoutbound` — and an area of
the agent's** — `outbound` in the areas an instruction may declare, a document
collection inside the group's own app folder, and no second database, no second
identity and no second permission model.

Four objects, and nothing else:

- a **campaign** — the root document. One sentence of purpose, the script it
  points at, the outcome vocabulary it admits, the window it runs in, and the
  group it belongs to. Closing a campaign is a state, not a deletion.
- a **row** — a part document of its own, so two members of the group write
  without touching each other. The number, the little identity needed not to
  mistake the person, its campaign, its owner, its state, its next call, and the
  calls it has taken inside a bounded window. No row outlives the campaign that
  created it.
- a **session** — not stored: the queue is the view of the rows that are mine or
  due, and it is where the work happens. The call is placed from the person's own
  phone; the product has no telephony and acquires none.
- a **handoff** — not an object: an outcome selects rows into a screened list
  that leaves through Gilbert's own surfaces, a calendar event for the
  appointment, a message to the receiving group, a file. The product's job ends
  when the list is closed and the subset is handed over.

The laws this area is held to:

- **The row dies with the campaign.** There is no customer master, no pipeline,
  no quote, no product catalogue and no per-person history that survives the
  campaign's window. The gravity this decision resists is a row becoming a
  person and a campaign becoming a funnel.
- **The vocabulary belongs to the campaign.** Outcomes are named per campaign
  ("appointment booked", "documents requested", "not the right material",
  "not interested"), because one central taxonomy would name one company's work
  and exclude the others'.
- **One list of numbers not to call, for the installation.** It is written by any
  campaign and read by all of them: a person called twice by two teams because
  each kept its own list is the failure this product cannot afford.
- **A row is claimed before its number is dialled**, so a list is never called
  twice at once — the same act of taking a piece of work the workorder already
  knows.
- **The area is the agent's like the others.** Reading a row's context is free;
  proposing the note a call leaves behind is a write, and only a group whose
  instruction declares the area may receive it.

Out of scope, and deliberately: dialers, telephony, recording, pipelines,
quotes, invoices, product catalogues, a customer 360, report suites and any
surviving anagraphic record. A request for one of these is a request for a CRM,
and the answer is the CRM the company already runs.

**`gilbertoutbound` is a block for the same reason the other four are** — an
area of the product with a boundary of its own — and it owns the campaign, the
row, the session and the handoff, and nothing else: the identity is Stalwart's,
the access is the group's, the durable document is the `gilbert` app folder,
the model work is `gilbertagents` and the pass that wakes a due list is
`gilbertserver`'. `README.md` defines the five blocks and this record does not
restate the definitions. Its agent-facing name is `outbound`, the plain noun the
rest of the area vocabulary uses: a block is how the product is divided, an area
is what a run may use, and the two registers never stand in for each other.

## Consequences

The list is the read that costs: a campaign's rows are documents, so the area
needs an index the campaign keeps and a listing that reads it rather than
opening hundreds of documents — the shape `workorders/listing.ts` already
carries.

Import is the surface that decides adoption, not the tab: a hundred calls begin
as a paste or a file, normalised and de-duplicated against the installation's
do-not-call list, and a form filled once per number is a campaign nobody runs.

The phone is the first screen, not a smaller version of a desktop one: a queue,
a number, a script, three outcomes, the next call. A campaign worked only from a
desk is a campaign that stops being worked.

Durable state costs one blob write per call rather than one per campaign, which
is the reason a row is a document and not a field in the root: the write is
small, the two callers of one list never collide, and the campaign document
changes only when the campaign does.

What the area cannot do without is an agent that reads a row it just did not
write: a document cache that misses a replaced document makes the note proposed
after a call describe the call before it, so the freshness a document's own
stamp carries is a prerequisite of this area rather than a refinement of it.
