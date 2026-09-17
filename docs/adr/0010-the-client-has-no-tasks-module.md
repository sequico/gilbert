# ADR 0010 — The client has no tasks module

Status: Proposed

Implementation: Built as an absence: no task module, route, store or catalog
string exists, and nothing reads or writes the `tasklist` marker — `MODULES`
(`web/src/views/AppShell.tsx`) names four sections, none of them a task list.

## Context

A task list is a convention, not a type: a calendar whose `description` is the
literal `tasklist`, holding JSCalendar `Task` objects. It is a convention
Stalwart knows nothing about — the marker is text in a field, and a `Task` is
an object in a calendar — and one another client is free to write.

Three facts decide what it costs to recognise that convention, and what it
costs not to:

- **Ownership follows the account.** A list created for a group lives in the
  group's own account, so recognising it means one code path that reads and
  writes in the reader's account or in a group's — the rule ADR 0005 states
  for everything a group owns.
- **Nothing of it is durable in Gilbert.** There is no table, because there is
  no database: the lists and their tasks are Stalwart's objects, under the
  account's quota, and they live or die with the calendar that holds them.
- **It would travel as calendar state.** `PUSH_STATE_TYPES`
  (`server/src/shared/push.ts`) names no task type. A change to a task arrives
  as a change to `CalendarEvent`, which is what a calendar is made of.

Recognising it therefore buys a fifth section of the application — an entry in
the module table (`MODULES` in `web/src/views/AppShell.tsx`), a route, a
sidebar, a quick-add field, drag ordering carried in a keyword, a catalog
string, and a column in the phone's tab bar, which draws that same table — and
it costs a second kind of calendar that every other surface has to filter out:
the calendar sidebar and the event editor must not offer a list as somewhere to
put an event. Recognising the convention is what makes those filters necessary;
not recognising it is what makes them nothing.

The module is not upstream's. Upstream ships no tasks module and no `tasklist`
marker, so recognising the convention is not something the download-only
relationship obliges this project to carry (ADR 0002).

## Decision

**Gilbert has no tasks module, and a task list is not a thing the client
knows.**

- **No surface.** No route, no entry in the module table, no view, no store,
  no lazy chunk. Four sections: mail, calendar, contacts, files — and the
  phone's tab bar draws those four, as its stylesheet's column count says.
- **No marker.** Nothing recognises `tasklist` and nothing writes it: the
  calendar sidebar has no **Use as task list**. A calendar is a calendar: its
  `description` is the text it is, and every calendar the reader may write is
  offered wherever an event may be put.
- **No data touched.** A marked calendar and whatever is inside it are the
  reader's own, and they stay where Stalwart holds them: this client neither
  migrates nor purges nor hides them. Not writing such objects and not
  deleting them are two different things, and the decision is the first.
