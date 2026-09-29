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
files that belong to it.

Who sees what is decided by **group membership and nothing else**. JMAP has no
field-level permission, so visibility is account access: a group owns the part
of the order it is competent for, and a reader sees the union of the parts the
groups they belong to own. This is the same grant every group feature already
uses (`gilbert-groups`).

## Decision

An order is **a shared reference and a set of parts**, each part owned by the
account of the group competent for it. A part points at that group's own
emails, files and checklist state, and at the procedure it follows; nothing is
copied. A reader's view is the union of the parts their group memberships
reach; an installation administrator sees every part by being a member of every
group. No central document and no per-file share is created.

## Consequences

- The boundary is group membership, which Stalwart already enforces — not a rule
  the client keeps.
- A part a reader cannot reach is simply not there for them, never an empty part
  and never a permission error.
- A cross-group step is a hand-off, not a shared document: a group never edits
  another group's part.
- Order management is its own surface; the KB (ADR 0024) is the checklist model
  it points at, not part of this decision.

## Open questions

- The word and the store path (`order`/`orders`; not `job`, which the fleet has
  taken for a run), and the owning account per kind of workflow.
- How an order is born, how its reference is assigned, and how a reader
  enumerates the orders they can see.
- Emails as thread references and files as node or folder references; how a part
  is populated (automatically or by hand).
- The checklist instance: which group's part carries which step's state.
- The hand-off between groups, and what the receiving group is told.

## References

- `docs/adr/0024` — the knowledge base (the procedure a checklist follows)
- `docs/adr/0003` — the agent fleet (its `job` is a run, not an order)
- `.opencode/skills/gilbert-groups/SKILL.md` — membership is the grant
