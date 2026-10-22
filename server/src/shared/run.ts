/**
 * The run's durable format (ADR 0030) — one definition, both tiers.
 *
 * A run is one document in the **group's own account**: `<id>.json` under
 * `runs/` in that account's `gilbert` app folder, addressed by
 * `server/src/agent/runs.ts`. It is the whole of the agent's durable state —
 * which rule or which instruction started it and which change in the account
 * woke it, the plan — each step, what it waits on and how it left it, so a
 * reader of the record alone can say why a step ran and why one did not —
 * the objects it touched, what it waits for, where it asked a person and until
 * when, which facts of the installation's memory its calls carried (ADR 0033),
 * every authorisation with the sentence it arrived in, the authority that
 * was given and the act it is for, the evidence behind what it claims, the
 * budget it has spent,
 * and the state it is in. A **wait is a date in this document** — a dated wait for
 * an instant, and the deadline a question to a person carries (ADR 0029, 0030) —
 * not a timer in a process, so the agent re-arms the waits it finds when it
 * starts and a container that dies mid-run loses nothing.
 *
 * This module is the shape, its parser and the pure transitions over it: no
 * I/O, so what a transition does is answerable in a test without a server, and
 * the client can read the same document the agent wrote.
 *
 * A stored run is a contract: every field below is written by one build and
 * read by the next, and a field that moves moves with every reader and writer
 * of it.
 */

import { errorDetail } from "./errors.js";
import { isInstant, isRecord } from "./json.js";
import type { Recall } from "./memory.js";
import { isSurfaceMatrix, type SurfaceMatrix } from "./surfaces.js";
import { isWorkorderRef, type WorkorderRef } from "./workorder.js";

/**
 * The schema this build writes and reads. A document of another version is
 * refused, so a field of the shape below moves this with it — the version is
 * how the change reaches a run an installation has already written.
 */
export const RUN_VERSION = 6;

/**
 * The most steps one run may take (ADR 0027).
 *
 * A ceiling of the loop's own, not a field of the run: a run measured against a
 * ceiling it carried itself is a run that could raise it. It is also the most
 * steps one answer may carry — a plan larger than the whole budget is refused
 * rather than run past it.
 */
export const RUN_STEPS_MAX = 20;

/**
 * The versions before this one, which this build reads as well.
 *
 * `recalled` was added by version 5 (ADR 0033) and `retrieval` by this one
 * (ADR 0038), and a **known** older version is read with the fields it does not
 * carry defaulted — an installation that ran an earlier build has runs on its
 * accounts, and refusing them would stop every pass before it worked a change,
 * forever, with no surface to delete them from: the version exists to carry a
 * change to those runs, never to orphan them on an upgrade. A version this build
 * does not know stays refused, because a document written by a newer Gilbert may
 * carry a field whose meaning changed, and reading it as though it had not is
 * worse than saying so.
 */
const RUN_VERSION_WITHOUT_RETRIEVAL = 5;
const RUN_VERSION_WITHOUT_RECALLED = 4;

/**
 * A step's state: `open` until it leaves the plan, and the three ways it can.
 *
 * "skipped" is the one that did not run: a step whose dependency ended in a way
 * no branch of the plan names is left unrun, and its record says which step and
 * which outcome left it (ADR 0030).
 */
export type RunStepState = "open" | RunStepOutcome | "skipped";

/** How a step ended: it worked, or it did not. A branch names one of these two. */
type RunStepOutcome = "done" | "failed";

/** The three ways a run ends (ADR 0030): done, a person is needed, or the budget is spent. */
/** The three ways a run is finished, and the two that are not an ending. */
export type RunEnding =
  | "done"
  | "blocked"
  | "out-of-budget"
  | "cancelled"
  /** A guardrail fired: the run stopped itself, and the record says which check. */
  | "refused";

/** A run's state: in flight, or one of the three endings. */
export type RunState = "running" | RunEnding;

/** The channel a sentence sits in (ADR 0029): the group's chat, or mail. */
type RunChannel = "chat" | "mail";

/** The sentence an instruction or an authorisation arrived in, per its channel. */
export interface RunMessageRef {
  channel: RunChannel;
  /** The channel's own correlation: a mail message id, or a chat node id. */
  id: string;
}

/**
 * Which authority a person gave (ADR 0028): the word for something irreversible
 * or destructive (class 2), the word that sends outward — or the rule that
 * declared it sends (class 3) — or the administrator's override of the written
 * policy (class 4). The class the agent decides alone, and the intent, which is
 * approved where ADR 0020 puts it, are not authorisations.
 */
export type RunAuthority = "destructive" | "outward" | "override";

/**
 * What started a run (ADR 0027, 0031, 0038): the group's standing instruction,
 * which is woken by a change in its account, or a sentence a person wrote.
 */
