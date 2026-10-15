# ADR 0028 — Workorders are group-owned parts

Status: Accepted

Implementation: Built. The shape, its validators and the wire views are one
definition (`server/src/shared/workorder.ts`); the Master-owned door and its
`/api/workorders` routes are `server/src/workorderAdmin.ts` and
`server/src/routes/workorder.ts`, with the boot ensure in `server/src/index.ts`;
the client reads through the route (`web/src/lib/workorder.ts`, `web/src/store/workorder.ts`),
hears about a part changing on the FileNode rail wired in `web/src/App.tsx`'s
StateChange dispatch — and about the installation's own checklist through the
subscription the deployment holds on that account (`followAccount` in
`server/src/push.ts`, followed by `server/src/routes/mail.ts`; the fan-out needs
the subscribe mode, since the per-tab relay carries the tab's own credential and
cannot follow an account that credential does not hold) — and the surface
is a factory launcher in the top bar beside
chat's opening a
large panel (`web/src/views/workorder/`, `web/src/views/AppShell.tsx`). A
checklist binds to a KB template revision, resolves the applicable steps from it
(`resolveChecklist`, `server/src/shared/knowledge.ts`) and carries the per-path
steps and their states (ADR 0030). The agent checks a part through the same door
(ADR 0003), and that agent part is **present in the tree but does not work yet; a
refactor is planned** (see `ROADMAP.md`).

## Context

Gilbert has no place for a workorder. A company keeps its workorders today as a
hand-made tree of folders and files in Files, one folder per workorder,
maintained by hand.

What is wanted: a surface of its own, beside the KB, where a workorder gathers —
**by reference, never by copy** — the reference checklists, the folders and the
documents that belong to it; and every reference can be followed, so clicking a
file opens it where it really lives.

Who sees what is decided by **group membership**. JMAP has no field-level
permission, so visibility is account access: a group owns the part of the
workorder it is competent for, and a reader sees the union of the parts their
group memberships reach.

A workorder's checklist is where the **KB (ADR 0024)** becomes a process: the
checklist is an instance of a **template** the KB defines, and the workorder
carries the step's state and never the controlled text. The KB is the strategic
layer; the workorder is the lean operational instance.

## The design as it stands

### One uid, a document in each account's app folder

A workorder is one **uid**, and everything about it is a document named
`<uid>.json` under `workorders/` in an account's `gilbert` app folder — the
hidden top-level folder the client already keeps out of the Files view
(`server/src/shared/appFolder.ts`, `web/src/lib/appFolder.ts`). The folder says
what the document is, so the name carries no marker and no second hiding rule is
invented: the app folder's own name is the whole rule, and the file is stored the
way every app-folder document is.

- The **Master's** copy, in the Master's account, is the workorder's **root**: its
  identity, its **global checklist** and its state. The Master's `workorders/`
  folder is the **registry** — listing it yields the active workorders, and each
  root carries where it stands; its `closed/` subfolder holds the ones a terminal
  state has moved — because `FileNode/query` cannot filter by name and no search
  spans accounts, so a workorder nothing registers cannot be found at all. No
  separate index document is kept: it would be one hot node every write in the
  account compares against.
- A **group's** copy, in that group's own account, is the group's **part**: the
  group's checklist and the group's references.
- The **same uid** names every copy. The account tells them apart and decides
  which role a document has, so the root and a part are one name in two places,
  not two shapes to keep in step.
- The root carries the workorder's **friendly name** beside the uid — the label a
  listing and the panel show. It is a field of the document and never the file's
  name: the uid is what ties the copies, so renaming a workorder is an edit and
  never a rename, and no reference breaks.

### The document shape

One definition, `@gilbert/shared/workorder`, read by both tiers. A root and a
part are the same shape; the root carries what a part does not.

