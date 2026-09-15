# ADR 0010 — The client has no tasks module

Status: Proposed

## Context

**gilbertmailer** recognises a task not by a type of its own but by where it
lives: a to-do list is a calendar whose `description` is the literal
`tasklist`, and a task is a JSCalendar `Task` inside one.
`web/src/lib/taskList.ts` holds that single rule — `TASKLIST_MARKER` and
`isTaskCalendar` — and everything else hangs off it:
`web/src/store/tasks.ts` reads, writes and orders them,
`web/src/views/tasks/` draws them.

The surface is a section of the application: an entry in the module table
(`MODULES` in `web/src/views/AppShell.tsx`), a route (`/tasks` in
`web/src/App.tsx`), a sidebar, a quick-add field, drag ordering carried in a
keyword, a catalog string for the new-task action, and the phone's tab bar,
which draws the same table — so the stylesheet counts the columns that table
has. **Use as task list**, on a calendar in the calendar sidebar, is the write
that marks a calendar the reader already has.

Three facts decide how much the module costs to keep, and how much it costs to
remove:

- **Ownership follows the account.** A list created for a group lives in the
  group's own account, so one code path reads and writes in the reader's
  account or in a group's, with no per-object sharing — the rule ADR 0005
  states for everything a group owns.
- **Nothing of it is durable in Gilbert.** There is no table, because there is
  no database: the lists and their tasks are Stalwart's objects, under the
  account's quota, and they live or die with the calendar that holds them.
- **It travels as calendar state.** `PUSH_STATE_TYPES`
  (`server/src/shared/push.ts`) names no task type; a change to a task reaches
  a tab as a change to `CalendarEvent`, which is what the list is made of.

From the other side, the calendar keeps itself clear of the module, and those
guards are what the grid relies on: `web/src/store/calendar.ts` skips an
object whose `@type` is `Task` and any calendar carrying the marker, and the
calendar sidebar and the event editor filter lists out of their pickers, so a
task list is never offered as somewhere to put an event.

The module is Gilbert's own. Upstream ships no tasks module, no `tasklist`
marker and no `web/src/views/tasks`, so none of this is a feature the
download-only relationship obliges this project to carry (ADR 0002).

**What is built, and what is only decided.** The module described above is in
the tree today; this record's tense is the design's, never the tree's.
Everything under Decision is the change `gilbertmailer` is pointed at, and it
lands as one diff — the client, the mock in **gilbertserver**, the catalogs,
the inventory and the skills together.

## Decision

**Gilbert has no tasks module, and a task list is not a thing the client
knows.**

- **No surface.** No route, no entry in the module table, no view, no store,
  no lazy chunk. Four sections remain — mail, calendar, contacts, files — and
  the phone's tab bar draws those four, as its stylesheet's column count then
  says.
- **No marker.** Nothing recognises `tasklist` and nothing writes it, so the
  calendar sidebar's **Use as task list** goes with the module. A calendar is
  a calendar: its `description` is the text it always was, and every calendar
  the reader may write is offered wherever an event may be put.
- **No data touched.** A marked calendar and the `Task` objects inside it are
  the reader's own, and they stay exactly where Stalwart holds them: no
  migration, no purge, no hiding pass. Removing the code that wrote them is
  not the same as removing them, and only the first is this decision.
- **The grid's guard stays.** A `Task` is still never drawn as an event
  (`web/src/store/calendar.ts`): a server may hold objects this client did not
  write — another client's task, or one already in the account — and a task
  *is* an instance the grid could build, its `due` reaching the wire as a
  `start`. The property is asked for (`@type` in `EVENT_PROPS`) precisely so
  the guard can fire against a server that honours `properties`. That guard is
  not the module; it is what keeps the calendar honest about data the client
  does not own.
