# ADR 0023 — Global contacts

Status: Accepted

Implementation: Built. The directory is written as the Master
(`server/src/globalContactsAdmin.ts`), its book name and card shape are declared
once (`server/src/shared/globalContacts.ts`), it is read in Contacts
(`web/src/views/contacts/ContactsSidebar.tsx`,
`web/src/views/contacts/GlobalContactsEditor.tsx`, `web/src/lib/contacts.ts`),
and the mock carries the Master's books (`server/src/mock/index.ts`). The exact
Stalwart shape of a share that names every account at once is owed a live probe,
as the consequences say.

## Context

Contacts are books, and none of them is everybody's. A reader may read their
own, a group's — membership is the subscription (ADR 0021) — and a colleague's,
added deliberately, and `All contacts` merges the books the reader may read.
Re-built per group or per person, an installation's own shared directory would
drift, and the same address would be spelled three ways in three books. What is
missing is one directory the whole installation reads.

## Decision

**Global contacts is one address book, owned by the Master, shared read-only
with every account, and written only by an administrator, from inside
Contacts.** It is identified by its name, declared once in
`@gilbert/shared/globalContacts`, so the sidebar and the mock cannot disagree
about which book is the directory.

- **It is an ordinary address book.** JMAP `AddressBook` and `ContactCard`,
  held in the Master's account — an object the server holds, gilbertstalwart's
  area. No new object type, and no second store in Gilbert.
- **Everyone reads it.** The share is universal: one rule, every account,
  including one created later. A reader sees it in `All contacts` beside their
  own book and the group books their membership subscribes, with no per-member
  patch and nothing to add by hand. The administration re-applies the share on
  every write, which is what brings an account created since the last one in.
- **It is the first row of the Contacts sidebar**, above `All contacts` and the
  reader's own books, so it can be opened and browsed alone; merged into
  `All contacts` it is the same book.
- **Only an administrator writes it, and from inside Contacts.** Global
  contacts is edited where it is read: the Contacts surface draws the edit
  controls for an administrator alone, and for everybody else the cards are
  read-only. The write goes through the same door every privileged write uses —
  impersonation as the Master, or the deployment's agent (ADR 0001, ADR 0007) —
  a server route, because the read-only share grants the administrator's own
  session nothing to write with.
- **Its cards are ordinary cards**, so they take part in the composer's
  recipient suggestions and the contact search the way every readable book's
  do, under ADR 0004's rules for group cards.

### What is not in it

- **A second contacts store.** Global contacts lives in Stalwart as a book;
  Gilbert keeps nothing of its own.
- **Global contacts copied per member, or writable by one.** A per-account copy
  that could drift, or a write path for a member, is not this decision.
- **Global contacts per group.** A group's own books stay the group's; Global
  contacts is the installation's, owned by the Master and read by everyone.
- **An org chart.** Global contacts is a book of contacts, with the fields a
  card has, and nothing about reporting lines.

## Consequences

- One edit of Global contacts changes what every reader sees, with nothing to
  republish and no copy to keep in step. The exact Stalwart shape of a share
  that names every account at once is owed a live probe; what the decision
  requires is that it is one rule.
- Reading Global contacts costs the client nothing new: it arrives with the
  shared books `loadShared` already loads, and `All contacts` already merges
  them.
- The directory is a rule about what the product draws, not a boundary: a
  member's own JMAP session cannot write the book, because the share carries
  read only, but an administrator with impersonation can — which is how the
  administration writes it, and why the app folder and its books are not a
  security boundary (ADR 0001, gilbert-stalwart).
- A deployment with no usable agent has no Global contacts administration, and
  the administration says so rather than refusing with a permission error.

## References

- `server/src/shared/globalContacts.ts` — the book name and the card shape both tiers read
- ADR 0001 — the administration door and impersonation
- ADR 0004 — a contact group is not a recipient
- ADR 0007 — the identity-enforcement surface, beside which the write lives
- ADR 0021 — a group's folders are subscribed for every member