- `v` — the schema version, an integer.
- `uid` — the workorder's id.
- `name` — the friendly name, on the root; a part does not carry it.
- `state` — on the root: `running`, `completed`, `cancelled` or `replaced`. A
  root also carries `replacedBy`, the successor's uid when the state is
  `replaced`. It is read as part of the shape, a writer preserves it, and the
  summary publishes it: the state is a relation, and the reader of a replaced
  workorder wants the one that took over, drawn beside it.
- `checklist` — `{ template, variants, items, steps }`. `template` names the KB
  article and the revision it binds to (ADR 0024). `variants` is the **chosen
  value per variant** and `items` the **chosen items per repeated section**, both
  taken once when the workorder is created and resolving the template's
  conditions **everywhere** (ADR 0030) — so the branching is the workorder's and
  never a group's. `items[sectionKey]` is `{ key, data }`, the `data` holding the
  repeat's per-item field values.
- `steps` — the **applicable** steps, one entry per path. A step is
  `{ path, state, by, at, note }`: the **path** carries the template section and,
  for a repeat, the item (`loading[CONT-1].seal`), so the same step in two items
  is two entries and never collides; the **state** is `open`, `done`, `skipped`
  (counts as complete but says it was not actually done) or `not-applicable`
  (dimmed, out of progress); `by` and `at` are the last signature. Content a
  condition excludes is **not** instantiated; the controlled text is read from
  the template revision, never copied here.
- `refs` — the references `{ accountId, kind, id }` this document gathers; `kind`
  names what `id` is — `folder`, `file` or `kb` — and a later version may add
  more, which a reader preserves and skips.
- `created`, `updated` — `{ by, at }`.

Two rules keep the shape open without losing anything. A document carries `v`,
and **a write preserves what it does not know** — every writer is a
read-modify-write that keeps unknown fields, so a document from a later version,
or one carrying an extra field, is never trimmed. A change to the shape is a
version bump and a **non-destructive migration** that carries values forward and
drops none.

### Closing a workorder moves its root

A workorder is **running** until it is closed, and there are three ways out: it
is **completed**, it is **cancelled**, or it is **replaced** by the workorder
that succeeds it. When it reaches one of those states the Master moves the
**root** into `workorders/closed/`, so listing `workorders/` is the active set
and listing `closed/` is what is done. The `closed/` folder is not a bin: a
terminal workorder is **kept for ever**, and nothing destroys one. A terminal
state **freezes the checklist** — a check after the fact is refused — so the
record is what was checked while the work ran.

**`replaced` is set by the act that succeeds one, and never on its own.** The
surface offers **Replace** beside the two ways of finishing, and it opens the
form a workorder is born from: the successor is created from that input — a name,
a template, its choices — and the predecessor is marked `replaced` with
`replacedBy` naming it, in one request. Nothing is copied from the one it
replaces: the successor is a new workorder a person chose. The two writes live in
two accounts and Stalwart has no transaction across them, so the pair is
**all-or-nothing by compensation**: the successor is created first, and a marking
that fails takes it back, so either both facts are there to be seen or neither is.
Marking first would leave a `replaced` root naming a uid nobody wrote, and no
retry invents it. A close request naming `replaced` without a successor is
therefore refused: the state is a relation, and a relation to nobody is not one.
The `closed/` **directory node** sits among the active
roots in a listing of `workorders/` and is dropped by node type, so the active
set is the files that remain. The folder is a **projection of the state, not the
state**: the `state` field is the truth, a root standing in the wrong folder is a
**finding** the fleet reconciles, and the move is one write that keeps the id, so
every reference by uid survives and reopening moves it back.

A group's **part never moves**: the panel is composed by the route and filters a
part by the root's state, and moving a part would be one write per group for no
gain. Only the Master's own account holds the projection, where the enumeration
happens.

### References, not copies and not markers

Everything a workorder gathers is a reference `{accountId, kind, id}` — a folder,
a file, a KB article — never a copy and never a marker planted in a work folder.
**Mail is out of v1 entirely**: an email is not referenced, no mailbox is a part,
and the product makes no folder for it. On an explicit instruction the agent may
do as it sees fit with mail, and that is the agent's own act, not part of this
model.

