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

- **The catalogue**: 45 endpoint-shaped tools, with contracts the model does not
  read. The 48 `"id" must be text`, 42 `"fact" is too long` and 9 invented tool
  names say it: the bottleneck is not reasoning, it is the interface. The
  state of the art is few job-shaped tools, a narrow schema, a repairable error.
  This is gap number one.
- **The judge on the evidence is missing**: a `done` with one refused step and
  one successful step still passes. The corpus says that is 51% of the
  successes.
- **The protocol is not native function calling**: it is JSON in the text, and
  that is the mechanical cause of most of the format refusals.
- **The measure is newborn**: 3 tasks of 10, not in CI, no history yet.

## Verdict

In the architecture of boundaries — permissions, drafts, idempotence, budget,
audit — we are solid, and on some points (a mandatory draft, areas, an eval born
from the corpus) ahead. In the model↔tools contact we are one generation behind:
that is where the next work goes, and now we have the instrument to measure it.

So: not state of the art in absolute terms — state of the art in the skeleton,
first generation in the contact. It is a better base than the average, with a
known and measurable bottleneck.
