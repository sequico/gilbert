# ADR 0028 — Workorders are group-owned parts

Status: Accepted

Implementation: Built. The shape, its validators and the wire views are one
definition (`server/src/shared/workorder.ts`); the Master-owned door and its
`/api/workorders` routes are `server/src/workorderAdmin.ts` and
`server/src/app.ts`, with the boot ensure in `server/src/index.ts`; the client
reads through the route (`web/src/lib/workorder.ts`, `web/src/store/workorder.ts`)
and the surface is a factory launcher in the top bar beside chat's opening a
large panel (`web/src/views/workorder/`, `web/src/views/AppShell.tsx`). A
checklist binds to a KB template revision, resolves the applicable steps from it
(`resolveChecklist`, `server/src/shared/knowledge.ts`) and carries the per-path
steps and their states (ADR 0030).

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
- `state` — on the root: `running`, `completed`, `cancelled` or `replaced`, and
  `replacedBy` names the successor's uid when it is `replaced`.
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

When a workorder reaches a terminal state — `completed`, `cancelled` or
`replaced` — the Master moves the **root** into `workorders/closed/`, so listing
`workorders/` is the active set and listing `closed/` is what is done. The
`closed/` folder is not a bin: a terminal workorder is **kept for ever**, and
nothing destroys one. A terminal state **freezes the checklist** — a check
after the fact is refused — so the record is what was checked while the work
ran. `replaced` means another workorder succeeds it, named in
`replacedBy`, and nothing is copied from the one it replaces. The `closed/` **directory node** sits among the active
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

What a reader may reach is decided by **group membership alone**: for a part, the
Master lists `workorders/` in each group the reader belongs to — every group, for
an administrator — and matches the uid, because the name cannot be asked of the
server. A root is found in the Master's `workorders/` or in its `closed/`, since
a terminal state moves it. Nothing lists the parts in the root; the membership is
the list, and a member's workorders are the union of their groups' parts. The
Master's own registry is the administrator's index, not the member's: the member
reaches their groups, not the Master's account.

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
own session still reaches the part.

### The checklist, and its signature

A workorder's checklist is **one per (workorder, group)**: a group's part holds
that group's steps, and the group's members are who check them; the Master's root
holds the **global** checklist — the workorder's own steps, which are the
Master's to keep, checked and edited by the Master, the agent or a human
administrator. The global is only global: each group has its own checklist beside
it, and the global is nobody else's detail. State is operational and lives only
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
chooses the **value of every variant** and the **items of every repeat**, and the
applicable steps are **materialised from the definition** — a step's path carries
its section and, for a repeat, its item, so the same step in two items is two
entries; content a condition excludes is not instantiated. The page's steps are
the controlled text; the workorder's are their state and last signature, never a
copy. A
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
variant values, and a step is `open`, `done` or `not applicable` (ADR 0030).
Everything gathered is a reference by id; nothing
is copied and no marker is planted in a work folder. The Master does every read
and write: it composes the surface from the root and the parts, an administrator
sees every part through it, and a member sees the global checklist and their own
groups' parts, the server route deciding what each caller may reach by their
group membership alone. A checked step keeps the last signature — who, taken from
the authenticated session, and when. Creation is the Master's or an
administrator's, and no folder tree and no per-file share beside the documents is
created.

## Consequences

- The boundary is the group membership the route checks, on top of the accounts
  the parts live in: a part a reader cannot reach is simply not there for them,
  never an empty part and never a permission error.
- The Master's membership is load-bearing, and where it does not hold for a group
  the surface says so (ADR 0007) rather than showing an empty part.
- Because the Master writes for everybody, the document is the only record of a
  person's act: an accountability record the product keeps, not a security
  boundary, and true only because the route stamps it from the session.
- Every check is one write to a small document; `ifInState` is whole-account, so
  the route retries a lost compare-and-set rather than dropping a check under two
  writers racing.
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
  variants, the step conditions and the `not applicable` state
- `.opencode/skills/gilbert-groups/SKILL.md` — membership is the grant