interface RunStart {
  /**
   * The rule's document name: null in every run this build writes, since a group
   * has one instruction and no rules. Kept because a run document already in an
   * account names one, and the record is read as it was written.
   */
  rule: string | null;
  /** The sentence a person wrote; null when a change woke the instruction. */
  instruction: RunMessageRef | null;
  /**
   * The change in the group's account that woke the instruction, in the group's
   * own words; null when a person's own sentence started the run.
   *
   * A change wakes the instruction, and the run has to say which change, or a
   * process that takes the run over cannot tell what it is answering. The words
   * are the loop's, composed from the event's own surface, change and address.
   * The change a run names is also what the loop reads a change once by: a run
   * already naming it is the change being worked or the answer it already has,
   * never a reason for a second run (ADR 0038).
   */
  woke: string | null;
  /**
   * The files a batched drop brought, when the run answers one (ADR 0034).
   *
   * The run is told the names it is answering, not only the folder: the change
   * turn saw the whole drop, and the run that works it must not have to list the
   * folder again to know what arrived.
   */
  batch?: readonly string[];
  /**
   * The address whose message woke a rule that sends, as the change carried it.
   *
   * Kept for the record a run already wrote; an outward act is a draft a person
   * sends (ADR 0041), so nothing licenses a send from it.
   */
  wakeFrom?: string | null;
  /**
   * The surface matrix the group's instruction carried when the run opened
   * (ADR 0038): what it may write on, and what woke it. A run written before the
   * matrix carries none, and may write where it did before.
   */
  surfaces?: SurfaceMatrix;
  /**
   * What woke it, in the words of the thing that woke it (ADR 0031).
   *
   * `woke` names the change; this says what the change *said* — the chat message
   * a person typed, the subject of the mail that arrived, the files a drop
   * brought, the event a calendar change renamed. It is captured **when the run
   * opens**, from what that pass read: the record is the arbiter of what
   * happened, and a message edited a week later does not rewrite the reason a run
   * exists. A document written before this field carries none, and its readers
   * fall back to `woke`.
   */
  about?: string;
  /**
   * Who set that change off, when the change names a person.
   *
   * The sender of the message that woke the rule. The change log names no actor
   * for a FileNode or a calendar write, so a files or calendar run carries none:
   * the field says who, and never guesses at a name the event did not state.
   */
  by?: string;
}

/**
 * What a step waits on: the step of the same plan it follows, and the outcome it
 * needs that step to have ended with (ADR 0030).
 *
 * A step with no `needs` is ready as soon as the run reaches it. One that names
 * a step is ready once that step has ended with its `when`, and is left unrun
 * once that step has ended any other way — because the branch this step is for
 * did not happen.
 */
export interface RunStepNeeds {
  /** The index in the plan of the step it waits on. */
  step: number;
  /** The outcome that step must have ended with for this one to run. */
  when: RunStepOutcome;
}

/** One step of the plan: what it is, what it waits on, and how it ended. */
export interface RunStep {
  what: string;
  state: RunStepState;
  /** What actually happened, "" until the step leaves the plan. */
  outcome: string;
  /** What it waits on, or null when it is ready as soon as the run reaches it. */
  needs: RunStepNeeds | null;
  /**
   * Whether this step said something in the group's conversation.
   *
   * It is what `spoke` reads: a `say` with the `say` action that ended done has
   * been heard by the people who asked, and repeating the ending beside it would
   * be two messages for one piece of work. A `say` with the `ask` action asks
   * something and says nothing about what was done, so it does not count — which
   * is the difference between a run that reported and one that only has a
   * question open (ADR 0030).
   */
  spoke?: boolean;
}

/** What a run waits for, where it asked, and until when (ADR 0029, 0030). */
export interface RunWait {
  /** What it waits for, in words. */
  what: string;
  /** The sentence it asked in: the message or chat node an answer comes back in. */
  asked: RunMessageRef;
  /** The instant the wait comes due, ISO 8601. */
  until: string | null;
}

/**
 * A question a run has open on a person, in the conversation (ADR 0029, 0038).
 *
 * The chat draws it, and the run that asked is the one an answer continues: the
 * message is the sentence a reply must answer, so the surface that highlights it
 * and the loop that reads the answer point at the same one.
 */
export interface OpenQuestion {
  /** The run waiting on the answer. */
  runId: string;
  /** The chat message the question was asked in, which an answer replies to. */
  messageId: string;
  /** The question, in the run's own words. */
  question: string;
}

/**
 * The questions these runs have open on a person **in the conversation**.
 *
 * A run blocked on a mail wait was written by an older build (a question leaves
 * only as a draft now, ADR 0041) and is not a chat question; a run that ended is
 * not waiting. One per run, in the order the documents were read.
 */
export function openQuestionsOf(
  runs: readonly {
    id: string;
    state: RunDoc["state"] | null;
    waiting: RunWait | null;
  }[],
): OpenQuestion[] {
  const questions: OpenQuestion[] = [];
  for (const run of runs) {
    if (run.state !== "blocked") continue;
    const asked = run.waiting?.asked;
    if (!asked || asked.channel !== "chat") continue;
    questions.push({
      runId: run.id,
      messageId: asked.id,
      question: run.waiting?.what ?? "",
    });
  }
  return questions;
}

/**
 * The act an authority is given for (ADR 0028), read from what the act reaches
 * and what it carries.
 *
 * The bound ADR 0028 draws: "an instruction that asks for a send authorises
 * **that send and no other**". A class is not an act — a run that carried one
 * outward authority would otherwise send to anybody, once, and the record could
 * not tell one send from the next. So the authority a person gave names the act
 * it is for, and the guard compares the act a tool is about to take against it.
 */
export interface RunAuthorityAct {
  /** What the act reaches: the address a send goes to, or the object it acts on. */
  target: string;
  /** What the act carries outward, when it carries anything: the text of a send. */
  content: string | null;
}

/**
 * One authorisation, with the sentence it arrived in (ADR 0028, 0029).
 *
 * `authority` is what a reader audits by: a class-3 send and a class-4 override
 * are told apart by this field and never by reading `what` for prose. `act` is
 * what the guard compares: the authorisation answers for the act it names and
 * for no other, so one send does not authorise the next.
 */
export interface RunAuthorisation {
  /** What was authorised, in the words it was read in. */
  what: string;
  /** Which authority of ADR 0028 was given. */
  authority: RunAuthority;
  /** The act the authority is for. */
  act: RunAuthorityAct;
  /** Who said it. */
  by: string;
  /** When it arrived. */
  at: string;
  from: RunMessageRef;
}

