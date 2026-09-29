# ADR 0028 — Orders are group-owned parts

Status: Proposed

Implementation: Not built.

> A stub, recorded before the design is settled. It states the shape reached so
> far and leaves the rest in **Open questions**; it is rewritten in place as
> they are answered. The knowledge base is a separate decision (ADR 0024).

## Context

Gilbert has no place for an order. A company keeps its orders today as a
hand-made tree of folders and files in Files, one folder per order number,
maintained by hand.

What is wanted: a surface of its own, beside the KB, where an order gathers —
**by reference, never by copy** — the reference checklists, the emails and the
files that belong to it; and every reference can be followed, so clicking a file
or a message opens it where it really lives.

Who sees what is decided by **group membership and nothing else**. JMAP has no
field-level permission, so visibility is account access: a group owns the part
of the order it is competent for, and a reader sees the union of the parts the
groups they belong to own (`gilbert-groups`).

## The design as it stands

### The surface

One **wide panel** — the chat launcher's shape (`store/chat.ts`: an icon, a
badge, open and close) but wide enough to work in. It lists the orders the
reader can see and holds the open order — checklist, parts, references — while
the rest of the app is used beside it. Opening a reference does not leave the
order: the panel stays as the context and the main area shows the target.

### References and navigation

Everything inside an order is a reference `{accountId, kind, id}` — a message or
a thread, a file or a folder, a KB article — and never a copy. One function
follows a reference, for every kind and every surface, built on the way the
client already moves (`store/mail`'s open thread, `store/chat`'s open account;
no router). It selects the target's account first, then opens the object, and
answers "not available" when the reader cannot reach that account — never a
broken pane.

### The folder tree is a projection, not a second source

The placement of files in a per-order folder survives as a **code-maintained
projection** of the order's pointers — the same filing a person does today, done
automatically, and legible without Gilbert. It is not a second source of truth:
the **pointers by id are the truth**, the tree never decides what belongs to an
order, and a file found in the tree without a pointer (or the reverse) is a
**finding** the fleet reconciles, never a silent divergence. The projection lives
in the owning group's visible Files, moves rather than copies, and is only as
current as the last run that wrote it.

### Cross-group references

A part points at its **own group's** objects, because the part's readers are that
group's members. Storing a reference into another account is possible but
resolves only where the memberships overlap; the pointer carries `{accountId,
id}` and a title is resolved live, only for a reader who may read the target, so
a reference leaks no name.

## Decision

An order is **a shared reference and a set of parts**, each part owned by the
account of the group competent for it. A part points at that group's own emails,
files and checklist state, and at the procedure it follows; nothing is copied. A
reader's view is the union of the parts their group memberships reach; an
installation administrator sees every part by being a member of every group. The
surface is a panel beside the work, the folder tree is a projection of the
pointers, and no central document and no per-file share is created.

## Consequences

- The boundary is group membership, which Stalwart already enforces — not a rule
  the client keeps.
- A part a reader cannot reach is simply not there for them, never an empty part
  and never a permission error.
- A cross-group step is a hand-off, not a shared document: a group never edits
  another group's part.
- The projection costs a move per association and can lag; it is kept because an
  association legible without Gilbert is worth it.
- Order management is its own surface; the KB (ADR 0024) is the checklist model
  it points at, not part of this decision.

## Open questions

- The word and the store path (`order`/`orders`; not `job`, which the fleet has
  taken for a run), and the owning account per kind of workflow.
- How an order is born, how its reference is assigned, and how a reader
  enumerates the orders they can see.
- The grain of a reference — thread or message, folder or node — and how a part
  is populated (automatically or by hand).
- The checklist instance: which group's part carries which step's state.
- The hand-off between groups, and what the receiving group is told.

## References

- `docs/adr/0024` — the knowledge base (the procedure a checklist follows)
- `docs/adr/0003` — the agent fleet (its `job` is a run, not an order)
- `docs/adr/0005` — group chat (the panel launcher's shape)
- `.opencode/skills/gilbert-groups/SKILL.md` — membership is the grant
