# ADR 0013 — An automation can be run by a person, now

Status: Proposed (2026-09-12)

## Context

A rule has four triggers (ADR 0003): an email arriving, a file changing,
somebody writing in the group's chat, and a time coming round. Three of them a
person can bring about deliberately — mail the group, mention the agent in its
chat, write a rule whose clock is a minute away. The fourth, mail arriving, is
the one nobody can stage: it depends on somebody else sending something, and an
installation whose agent has just been given a group has no way to see whether
anything works until real mail happens to arrive.

The gap is worse than slow feedback. A rule that never ran and a rule that
cannot run read identically on the surface: both are a document with an
`enabled` flag, and the difference between "it is not armed", "its filter
matches nothing", "no worker holds this group" and "it ran and did nothing" is
only discoverable afterwards, if at all. What an operator needs is the one
thing that answers all four questions at once: run it on a message I name, and
show me what happened.

## Decision

**A person can ask for one automation, on one message.** The admin surface's
Automations tab gains *Run now* beside each rule; the route resolves the group,
the rule and the message, and writes a **job** — the same document, in the same
states, that every other trigger writes.

**It runs on the rule's own terms. Nothing is bypassed.** The worker holding the
group's claim picks the job up on its next pass and runs it exactly as it runs
an arrival: the capability allowlist, the review policy, the version pin and the
audit entry are the ones already in force. A run asked for by a person meets the
rule it names; it does not replace it.

**The ask is a job's provenance, never a rule's trigger.** `AgentTriggerRecord`
carries a fifth value, `manual`, and `AgentTriggerOn` — what a rule may be woken
by — keeps its four. An automation that only runs when somebody asks is a habit,
not a document: a rule that could carry it would have to say what it acts on,
which is what its trigger already says.

**The message is the one named, or the newest in the group's own inbox.** An ask
that names none is asking "does this work at all", and the message a person just
sent or just received is the one they have in mind. Drafts are excluded for the
reason the executor excludes them: a draft is work in progress, and a run that
prepares one would be the first thing found here.

**The rule's filter still decides.** The ask reads the message and matches the
rule's own filter against it, through the same matcher the executor uses; a
message the filter passes over is answered as exactly that, which is one of the
four questions above. A filter the executor cannot evaluate is refused in the
words the form refuses it in.

**A refusal is answered to the person, and written nowhere else.** An
unarmed rule, an automation that is not about mail, no message to run on, a
message the filter does not match: each is a sentence for whoever asked, who can
act on it. None of them is written into the group's audit, because none of them
is a run that happened — the audit is the record of what the agent did, not of
what somebody tried. This is the one place the manual door differs from the
executor's own refusals, which do write an audit line: those are refusals of a
real trigger, and a group whose automation silently stopped is a fact its
members live with.

**The door is mail's, because mail is the one without one.** A chat automation
is already asked for by mentioning the agent in the group's chat; a timed one by
its own clock; a file one by changing a file. What the manual ask answers is the
trigger nobody can stage by hand.

## Consequences

- The answer is a job id, and the run is the worker's: a deployment whose poll
  interval is a minute shows the open run up to a minute later, and the surface
  says where the outcome is read rather than pretending to have it. The interval
  is a deployment's own knob (`GILBERT_AGENT_POLL_MS`).
- A manual ask needs a worker holding the group — the fleet is the only
  executor, and a claim is what fences work (ADR 0003 §6). An installation with
  no worker gets a job that waits, which is the honest state and is visible as
  one: the Workers tab says which groups are held, and a job that never leaves
  `pending` is the same fact.
- A manual ask is its own deduplication identity — the instant it was asked at,
  not the message it names — so the same message can be run twice on purpose.
  Every other trigger keeps the identity of the thing that woke it, and the
  reason for that difference is the one it is for: a re-read change is not a
  second event, and a person pressing a button twice is two asks.
- The run is indistinguishable from a real one in the audit except by its
  trigger line, which says it was asked for. Anything that reads the trail can
  tell a rehearsal from an arrival, which matters the first time somebody asks
  whether an automation acts on its own.
- Nothing here grants a person the ability to make an automation do something
  the automation could not do: the rule's own capabilities, review and consent
  floor bound it. A manual run of a rule that sends mail still stops for the
  approval a real run would stop for.

## Alternatives considered

- **A `manual` trigger on the rule document.** Rejected: it makes a rule say
  both that it runs when asked and that it runs on a message, and the document
  has no place for the second half. The trigger is what wakes it; what it acts
  on is what its trigger kind already implies.
- **A dry run that plans without acting.** Rejected as the first door: it
  answers "what would it do" but not "does it work", and it needs every action
  in the catalogue to describe itself without running — a property of the
  capability catalogue rather than of the trigger, and a larger change than the
  question it answers. It remains the right second door.
- **Firing the run from the web tier instead of writing a job.** Rejected: the
  claim is the fence that keeps one run from becoming two (ADR 0003 §6), and a
  web tier that executed work would run outside it — the double execution the
  fence exists to prevent, in the tier that has no lease at all.
- **Skipping the filter, so a person only has to pick a rule.** Rejected: the
  filter is where "why did nothing happen" usually lives, and a door that ran
  past it would turn the most common real fault into a successful test.
- **Writing every refusal into the group's audit.** Rejected: the trail would
  fill with attempts, and the one line that matters there — the run — would have
  to be found among them.

## References

- ADR 0003 — the fleet: the rule, the four triggers, the job, the claim, the
  capability allowlist, the review policy and the consent floor
- ADR 0012 — the server runs a worker beside itself, which is what lets a
  deployment answer an ask without a second command
- `server/src/agentAdmin.ts` — `runRuleNow`
- `server/src/app.ts` — `POST /api/admin/groups/:name/agent/run`
- `web/src/views/admin/agent/RuleEditor.tsx` — *Run now*
