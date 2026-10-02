# ADR 0028 — Orders are group-owned parts

Status: Proposed

Implementation: Not built.

## Context

Gilbert has no place for an order. A company keeps its orders today as a
hand-made tree of folders and files in Files, one folder per order number,
maintained by hand.

What is wanted: a surface of its own, beside the KB, where an order gathers —
**by reference, never by copy** — the reference checklists, the folders, the
emails and the documents that belong to it; and every reference can be followed,
so clicking a file or a message opens it where it really lives.

Who sees what is decided by **group membership**. JMAP has no field-level
permission, so visibility is account access: a group owns the part of the order
it is competent for, and a reader sees the union of the parts their group
memberships reach.

An order's checklist is where the **KB (ADR 0024)** becomes a process: a step
names the article that says what the step means, and the order carries the
step's state. The KB is the model; the order is the instance.

## The design as it stands

### One uid, a document in each account's app folder

An order is one **uid**, and everything about it is a document named
`<uid>.gilbert` under `workorders/` in an account's `gilbert` app folder — the
hidden top-level folder the client already keeps out of the Files view
(`server/src/shared/appFolder.ts`, `web/src/lib/appFolder.ts`). No marker is
dropped in a work folder and no second hiding rule is invented: the app folder's
own name is the whole rule, and the file is stored the way every app-folder
document is.

- The **Master's** copy, in the Master's account, is the order's **root**: its
  identity, its **global checklist** and its state. It is also the **registry** —
  the list of every order and where it stands — because `FileNode/query` cannot
  filter by name and no search spans accounts, so an order nothing registers
  cannot be found at all.
- A **group's** copy, in that group's own account, is the group's **part**: the
  group's checklist and the group's references.
- The **same uid** names every copy. The account tells them apart and decides
  which role a document has, so the root and a part are one name in two places,
  not two shapes to keep in step.

### References, not copies and not markers

Everything an order gathers is a reference `{accountId, kind, id}` — a folder, a
message or a thread, a file, a KB article — never a copy and never a marker
planted in a work folder.

**The pointers by id are the truth.** A folder belongs to an order because a
reference names it, never because it sits under another folder: no per-order
folder tree is maintained, and a folder read by several orders is one reference
per order and nothing special. A reference whose target is gone resolves as
**not available** — never a broken pane — and is a **finding** the fleet
reconciles, never a silent divergence.

**One function follows every reference**, for every kind and every surface,
built on the way the client already moves (`store/mail`'s open thread,
`store/chat`'s open account; no router). It selects the target's account first,
then opens the object, and answers "not available" when the reader cannot reach
that account.

A part points at its **own group's** objects, because the part's readers are that
group's members. A pointer carries `{accountId, id}` and a title is resolved
live, only for a reader who may read the target, so a reference leaks no name.

### The surface, and who reads what

One **wide panel** beside the work — the chat launcher's shape (`store/chat.ts`:
an icon, a badge, open and close) but wide enough to work in. It lists the orders
the reader can see and holds the open order — global checklist, the reader's own
checklists, parts, references — while the rest of the app is used beside it.
Opening a reference does not leave the order: the panel stays as the context and
the main area shows the target.

The **Master does every read and every write**, because it is a member of every
group the installation grants it on (ADR 0007). It composes the full view from
its own root and the parts it can read, and it is what makes one surface possible
at all: an administrator sees every part **without being a member of every
group**, because the view served is read as the Master, while a member sees the
global checklist and the parts of their own groups.

The door is therefore the **server route**, not the membership: the route answers
the order surface as the Master and decides, per request, whether the caller may
see or act on a part by checking the **caller's own** group membership — the
decision made where the request arrives (ADR 0017). A member never holds the
document; they hold what the route serves them.

### The checklist, and its signature

An order's checklist is **one per (order, group)**: a group's part holds that
group's steps, the Master's root holds the global checklist. State is operational
and lives only in the document — the root holds the global checklist, and the
combined picture is **read** from the parts, never stored beside them.

A checked step carries its **last signature**: who checked it and when.

- **Who** is the person's own address, not the identity the group sends as (ADR
  0007) — the actor, not the From line.
- **When** is an instant, rendered in the reader's locale.
- The signature is taken from the **session the server authenticated**, never
  from the request body: the Master is the writer, so the document is the only
  place a person can be named, and a name the client could assert would be worth
  nothing.
- The step keeps the **last** signature, not a trail: the latest
  `checked`/`unchecked` and who did it.

### Creation

An order is created **by the Master** — instructed in chat, or by an installation
administrator from the order surface. Creation is privileged because the registry
must be complete: it is the only enumeration, so nothing may create an order the
Master's copy does not know. A group's part is written **in that group's own
account**, so it is the group's; the Master seeds it as a member.

## Decision

An order is a **uid** with a root document in the Master's app folder — identity,
global checklist, and the registry of every order — and a **part** in the app
folder of each group competent for it, holding that group's checklist and its
references to that group's own folders, messages and files, and to KB articles.
Everything gathered is a reference by id; nothing is copied and no marker is
planted in a work folder. The Master does every read and write: it composes the
surface from the root and the parts, an administrator sees every part through it,
and a member sees the global checklist and their own groups' parts, with the
server route deciding what each caller may reach. A checked step keeps the last
signature — who, taken from the authenticated session, and when. Creation is the
Master's or an administrator's, and no folder tree and no per-file share beside
the documents is created.

## Consequences

- The boundary is the group membership the route checks, over the membership
  Stalwart already enforces on the accounts the parts live in: a part a reader
  cannot reach is simply not there for them, never an empty part and never a
  permission error.
- The Master's membership is load-bearing, and where it does not hold for a group
  the surface says so (ADR 0007) rather than showing an empty part.
- Because the Master writes for everybody, the document is the only record of a
  person's act: an accountability record the product keeps, not a security
  boundary, and true only because the route stamps it from the session.
- Every check is one write to a small document; `ifInState` is whole-account, so
  the route retries a lost compare-and-set rather than dropping a check under two
  writers racing.
- An order's history is operational, not revisioned: a checked step keeps its
  last signature, so an earlier state is not kept the way a KB revision is.

## Open questions

- How an order is archived, and what the archive is — whether a finished order
  stays in the registry, and what the registry shows of it.
- The document's exact schema, and the reference kinds it carries first.
- The capability by which a chat instruction creates an order, in the fleet's
  closed catalogue (ADR 0003).
- Whether the surface degrades read-only when the Master's session is
  unavailable, since it is the only writer.

## References

- `docs/adr/0024` — the knowledge base: the procedure a checklist step follows
- `docs/adr/0003` — the agent fleet (its `job` is a run, not an order)
- `docs/adr/0005` — group chat (the panel launcher's shape)
- `docs/adr/0007` — the agent as a member of every group it is granted on
- `docs/adr/0017` — administration is a door, not a menu
- `.opencode/skills/gilbert-groups/SKILL.md` — membership is the grant
