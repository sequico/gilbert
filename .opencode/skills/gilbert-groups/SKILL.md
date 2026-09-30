---
name: gilbert-groups
description: The group-ownership law of the Gilbert client — everything a group owns lives in the group's own account, owned by the group from creation, with no shareWith maintenance; how to tell a group mailbox from other shared accounts (mail probe), and the per-feature map (calendars, contacts, files, chat, composer pickers). Load before creating, moving, or showing group-owned data, or before changing a group feature.
metadata:
  short-description: Group ownership law & per-feature map
---

# Gilbert — group ownership law

## The law

**"DI GRUPPO" means every user assigned to the group has maximum privileges on
every feature of the group — and everything the group owns belongs to the
group.** Concretely:

1. Group data is **created in the group's own account**, never in a member's
   personal account and then shared out. A `shareWith` written at creation is
   a smell — it is the per-object ACL maintenance, members added later invisible —
   that this repository has been fixing feature by feature.
2. A member added **after** the data exists sees it without any per-user
   patching: it is the group's, and their session on the group account reaches
   it. Membership is the grant; leaving the group removes the session.
3. What is shared from **individual** accounts (a colleague's folder,
   calendar, book) is different: there the reader *adds* it deliberately, and
   cards/names from it must never reach To-field suggestions or "All" views
   until added — never treat a stranger's collection as a group's.
4. There is **no product-admin group** to exclude: a mailbox whose local part
   is `gilbert-admin` is an ordinary working group, offered like any other.
   Administration is Stalwart's admin role and nothing else (ADR 0001).

## How to tell a group mailbox from other shared accounts

Session capabilities lie: Stalwart advertises the full set on every listed
account. The working classifier is the **mail store's probe**
(`store/mail/` `discoverMailAccounts`): candidates from the session that
answer `Mailbox/get` with a folder tree are `kind: "group"` in
`useMail((s) => s.mailAccounts)`; accounts that share only calendars/books/
files answer with none and are not listed. `mailAccounts` is set **once at
the end** of the probe — code reading it early (boot races) must wait for
that single transition, and only while it is still empty. Every probed
mailbox is a group, whatever its name: there is no name-based exclusion left.

## Per-feature map (state 2026-09-18)

- **Calendars**: the pattern-setter. `store/calendar.ts`
  `createCalendar(data, accountId?)` — omit for your own, pass the group
  account id to create one the group owns (subscribed from the start).
  `CalendarSidebar` puts the reader's own under **My calendars** and every
  group's together under **Group calendars** — one section, the calendars listed
  one after another and each naming its group on hover, with a **+** on the
  section that creates a calendar **owned by the group** (asking which group
  when there is more than one), and a group's calendars listed as subscribed (no
  "+ add" row: membership is the subscription, and no remove either -- a member
  hides and shows one, never unsubscribes it). A group calendar's **colour
  belongs to the calendar**, so every reader sees the same one, and only an
  installation administrator may change it — the Edit entry is disabled for a
  member. A calendar a group owns is renamed from that same section, and never
  deleted — Delete is disabled for a shared calendar, a group's included;
  non-group shared calendars stay in the read-only *Shared with me / Available
  to add* area.
- **Address books**: same shape — `store/contacts.ts`
  `createBook(name, accountId?)`; `ContactsSidebar` lists every group's books
  together under **Group contacts**, each naming its group on hover, with the
  same **+** on the section.
  **Global contacts is not one of these**: it is one Master-owned book with a
  universal read-only share, the installation's rather than a group's, and it
  gets no per-group section and no per-group copy (`gilbert-global-contacts`).
- **Files**: ownership follows the browsed context (`store/files.ts`
  `openAccount`); a doc created while browsing the group account is the
  group's. The composer's "Attach from Files" picker lists every probed
  account, group mailboxes included, and copies the blob into the sender's
  account at attach time.
- **Shared/group contacts in the composer**: a group mailbox's books answer
  in the recipient picker, To-field suggestions and "All contacts" **without
  each member adding the book** — membership is the subscription
  (`store/contacts.ts` `loadShared`, which also loads for group accounts).
  Cards load by page up to 5 000 per account; `loadShared` is single-flight.
- **Chat (ADR 0005)**: one JSON node per message in `gilbert/chat` and one
  read marker per member in `gilbert/chat-state`, both in the group account,
  pushed by FileNode state changes (`lib/chat.ts`, `store/chat.ts`).
- **Deleting the group's mail (ADR 0015)**: the one thing a member may not do.
  A group is reached by membership, so the mail server tells one member's delete
  from another's by nothing and there is no rank inside a group; the rule is the
  client's and lives in `lib/mailDelete.ts` alone. The three entry points that
  end a message for good — a destroy out of Deleted Items or Junk Mail,
  `emptyMailbox`, and `destroyMailbox` **with** its mail — are refused for
  everybody but an installation administrator (`session.gilbert.isAdmin`), and
  the guards sit on those effects in `store/mail/` rather than on the menus,
  because `trash()` destroys a message already in Deleted Items or Junk Mail by
  calling `destroy`. Everything else stays: filing into the group's Deleted
  Items, archiving, labelling, replying — so both folders are real folders
  members fill and cannot empty. `mayDestroy` asks `isOwnMailAccount` **before**
  anything else, never `isGroupMailboxAccount`: the classifier answers "group"
  only after the account probe has listed the account, so an undiscovered group
  and the reader's own mailbox are one answer to it. It is a rule the client
  keeps, not a boundary — another client on the same account destroys the same
  mail.

## Working rules

1. Before adding or moving group data, decide which group account owns it and
   pass that `accountId` explicitly; never create in the reader's own account
   and share to the group principal.
2. Keep the classifier consistent: the probed `mailAccounts` (`kind: "group"`)
   is the one answer to what is a group. Do not invent per-feature heuristics.
3. Group features must work for a member added later and for a member on
   multiple devices; verify against a live server or a dated comment, keep
   `server/src/mock` in step, and update FEATURES.md when a group surface
   changes.
4. UI strings are English `t()` keys (see gilbert-i18n); group names in copy
   are the account names as the session reports them.
5. A group-only rule is asked from **one** module and guarded on the **effect**,
   not on the surface that draws the entry (ADR 0015). A surface that asks for
   itself, or a guard on a menu item, is how the group rule drifts.
