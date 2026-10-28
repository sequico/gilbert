# ADR 0040 — Outbound calling is a bounded campaign

Status: Proposed

Implementation: Partly built. The documents, their paths and their validators
are `server/src/shared/outbound.ts`; the one number form, the paste, the queue,
the two acts on a row, the documents on disk and the group's door are
`server/src/outbound/`, answered by `server/src/routes/outbound.ts` and drawn by
`web/src/views/outbound/TodayView.tsx`; `server/src/outbound.test.ts` drives the
door, the import, the do-not-call list and the two acts against the mock. The area
acts as the caller and never as the installation's agent, which is what lets a
group that exists for outbound work alone be worked at all.

A number the group's cards already carry is matched at the import through an index
beside the campaigns, rebuilt whenever the card store's state has moved
(`server/src/outbound/cards.ts`). The first call creates the card, carrying the
number and the words the paste had about it, and writes the call into the card's own
bounded window (`outbound/calls/<cardUid>.json`, drawn by
`web/src/views/contacts/CardCalls.tsx` on the card). A campaign past its window with
rows still open is a finding the campaign list reports, and closing is an act that
either keeps the rows with the campaign or carries them into a successor
(`closeCampaign`). A campaign pins the revision of its script and Today shows those
words as a row is taken (`server/src/outbound/script.ts`). The handoff leaves as a
file of the rows that ended with one outcome.

Future improvements, named rather than left implicit: the handoff leaves as a file
and nothing else, so an appointment in the calendar and a message to the receiving
group are not built and are not owed by this record; and the area is not one of the
agent's — `shared/areas.ts` names none of it, no instruction may declare it, and the
agent neither reads a card's calls nor proposes a note. Each of those is a change
with a record of its own if a group ever needs it.

Owed the live probe it depends on: a member of a group the installation's agent
holds no grant on, reading and writing that group's outbound folder — the mock
answers a member with full rights, so it cannot demonstrate that.

## Context

Every company runs bounded outbound calling: a list of numbers, one reason to
call it, a script, a handful of outcomes and a handoff. Booking appointments,
qualifying a list for a sales team to work afterwards, asking suppliers for a
quote, and proposing something to customers already known are the same
operation under different words, and it is the commercial activity that behaves
most like an operation: it starts, it runs for a window and it closes.

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
does **not** hold is a relationship, and that is the line this area must not
cross.

## Decision

**Outbound is the fifth block of the product — `gilbertoutbound`** — documents
inside the group's own app folder, and no second database, no second identity and
no second permission model. It is nobody's area in the agent's vocabulary: the
calls are made by people, and nothing here is a run's to propose.

### The directory is the group's contacts

Identity is not rebuilt. The company is a contact card of the organization kind,
the person is an individual card whose labelled phones carry every number known
for them and whose `relatedTo` names the company. **A card is created at the first
call, never by an import**: an imported number with no card stays a row until
somebody dials it, so a list of three hundred numbers never becomes three hundred
entries in the group's address book and in every member's phone, and a list nobody
dialled leaves nothing behind.

**The call log lives on the card of whoever was spoken to**, and on the company's
own when the call named nobody: opening a card shows what was said to it — when,
by whom, in which campaign, with which outcome and note — so the card a caller
opens in November carries what a colleague said in October. A call to a
switchboard that named nobody is the company's history until a person is attached
to it, and the routing note that says who is competent for what is that same
card's own note or a person's title, written while the call is happening: the
handoff carries it, and does not invent it.

### The two lists

A **campaign's list** is its rows: it never exists without the campaign that owns
it, so re-running a list is a new campaign with the same file rather than the
same list reused. The **do-not-call list** is the group's own — one document in
the group's account beside the campaigns that honour it, durable and shared by
every campaign of that group, and the only list that lives on its own, because a
promise not to call is not a campaign's to keep. It is not the installation's: a
group exists for outbound work alone as often as not, and the installation's agent
holds no grant on every group, so a list reached through it would be a promise
some groups cannot keep. The cost is stated where the promise is made — a number
that must never be called is entered once for each group that calls.

### What a campaign is made of

- a **campaign** — the root document. One sentence of purpose, the revision of the
  script it points at, the outcome vocabulary it admits, the window it runs in, and
  the group it belongs to. Closing a campaign is a state, not a deletion.
