# Plan — ADR 0038 in the tree

Status: **in progress, on branch `agents-reloaded`**. The server and the client
carry the new shape; the eval set and the job-shaped catalogue are still owed.
Each block lands green and on its own.

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
4. **The old documents are cleared once.** `agent/legacy.ts` removes `rules/`
   and `agent/rules.json` from an account, writes `agent/reset-0038.json` so it
   happens once, and touches nothing else — the instruction, the runs, the
   cursors and the memory are the group's present. The loop calls it per account
   before anything reads the account (owner decision 2026-10-22: agents-reloaded
   starts from scratch, no residue).
5. **The client says the new words.** `GroupRules.tsx` and the rules calls are
   gone; `GroupInstruction.tsx` shows the prose and a checkbox per area, under
   Administration → AI Agents → Instruction. The `@gilbert/agent` alias the
   browser no longer needs is removed from both configs, and the six stale i18n
   keys are out of the eleven catalogues.
6. **The documents follow the tree.** `FEATURES.md` and `README.md` describe one
   instruction, the areas, the run keyed by its change and the one-off clear.
7. **A `done` stands on its plan, and a tool's answer is filtered.**
   `loop.ts` sends back once a `done` that carries no finished step or a refused
   step the run has not been told about, and a second one with nothing finished
   ends the run `refused` — the ending that had a reader and no writer. Every
   tool answer is emptied of a credential-shaped field before it reaches the turn
   or the record (`agent/redact.ts`), and the step says what was withheld.

## Owed, and named so it is not forgotten

- The **eval set** (ADR 0038): the 15–20 tasks taken from the 171 measured runs
  are not written yet, so no block above has a score.
- The **judge that reads the ask and the evidence against the plan** (ADR 0038):
  the guard reads the plan alone, so a `done` that stands on a refused step while
  a later step succeeded still passes.
- The **job-shaped catalogue** (ADR 0038): the tools are still the endpoint
  catalogue under area prefixes; the eight job-shaped tools are not written.