- **The wire shape loses what only the module read.** `TaskItem`
  (`web/src/jmap/types.ts`) goes with the store that used it, as do the
  task-only fields on `JSCalendarEvent` — `progress`, `due`,
  `percentComplete`. `@type` keeps `Task` in its union, because the guard
  above compares against it. (`JSCalendarParticipant`'s own `progress` and
  `percentComplete` are a participant's, and are not touched.)
- **A URL that no longer names a section lands where any unknown path lands**:
  on mail, through the router's own fallback, with no redirect invented for
  it. The install surface needs nothing either: the manifest's `start_url` is
  mail and its shortcuts are Compose, Calendar and Contacts, so no installed
  address names the section — the phone's change is the tab bar's column
  count and nothing else.
- **`PUSH_STATE_TYPES` is unchanged.** Tasks were never a state type of their
  own, and the list goes on carrying `CalendarEvent` and `Calendar` for the
  calendar that remains.

**ADR 0005's rule is not what changes; its enumeration is.** A group's
collections are calendars, address books and files, owned by the group from
creation — and a task list is not one of the examples that rule carries.
This record supersedes that clause of ADR 0005 and leaves the rest of it
standing, the way ADR 0016 supersedes ADR 0001's policy bullet.

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
  The only difference a calendar sees is that nothing is filtered out of them
  and no marker is written.
- **The mock's `CalendarEvent/query`**, which keeps answering `inCalendar` for
  any calendar — that is the calendar's filter, exercised by a group calendar
  in `server/src/mock/group-mailbox.test.ts`, and it is not a task feature.
- **ADR 0005's rule.** Everything a group owns still lives in the group's own
  account, owned from creation; what changes is the enumeration of what that
  is — calendars, address books and files, without task lists.
- **`gilbertagents`**, which never read a task: `RECONCILED_TYPES`
  (`server/src/agent/agent.ts`) reconciles `Email` and `FileNode` only, and no
  action in the catalogue reads or writes a calendar object.
- **`gilbertstalwart`**, which needs no setting for this: the objects are
  ordinary calendar objects to the server, and nothing is stored for Gilbert.

## Consequences

- An account holding marked calendars finds them where calendars appear, in
  the reader's own list or under the group that owns them. What was written in
  one as a task is not drawn — the guard above — so such a calendar reads as
  an empty one, and the reader who wants it gone deletes it, taking whatever
  is inside it with it.
- The inventory and the public documents that name task lists as one of the
  things a group owns, or as one of the live surfaces the push fan-out covers,
  are corrected in the same change — a claim that a change makes false is
  fixed with it. The group skill's per-feature map hands its "pattern-setter"
  role to calendars, which is the collection that already has it.
- The catalog string for the new-task action comes out of every catalog in the
  same change: a key the code does not ask for is a stale key the i18n check
  reports, and a missing one renders English on screen.
- The grid guard keeps a test that fails when the guard is removed — the
  decision above is a mechanism, so it is pinned where it can break rather
  than left to a comment. The calendar test that pins it today is rewritten to
  name the guard rather than the marker.
- The module's own tests go with it: the seven files beside the store that
  exercised list discovery, ordering, paging, writes and the group cases have
  nothing left to exercise once the store is gone.
- The demo account loses its two list calendars and their two tasks; what it
  demonstrates from then on is mail, calendars, contacts and files.
- The last-place record remembers three surfaces instead of four: the mail
  account on screen, the address book, the folder open in Files. A `taskList`
  field already written into a device's local storage is read by nothing, and
  no migration is owed for it.
- A to-do list is not something Gilbert offers, in any form. A reader who
  wants one in Stalwart uses a client that has it, and this client draws the
  calendar they put it in and skips the objects inside — which is the whole of
  the interoperation this decision claims.

## References

- `web/src/lib/taskList.ts` — `TASKLIST_MARKER`, `isTaskCalendar`, the single
  recognition rule
- `web/src/store/tasks.ts`, `web/src/views/tasks/TasksView.tsx`,
  `web/src/views/tasks/TaskSidebar.tsx` — the module this record removes
- `web/src/store/calendar.ts` — the grid's own guard against a `Task`, and the
  marker filter that goes with the module
- `web/src/views/AppShell.tsx` — `MODULES`, the table every renderer draws
- `web/src/App.tsx` — the route
- `server/src/mock/index.ts` — the two fixture lists and their two tasks
- `server/src/shared/push.ts` — `PUSH_STATE_TYPES`, unchanged
- ADR 0009 — the push subscription covers every live type, which is why a
  surface dropped costs the list no entry
- ADR 0002 — upstream is download-only, so nothing here is upstream's to carry
- ADR 0005 — everything a group owns lives in the group's own account
