# ADR 0023 — Global contacts

Status: Accepted

Implementation: Built. The directory is written and read as the Master
(`server/src/globalContactsAdmin.ts`), its book name and card shape are declared
once (`server/src/shared/globalContacts.ts`), it is served to every session
through a route (`/api/global-contacts`) and read in Contacts
(`web/src/views/contacts/ContactsSidebar.tsx`,
`web/src/views/contacts/GlobalContactsEditor.tsx`, `web/src/lib/contacts.ts`),
and the mock carries the Master's books (`server/src/mock/index.ts`). A share
naming every principal cannot work — Stalwart caps a share at 10 principals per
item, live-probed (2026-10-02) — so the directory is served through a route.

## Context

Contacts are books, and none of them is everybody's. A reader may read their
own, a group's — membership is the subscription (ADR 0021) — and a colleague's,
added deliberately, and `All contacts` merges the books the reader may read.
Re-built per group or per person, an installation's own shared directory would
drift, and the same address would be spelled three ways in three books. What is
missing is one directory the whole installation reads.

## Decision

**Global contacts is one address book, owned by the Master, read by every
account and written only by an administrator, from inside Contacts.** The
Master's own book is found by the name declared once in
`@gilbert/shared/globalContacts`; the client, which never holds that book,
identifies the directory it installs under a sentinel id, so the sidebar and the
mock cannot disagree about which book is the directory, and a member's own book
that happens to carry the name is never taken for it.

- **It is an ordinary address book.** JMAP `AddressBook` and `ContactCard`,
  held in the Master's account — an object the server holds, gilbertstalwart's
  area. No new object type, and no second store in Gilbert.
- **Everyone reads it, through a server route.** A `shareWith` naming every
  principal **cannot work**: Stalwart
  caps shares at **10 per item** and refuses the rest with `invalidProperties`
  ("Maximum number of shares per item exceeded (max: 10)"), live-probed on the
  deployment (2026-10-02), while an installation has more principals than that.
  So the directory is **served through a route** that reads it as the Master and
  answers any authenticated session — the same door the KB's company tier and
  the workorder surface use. One rule, every account, including one created
  later, with nothing to add by hand and no per-item share to keep current.
- **It is the first row of the Contacts sidebar**, above `All contacts` and the
  reader's own books, so it can be opened and browsed alone; merged into
  `All contacts` it is the same book. The client draws it from the route rather
  than from a shared book in its own session.
- **Only an administrator writes it, and from inside Contacts.** Global
  contacts is edited where it is read: the Contacts surface draws the edit
  controls for an administrator alone, and for everybody else the cards are
  read-only. The write goes through the same door every privileged write uses —
  impersonation as the Master, or the deployment's agent (ADR 0001, ADR 0007) —
  a server route, because the directory is the Master's and the caller's session
  does not hold it.
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
- **A universal `shareWith`.** The server caps a share at 10 principals per
  item, so "shared read-only with every account" is not a shape Stalwart offers;
  the route is the door instead.
- **An org chart.** Global contacts is a book of contacts, with the fields a
  card has, and nothing about reporting lines.

## Consequences

- One edit of Global contacts changes what every reader sees, with nothing to
  republish and no copy to keep in step. The route is what makes "one rule" true,
  since the share cannot name an unbounded set of accounts.
- Reading Global contacts costs the client one route call, answered as the
  Master and drawn as the directory's own book; `All contacts` merges it like
  any other book it may read.
- The directory is a rule about what the product draws, not a boundary: the
  route answers any authenticated session, and an administrator with
  impersonation can write the book — which is how the administration writes it,
  and why the app folder and its books are not a security boundary (ADR 0001,
  gilbert-stalwart).
- A deployment with no usable agent has no Global contacts administration, and
  the administration says so rather than refusing with a permission error.

## References

- `server/src/shared/globalContacts.ts` — the book name and the card shape both tiers read
- `docs/adr/0024` — the knowledge base, whose company tier takes the same route
  rather than a share, for the same reason
- ADR 0001 — the administration door and impersonation
- ADR 0004 — a contact group is not a recipient
- ADR 0007 — the identity-enforcement surface, beside which the write lives
- ADR 0021 — a group's folders are subscribed for every member
- `.opencode/skills/gilbert-stalwart/SKILL.md` — the 10-share cap, live-probed
