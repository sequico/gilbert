# Plan — ADR 0038 in the tree

Status: **in progress, on branch `agents-reloaded`**. The server carries the new
shape; the client still draws the old one. Each block lands green and on its own.

The gate is the project's own (`npm run check:ci`) at every push, and the measure
is the eval set of ADR 0038 — tasks taken from the runs that failed, judged on
whether the work is accepted and what it cost in calls and refusals.

## Done

1. **The areas exist and select the catalogue.**
   `shared/areas.ts` (the vocabulary both tiers read) and `agent/areas.ts` (which
   tool is in which area, and the selection): a run is handed the areas its
   instruction declares and its matrix names, plus chat, knowledge and memory;
   **reading is free, a write needs its area**. Wired into the turn that chooses,
   with the invariant test that a surface turned off takes its writings out.
2. **One instruction is the document.** `InstructionDoc` v2 — prose, areas, the
   surface matrix, and whether it sends — with the v1 document an installation
   already wrote still read, upgraded in memory. `GET /admin/groups/:name/prose`
   returns it; the `PUT` accepts the areas and refuses one nobody has.
3. **The rules are gone.** `rule.ts`, `rules.ts`, `shared/rule.ts`, their tests
   and their endpoints are deleted. The decision turn no longer names rules: it
   is told the change and answers what the change is about. A change is the
   group's when its area is declared or its surface is `watch`; a run is keyed by
   its change, and a group with no instruction gets a notice in its conversation.
   `prose.ts` carries two levels, not three.

## Next

4. **The client.** `GroupRules.tsx` and `agentProse.ts` go; Administration shows
   one instruction with its areas; the run card speaks of areas and changes, not
   rules. The strings move in the eleven catalogues, or `i18n:check` fails.
5. **The documents.** `FEATURES.md` and `README.md` lose what the tree no longer
   does (rules, the poll, the 45-tool catalogue). `docs/adr/0038` goes
   `Accepted` when the owner accepts it.

## Owed, and named so it is not forgotten

- The **migration**: an installation with `rules/*.json` has docs the tree no
  longer reads. They are inert, and the instruction a group writes now is what
  counts; a reader that folds them into the instruction is owed before a release
  that ships this to an installation that has them.
- The **eval set** (ADR 0038): the 15–20 tasks taken from the 171 measured runs
  are not written yet, so no block above has a score.
- The **judge on `done`** and the `refused` ending (ADR 0038, 0030): the record
  can carry `refused`; nothing writes it yet.
