# ADR 0040 — Outbound calling is a bounded campaign, not a customer record

Status: Proposed

Implementation: Not built. No area, route, document or view of this area
exists: `shared/areas.ts` names eight areas and `outbound` is not one of them,
and the `gilbert` app folder holds no campaign, row or call log. The primitives
the decision rests on are built and are named in its Context: the app folder's
documents (`server/src/appFolder.ts`), the group's contact cards (JSContact for
`organizations`, labelled `phones`, `titles` and `relatedTo`), the workorder's
root, parts and states (`server/src/workorder/`, ADR 0036), the claim a document is
taken with (`server/src/agent/claim.ts`, ADR 0032), the knowledge
base's two tiers (`server/src/knowledge/scope.ts`), and the agent's declared
areas (ADR 0038).

## Context

Every company runs bounded outbound calling: a list of numbers, one reason to
call it, a script, a handful of outcomes and a handoff. Booking appointments,
qualifying a list for a sales team to work afterwards, asking suppliers for a
quote, and proposing something to customers already known are the same
operation under different words, and it is the one commercial activity that is
an operation rather than a relationship: it starts, it runs for a window and it
closes.

The work is done by people who must know what was already said. A company is
called for one thing in October and for another in November, by two colleagues,
and the second caller who does not know the first call repeats it — that is the
failure this area exists to prevent. A person carries several numbers (mobile,
office, switchboard, WhatsApp), a company is often called without knowing whom
to ask for, and the person competent for a subject is discovered during the call
rather than before it.

Gilbert already holds identity: a group's own contacts are JSContact cards in
the group's account, with organizations, labelled phones, titles and roles, and
relations between a person and the company they work at. What the installation
does **not** hold is a relationship: no stage, no value, no forecast, no owner of
an account. That line is the whole difference between this area and the CRM the
company already runs.

## Decision

**Outbound is the fifth block of the product — `gilbertoutbound` — and an area of
the agent's** — `outbound` in the areas an instruction may declare, documents
inside the group's own app folder, and no second database, no second identity and
no second permission model.

### The directory is the group's contacts

Identity is not rebuilt. The company is a contact card of the organization kind,
the person is an individual card whose labelled phones carry every number known
for them and whose `relatedTo` names the company. **A card is created at the first
call, never by an import**: an imported number with no card stays a row, the
person discovered on a call becomes a card at that moment, and a list of three
hundred numbers never becomes three hundred entries in the group's address book
and in every member's phone. Until that call the row carries what the file said —
a number, an optional company and name — and nothing is left behind by a list
nobody dialled.

**The call log lives on the person, and on the company when the person was not
known.** Opening a card shows what was said to it: when, by whom, in which
campaign, with which outcome and note — the card a caller opens in November
carries what a colleague said in October. A call to a switchboard that named
nobody is the company's own history until a person is attached to it.

### Two lists, and they are not the same kind of thing

A **campaign's list** is its rows: it never exists without the campaign that owns
it and never outlives it, so re-running a list is a new campaign with the same
file rather than the same list reused. The **do-not-call list** is the
installation's own, durable and one for every group — the only list that lives on
its own, because a promise not to call is not a campaign's to keep.

### Four objects, and nothing else

- a **campaign** — the root document. One sentence of purpose, the script it
  points at, the outcome vocabulary it admits, the window it runs in, and the
  group it belongs to. Its list is its rows and is not a document beside it.
  Closing a campaign is a state, not a deletion.
- a **row** — a part document of its own, so two members of the group write
  without touching each other. It carries the number to dial and, once a card
  exists for it, the card it calls; and its state, its owner and its next call. A
  row may point at a company and no person: that is the ordinary switchboard case,
  not a defect.
- **Today** — not stored: the queue is the view of the rows that are mine or
  due, and it is where the work happens. The call is placed from the person's own
  phone.
- a **handoff** — not an object: an outcome selects rows into a screened list
  that leaves through Gilbert's own surfaces, a calendar event for the
  appointment, a message to the receiving group, a file. It carries the row's
  outcome and note, who called and when, the discovered person and the routing
  note that says who is competent for what. The product's job ends when the list
  is closed and the subset is handed over.