/** One thing a claim of the run rests on (ADR 0028, 0030). */
interface RunEvidence {
  /** The step the support belongs to, "" when it stands for the run itself. */
  claim: string;
  /** Where the support is: an object's id, or a document's path. */
  source: string;
}

/**
 * What the run has spent (ADR 0027): the tally of its budget, and only the
 * tally.
 *
 * The budget is steps, time and model calls. The **ceiling** is not here: it is
 * the loop's own (`agent/loop.ts`), because a run measured against a ceiling it
 * carried itself is a run that could raise it. The tally is here because the run
 * is the whole of the agent's durable state and a tally that did not survive a
 * restart would start a run over on the budget it had already spent.
 *
 * The provider's token counts are recorded beside the budget and are **not** one
 * of its ceilings: they say what the work cost, not when the run must stop.
 */
export interface RunSpent {
  /** Plan steps that ended. */
  steps: number;
  /** Model calls the run made. */
  calls: number;
  /** Milliseconds of work spent. */
  ms: number;
  /**
   * The provider's own token counts, when it reported them. Absent on runs
   * written before the tally carried them, and on a provider that answers
   * without a `usage` object — a metric that only claims what was measured.
   */
  promptTokens?: number;
  completionTokens?: number;
  /** The part of `promptTokens` the provider answered from its own cache. */
  cachedPromptTokens?: number;
}

/** How a run ended: when, and why, in words (ADR 0030). */
export interface RunEnd {
  /** The instant it ended, ISO 8601. */
  at: string;
  /** Why it ended, in words. */
  why: string;
  /**
   * Whether the ending has been said where a person reads it, when the ending
   * owes words: absent when nothing is owed (a question it left, a stop a person
   * took), `false` while the words are still to be said, `true` once they have
   * left. The debt is on the record so that a pass which could not speak, or a
   * process that stopped between writing and speaking, says it exactly once
   * afterwards.
   */
  said?: boolean;
}

/**
 * Which memory retrieval a run used (ADR 0038), in the memory's own words.
 *
 * One definition, two documents: the memory's selection answers it and the run
 * records it, so the two cannot spell the same retrieval differently.
 */
export type RunRetrieval = Recall["retrieval"];

/**
 * One run, as it is stored.
 *
 * Every field is written when the run starts, so a document that is missing one
 * is a document this build did not write. `waiting` and `ended` are null when
 * they do not apply, and a run's `state` is `running` exactly while `ended` is
 * null — an ending on a run that is still running is a contradiction rather
 * than a value. A wait lives on a running run and on a run that ended **blocked
 * on a person**: that one keeps the question it left, and the sentence it asked
 * it in, so the run and the answer can be recognised as each other (ADR 0029).
 */
export interface RunDoc {
  /** The schema version; `RUN_VERSION` today. */
  v: 6;
  /** The run's identity: its document's name under `runs/`. */
  id: string;
  /** When the run was opened. Absent on a document written before it existed. */
  startedAt?: string;
  startedBy: RunStart;
  plan: RunStep[];
  /**
   * What the run touched, so a person can undo by hand what can be undone
   * (ADR 0030). The objects themselves are Stalwart's; what is written here is
   * a reference to one, never a copy of it.
   */
  touched: WorkorderRef[];
  /** The live wait, or null when the run is not waiting. */
  waiting: RunWait | null;
  /**
   * What the memory gave the calls of this run (ADR 0033): the ids of the facts
   * it recalled, each addressed under `memory/` in the **Master's** own account.
   *
   * A reference and never a copy — the sentence lives in the sheet, so a
   * correction of a fact lands in one place — and it is the whole of what makes
   * a wrong conclusion traceable to the fact that carried it.
   */
  recalled: string[];
  /**
   * Which memory retrieval the run's turns used (ADR 0038): `exact` when the
   * change's words were matched against the known subjects alone, or
   * `exact+similarity` when the installation embeds and the comparison was also
   * made by vector. The record says what a wrong conclusion was recalled by.
   */
  retrieval: RunRetrieval;
  authorisations: RunAuthorisation[];
  evidence: RunEvidence[];
  /**
   * What the run has spent so far (ADR 0027). */
  spent: RunSpent;
  state: RunState;
  /** The ending, or null while the run is running. */
  ended: RunEnd | null;
}

/* ------------------------------------------------------------------ */
/* The shape over a folder of runs                                     */
/* ------------------------------------------------------------------ */

/**
 * One document of a group's `runs/`, as a reader draws it.
 *
 * `run` is the run this build reads and `problem` is why it cannot read what is
 * there — never both, and never neither: a document written by another build is
 * **said** rather than drawn as a run with no plan and no history, which would
 * be a record invented where the installation has none. The agent's own listing
 * refuses such a document instead (`agent/runs.ts`); a surface that must show
 * the runs beside the one it cannot read takes this.
 */
export interface RunListing {
  /** The document's name under `runs/`, without the extension: the run's id. */
  id: string;
  /** The run, or null when this build cannot read it. */
  run: RunDoc | null;
  /** Why it cannot be read, in the reader's own words; null when it can. */
  problem: string | null;
}

/**
 * A run's header, for a list: what a page draws without downloading a year of
 * plans, outcomes and evidence.
 *
 * The detail is one route away (`GET /groups/:name/runs/:id`); this is the same
 * record's identity, state, tallies and instants, and never a plan.
 */
