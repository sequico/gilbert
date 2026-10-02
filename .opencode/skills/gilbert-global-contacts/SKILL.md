---
name: gilbert-global-contacts
description: The Global contacts law of the Gilbert client — the one Master-owned directory the installation creates at boot, read by every account through a server route and written only by an administrator from inside Contacts. Load before touching Global contacts, the directory's editor or sidebar, or the account-wide contact merge.
metadata:
  short-description: Global contacts directory law
---

# Gilbert — Global contacts

ADR 0023 decides the directory; this file is how the tree keeps it. **Read the
record before changing the feature** — a sentence here that disagrees with it is
a bug in one of the two.

## The directory (ADR 0023) — the invariants

1. One address book in the **Master's account**, **created by the installation
   at boot** (`ensureGlobalContacts`), not by hand.
2. Read by every account **through a server route** — a `shareWith` cannot
   name an unbounded set: Stalwart caps a share at 10 principals per item
   (live-probed; `gilbert-stalwart`), so the route is the door. Written only by
   an administrator from inside Contacts, through a server route that acts as the
   Master.
3. The **first row of the Contacts sidebar**, above `All contacts` and the
   reader's books, merged in `All contacts`; the book's name is the marker
   (`@gilbert/shared/globalContacts`).
4. A card is an ordinary JSContact card — name, emails, telephones,
   organisation, notes — declared once as `GlobalContactInput`, so the
   administration cannot write a key the directory does not mean to carry.

## The map

- `server/src/globalContactsAdmin.ts` — the write, the read the route serves,
  the boot-time `ensureGlobalContacts`.
- `server/src/index.ts` — its call, before anything is served.
- `server/src/shared/globalContacts.ts` — the book name and the card shape both
  tiers read.
- `web/src/views/contacts/GlobalContactsEditor.tsx` — the administrator's
  editor.
- `web/src/views/contacts/ContactsSidebar.tsx` and `web/src/lib/contacts.ts` —
  the row and the predicate (`isGlobalContactsBook`).

## Rules

1. A decision moves by rewriting its record **in place**, and this file with it.
2. It is the installation's, not a group's: one book, one Master owner, no
   per-group copy.
3. **If something is needed, make it happen** — the installation creates the
   book at boot; no administrator sets it up by hand.
4. It is a Stalwart object, never a second store.

Companion skills: Stalwart objects load `gilbert-stalwart`; group books load
`gilbert-groups`; strings load `gilbert-i18n`.