### The laws this area is held to

- **The row dies with the campaign; the card and its calls do not.** The work
  item is bounded, the identity and the fact of the conversation are not — they
  are what makes the next campaign intelligent.
- **The directory knows who someone is and what was said. It never decides what
  to do, and nothing here makes a call.** No stage, no value, no forecast, no
  owner of an account, no follow-up cadence, no pipeline, no quote, no invoice, no
  product catalogue, no customer 360, no report suite; no dialer, no recording, no
  telephony. A request for one of these is a request for the CRM the company
  already runs, or for the phone in the caller's pocket.
- **The vocabulary belongs to the campaign.** Outcomes are named per campaign
  ("appointment booked", "documents requested", "not the right material",
  "not interested"), because one central taxonomy would name one company's work
  and exclude the others'.
- **The do-not-call list is the installation's, not the campaign's.** It is
  checked against every number a card carries, not against the string that was
  pasted: a person called twice by two teams is the failure this product cannot
  afford.
- **A row is claimed before its number is dialled**, so a list is never called
  twice at once — the conditional write and the lapsed lease the installation's
  own claim already uses (ADR 0032), one row at a time.
- **A number has one form: E.164 and nothing else.** `+` and the country code
  followed by digits, no space, no punctuation, no extension, no trunk zero, no
  note: the canonical string is the number's identity, and two rows that carry it
  are the same number however they were written when they arrived. **The country
  lives in the number**, read against one table of calling codes and the national
  lengths each of them has — never a country chosen for the installation and never
  a group's default, because one group calls Zambia, Rwanda and Tanzania while
  another calls China, Bulgaria and Turkey, and the number is what says which.
  Every other form is normalised on arrival — a leading code the table knows and a
  length that country has, a trunk zero dropped, an extension and any prose moved
  to the row's note — and a number the table cannot place is refused and counted,
  never guessed and never stored half-written. The do-not-call list is matched on
  that same string.
- **The area is the agent's like the others.** Reading a card's calls is free;
  proposing the note a call leaves behind is a write, and only a group whose
  instruction declares the area may receive it.

**`gilbertoutbound` is a block for the same reason the other four are** — an
area of the product with a boundary of its own — and what it does not hold is what
already has an owner: the identity is Stalwart's, the access is the group's, the
durable document is the `gilbert` app folder, the contact card is the mailer's,
the model work is `gilbertagents`, and the pass that wakes a due list is
`gilbertserver`.
`README.md` defines the five blocks and this record does not restate the
definitions. Its agent-facing name is `outbound`, the plain noun the rest of the
area vocabulary uses: a block is how the product is divided, an area is what a run
may use, and the two registers never stand in for each other.

## Consequences

The import is the surface that decides adoption, not the tab: a hundred calls
begin as a paste or a file, normalised to the one canonical form and resolved
against the group's cards and the installation's do-not-call list, with the counts
said out loud — matched to a card, new, duplicated within the list, refused. An
import writes no card and no contact: it writes rows. A form filled once per
number is a campaign nobody runs. A form that arrives without its `+` is read
against that same table — a leading code it knows, a length that country has — so
nothing about the installation has to be chosen before a campaign can run; a
number the table cannot place is refused and counted.

Resolution by number wants an index the group keeps, because asking the mail
server to find a card by phone is not the cheap read a hundred-row paste needs;
the index is rebuilt from the cards and never becomes a second truth.

The call log is a bounded window per card, oldest trimmed: a card is read far more
often than it is written, and a log that grows without limit turns opening a
contact into a large read.

The handoff must be takeable: copy, CSV or a message, with the discovered person
and the routing note included, because a screened list the receiving team cannot
consume is a campaign that produced nothing.

The phone is the first screen, not a smaller version of a desktop one: a queue, a
number, a script, three outcomes, the next call — and one more act, attaching the
person the call discovered.

What the area cannot do without is an agent that reads a card it just did not
write: a document cache that misses a replaced document makes the note proposed
after a call describe the call before it, so the freshness a document's own stamp
carries is a prerequisite of this area rather than a refinement of it.
