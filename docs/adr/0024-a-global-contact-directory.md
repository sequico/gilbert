# ADR 0024 — A global contact directory

Status: Proposed

Implementation: Not built.

## Context

Contacts are books. The reader's own, a group's — membership is the
subscription (ADR 0021) — and a colleague's, which a reader adds deliberately.
`All contacts` merges the books the reader may read. What none of them gives is
a **directory every reader shares**: the installation's people and places, the
same for everybody, kept in one place by whoever administers it. Re-created per
group or per person it would drift, and the same address would be spelled three
ways in three books.

The doors already exist. A privileged write into an account goes through
impersonation (ADR 0001); identities and per-account documents are written that
way (ADR 0007, ADR 0011). And a reader already reads books — seeing one more is
nothing new for the client.

## Decision

**The global directory is one address book, owned by the Master, shared
read-only with every account, and written only by an administrator, from inside
Contacts.**

- **It is an ordinary address book.** JMAP `AddressBook` and `ContactCard`,
  held in the Master's account — an object the server holds, gilbertstalwart's
  area. No new object type, and no second store in Gilbert.
- **Everyone reads it.** The share is universal: every account, including one
  created later. A reader sees the directory in `All contacts` beside their own
  book and the group books their membership subscribes, with no per-member
  patch and nothing to add by hand.
- **Only an administrator writes it, and from inside Contacts.** The directory
  is edited where it is read: the Contacts surface draws the edit controls for
  an administrator alone, and for everybody else the cards are read-only. The
  write itself goes through the same door every privileged write uses —
  impersonation as the Master, or the deployment's agent (ADR 0001, ADR 0007).
  The share carries read only, so a member's own session cannot edit a card,
  and the client shows those cards as it shows any book it may not write
  (`cardWritable`): Edit and Delete withheld.
- **Its cards are ordinary cards**, so they take part in the composer's
  recipient suggestions and the contact search the way every readable book's
  do, under ADR 0004's rules for group cards.
- **The phone offers them as speed dial.** Clicking a directory contact calls
  it, like any other contact (ADR 0023).

### What is not in it

- **Not a second contacts store.** The directory lives in Stalwart as a book;
  Gilbert keeps nothing of its own.
- **Not member-writable, and not copied per member.** A per-account copy that
  could drift, or a write path for a member, is not this decision.
- **Not per-group.** A group's own books stay the group's; the directory is the
  installation's, owned by the Master and read by everyone.
- **Not an org chart.** It is a book of contacts, with the fields a card has,
  and nothing about reporting lines.

## Consequences

- One edit changes what every reader sees: there is nothing to republish and no
  copy to keep in step.
- A reader added later sees it without any patch, because the share is
  universal rather than one written per member. The exact Stalwart shape of a
  share that names every account at once is to be confirmed against a live
  server; what the decision requires is that it is one rule.
- Reading it costs the client nothing new: it arrives with the shared books
  `loadShared` already loads, and `All contacts` already merges them.
- A deployment with no usable agent has no directory administration, and the
  administration says so rather than refusing with a permission error.

## References

- ADR 0001 — the administration door and impersonation
- ADR 0004 — a contact group is not a recipient
- ADR 0007 — identity administration
- ADR 0018 — a contact is moved between accounts by an administrator
- ADR 0021 — a group's folders are subscribed for every member
- ADR 0023 — the phone, whose speed dial reads this directory
