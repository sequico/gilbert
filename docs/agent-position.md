# Where Gilbert's agent stands — 2026-10-22

A judgement of the tree against the field, kept because it names the next work
better than a feature list does. The parts are a person's words, written after
reading the session that rebuilt the agent on ADR 0038.

## Where we are ahead

- **A change is a run, keyed by the change**: real idempotence, resumption from
  the document after a crash, a cursor that survives a restart. Many
  state-of-the-art agents lose the thread at every restart.
- **Structural permissions, not prompt permissions**: reading is free, writing
  needs a declared area. It is a boundary the model cannot negotiate, not a
  sentence it can ignore.
- **Everything outward is a draft a person sends.** Human-in-the-loop is
  mandatory, not optional: that is ahead of most products.
- **Budget and endings are explicit**: steps, calls, milliseconds; `blocked`,
  `refused`, `out-of-budget` are distinct. Silence is not an ending.
- **An eval whose expected outcome is written first and whose cost is measured**:
  almost nobody does it, and the 171-run corpus is a rare asset.
- **No database of our own**: everything durable in Stalwart, the container
  immutable.

## Where we are behind

- **The measure's reliability.** The eval prints `pass@1` with one retry of a
  failure, not `pass^k`: one task of ten answering only on the retry is already a
  signal that a single run overstates. τ-bench is the reference, and the number a
  person experiences is the repeated one.
- **The judge's independence and calibration.** The judge fires only on a suspect
  plan, which is right, but it runs on the installation's own model — the one
  that wrote the report — and has no human sample behind it. The literature is
  explicit on both counts: a judge should not grade its own family, and an
  uncalibrated judge is an opinion with a schema.
- **The memory's read cost.** The index is rebuilt from `memory/` on every pass
  that needs it: correct, and O(facts) per pass up to the 5 000 cap. The tree
  already has the pattern that avoids it (the run listing's FileNode state).
- **The provider's schema is advisory where it matters.** The live provider
  refuses `json_schema` and accepts `json_object`; the discriminator is now
  required, the rest is the endpoint parser's door. That is honest, and it means
  the model can still pay for an argument the schema could have refused.
- **Trajectory checks are implicit.** The guard forbids the act and the run's
  record holds every step, but nothing prints "tool calls valid / step budget /
  forbidden action touched" as a measure of its own.

## Verdict

The contact is no longer the bottleneck: eight job-shaped tools, native function
calling as the only protocol, a structured decision turn, a repairable refusal and
a schema with one branch per value. In the architecture of boundaries —
permissions, drafts, idempotence, budget, audit — we are solid, and in places (a
mandatory draft, eight jobs, a temporal memory, an eval born from the corpus)
ahead. What is behind is **measurement and independence**: a judge that shares its
subject's model, a reliability number not yet repeated, and a memory that is read
whole. Those are smaller than the contact was, and they are measurable with the
instrument that now exists.