**The pointers by id are the truth.** A folder belongs to a workorder because a
reference names it, never because it sits under another folder: no per-workorder
folder tree is maintained, and a folder read by several workorders is one
reference per workorder and nothing special. A reference whose target is gone
resolves as **not available** — never a broken pane — and is a **finding** the
fleet reconciles, never a silent divergence.

**One function follows every reference**, for every kind and every surface,
built on the way the client already moves (`store/mail`'s open thread,
`store/chat`'s open account; no router). It selects the target's account first,
then opens the object, and answers "not available" when the reader cannot reach
that account.

A part points at its **own group's** objects, because the part's readers are that
group's members. A pointer carries `{accountId, id}` and a title is resolved
live, only for a reader who may read the target, so a reference leaks no name.

### The surface, and who reads what

One **launcher in the top bar** beside chat's (`store/chat.ts`: an icon, a badge,
open and close), and one **large panel** it opens: wide and tall enough to work
in, not a popover — the chat launcher's shape at a working size. The icon is a
**factory**. The panel lists the workorders the reader can see and holds the open
one — global checklist, the reader's own checklists, parts, references — while the
rest of the app is used beside it. Opening a reference does not leave the
workorder: the panel stays as the context and the main area shows the target.

The **Master does every read and every write**, because it is a member of every
group the installation grants it on (ADR 0007). It composes the full view from
its own root and the parts it can read, and it is what makes one surface possible
at all: an administrator sees every part **without being a member of every
group**, because the view served is read as the Master, while a member sees the
global checklist and the parts of their own groups.

What a reader may reach is decided by the template's **assignment of its
sections** (ADR 0030), read against the caller's own group membership. A section
carries a group's account when that group owns it and carries nothing when it is
the workorder's own, and the two halves answer two questions.

- **A section assigned to no group is global, and it makes the workorder every
  user's to see** — administrator or not. The global section is the part of the
  process the whole installation shares, so which workorders are running is not a
  fact a group can own. A caller in no group at all reads it like anybody else,
  and reads the global checklist alone: the group sections they cannot reach are
  simply not there for them.
- **A workorder whose sections are all assigned is its groups' alone.** The
  membership is then what makes it theirs, and a caller outside those groups
  neither reads it nor finds it listed.
- **An administrator reads the whole registry either way**, every part of every
  workorder, through the Master's own account.

Either answer is read from the **template**, never from whether a document
happens to be readable, so a group's part that cannot be read at this instant is
not the reason a workorder disappears; a part whose document is gone is a finding
the fleet reconciles and is omitted from the view. For a part, the Master lists
`workorders/` in each group the reader is competent for — every group, for an
administrator — and matches the uid, because the name cannot be asked of the
server. A root is found in the Master's `workorders/` or in its `closed/`, since
a terminal state moves it. Nothing lists the parts in the root: the membership is
the list for a workorder that has no global section, and the template is for one
that has. The Master's own registry is the administrator's index, not the
member's — the member reaches their groups, and the globals, not the Master's
account.

The door is therefore the **server route**, not the membership: the route answers
the workorder surface as the Master and decides, per request, whether the caller
may see or act on a part by checking the **caller's own** group membership — the
decision made where the request arrives (ADR 0017). A member never holds the
document; they hold what the route serves them. Nothing on this surface is read
through a Stalwart share: a workorder is route-only, unlike the KB's company
tier, which is read through its own share (ADR 0024). Because the Master is the
only writer, the surface **degrades to read-only** when its session is
unavailable: a reader sees the last state served and a check waits, and no client
writes on its own — a rule the product keeps, not a boundary, since a member's
own session still reaches the part. A change on the rail is answered by a **read**,
never by a document: the surface follows the FileNode state of the accounts a
reader's own credential covers and a part may live in — their groups' — and, while
the panel is open, turns a change on one of them into the same route read an open
performs. The frame names an account and carries no payload, so it can leak
nothing, and what comes back is the route's own answer for that caller. Where a
document lives therefore decides who is woken by it: a check on a **group's**
checklist is a write into that group's own account, and the group's members are
woken by it as it happens; the **global** checklist and the registry are the
Master's own account, which no reader's credential covers, so the subscription the
deployment already holds on that account — fanned out to the tabs that follow it —
is what carries a change there to a reader as it happens.