export interface RunSummary {
  id: string;
  /** Why the document cannot be read; null when it can. */
  problem: string | null;
  state: RunDoc["state"] | null;
  startedAt?: string;
  ended: RunEnd | null;
  /** The rule the run answers, or null when an instruction opened it. */
  rule: string | null;
  /** The change that woke it, in the run's own words. */
  woke: string | null;
  /**
   * What the change said when it woke the run — the message, the subject, the
   * files — or null for a document written before that line existed.
   */
  about: string | null;
  /** Who set the change off, when the change names a person; null otherwise. */
  by: string | null;
  /**
   * The plan, with each step's state, when the caller asked for it.
   *
   * The history list draws a header per run and leaves the plan to the one-row
   * read; the live view draws what is happening **now**, and a step that turns
   * from open to done is the thing a reader is watching. So the plan travels
   * only when the caller asks for it, and a page of a hundred past runs keeps its
   * size.
   */
  plan?: ReadonlyArray<{ what: string; state: RunStepState; outcome: string }>;
  /** Steps the run has, and the failed ones among them. */
  steps: number;
  /** Plan entries that ended failed — not the steps the run spent. */
  failed: number;
  /**
   * What the run waits for, when it is blocked on a person (ADR 0029).
   *
   * The chat draws the question it asked from this: the message a reply must
   * answer is `waiting.asked.id`, and a run that is not blocked carries null.
   */
  waiting: RunWait | null;
  spent: RunSpent;
}