- **No reader names them.** There is no `TaskItem`, `JSCalendarEvent` declares
  no `progress`, `due` or `percentComplete`, and `JSCalendarEvent["@type"]` is
  `Event` alone — there is no task type anywhere in the client, so nothing in
  it is written or read for one. (`JSCalendarParticipant`'s own `progress` and
  `percentComplete` are a participant's, and stay.)
- **A URL that names no section lands where any unknown path lands**: on mail,
  through the router's own fallback, with no redirect of its own. The install
  surface needs nothing either: the manifest's `start_url` is mail and its
  shortcuts are Compose, Calendar and Contacts, so no installed address names
  a section that is not there.
- **`PUSH_STATE_TYPES` names no task type.** The list carries `CalendarEvent`
  and `Calendar`, for the calendar that remains.

**A group's collections are calendars, address books and files** (ADR 0005),
owned by the group from creation — and a task list is not one of them.

### Rejected — hiding the module instead of removing it

Taking the entry out of the module table and the route out of the router, and
leaving the rest in place, is the smaller diff and the wrong one: the store
keeps querying task-shaped changes for surfaces nobody opens, the sidebar
keeps the write that marks a calendar, the mock keeps its fixtures, and the
removal then rests on a navigation entry that a later change can add back
without re-deciding anything. A decision that a thing is not part of the
product is carried by the thing being absent, not by it being unreachable.

### Rejected — keeping it as a read-only surface

A surface that listed and deleted what is already in the account has one
argument for it: a reader who wants the objects gone would have a way to do
it. It is not enough. Keeping it keeps the whole module — route, store, view,
catalog strings, the fifth section, the column count — alive for data the
reader can reach through the calendar it lives in, where deleting the calendar
deletes its tasks with it (`onDestroyRemoveEvents` in the calendar store).
What remains is a read-only product for a mutable data set, which is a defect
waiting to be reported.

### Rejected — purging the data

Deleting the marked calendars and their objects, so that nothing task-shaped
is left in any account, is irreversible and is not Gilbert's to do: the
objects belong to the accounts that hold them, the write needs impersonation
for every account in the directory, and a calendar that is not a task list is
indistinguishable from one until the marker is read. A reader who wants a list
gone deletes a calendar — a calendar delete, through the door that already
exists.

## What this does not change

- **The calendar**, and everything it already does: sharing, group ownership
  (ADR 0005), event editing, the pickers that offer a place to put an event.
  A calendar is offered there on its rights alone, and its `description` is the
  text it is.
- **The mock's `CalendarEvent/query`**, which answers `inCalendar` for any
  calendar — that is the calendar's filter, exercised by a group calendar
  in `server/src/mock/group-mailbox.test.ts`, and it is not a task feature.
- **ADR 0005's rule.** Everything a group owns lives in the group's own
  account, owned from creation, and the enumeration that rule carries is
  calendars, address books and files.
- **`gilbertagents`**, which never read a task: `RECONCILED_TYPES`
  (`server/src/agent/agent.ts`) reconciles `Email` and `FileNode` only, and no
  action in the catalogue reads or writes a calendar object.
- **`gilbertstalwart`**, which needs no setting for this: the objects are
  ordinary calendar objects to the server, and nothing is stored for Gilbert.

## Consequences

- An account holding marked calendars finds them where calendars appear, in
  the reader's own list or under the group that owns them, with whatever is
  inside them drawn as what it is — an object in a calendar. That is the whole
  of the interoperation: the client knows calendars.
- No document here names a task list as something a group owns or as a live
  surface the push fan-out covers, and no catalog carries a string for an
  action the client does not have: a key the code does not ask for is a stale
  key, which the i18n check reports.
- Nothing in the suite pins a task surface: there is no module for a test to
  exercise and no grid guard for one to pin.
- The demo account seeds mail, calendars, contacts and files, and no list.
- The last-place record holds three surfaces: the mail account on screen, the
  address book, the folder open in Files. A `taskList` field in a device's
  stored record is read by nothing, and no migration is owed for it.
- A to-do list is not something Gilbert offers, in any form. A reader who
  wants one in Stalwart uses a client that has it, and this client draws the
  calendar they put it in and skips the objects inside — which is the whole of
  the interoperation this decision claims.

## References

- `web/src/store/calendar.ts` — the grid, with no task in it: an object in a
  calendar the reader can see is drawn, and nothing filters a calendar's
  contents by what the calendar is called
- `web/src/views/AppShell.tsx` — `MODULES`, the table every renderer draws
- `web/src/App.tsx` — the router's own fallback for a path that names no
  section
- `web/src/jmap/types.ts` — `JSCalendarEvent`, whose `@type` is `Event` alone
- `server/src/shared/push.ts` — `PUSH_STATE_TYPES`, which names no task type
- `server/src/mock/index.ts` — the calendars a demo account holds
- ADR 0009 — the push subscription covers every live type, which is why a
  surface the client does not have costs the list no entry
- ADR 0002 — upstream is download-only, so nothing here is upstream's to carry
- ADR 0005 — everything a group owns lives in the group's own account
