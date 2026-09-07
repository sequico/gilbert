---
name: gilbert-groups
description: The group-ownership law of the Gilbert client — everything a group owns lives in the group's own account, owned by the group from creation, with no shareWith maintenance; how to tell a group mailbox from other shared accounts (mail probe), the product-admin group exclusion, and the per-feature map (tasks, calendars, contacts, files, chat, composer pickers). Load before creating, moving, or showing group-owned data, or before changing a group feature.
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
   a smell — it is the old tasks/calendar/contacts mistake (per-object ACL
   maintenance, members added later invisible) that this repository has been
   fixing feature by feature.
2. A member added **after** the data exists sees it without any per-user
   patching: it is the group's, and their session on the group account reaches
   it. Membership is the grant; leaving the group removes the session.
3. What is shared from **individual** accounts (a colleague's folder,
   calendar, book) is different: there the reader *adds* it deliberately, and
   cards/names from it must never reach To-field suggestions or "All" views
   until added — never treat a stranger's collection as a group's.
4. The **product-admin group** (`gilbert-admin` local part on any domain, the
   ADR 0001 grant) is an administration surface, not a working group: it is
   excluded from group-creation surfaces and from chat. Its Files are not
   member-readable through JMAP (`FileNode/query` answers nothing).

## How to tell a group mailbox from other shared accounts

Session capabilities lie: Stalwart advertises the full set on every listed
account. The working classifier is the **mail store's probe**
(`store/mail.ts` `discoverMailAccounts`): candidates from the session that
answer `Mailbox/get` with a folder tree are `kind: "group"` in
`useMail((s) => s.mailAccounts)`; accounts that share only calendars/books/
files answer with none and are not listed. `mailAccounts` is set **once at
the end** of the probe — code reading it early (boot races) must wait for
that single transition, and only while it is still empty. Client helper:
`isAdminGroupAccountName(name)` in `lib/mailAccounts.ts` (local part
`gilbert-admin`), mirroring the server rule in `server/src/upstream.ts`.

## Per-feature map (state 2026-09-07)

- **Task lists**: the pattern-setter. A group list is a `tasklist`-marked
  calendar created with `accountId` = the group account
  (`store/tasks.ts` `createList(accountId, …)`); sidebar has one section per
  group mailbox with its own "+".
- **Calendars**: `store/calendar.ts` `createCalendar(data, accountId?)` —
  omit for your own, pass the group account id to create one the group owns
  (subscribed from the start). `CalendarSidebar` renders one section per
  group mailbox with "New calendar in {group}"; non-group shared calendars
  stay in the read-only *Shared with me / Available to add* area. The admin
  group gets no section.
- **Address books**: same shape — `store/contacts.ts`
  `createBook(name, accountId?)`; `ContactsSidebar` sections per group.
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
- **Chat (ADR 0006, not yet implemented)**: message JSON documents in the
  group account's `gilbert` app folder (`chat`/`chat-state`), pushed by
  FileNode state changes.

## Working rules

1. Before adding or moving group data, decide which group account owns it and
   pass that `accountId` explicitly; never create in the reader's own account
   and share to the group principal.
2. Keep the classifier consistent: probed `mailAccounts` (kind "group") for
   what is a group; `isAdminGroupAccountName` for what is not offered group
   creation. Do not invent per-feature heuristics.
3. Group features must work for a member added later and for a member on
   multiple devices; verify against a live server or a dated comment, keep
   `server/src/mock` in step, and update FEATURES.md when a group surface
   changes.
4. UI strings are English `t()` keys (see gilbert-i18n); group names in copy
   are the account names as the session reports them.