/** The header of one listed run: the list's one shape, in both tiers. */
export function summarizeRun(
  listed: RunListing,
  opts: { steps?: boolean } = {},
): RunSummary {
  const run = listed.run;
  return {
    id: listed.id,
    problem: listed.problem,
    state: run?.state ?? null,
    ...(run?.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ended: run?.ended ?? null,
    rule: run?.startedBy.rule ?? null,
    woke: run?.startedBy.woke ?? null,
    about: run?.startedBy.about ?? null,
    by: run?.startedBy.by ?? null,
    ...(opts.steps && run
      ? {
          plan: run.plan.map((step) => ({
            what: step.what,
            state: step.state,
            outcome: step.outcome,
          })),
        }
      : {}),
    steps: run?.plan.length ?? 0,
    failed: run?.plan.filter((step) => step.state === "failed").length ?? 0,
    waiting: run?.waiting ?? null,
    spent: run?.spent ?? { steps: 0, calls: 0, ms: 0 },
  };
}

/* ------------------------------------------------------------------ */
/* Reading a stored run                                                */
/* ------------------------------------------------------------------ */

/** Whether a value is a count the run can carry: a whole tally, never negative. */
function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

function isChannel(x: unknown): x is RunChannel {
  return x === "chat" || x === "mail";
}

function isMessageRef(x: unknown): x is RunMessageRef {
  return isRecord(x) && isChannel(x.channel) && typeof x.id === "string" && !!x.id;
}

function isStart(x: unknown): x is RunStart {
  if (!isRecord(x)) return false;
  const { rule, instruction, woke } = x;
  // A field this build writes is a field it requires: a document missing one is
  // a document this build did not write.
  if (!("woke" in x)) return false;
  if (rule !== null && (typeof rule !== "string" || !rule)) return false;
  if (instruction !== null && !isMessageRef(instruction)) return false;
  if (woke !== null && (typeof woke !== "string" || !woke.trim())) return false;
  if ("batch" in x) {
    const batch = (x as { batch?: unknown }).batch;
    if (
      !Array.isArray(batch) ||
      !batch.every((one) => typeof one === "string" && one !== "")
    )
      return false;
  }
  const wakeFrom = (x as { wakeFrom?: unknown }).wakeFrom;
  if (wakeFrom !== undefined && wakeFrom !== null && typeof wakeFrom !== "string")
    return false;
  if ("surfaces" in x && !isSurfaceMatrix((x as { surfaces?: unknown }).surfaces))
    return false;
  if ("about" in x && typeof (x as { about?: unknown }).about !== "string") return false;
  if ("by" in x && typeof (x as { by?: unknown }).by !== "string") return false;
  // A run is started by one thing: a rule (the shape before ADR 0038), the
  // sentence a person wrote, or the group's standing instruction — which names
  // neither and is named by the change it answered.
  const named = [rule !== null, instruction !== null].filter(Boolean).length;
  if (named > 1) return false;
  // A rule or the standing instruction is woken by a change in the group's
  // account; a person's own sentence **is** the change, so it names none beside it.
  if (instruction !== null) return woke === null;
  return woke !== null;
}

function isStepState(x: unknown): x is RunStepState {
  return x === "open" || x === "done" || x === "failed" || x === "skipped";
}

/** Whether a value names a step of the plan and the outcome it must end with. */
function isStepNeeds(x: unknown): x is RunStepNeeds {
  return (
    isRecord(x) &&
    typeof x.step === "number" &&
    Number.isInteger(x.step) &&
    x.step >= 0 &&
    (x.when === "done" || x.when === "failed")
  );
}

function isStep(x: unknown): x is RunStep {
  return (
    isRecord(x) &&
    typeof x.what === "string" &&
    !!x.what &&
    isStepState(x.state) &&
    typeof x.outcome === "string" &&
    (x.needs === null || isStepNeeds(x.needs)) &&
    (x.spoke === undefined || typeof x.spoke === "boolean")
  );
}

/**
 * Whether every step of a plan waits on a step the plan already carries.
 *
 * A step waits only on one defined before it, which is what makes the plan a
 * graph with no cycle by construction rather than one a reader has to search:
 * the loop only ever appends a step whose dependency is already there, so a plan
 * waiting forward or on itself is a document this build did not write.
 */
function planIsOrdered(plan: readonly RunStep[]): boolean {
  return plan.every((step, index) => !step.needs || step.needs.step < index);
}

/**
 * Whether a value is one of the run's waits (ADR 0029, 0030).
 *
 * The one reader of a wait's shape, so a caller that has just been handed
 * something — the result of the tool that asked a person — asks whether it is a
 * wait the same way this document's own parser does, and the two cannot drift.
 */
export function isRunWait(x: unknown): x is RunWait {
  return (
    isRecord(x) &&
    typeof x.what === "string" &&
    !!x.what &&
    isMessageRef(x.asked) &&
    (x.until === null || isInstant(x.until))
  );
}

function isAuthority(x: unknown): x is RunAuthority {
  return x === "destructive" || x === "outward" || x === "override";
}

/** Whether a value names the act an authorisation is for. */
function isAuthorityAct(x: unknown): x is RunAuthorityAct {
  return (
    isRecord(x) &&
    typeof x.target === "string" &&
    !!x.target &&
    (x.content === null || typeof x.content === "string")
  );
}

function isAuthorisation(x: unknown): x is RunAuthorisation {
  return (
    isRecord(x) &&
    typeof x.what === "string" &&
    !!x.what &&
    isAuthority(x.authority) &&
    isAuthorityAct(x.act) &&
    typeof x.by === "string" &&
    !!x.by &&
    isInstant(x.at) &&
    isMessageRef(x.from)
  );
}

function isEvidence(x: unknown): x is RunEvidence {
  return (
    isRecord(x) &&
    typeof x.claim === "string" &&
    typeof x.source === "string" &&
    !!x.source
  );
}

function isSpent(x: unknown): x is RunSpent {
  return (
    isRecord(x) &&
    isCount(x.steps) &&
    isCount(x.calls) &&
    isCount(x.ms) &&
    (x.promptTokens === undefined || isCount(x.promptTokens)) &&
    (x.completionTokens === undefined || isCount(x.completionTokens)) &&
    (x.cachedPromptTokens === undefined || isCount(x.cachedPromptTokens))
  );
}

function isEnd(x: unknown): x is RunEnd {
  return (
    isRecord(x) &&
    isInstant(x.at) &&
    typeof x.why === "string" &&
    (x.said === undefined || typeof x.said === "boolean")
  );
}

/** Whether a value is one of the four endings. */
export function isRunEnding(x: unknown): x is RunEnding {
  return (
    x === "done" ||
    x === "blocked" ||
    x === "out-of-budget" ||
    x === "cancelled" ||
    x === "refused"
  );
}

/** Whether a value is a run state. */
function isRunState(x: unknown): x is RunState {
  return x === "running" || isRunEnding(x);
}

/**
 * Parse one stored run.
 *
 * Strict JSON, an object at the top, then every declared field checked. The
 * **first** field that is wrong is named and nothing is returned: an unreadable
 * run is a defect the agent reports, never a shape it guesses at (ADR 0030).
 * A key this build does not know is ignored — a field a later build added, or a
 * retired one, decides nothing here and does not refuse a run that is otherwise
 * whole — and the parsed run carries only the fields above, so the next write
 * of it drops what was unknown.
 *
 * A `v` this build does not know is refused. That is what the field is for: a
 * document written by a newer Gilbert may carry a field whose meaning changed,
 * and reading it as though it had not is worse than saying so.
 *
 * The one version before this is read rather than refused, with the field it
 * added — `recalled` — defaulted to empty (`RUN_VERSION_WITHOUT_RECALLED`): an
 * installation that ran the build before it has runs on its accounts, and a
 * version is how a change reaches those runs rather than how it abandons them.
 */
export function parseRunDocumentDetailed(
  raw: string,
): { run: RunDoc } | { problem: string } {
  let whole: unknown;
  try {
    whole = JSON.parse(raw);
  } catch (err) {
    return { problem: `Not valid JSON${errorDetail(err)}.` };
  }
  if (!isRecord(whole)) return { problem: "The document must be a JSON object." };
  if (
    whole.v !== RUN_VERSION &&
    whole.v !== RUN_VERSION_WITHOUT_RETRIEVAL &&
    whole.v !== RUN_VERSION_WITHOUT_RECALLED
  )
    return {
      problem: `"v" is ${JSON.stringify(whole.v)}; this build reads version ${RUN_VERSION} and the two before it.`,
    };
  if (typeof whole.id !== "string" || !whole.id)
    return { problem: '"id" must be the run\'s name.' };
  if (!isStart(whole.startedBy))
    return {
      problem:
        '"startedBy" must name the rule, the instruction or the change that started the run.',
    };
  /*
   * A run written before the field existed carries no `startedAt`. It reads as
   * absent — the surface draws the ending, or the listing order — and is not a
   * defect; a value that is there must be an instant.
   */
  if (whole.startedAt !== undefined && !isInstant(whole.startedAt))
    return { problem: '"startedAt" must be the instant the run was opened.' };
  if (!Array.isArray(whole.plan) || !whole.plan.every(isStep))
    return { problem: '"plan" must be a list of steps.' };
  if (!planIsOrdered(whole.plan))
    return {
      problem: 'every step of "plan" must wait on a step the plan already carries.',
    };
  if (!Array.isArray(whole.touched) || !whole.touched.every(isWorkorderRef))
    return { problem: '"touched" must be a list of what the run touched.' };
  if (whole.waiting !== null && !isRunWait(whole.waiting))
    return {
      problem:
        '"waiting" must be null or what the run waits for, where it asked and until when.',
    };
  /*
   * A version-4 run carries no `recalled` list, because the field did not exist
   * when it was written: it reads as empty — this run recalled nothing — and the
   * document is written back as the version this build writes. A version-5 run
   * missing the field is a document this build did not write, and is refused.
   */
  const recalled =
    whole.recalled ?? (whole.v === RUN_VERSION_WITHOUT_RECALLED ? [] : undefined);
  if (!Array.isArray(recalled) || !recalled.every((id) => typeof id === "string" && !!id))
    return {
      problem: '"recalled" must be the ids of the facts the run recalled.',
    };
  /*
   * A run written before this version carries no `retrieval`, because the field
   * did not exist when it was written: it reads as the exact retrieval, which is
   * the only one the build that wrote it had.
   */
  const retrieval = whole.retrieval ?? (whole.v === RUN_VERSION ? undefined : "exact");
  if (retrieval !== "exact" && retrieval !== "exact+similarity")
    return {
      problem: '"retrieval" must be "exact" or "exact+similarity".',
    };
  if (
    !Array.isArray(whole.authorisations) ||
    !whole.authorisations.every(isAuthorisation)
  )
    return { problem: '"authorisations" must be a list of authorisations.' };
  if (!Array.isArray(whole.evidence) || !whole.evidence.every(isEvidence))
    return { problem: '"evidence" must be a list.' };
  if (!isSpent(whole.spent))
    return {
      problem: '"spent" must be the tally of steps, model calls and milliseconds.',
    };
  if (!isRunState(whole.state))
    return {
      problem:
        '"state" must be "running", "done", "blocked", "out-of-budget", "cancelled" or "refused".',
    };
  if (whole.ended !== null && !isEnd(whole.ended))
    return { problem: '"ended" must be null or how the run ended.' };
  if ((whole.state === "running") !== (whole.ended === null))
    return { problem: '"ended" must be there exactly when "state" is not "running".' };
  if (whole.waiting !== null && whole.state !== "running" && whole.state !== "blocked")
    return {
      problem:
        '"waiting" must be null once the run has ended, unless it ended blocked on a person.',
    };
  if (whole.state === "blocked" && whole.waiting === null)
    return {
      problem: '"waiting" must name the question a run blocked on a person left.',
    };
  return {
    run: {
      v: RUN_VERSION,
      id: whole.id,
      ...(whole.startedAt === undefined ? {} : { startedAt: whole.startedAt }),
      startedBy: whole.startedBy,
      plan: whole.plan,
      touched: whole.touched,
      waiting: whole.waiting,
      recalled,
      retrieval,
      authorisations: whole.authorisations,
      evidence: whole.evidence,
      spent: whole.spent,
      state: whole.state,
      ended: whole.ended,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The transitions                                                     */
/* ------------------------------------------------------------------ */

/**
 * A run that has ended does not act again: every transition but `finishRun`
 * refuses it, so a stale caller cannot make an ending mean two things.
 */
function mustBeRunning(run: RunDoc): void {
  if (run.state !== "running")
    throw new Error(`the run "${run.id}" has ended (${run.state})`);
}

/** Whether a value names an instant, for the transitions that take one. */
function requireInstant(where: string, value: string): void {
  if (!isInstant(value)) throw new Error(`"${value}" is not an instant: ${where}`);
}

/**
 * Start a run: its identity, what started it, and the plan's first steps.
 *
 * The plan arrives as what each step is, in order — the steps the model chose,
 * or the ones a rule declared — and every one of them starts `open`. A caller
 * with no plan yet starts with none.
 */
export function startRun(input: {
  id: string;
  startedBy: RunStart;
  /** What each step is, in order. */
  plan?: readonly string[];
  /** The instant it was opened; the clock unless a fixture says otherwise. */
  startedAt?: string;
}): RunDoc {
  return {
    v: RUN_VERSION,
    id: input.id,
    startedAt: input.startedAt ?? new Date().toISOString(),
    startedBy: input.startedBy,
    plan: (input.plan ?? []).map((what) => ({
      what,
      state: "open",
      outcome: "",
      needs: null,
    })),
    touched: [],
    waiting: null,
    recalled: [],
    retrieval: "exact",
    authorisations: [],
    evidence: [],
    spent: { steps: 0, calls: 0, ms: 0 },
    state: "running",
    ended: null,
  };
}

/**
 * Record how one step left the plan, and what actually happened.
 *
 * The three terminal states are the two an outcome can be and `skipped`, the one
 * for a step no branch of the plan reached. The step's `needs` is kept as it was:
 * what a step waits on is the plan's shape, not the ending's business.
 */
export function recordStep(
  run: RunDoc,
  index: number,
  ended: {
    state: RunStepOutcome | "skipped";
    outcome: string;
    spoke?: boolean;
  },
): RunDoc {
  mustBeRunning(run);
  const step = run.plan[index];
  if (!step) throw new Error(`the run "${run.id}" has no step ${index}`);
  const plan = [...run.plan];
  plan[index] = {
    what: step.what,
    state: ended.state,
    outcome: ended.outcome,
    needs: step.needs,
    ...((ended.spoke ?? step.spoke) ? { spoke: true } : {}),
  };
  return { ...run, plan };
}

/**
 * Append the step the model chose after seeing a result (ADR 0027).
 *
 * The plan grows as the run goes: the model chooses the tools and the order,
 * acts, looks at the result and chooses again, so a step it decides on is
 * appended at the end of the plan and starts `open` — there is no plan compiled
 * when the run is written, and none of them is known before it acts.
 *
 * `needs` is what the step waits on: a step of the plan the model named before
 * it, so the value refers to a step already appended or to none (ADR 0030).
 */
export function appendStep(
  run: RunDoc,
  what: string,
  needs: RunStepNeeds | null = null,
): RunDoc {
  mustBeRunning(run);
  if (!what) throw new Error(`a step the run "${run.id}" appends needs what it is`);
  if (needs) {
    if (!isStepNeeds(needs)) throw new Error(`the run "${run.id}" cannot wait on that.`);
    if (needs.step >= run.plan.length)
      throw new Error(
        `the run "${run.id}" has no step ${needs.step} to wait on: a step waits on one already in its plan.`,
      );
  }
  return {
    ...run,
    plan: [...run.plan, { what, state: "open", outcome: "", needs }],
  };
}

/**
 * Record an object the run touched (ADR 0030).
 *
 * The list a person reads to undo by hand what can be undone, and the one
 * transition that writes it: an act the run cannot name is an act nobody can
 * undo, so the reference is the same shape a workorder keeps and is checked
 * like one.
 */
export function touchObject(run: RunDoc, ref: WorkorderRef): RunDoc {
  mustBeRunning(run);
  if (!isWorkorderRef(ref))
    throw new Error(`a reference the run "${run.id}" touched is not one.`);
  return { ...run, touched: [...run.touched, ref] };
}

/**
 * Record the facts a call carried from the installation's memory (ADR 0033),
 * and which retrieval found them (ADR 0038).
 *
 * One list and never a second: a fact recalled by a later call of the same run
 * is already on it, so the record says which facts the run reasoned from without
 * repeating the same one for every turn. What is written is the id of each
 * document — a reference, so a correction of a fact lands in the memory and not
 * in every run that read it — and the order is the order the selection carried
 * them in. The retrieval is the one the turn that recalled them used: a later
 * turn that embedded nothing does not make an earlier similarity recall exact.
 */
export function recordRecall(
  run: RunDoc,
  ids: readonly string[],
  retrieval: RunRetrieval = "exact",
): RunDoc {
  mustBeRunning(run);
  const recalled = [...run.recalled];
  for (const id of ids) {
    if (typeof id !== "string" || !id)
      throw new Error(`a fact the run "${run.id}" recalled is not one.`);
    if (!recalled.includes(id)) recalled.push(id);
  }
  return {
    ...run,
    recalled,
    retrieval: run.retrieval === "exact+similarity" ? run.retrieval : retrieval,
  };
}

/**
 * Set the run's wait: what it waits for, where it asked, and until when.
 *
 * One wait replaces the previous one: a run waits in one place at a time, and
 * the date it carries is what the agent re-arms a process from. That date is
 * optional, because a person's answer arrives when they write it: a wait with
 * no deadline is a question left in the conversation (ADR 0029), and the
 * sentence it was asked in is what the answer arrives through.
 */
export function waitUntil(run: RunDoc, wait: RunWait): RunDoc {
  mustBeRunning(run);
  if (wait.until !== null)
    requireInstant("a wait needs the instant it comes due", wait.until);
  if (!isRunWait(wait)) throw new Error(`the run "${run.id}" cannot wait on that.`);
  return {
    ...run,
    waiting: { what: wait.what, asked: wait.asked, until: wait.until },
  };
}

/** Record an authorisation, with the sentence it arrived in and its authority. */
export function takeAuthorisation(run: RunDoc, authorisation: RunAuthorisation): RunDoc {
  mustBeRunning(run);
  if (!isAuthorisation(authorisation))
    throw new Error(`the run "${run.id}" cannot take that authorisation.`);
  return { ...run, authorisations: [...run.authorisations, authorisation] };
}

/** Record what one of the run's claims rests on (ADR 0028, 0030). */
export function recordEvidence(run: RunDoc, evidence: RunEvidence): RunDoc {
  mustBeRunning(run);
  if (!isEvidence(evidence)) throw new Error(`the run "${run.id}" cannot rest on that.`);
  return { ...run, evidence: [...run.evidence, evidence] };
}

/**
 * Add to the run's tally of what it has spent (ADR 0027).
 *
 * The one place the tally moves: the caller says which of the three counters a
 * turn touched — the step it took, the model call it made, the milliseconds it
 * cost — and the run carries the sum. What the sum is measured against is the
 * ceiling the run declares, not the rule's (ADR 0030, 0038).
 */
export function spendRun(run: RunDoc, spent: Partial<RunSpent>): RunDoc {
  mustBeRunning(run);
  const next: RunSpent = { ...run.spent };
  for (const counter of ["steps", "calls", "ms"] as const) {
    const by = spent[counter];
    if (by === undefined) continue;
    if (!isCount(by))
      throw new Error(`the run's "${counter}" can only grow, by a count: ${by}`);
    next[counter] += by;
  }
  for (const counter of [
    "promptTokens",
    "completionTokens",
    "cachedPromptTokens",
  ] as const) {
    const by = spent[counter];
    if (by === undefined) continue;
    if (!isCount(by))
      throw new Error(`the run's "${counter}" can only grow, by a count: ${by}`);
    next[counter] = (next[counter] ?? 0) + by;
  }
  return { ...run, spent: next };
}

/**
 * End the run: how, when and why (ADR 0030).
 *
 * The ending is written down — so a run that stops says which of the three ways
 * it stopped, and why — and the wait is dropped, because a run that has stopped
 * is not waiting for anything. A run that ends **blocked on a person** is the
 * one exception: it keeps the question it left, and the sentence it asked it
 * in, so the answer that arrives in the conversation can be recognised as
 * addressed to it (ADR 0029).
 */
export function finishRun(run: RunDoc, ending: RunEnding, end: RunEnd): RunDoc {
  /*
   * A run waiting on a person is still in flight: a member of the group may stop
   * it, and that ending is `cancelled`. No other ending takes a blocked run —
   * only the answer that arrives continues it (`takeAnswer`) — so the exception
   * is stated here, where the transition is, and not left to each caller.
   */
  if (!(run.state === "blocked" && ending === "cancelled")) mustBeRunning(run);
  requireInstant("an ending needs the instant it happened", end.at);
  if (ending === "blocked" && !run.waiting)
    throw new Error(`a run blocked on a person names the question it left: "${run.id}"`);
  /*
   * The ending replaces the one it lands on, **with its debt**: `said` belongs to
   * the ending it was written for, so an ending that replaced another withdraws a
   * saying that has not left. That is what a person's stop means — the words the
   * loop owed described an ending that no longer happened — and it is why the
   * field is not carried over here.
   */
  return {
    ...run,
    state: ending,
    ended: { at: end.at, why: end.why },
    waiting: ending === "blocked" ? run.waiting : null,
  };
}

/**
 * Take a person's answer, and go on working the run that asked for it.
 *
 * The one transition out of an ending: a run that parked on a question is not
 * finished, it is waiting, and the answer that comes back **is** the run
 * carrying on — so the answer is a step of its own, naming the message it
 * arrived in and carrying what the person said as what it answered, and the run
 * is running again with no wait on it. A record the model is shown whole is what
 * lets a run picked up by the next holder continue from the document rather than
 * from a process's memory (ADR 0030).
 *
 * The answer must be the run's **own** question: a run asks in one sentence and
 * only that sentence's answer continues it, which is what keeps two runs that
 * asked the same thing apart. Anything but a run that ended blocked on a person
 * is refused — a run that never asked, or one that has already ended for another
 * reason, is not continued by a message.
 *
 * `question` is the run's own wait and is what is matched; `answer` is the
 * message the answer came in, which is what the record names, so a reader of the
 * document can find the sentence in the conversation it was written in.
 */
export function takeAnswer(
  run: RunDoc,
  question: RunMessageRef,
  answer: RunMessageRef,
  said: string,
): RunDoc {
  if (run.state !== "blocked")
    throw new Error(
      `the run "${run.id}" is not waiting on a person (${run.state}), so nothing answers it.`,
    );
  const asked = run.waiting?.asked;
  if (!asked || asked.channel !== question.channel || asked.id !== question.id)
    throw new Error(
      `the answer in ${question.channel} ${question.id} is not the question the run "${run.id}" left.`,
    );
  if (!said) throw new Error(`the run "${run.id}" took an answer with nothing in it.`);
  return {
    ...run,
    plan: [
      ...run.plan,
      {
        what: `the answer in ${answer.channel} ${answer.id}`,
        state: "done",
        outcome: said,
        needs: null,
      },
    ],
    waiting: null,
    state: "running",
    ended: null,
  };
}

/**
 * How long a question asked in the conversation waits for its answer.
 *
 * A question carries a deadline (ADR 0029, 0030): 72 hours is long enough for a
 * person to come back to a question asked on a Friday and short enough that a run
 * does not wait for ever. The ask tools state it
 * (`agent/tools/chat.ts`, `agent/tools/mail.ts`), and the run's own wait carries
 * it — never a timer in a process, so a restart keeps the deadline.
 */
export const QUESTION_TTL_MS = 72 * 60 * 60_000;

/**
 * The question a run left has gone unanswered past its deadline, and the work
 * goes on without the answer.
 *
 * The one case nothing else covers is a person who never answers. The run is not
 * ended for it — the work may still be possible — so it goes back to running
 * with a step that says what did not come, and the model decides with that on the
 * record. The wait is dropped with it, or the same deadline would fire again.
 */
export function answerOverdue(run: RunDoc, at: string): RunDoc {
  const waiting = run.waiting;
  if (run.state !== "blocked" || !waiting?.until)
    throw new Error(
      `the run "${run.id}" is not waiting on an answer with a deadline (${run.state}).`,
    );
  requireInstant("an overdue question needs the instant it came due", at);
  const ask = waiting.asked;
  const resumed: RunDoc = { ...run, state: "running", waiting: null, ended: null };
  const grown = appendStep(
    resumed,
    `the answer to the question asked in ${ask.channel} ${ask.id}`,
  );
  const recorded = recordStep(grown, grown.plan.length - 1, {
    state: "failed",
    outcome: `nobody answered it within the deadline (${waiting.until}), so the work goes on without the answer.`,
  });
  return spendRun(recorded, { steps: 1 });
}

/**
 * Whether a run is still the agent's to work: working, or waiting on a person.
 *
 * One definition for the four surfaces that ask it — the admin overview, the
 * group's run list, the group-wide stop and the archive — so "in flight" cannot
 * mean two things on two screens.
 */
export function isInFlight(state: RunState): boolean {
  return state === "running" || state === "blocked";
}

/**
 * The instant the run's wait comes due, or null when it has none.
 *
 * The run's own answer to "is it waiting, and until when", and the one place it
 * is given: a run that is running or **blocked on a person with a deadline** is
 * waiting, and a dated wait beside any other ending is not — a date on a stopped
 * run is not a wait, and firing it would start a run whose end nobody re-opened.
 * Both readers of the answer ask it here — the process that arms the waits
 * (`agent/timers.ts`) and the question of whether one has come due (`isRunDue`) —
 * so the two cannot drift apart on a dateless or an ended run.
 */
export function waitDueAt(run: RunDoc): string | null {
  if (run.state !== "running" && run.state !== "blocked") return null;
  return run.waiting?.until ?? null;
}

/** Whether the run's wait has come due at `now`. */
export function isRunDue(run: RunDoc, now: Date): boolean {
  const until = waitDueAt(run);
  return until !== null && Date.parse(until) <= now.getTime();
}
