# ADR 0018 — A contact is moved between accounts by an administrator only

Status: Accepted

Implementation: Built. The rule is one module (`web/src/lib/contactMove.ts`),
which answers whether a write is a move between accounts at all
(`movesBetweenAccounts`) and why one is refused (`contactMoveRefusal`, answering
the code `contact_move_admin`); the guard sits on the effect —
`moveCardTo` in `web/src/store/contacts.ts`, which refuses before any call
leaves the client — and the sentence is composed there from the catalogue, as
the mail rule's refusals are (`contactMoveSentence`). The surface reads the same
answer before drawing the entry, through one hook
(`web/src/lib/useMayMoveContact.ts`) so the drawn answer moves with the admin
flag: the row menu and the destination dialog in
`web/src/views/contacts/ContactsView.tsx`. The invariant is pinned in
`web/src/store/__tests__/contact-move-admin.test.ts`, with the surfaces pinned
in `web/src/views/contacts/__tests__/contacts-move.test.tsx`.

## Context

A contact card is an object of **one account**: a personal book's card belongs
to the reader, and a group mailbox's card belongs to the group, filed in the
account the group owns (ADR 0005). Gilbert already moves a card between accounts
— `moveCardTo` copies it into the target account's book and destroys the
original, because a card is not shareable across accounts and its id is only
unique where it lives — and it has done so from the contact editor since the
target book became a choice there.

What was missing is that the move is the one edit that changes **whose** the
card is. Filing a new card into a group's book creates group data, which is what
a member is for; editing a card in the group's directory changes what the group
knows, which its own book grants them; but handing a card from one account to
another takes it out of one principal's records and puts it in another's, and
nothing in the mail server expresses who may do that: a member holds the same
rights on a group's books as on their own, and the accounts are reached by
membership rather than by a share (ADR 0005, ADR 0015).

The installation has exactly one administration — Stalwart's own permission
list, resolved into `session.gilbert.isAdmin` (ADR 0001) — and this is one of
the things it is for.

## Decision

**Moving a contact from the account it lives in to another account is an
installation administrator's. Everything else a member does with a group's
contacts is unchanged.**

- **A move is a change of account, and nothing else.** `movesBetweenAccounts`
  answers it for the two accounts, so a write that keeps the card where it is —
  a patch that re-files it between two books of one account — is not a move and
  is not refused. Filing a **new** card into any book the reader may write,
  group books included, is untouched: it is how group data is created.
- **One rule, one module.** The decision lives in `web/src/lib/contactMove.ts`
  and nowhere else, and it reads no store: the two accounts and the admin flag
  are handed in, which is what lets it be exercised without a running app — the
  shape `mailDelete.ts` already has.
- **The guard is where the effect is.** `moveCardTo` refuses before it calls the
  server, so the move is refused whatever reaches it — the row's menu, the
  destination dialog, and the contact editor's own account change, which is the
  second route to the same write. A rule kept on the menu that offers the entry
  is a rule the next surface walks around (ADR 0015).
- **The surfaces draw the same answer.** The right-click menu on a row carries
  **Move to…** only for a session that may move a card, and the dialog behind it
  is reached by nothing else, so nothing is offered that would be refused. The
  hook is the reason to re-render when the flag moves, exactly as
  `useMayDestroy` is for the mail rule.
- **The rule answers a code, and the sentence is composed where it shows.** The
  module says `contact_move_admin`; `contactMoveSentence` in the store composes
  the sentence the reader reads from the catalogue in force, and it says what
  still works — editing the card, and filing new ones where they are —
  because the reader's next move is the point.
- **The dialog names the accounts, not only the books.** A destination is a book
  **and the account that owns it**: two groups may each keep a "Team", and the
  account is the half that says whose records the card is joining. The groups'
  books are listed whether or not the reader holds a write on each — the server
  refuses what it must, in its own words, rather than the picker hiding a
  destination that exists. The reader's own books are offered only from a card
  that is elsewhere, because within one account the editor already re-files a
  card and nothing about ownership changes.

### What this rule is not

It is not a boundary, and it is not written as one. Another JMAP client on the
same accounts moves the same card without asking this code, and the mail server
itself has no per-object right for it. It is the same posture ADR 0015 states
for a group's mail, and the sentence a refused reader reads names the rule
rather than claiming a protection.

## Consequences

- **A member cannot hand a group's contact out, or take one in.** Filing a card
  into the group's directory and editing it there still work, so the group's
  records are still the group's to keep; what is closed is the one action that
  moves a card across the line between two principals.
- **The contact editor's account change is refused with it.** A form that saves
  a card into another account's book goes through the same write, and a member
  meets the same sentence there. The editor is otherwise unchanged.
- **A withdrawn administrator keeps the menu until the session is read again.**
  The flag is ADR 0001's, resolved at sign-in and re-read when the session state
  changes; between those moments the client answers from what it holds, and the
  refusal on the write is what actually holds — which is why the guard is there
  rather than only on the menu.
- **The rule is only as good as the client that carries it.** An installation
  that needs the guarantee rather than the convention has to take it up where
  the accounts and their books are administered.

## References

- `web/src/lib/contactMove.ts` — the rule: what counts as a move and which
  refusal it answers
- `web/src/lib/useMayMoveContact.ts` — the hook the surfaces read it through, so
  the drawn answer re-renders when the admin flag moves
- `web/src/store/contacts.ts` — `moveCardTo`'s guard, before any call leaves the
  client, and `contactMoveSentence` composing the refusal from the catalogue
- `web/src/views/contacts/ContactsView.tsx` — the row's right-click menu, and
  `MoveContactDialog` naming each group and the books it owns
- `web/src/store/__tests__/contact-move-admin.test.ts` — the invariant: a
  non-administrator's move reaches no server, an administrator's reaches the
  target account, and re-filing a card inside one account is served to anybody
- `web/src/views/contacts/__tests__/contacts-move.test.tsx` — the surfaces:
  the entry is offered to an administrator and drawn for nobody else
- ADR 0001 — administration is Stalwart's, and `isAdmin` is its answer
- ADR 0005 — a group owns its data, and membership is the grant
- ADR 0015 — the same posture for a group's mail, and the shape this rule copies
