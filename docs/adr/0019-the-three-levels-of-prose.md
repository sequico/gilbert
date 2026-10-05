# ADR 0019 — The three levels of prose

Status: Accepted

Implementation: Not built. The code is present in the tree but the agent part
does not work; a refactor is planned (see `ROADMAP.md`).
`AgentProseDoc`/`AGENT_PREAMBLE_FILE`/`AGENT_INSTRUCTION_FILE`
and `proseFor` in `server/src/agent/documents.ts`; `AgentStore.readProse`/
`writeProse` in `server/src/agent/store.ts`; `preambleBlock`/`proseHead` in
`server/src/agent/llm.ts`; `readAgentProse`/`saveAgentProse` and the two routes
in `server/src/agentAdmin.ts` and `server/src/app.ts`; `ProsePanel.tsx`,
`AgentPreamble`'s place in `AdminAgents.tsx` and `GroupInstruction.tsx` in the
web tree.

An agent is told what to do in prose, and there are three places that prose
comes from. They are not three kinds of thing: they are the same thing — a page
of sentences a person wrote for the agent to work by — at three reaches. What
this record fixes is that there are three, that they are one shape, where each
one lives, and the order they reach the model in.

## Decision

**The prose an agent carries is three documents at three reaches, and they are
read in one order.**

| Level | Document | Written in | Reaches |
|---|---|---|---|
| The installation's own rules | `agent/preamble.json` in the Master's account | Admin → Master | every call of every group this installation serves |
| A group's standing instruction | `agent/instruction.json` in the group's account | Group Agents → Instruction | every call of that group's agent |
| An automation's instruction | the `instruction` field of a rule | the automation, beside its trigger | the runs of that automation |

The order is the order of reach, outermost first: the installation's rules, then
the group's own facts (its notebook — a document of *facts*, not of prose, and so
not one of these three), then the group's standing instruction, then the
automation's instruction, and last the volatile content the run is about. One
builder produces that order — `proseHead` in `llm.ts` — and both callers use it:
a run's decision (`decideActions`) and an administrator's reading of a draft
(`readDraft`). A reading is a judgement of a draft against what the agent would
actually be told, so a reading asked under a different head would be a reading
of something nobody runs.

**The three levels are one shape, and there is one reader for it.** The
installation's rules and a group's instruction are the same document type
(`AgentProseDoc`: text, and who last wrote it) read and written by the same pair
of functions. They differ in the account they live in and in how far they reach,
never in what they are. The automation's instruction is a field rather than a
document because it is authored with the automation and has no life of its own.

**None of them grants anything.** Every level says how to work; what a run may
do is its own capability allowlist, checked on every answer the model gives
(ADR 0003, ADR 0006). The sentence is on each screen where a person writes one,
because a person writing house rules needs to know that they are steering and
not licensing.

## Why three, and not one

One text would be simpler and would fail at the first installed group whose work
differs from the next one's. The levels answer three different questions and
change at three different rates:

- the **installation's** rules are what the company states once — the language
  it answers in, the way it names documents, what it never does unasked — and
  they should not have to be copied into every group's instruction to be true
  everywhere;
- the **group's** instruction is what is true of one team's work and untrue of
  another's;
- the **automation's** instruction is what is true of one trigger's job — the
  branching between one case of mail and another, which ADR 0006 decision one
  puts here deliberately.

They also sit in the prompt's **stable head** (ADR 0003): the prose is the same
from call to call, so a provider's context cache can serve it nearly free, and
what a run actually pays for stays the volatile tail. Adding a level costs a
cache hit, not a per-run price — which is exactly the trade ADR 0006 decision
three refuses to make with raw correspondence.

## What is deliberately absent

- **No author's notes beside the prose.** The two documents carried a free-text
  field for remarks aimed at the next editor, read by no model. It was a fourth
  and fifth level of prose that nothing read, and the reasoning it held belongs
  in the sentence that states the rule.
- **No grant, at any level.** A level that could widen what an automation may do
  would be a second enforcement door, and ADR 0003 keeps one: the allowlist,
  checked in code against every answer the model gives.
- **No per-group override of the installation's rules.** A group that disagrees
  with them says so in its own instruction; the alternative — a merge strategy
  for two documents of prose — would make "what was this agent told" a question
  nobody could answer by reading one page.
- **No versioning, and no history.** A document is edited in place and the
  version it replaced is git's, exactly as every other document in this product
  is. Each carries who last wrote it and when, which is what a reader actually
  asks.

## Consequences

- What an agent was told is readable in three places, and "where do I change
  that" has one answer per kind of statement: installation-wide, group-wide, or
  this automation's own.
- A reading spends the same tokens a run does on the same head, so the authoring
  bound (ADR 0003) applies to it unchanged.
- The installation's rules are read on every run of every group, so they are one
  more document the Master's account is asked for per run. It is one read of a
  file already in the account the executor holds a session on, and it sits in
  that same cached head.
- An installation that writes no preamble behaves as it did before one existed:
  `preambleBlock` answers `""` for absent or empty prose and `proseHead` drops
  it, so nothing about the prompt changes for a deployment that says nothing.

## References

- ADR 0003 — the rule shape, `planFor` → `decideActions`, the fixed prompt
  order and the caching argument for it, the reading helper
- ADR 0006 — one automation per trigger, the areas, the group's policy
- `server/src/agent/documents.ts` — `AgentProseDoc`, `isAgentProseDoc`,
  `proseFor`, `AGENT_PREAMBLE_FILE`, `AGENT_INSTRUCTION_FILE`,
  `AGENT_INSTRUCTION_MAX`
- `server/src/agent/llm.ts` — `preambleBlock`, `notebookBlock`, `standingBlock`,
  `proseHead`
- `server/src/agent/executor.ts` — `planFor`, where the three documents are read
  once per run and handed to the call
- `server/src/agentAdmin.ts` — `readAgentProse`, `saveAgentProse`, `readDraft`
- `server/src/app.ts` — the two routes the prose is reached by
- `web/src/views/admin/agent/ProsePanel.tsx` — the one component both scopes are
  written and read with