- a **row** — a part document of its own, so two members of the group write
  without touching each other. It carries the number to dial and, once a card
  exists for it, the card it calls; and its state, its owner and its next call. A
  row may point at a company and no person.
- **Today** — not stored: the queue is the view of the rows that are mine or
  due, and it is where the work happens. The call is placed from the person's own
  phone.
- a **handoff** — not an object: an outcome selects rows into a screened list that
  leaves as a **file**, carrying the row's outcome and note, who called and when,
  the discovered person and the routing note that says who is competent for what.
  The product's job ends when the campaign closes and the subset has left; what the
  receiving side does with the file is its own business, and this block drafts no
  message and books no appointment.

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
- **Every number a card carries is checked against the do-not-call list**, not
  only the string that was pasted: a person called twice by two teams is the
  failure this product cannot afford. The list is the group's, so the check happens
  where the rows are written and never reaches another account: a number the group
  was told never to call is never written into that group's campaigns.
- **The list arrives by paste or file, and the work happens on a phone.** A
  hundred calls begin as a paste or a file, never as a form filled once per
  number, and the work happens on the screen in the caller's hand: the size of the
  list is why the first is true, and where the call is made is why the second is. A
  file is read by its columns; **a paste has none**, so it is read for the numbers
  in it — one row for each, the words around it kept as the row's own context —
  because the paste that starts a campaign is as often a mail as a spreadsheet.
- **The window orders the work; it does not delete it.** A campaign past its window
  with rows still open is a finding for the group that owns it — closed, extended,
  or carried into the next campaign — never a list that quietly stops existing.
- **A row is claimed before its number is dialled**, so a list is never called
  twice at once — the conditional write and the lapsed lease the installation's
  own claim already uses (ADR 0032) — and a caller holds one row at a time.
- **A number has one form: E.164 and nothing else.** `+` and the country code
  followed by digits — fifteen at most — with no space, no punctuation, no
  extension, no national trunk prefix, no note: the canonical string is the
  number's identity, so two rows that carry it are the same number however they
  were written when they arrived.
- **The country lives in the number.** One table of calling codes and the national
  lengths each of them has — never a country chosen for the installation and never
  a group's default, because one group calls Zambia, Rwanda and Tanzania while
  another calls China, Bulgaria and Turkey, and the number is what says which. A
  form that arrives without its `+` is read against that table; a leading code it
  knows and a length that country has are normalised, a national trunk prefix is
  dropped, an extension and any prose move to the row's note, and a number the
  table cannot place is refused and counted, never guessed and never stored
  half-written.
- **A campaign reads one revision of its script.** The script is a page of the
  knowledge base, taken at the revision the campaign started with: two callers
  saying different things because somebody edited the page on Wednesday is worse
  than a script that is a week old, and the page's own history says what was
  issued when.
- **The agent does not work this block.** A list is called by people, and the
  vocabulary of a campaign — its purpose, its outcomes, the note a call leaves — is
  theirs: no area of an instruction reaches a campaign, and reading a card's calls
  is the reader's own membership, not a run's permission.

**`gilbertoutbound` is a block for the same reason the other four are** — an
area of the product with a boundary of its own — and what it does not own already
has an owner: the identity is Stalwart's, the access is the group's, the durable
document is the `gilbert` app folder, the contact card is the mailer's, and the pass
that wakes a due list is `gilbertserver`. `README.md` defines the five blocks and
this record does not restate the definitions. A block is how the product is divided;
it is not an agent area, and this one is no exception.

## Consequences

The import normalises to the one canonical form, resolves against the group's
cards and its do-not-call list, and says its counts out loud — matched to a card,
new, duplicated within the list, on the do-not-call list, refused.

Resolution by number wants an index the group keeps in its own app folder, because
asking the mail server to find a card by phone is not the cheap read a hundred-row
paste needs; it is rebuilt from the cards and never becomes a second truth.

The call log is a bounded window per card: the most recent calls, and a count of
the ones it trimmed. A card is read far more often than it is written, and a log
that grows without limit turns opening a contact into a large read.

A card outlives this area and may already carry a number in any form: outbound
writes only the canonical one, normalises a card's number when it touches it, and
reports what it could not normalise instead of rewriting a contact's own data
silently.

What the area cannot do without is the freshness a document's own stamp carries:
the index is rebuilt when the card store has moved, and the door acts as the caller
whose session wrote the last thing read, so a stale read is a campaign that offers a
number somebody has since written off.