### The checklist, and its signature

A workorder's checklist is **one per (workorder, group)**: a group's part holds
that group's steps, and the Master's root holds the **global** checklist — the
workorder's own steps, the template's unassigned sections.

**Whoever may see a part may check it, and the check is an act of signing.** No
role is asked for on this surface: the global checklist's readers are the
workorder's readers and they check its steps, a group's part is checked by that
group's members, and an administrator checks whatever they can read. What makes
the act accountable is the **record** rather than the permission — a checked step
carries its **last signature**, `by` taken from the authenticated session and
drawn under the check — so a reader sees who asserted it and judges whether that
is who they expected. The **agent** is a session like any other here: it checks
through the same door, with its own address in `by`.

Administration is a rule about **templates** and about nothing on this surface:
only an administrator approves a checklist template (ADR 0024 — it is what
versions the rules a workorder binds to), while a workorder's own steps are the
work's, and belong to whoever is doing it. State is operational and lives only
in the document — the root holds the global checklist, and the combined picture
is **read** from the parts, never stored beside them.

Every checklist — the global as much as a group's part — is bound to the
revision **in force** of its template when it is created (ADR 0024): a revision
approved with a future effective instant is not yet the one bound, and a template
with **no** revision in force — never approved, or its first still pending —
cannot be instantiated at all, because there is nothing to bind. The Master
chooses each template, as a reference to a template the reader may read. A
**template is a KB page whose draft carries a checklist definition** (ADR 0024,
ADR 0030): the picker offers only those, the tree marks them with a red checklist
icon, and the checklist names the page it came from. On creation the creator
chooses the **value of every variant** and the **items of every repeat that
applies**, and the applicable steps are **materialised from the definition** — a
step's path carries
its section and, for a repeat, its item, so the same step in two items is two
entries; content a condition excludes is not instantiated. The workorder's
**parts** are the groups the template **assigns sections to** (ADR 0030) — the
global checklist holds the unassigned sections, each group's part holds that
group's — so competence is read from the template rather than listed by hand at
creation. The page's steps are the controlled text; the workorder's are their
state and last signature, never a copy. A
retired template is not gone: the reference still resolves to it by id, because
its revisions are kept, and it is simply no longer in the tree; a changed
template is a new **revision** of the same page, never a new id; a change to a
**retired** template is a new article (ADR 0024). Re-binding a running checklist
is a later concern with its own gate.

A checked step carries its **last signature**, visible to the workorder's
readers: who checked it and when — unlike a KB draft's attribution, which is
private to the writer.

- **Who** is the person's own address, not the identity the group sends as (ADR
  0007) — the actor, not the From line. A step the agent checks is signed as the
  agent, which is not a person.
- **When** is an instant, rendered in the reader's locale.
- The signature is taken from the **session the server authenticated**, never
  from the request body: the Master is the writer, so the document is the only
  place a person can be named, and a name the client could assert would be worth
  nothing.
- The step keeps the **last** signature, not a trail: the latest
  `checked`/`unchecked` and who did it.

### Creation

A workorder is created **by the Master** — instructed in chat, or by an
installation administrator from the workorder surface. Creation is privileged
because the registry must be complete: it is the only enumeration, so nothing may
create a workorder the Master's copy does not know. A request made in chat is an
explicit run of a capability this adds to the fleet's closed catalogue, not a new
kind of trigger (ADR 0003, ADR 0006). A group's part is written **in that group's own
account**, so it is the group's; the Master seeds it as a member.

## Decision

A workorder is a **uid** whose root document sits in the Master's
`gilbert/workorders/` — identity, friendly name and global checklist, moved to
`workorders/closed/` when its state turns terminal — and that folder, with its
`closed/`, is the registry of every workorder; a **part** sits in the app folder
of each group competent for it, holding that group's checklist — the operational
instance of a KB template (ADR 0024) in force — and its references to that
group's own folders and files — a template may branch on the workorder's chosen
variant values, and a step is `open`, `done`, `skipped` or `not-applicable`
(ADR 0030).
Everything gathered is a reference by id; nothing
is copied and no marker is planted in a work folder. The Master does every read
and write: it composes the surface from the root and the parts, an administrator
sees every part through it, and a reader sees the global checklist and their own
groups' parts, the server route deciding what each caller may reach by the
template's assignment of its sections — a workorder carrying a global section
being every user's, and one whose sections are all assigned being its groups'
alone. A checked step keeps the last signature — who, taken from
the authenticated session, and when. Creation is the Master's or an
administrator's, and no folder tree and no per-file share beside the documents is
created.

## Consequences

- The boundary is the template's section assignments, checked by the route on top
  of the accounts the parts live in. A workorder carrying a global section is
  readable by any signed-in user; one whose sections are all assigned is its
  groups' alone; a part a reader cannot reach is simply not there for them, never
  an empty part and never a permission error. What the widening means is that the
  installation's own part of a process is not a group's secret: showing the global
  checklist while hiding the workorder that carries it would be one fact told two
  ways. A part whose document is missing is a **finding the fleet reconciles**,
  not a workorder that vanishes for its group.
- The Master's membership is load-bearing, and where it does not hold for a group
  the surface says so (ADR 0007) rather than showing an empty part.
- Because the Master writes for everybody, the document is the only record of a
  person's act: an accountability record the product keeps, not a security
  boundary, and true only because the route stamps it from the session.
- Every check is one write to a small document; `ifInState` is whole-account, so
  the route retries a lost compare-and-set rather than dropping a check under two
  writers racing.
- A request resolves what it needs **once**: one Master session, one read of the
  caller's own groups (one live session and one probe pass, not one per group) and
  one resolution of the bound template revision, shared between the view the read
  composes and the gate reconcile that follows a write — asking per group paid for
  the same answer for every group the Master holds.
- The live rail is the **FileNode state of the parts**, which is the one change a
  reader's own credential covers: the frame names an account and carries no
  payload, so the answer is a route read and visibility stays the route's decision.
  It is followed while the panel is open, and a group's checks appear to its members
  as they happen; a change to the global checklist, which lives in the Master's own
  account, reaches a member through the subscription the deployment holds on that
  account and fans out to the tabs following it — a member's own credential cannot
  cover it, so the installation's is what must.
- A closed workorder is a **document moved**, not a tree that decides: the root's
  own state is the truth, `closed/` is the projection, and a root in the wrong
  folder is a finding. The move keeps the id, costs one write, and never touches
  a group's part.
- A workorder's history is operational, not revisioned: a checked step keeps its
  last signature, so an earlier state is not kept the way a KB revision is.
- Reaching a part costs one listing of the group's `workorders/` folder per
  lookup, because the server matches no name; that is the price of the registry
  being a folder rather than an index.

## References

- `docs/adr/0024` — the knowledge base: the procedures and the checklist
  templates a workorder instantiates
- `docs/adr/0003` — the agent fleet (its `job` is a run, not a workorder)
- `docs/adr/0005` — group chat (the panel launcher's shape)
- `docs/adr/0006` — the minimal automation (one automation per trigger)
- `docs/adr/0007` — the agent as a member of every group it is granted on
- `docs/adr/0017` — administration is a door, not a menu
- `docs/adr/0030` — a checklist template branches on data, not on groups: the
  variants, the step conditions, a section's group and the step states
- `.opencode/skills/gilbert-groups/SKILL.md` — membership is the grant
