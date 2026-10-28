/**
 * The loop that works a run (ADR 0028, 0030, 0032, 0038).
 *
 * One pass answers whatever the installation's own accounts have changed and
 * whatever a run was waiting for: it takes the installation's claim, resolves the
 * accounts the Master works — its groups, asked afresh on **every** pass, so one
 * the Master joins is worked by the next pass and one it leaves stops being
 * worked, with no restart — then works the runs whose wait has come due, reads
 * each account's changes, and for each change asks the **decision turn** what the
 * change is about. A change the group's instruction covers opens **one** run
 * (ADR 0038); a change it does not cover costs no model call and no step, and each
 * run is worked by the **choosing turn** — the model asks for a plan of one or more
 * steps, each naming what it waits on, the loop **writes that plan on the run
 * before it acts on any of it**, runs the steps whose dependencies have ended
 * **together**, reads each outcome and takes the branch that outcome names,
 * writes each outcome and its own spend on the run, and asks again, until the
 * model says done, a step parks the run on a person, or the liveness valve stops
 * it. A step no branch of the plan reaches is left unrun, and the
 * record says which step and which outcome left it — the loop invents no
 * ordering of its own.
 *
 * **Every call starts from what the installation knows.** The pass reads the
 * memory the Master's account holds **once** (ADR 0038), at the pass's own clock,
 * and takes the **selection** each change's own words name — the entities they
 * name, their facts valid at that moment and one hop of their relations, inside a
 * ceiling, by exact subject first and by similarity where the installation
 * embeds — hands it to both turns fenced as data, and records on the run which
 * facts it carried, so a wrong conclusion traces to the fact that carried it. A change with nothing to recall is worked exactly
 * as it was before the memory existed.
 *
 * **Every call is told the two levels of prose the record names** (ADR 0038),
 * outermost first: the installation's own line, read from its document at the
 * boot; and the group's one instruction, read from the group's account once per
 * pass, so an edit is in force at the next one. A level that says nothing
 * contributes nothing, and the order is the builder's alone (`prose.ts`), never a
 * caller's.
 *
 * **A sentence that answers a run is also read for what it authorises**
 * (ADR 0028): the reading is one call (`readAnswerAuthority`), what it reports is
 * recorded on the run with the person's own words and the message they wrote it
 * in, and the guard is what bounds it — an authorisation licenses the act it
 * names and no other. An override is reported only where the answering person is
 * an installation administrator, proved by the directory before the answer is read
 * (`isAdministrator`), so the sentence alone can never claim class 4.
 *
 * **The loop never decides what may be done.** A chosen call is run through
 * `runTool`, the only door to a writing tool: the authority guard (`mayRun`, ADR
 * 0028) answers, the loop never overrides it, and a refusal — an act beyond what
 * the run carries, or a call that failed — is written on the run as a failed step
 * rather than skipped, so the record shows what was refused and the model is told
 * it before it chooses again. An answer the choosing turn could not use at all —
 * an unknown tool, a call that is not a call, arguments a tool cannot take, any
 * key this build does not know — is refused whole and recorded the same way.
 *
 * **The run document is the product** (ADR 0030): the model is shown exactly what
 * the document holds — the change that woke the run, the plan with what each step
 * waited on, and what each step answered — so a run picked up by the next holder
 * continues from the record and never from a process's memory.
 *
 * There is no timer of its own here: a pass is the caller's to ask for, and the
 * waits' alarms are armed per account (`timers.ts`) so a process that starts
 * re-arms what the installation left.
 */

import { randomUUID } from "node:crypto";
import {
  appFolderState,
  type Ctx,
  documentType,
  filesAccountId,
  readAppFileAt,
  readVisibleFileBytes,
  writeAppFileAt,
} from "../appFolder.js";
import { postChatMessage, readChatMessage, readChatMessageAt } from "../groupChat.js";
import { JmapError, retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import { forgetRemembered } from "../requestMemory.js";
import { impersonationAuthorization } from "../sessions.js";
import { sameAddress } from "../shared/address.js";
import {
  isPassStatusDoc,
  PASS_STATUS_FILE,
  type PassStatusDoc,
} from "../shared/agent.js";
import type { AreaName } from "../shared/areas.js";
import { writeSurfacesOf } from "../shared/areas.js";
import { CAPABILITIES } from "../shared/capabilities.js";
import { repliesToAuthor } from "../shared/chat.js";
import { mapLimit } from "../shared/concurrency.js";
import { errorMessage } from "../shared/errors.js";
import {
  INSTALLATION_FILE,
  type InstallationDocument,
  installationDefaults,
  parseInstallationDocumentDetailed,
} from "../shared/installation.js";
import { isRecord } from "../shared/json.js";
import {
  answerOverdue,
  appendStep,
  compactAt,
  compactRun,
  finishRun,
  isRunDue,
  isRunWait,
  type RunDoc,
  type RunEnd,
  type RunEnding,
  type RunMessageRef,
  type RunStep,
  type RunStepNeeds,
  type RunWait,
  recordEvidence,
  recordRecall,
  recordStep,
  resumeRun,
  sliceRun,
  spendRun,
  startRun,
  takeAnswer,
  takeAuthorisation,
  waitUntil,
  withCase,
} from "../shared/run.js";
import {
  fetchAccountIntrospection,
  isStalwartAdmin,
  UpstreamError,
  upstreamFor,
} from "../upstream.js";
import type { AccountEvent } from "./accountEvent.js";
import { archiveOldRuns } from "./archive.js";
import { catalogueFor, selectedAreas } from "./areas.js";
import { forgetRunNote, listCases, readCaseNote, writeCaseNote } from "./case.js";
import {
  chatWoken,
  mailWoken,
  offPath,
  openWaits,
  readChangesForPass,
  wokeOf,
  workChanges,
} from "./changes.js";
import { CLAIM_TTL_MS, releaseClaim, renewClaim, takeClaim } from "./claim.js";
import { NOTICE_CURSOR_FILE, readCursor, writeCursor } from "./cursors.js";
import type { AccountEvents, EventCursor } from "./events.js";
import type { InstructionDoc } from "./instruction.js";
import { readInstruction } from "./instruction.js";
import { forgetMemoryStores, listMemory, type MemoryStore, recallFor } from "./memory.js";
import {
  askOf,
  boundedText,
  type CaseHeld,
  chooseStep,
  embedTexts,
  judgeRun,
  type ModelAccess,
  ModelError,
  modelAccess,
  readAnswerAuthority,
  readImage,
  type StepCall,
  setRunningModelAccess,
  summarisePlan,
  type UsageMeter,
  usageMeter,
} from "./model.js";
import { type AgentMeasure, emitMeasures } from "./otlp.js";
import type { ProseLevel } from "./prose.js";
import {
  forgetDrop as dropForgotten,
  forgetPath as dropPathForgotten,
  dueDrops as dropsDue,
  noteFile,
} from "./queue.js";
import { redactSecrets } from "./redact.js";
import {
  createRun,
  listRunsForWorking,
  type RunRecord,
  readRun,
  replaceRun,
} from "./runs.js";
import { forgetStop, stopAsked } from "./stops.js";
import { readAgentSwitch } from "./switch.js";
import { threadLines } from "./thread.js";
import { type DueWait, WaitTimers } from "./timers.js";
import { READ_BYTES_MAX, readFileText } from "./tools/content.js";
import { caseOf } from "./tools/note.js";
import {
  type AnyTool,
  type ImageReader,
  repeatable,
  runTool,
  TOOLS,
  type ToolCall,
} from "./tools.js";

/**
 * The other limits a run records beside its tally.
 *
 * One valve: **liveness, not money**. A run ends when its work is done, when it
 * waits on a person, when a person stops it, or when it fails — never because of
 * what it cost (ADR 0038). What keeps a machine from hanging is the model-call
 * valve below; what keeps a bill from running away is the installation's daily
 * ceiling, which refuses new runs and never cuts one in flight.
 */
const RUN_MODEL_CALLS_MAX = 100;

/**
 * How many steps of one wave run at once.
 *
 * A model's answer that reaches for the same folder thirteen times is one
 * delivery of six files, and the thirteen calls went to the server together:
 * Stalwart answered `400` — *"The request exceeds the maximum number of
 * concurrent requests"* (`maxConcurrentRequests`) — and a run paid a failed
 * step for each. The wave is a burst of independent calls, so a bound is what
 * makes it a burst the server can take; four keeps every one of them under
 * that ceiling and still turns a round trip each into a handful.
 */
const TOOL_WAVE_MAX = 2;

/** How many entries of a knowledge base or a folder one case block carries. */
const CASE_PLACE_MAX = 40;

/** How many of a folder's own levels the case block opens. */
const CASE_PLACE_FOLDERS_MAX = 5;

/** The most lines the case's place carries, levels together. */
const CASE_PLACE_LINES_MAX = 120;

/**
 * The step a `done` that closed over a refusal leaves on the record.
 *
 * One name for one idea: the guard that asks the model to finish before it
 * claims the work is done writes it, and the run's card draws it like any other
 * step.
 */
export const DONE_CHECKED = "the work, checked against the plan's refusals";

/**
 * Whether a call is the group's own report: `say` with the `say` action (ADR 0038).
 *
 * One definition, read twice: the wave records that the run spoke, and a run that
 * has already spoken does not speak again. `say` with `ask` asks a person a
 * question and reports nothing, so it is not one.
 */
function reportsInChat(call: StepCall): boolean {
  // Trimmed like the router reads it (`routeOf`), so `" say "` is the same action.
  return (
    call.name === "say" &&
    isRecord(call.args) &&
    typeof call.args.action === "string" &&
    call.args.action.trim() === "say"
  );
}

/**
 * The refusals a run has **not** recovered from.
 *
 * A **call** is a step whose line is `<verb> {…}` — what the loop writes when the
 * model asked for one, whether or not the verb still exists in this build's
 * catalogue (a document written by an older build is read, not rewritten). A step
 * the loop itself wrote — `the model's answer`, the mechanical check, the judge's
 * verdict — is not a call: those are the loop telling the model something, and
 * counting them as refusals made every later report look worse than the plan.
 *
 * A refused call the run answered afterwards — the same verb on the same object,
 * done later — is a probe it paid for and learned from: a folder looked for before
 * it existed, an id guessed. Anything else stays counted, which is what the
 * mechanical check exists for: a refused act is never covered by a later one that
 * did something else (ADR 0030, 0038). The case's note names no object, so a failed
 * note always counts: there is nothing to match it against, and the check's
 * direction is to keep a claim out, not to let one through.
 */
function unrecoveredRefusals(plan: readonly RunStep[]): number {
  const isCall = (what: string): boolean => what.split(" ")[1]?.startsWith("{") === true;
  const verbOf = (what: string): string => what.split(" ")[0] ?? "";
  const objectOf = (what: string): string | null =>
    /"(?:what|action)":"([^"]*)"/.exec(what)?.[1] ?? null;
  return plan.filter((step, at) => {
    if (step.state !== "failed" || !isCall(step.what)) return false;
    const verb = verbOf(step.what);
    const object = objectOf(step.what);
    return !plan
      .slice(at + 1)
      .some(
        (later) =>
          later.state === "done" &&
          isCall(later.what) &&
          verbOf(later.what) === verb &&
          object !== null &&
          objectOf(later.what) === object,
      );
  }).length;
}

/**
 * The step the judge leaves on the record (ADR 0038).
 *
 * The judge fires on a **suspect plan** — a refused step, then a later step that
 * succeeded, so the mechanical check above saw a finished step and the claim may
 * still rest on the refusal. Its verdict is a step of its own, and on a second
 * `done` it is what the record shows beside the claim.
 */
export const JUDGE_CHECKED = "the report, judged against the plan";

/**
 * How close to lapsing the claim is renewed.
 *
 * Holding a claim is not an event, so an ordinary pass costs one read and no
 * upload (ADR 0032); a holder renews only once the window it is believed in is
 * down to half, which keeps the write off every pass and still pushes the expiry
 * out well before it lapses. A holder that never renewed would let a second copy
 * take the installation over beside it.
 */
const CLAIM_RENEW_WITHIN_MS = CLAIM_TTL_MS / 2;

/**
 * How many old runs one pass archives.
 *
 * A first pass over a group with years of history would otherwise move
 * thousands of documents in one go, outliving the claim it works under. The
 * rest follow on later passes; the drawer is the same either way.
 */
const ARCHIVE_PER_PASS = 50;
/** How often one account's archive is looked at: housekeeping, not a beat. */
const ARCHIVE_EVERY_MS = 60 * 60_000;
/** How stale the off path's reading may be before it starts from now instead. */
const OFF_READING_FRESH_MS = 60 * 60_000;
/** How often a pass that worked nothing rewrites the last pass it left. */
const STATUS_EVERY_MS = 5 * 60_000;
/** How long a run left running without a wait waits before it is tried again. */
const STUCK_RETRY_MS = 60_000;

/**
 * How long one pass works one run before leaving it for the next (R6).
 *
 * A pass loops over every group in turn, and a run of twenty minutes held the whole
 * pass: the log of 2026-10-26 says "what came after it waited". Ninety seconds is
 * longer than any turn this build has measured (the slowest provider took 27 s a call)
 * and short enough that a group is not left waiting behind another's mail.
 */
const SLICE_MS = 90_000;

/**
 * How many permanent provider failures in a row stop the pass (ADR 0038).
 *
 * Three: one refusal may be a model the provider does not serve any more, two
 * may be a request that drifted, three is the deployment broken. The run stays
 * `running` and the pass status says why, rather than every change of the day
 * being consumed as an answer nobody gave.
 */
const PERMANENT_FAILURES_MAX = 3;

/** A pass that stopped on purpose: the provider is broken, not this account. */
class PassStopped extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "PassStopped";
  }
}

/** What one pass of the loop did. */
export interface PassSummary {
  /** Whether this process held the installation's claim and worked at all. */
  claimed: boolean;
  /**
   * The accounts this pass resolved and worked: the Master's groups.
   *
   * Zero is the Master working no group — the agent has nothing to work and
   * says so once (`supervisor.ts`) rather than going quiet in a way nobody can
   * tell from a working one.
   */
  accounts: number;
  /** The changes read this pass, across every account. */
  changes: number;
  /** The runs this pass opened for a change. */
  runs: number;
  /** The runs whose wait had come due and were picked up again. */
  due: number;
  /** The tokens the pass spent, prompt and completion together (ADR 0038). */
  tokens: number;
  /** How long the pass took, in milliseconds. */
  ms: number;
  /**
   * What a change log could not cover, named rather than read as silence
   * (`events.ts`): the pages before the gap were worked, and what fell in it is
   * lost.
   */
  gaps: string[];
}

/**
 * A run a person's answer continued, and what the reading of that answer needs.
 *
 * `runs` is every run parked on the question the answer replies to: a group has
 * one conversation, so a question asked once is answered once, and each run that
 * needed it goes on from the same words (ADR 0029).
 */
export interface AnsweredRun {
  runs: RunDoc[];
  /** The sentence the run asked, which the answer is read against. */
  asked: string;
  /** What the person wrote. */
  said: string;
  /** The address it came from: the person the authorisation is theirs. */
  from: string;
  /** When they sent it, as the message carries it. */
  at: string;
  /** The message it arrived in, which the trace names. */
  message: RunMessageRef;
}

/** What one loop needs: who holds the claim, which accounts, and the model. */
export interface AgentLoopOptions {
  /** Who holds the installation's claim: the process's own name. */
  holder: string;
  /**
   * The accounts the agent works: the installation's groups' own accounts.
   *
   * Asked afresh on **every pass**, never once at construction: a group the
   * Master is added to is worked by the next pass and one it leaves stops being
   * worked, with nothing to restart. A group that appears anchors its own
   * reading where the account stands then (`events.ts`), so what it did before
   * the Master held it is not replayed; a run left open on a group the Master
   * has left is frozen as its document stands, and the first pass that works
   * the group again picks it up from that document, its wait honoured then.
   */
  accounts: () => Promise<readonly string[]>;
  /** The installation's model; an installation without one has no agent. */
  /** The model to start with, when the boot has one; each pass re-reads it. */
  access?: ModelAccess;
  /** The operator's switch on private provider addresses; kept apart from a model. */
  allowPrivateProvider?: boolean;
  /**
   * The installation's own line of prose, carried into every call above every
   * group's (ADR 0038). Read from the installation's document at the boot, like
   * the model: which document a booted process runs on is fixed at the boot.
   */
  installation?: string;
  /**
   * The tools a run's steps are taken with. The product's catalogue by default;
   * a caller may hand a narrower one, and what it holds is also what the model is
   * offered.
   */
  catalogue?: readonly AnyTool[];
  /**
   * Where the loop says what it is doing, one line as it starts an account and a
   * run.
   *
   * A pass is not an event and writes no line of its own: without a line as it
   * starts, a pass that hung in a model call or a folder read is indistinguishable
   * from an agent that had stopped, because the only line there is comes **after**
   * the pass returns. Progress
   * recorded as it happens is what a stall is read from — the last line names the
   * account and run that never finished — and it needs no watchdog: a missing end
   * line is the fact.
   */
  log?: (line: string) => void;
  /**
   * How long one pass works one run before it leaves it for the next (R6).
   *
   * A pass is the clock of every group at once, so a run that works for six minutes
   * makes the others wait: at this much time, and only **at a turn boundary** — every
   * step of the wave written, nothing left open — the pass stops, marks the run as left
   * on purpose (`RunDoc.slice`), and the next pass picks it up at once instead of
   * treating it as a crash.
   */
  sliceMs?: number;
}

/**
 * One process's loop, and the process state it carries.
 *
 * An instance is the whole of it: the alarms live here and nowhere else, so a
 * restart begins with a fresh instance and the run documents decide what happens
 * next. The **reading cursor is not** process state: it is a document in each
 * group's own app folder (`cursors.ts`, ADR 0037), read at a process's first
 * pass and written after a batch, so a restart resumes where the last process
 * stopped instead of anchoring at the present and losing the window between.
 */
export class AgentLoop {
  /** Where each account's reading has reached, by account. */
  private readonly cursors = new Map<string, EventCursor>();
  /** The cursor each account's document already carries, as last written. */
  private readonly savedCursor = new Map<string, string>();
  /**
   * The switched-off pass's own reading, by account — a second reader with its
   * own freshness rule, and its own document (`notices.json`).
   */
  private readonly notices = new Map<string, EventCursor>();
  /** When each account's notice position was last taken, in milliseconds. */
  private readonly noticeAt = new Map<string, number>();
  /** The notice position each account's document already carries. */
  private readonly noticeSaved = new Map<string, string>();
  /**
   * Accounts whose cursor document this build could not read.
   *
   * The pass says so and anchors afresh in memory, but does **not** write over
   * it: a document reported as left exactly as it is must be left exactly as it
   * is, or the evidence of whatever made it unreadable is gone and the sentence
   * was the only thing that ever said otherwise.
   */
  private readonly cursorUnreadable = new Set<string>();
  /**
   * The claim this process is working under, as the document names it.
   *
   * A claim document is returned unchanged while this process holds it, so a
   * different `takenAt` is a claim this process has just taken — a boot, or a
   * handover back after someone else held it. Everything this process believed
   * about the durable state belongs to the previous tenure and is re-read then.
   */
  private claimTakenAt: string | null = null;
  /** When the last pass's document was written, so a quiet one is not a write. */
  private statusAt = 0;
  /** The pass failures already said in a group's conversation, and when. */
  private readonly failureSaid = new Map<string, number>();
  /** The status document as last written, so a pass with nothing new uploads none. */
  private lastStatus: PassStatusDoc | undefined;
  /** The last run the loop ended, for the status document a person reads. */
  private lastEnded: PassStatusDoc["lastEnded"] | null = null;
  /**
   * What this pass's ended runs measured, for the trend and the collector
   * (ADR 0038). Emptied by the pass that sends it; a pass that works nothing
   * adds nothing.
   */
  private readonly outbox: AgentMeasure[] = [];
  /**
   * What the installation spent today, as the pass's own document holds it.
   *
   * The daily ceiling's counter (ADR 0038): read with the last pass's document
   * when this process takes the claim, added to by every pass it works, and
   * reset when the UTC date changes (a lazy reset, on the read that finds it).
   */
  private statusSpent: PassStatusDoc["spent"] | null = null;
  /**
   * Permanent provider failures in a row, across the pass's accounts.
   *
   * A transient failure does not count and a success clears the count; the
   * pass stops at `PERMANENT_FAILURES_MAX` (ADR 0038).
   */
  private permanentFailures = 0;

  /**
   * Take the last ending the document holds, when this process takes the claim.
   *
   * One read per claim: a deploy does not blank the line a reader came for, and a
   * handover does not leave this process believing its own older ending is the
   * newest. A read that **failed** says nothing about the ending — a transient
   * failure is not news that there was none — so what this process already holds
   * is kept, and a document this build cannot read is left to the next status
   * write that replaces it.
   */
  private async loadLastEnded(): Promise<void> {
    try {
      const found = await readAppFileAt(
        this.ctx,
        filesAccountId(this.ctx),
        PASS_STATUS_FILE,
      );
      if (!found) {
        this.lastEnded = null;
        this.statusSpent = null;
        return;
      }
      const parsed = JSON.parse(found.text) as unknown;
      if (!isPassStatusDoc(parsed)) return;
      this.lastEnded = parsed.lastEnded ?? null;
      this.statusSpent = parsed.spent ?? null;
    } catch {
      // Kept, not blanked: the read failed, and that is not an ending.
    }
  }
  /**
   * What the installation has spent today, and the ceiling it is measured
   * against (ADR 0038). A date other than today's is yesterday's spend and is
   * not carried: the reset is lazy, on the read that finds it.
   */
  private dailySpent(maxDailyTokens: number, now: Date): number {
    const today = now.toISOString().slice(0, 10);
    const held = this.statusSpent?.date === today ? this.statusSpent.tokens : 0;
    return held >= maxDailyTokens ? held : 0;
  }
  /**
   * When each account's change cursor was last advanced, by the working pass.
   *
   * The working pass's own clock, used to seed a read and to answer nothing else:
   * the switched-off pass has its own position and its own age (`notices`), and
   * judging one by the other's clock is what threw a five-second-old cursor away
   * on the first pass after the switch went off.
   */
  private readonly cursorAt = new Map<string, number>();
  /** The runs the alarms have handed over, worked on the next pass. */
  private readonly pending: DueWait[] = [];
  /** The tokens this pass's runs spent, added to the document at its end. */
  private passTokens = 0;
  /**
   * The installation's memory as **this** pass read it (ADR 0033).
   *
   * Resolved the first time a pass needs it and reused for the rest of that
   * pass, so the whole store is walked once rather than once per change and once
   * per remembered fact. The pass clears it as it begins, so every pass reads the
   * memory afresh and a fact written during one is visible to the next.
   */
  private reading: Promise<MemoryStore> | null = null;
  /**
   * The group's instruction, by account, as this pass read it (ADR 0038).
   *
   * One document opened once and shared by the prose, the run's matrix and the
   * areas. Cleared as the pass begins, so an instruction a group edited is in
   * force at the next pass with no restart.
   */
  private readonly instructions = new Map<string, InstructionDoc | null>();
  private readonly timers: WaitTimers;
  private readonly catalogue: readonly AnyTool[];

  /** The model the current pass runs on, re-read from the document each pass. */
  private access: ModelAccess | null;
  /** The installation's limits as this pass read them (ADR 0038). */
  private limits: InstallationDocument["limits"] = installationDefaults().limits;
  /** The operator's switch on private provider addresses. */
  private readonly allowPrivate: boolean;
  /** When an account's change batch may be tried again after it failed. */
  private readonly retryAfter = new Map<string, number>();
  /** How many passes of an account have failed in a row, for the wait between them. */
  private readonly retryCount = new Map<string, number>();
  /** When each account's archive last ran, so the scan is hourly, not per pass. */
  private readonly archivedAt = new Map<string, number>();

  /**
   * The working set as this process last read it, per account and under the
   * FileNode state it was read at. A pass that finds the same state has nothing
   * new to download; any write anywhere in the account moves the state.
   */
  private readonly runReadings = new Map<
    string,
    { state: string; records: RunRecord[] }
  >();
  /** Runs a pass tried while nothing waits on them: a failure is not retried at once. */
  private readonly stuckUntil = new Map<string, number>();
  /**
   * The state each account's last write in **this pass** produced. A due run's
   * record carries the token of the pass's listing, which the first write of
   * another run moves; using this newer token saves the conflict that would
   * otherwise be paid once per run.
   */
  private readonly passState = new Map<string, string>();
  /**
   * The token one run's own last write produced, by account and run id.
   *
   * The account-wide `passState` answers "what state is the account in after
   * this process wrote", which is the run-reading filter's question. It is not
   * a run's own compare-and-set token: another run's write moves the account
   * state past a stop written to this run, and a token from that write would
   * let this one overwrite the ending. Each run carries its own.
   */
  private readonly runState = new Map<string, string>();
  /** Set by the supervisor: a wait that came due asks for a pass now. */
  onDue?: () => void;

  constructor(
    /**
     * The context every request of this loop is made with. Mutable by one thing
     * only: a pass swaps in a copy carrying its own abort (`pass`), and puts this
     * back when it returns.
     */
    private ctx: Ctx,
    private readonly opts: AgentLoopOptions,
  ) {
    this.access = opts.access ?? null;
    this.allowPrivate =
      opts.allowPrivateProvider ?? opts.access?.allowPrivateProvider ?? false;
    this.catalogue = opts.catalogue ?? TOOLS;
    this.timers = new WaitTimers((due) => {
      this.pending.push(due);
      this.onDue?.();
    });
  }

  /** Boot: work what the installation left, and re-arm every wait it holds. */
  async start(now = new Date()): Promise<PassSummary> {
    return await this.pass(now);
  }

  /**
   * Give up the alarms, and the claim.
   *
   * A process that is stopping knows it is stopping: releasing the claim here
   * is what lets the next one take over at once instead of waiting out the ten
   * minutes a claim lives after its holder goes silent. A release that fails
   * changes nothing — the claim then lapses on its own, as it always did.
   */
  async stop(): Promise<void> {
    this.timers.stop();
    await releaseClaim(this.ctx, this.opts.holder).catch(() => undefined);
  }

  /**
   * One pass, timed, with what it did left where a person can read it.
   *
   * `workPass` is the pass; this is the boundary that says how long it took and
   * writes the last one into the installation's own `agent/status.json`
   * (ADR 0030's record, read by the administration). A pass is not an event and
   * writes no log line, which is exactly how an installation whose agent is
   * working looked like one whose agent had stopped.
   */
  async pass(now = new Date(), signal?: AbortSignal): Promise<PassSummary> {
    const started = Date.now();
    this.passTokens = 0;
    /*
     * The pass's abort travels on the context, which is the one thing every
     * request of the pass is made with (`Ctx.signal`): the supervisor gives a pass
     * up by aborting here, and the mail server stops answering it. Swapping the
     * context is safe because one pass runs at a time — the supervisor keeps
     * `inFlight` until the pass is really gone (`supervisor.ts`).
     */
    const own = this.ctx;
    if (signal) this.ctx = { ...own, signal };
    try {
      const summary = await this.workPass(now);
      // What this pass's runs spent joins what the changes spent, so the document
      // and the daily counter have one number (ADR 0038).
      summary.tokens += this.passTokens;
      summary.ms = Date.now() - started;
      await this.recordStatus(summary);
      return summary;
    } finally {
      this.ctx = own;
    }
  }

  /**
   * Whether the supervisor has given this pass up (`PASS_WATCHDOG_MS`).
   *
   * Asked where a pass would start new work, and nowhere else: what is already in
   * flight ends on its own, and a run stopped between two waves stays on the record
   * for the pass that follows.
   */
  private get givenUp(): boolean {
    return this.ctx.signal?.aborted === true;
  }

  /**
   * One pass: claim the installation, then work every account's runs and
   * changes.
   *
   * A peer that holds the claim is answered with one read and no work at all —
   * this process is not the installation's agent while another is, and not even
   * the accounts are resolved — and the claim is renewed while it works, so a
   * holder that is busy is not taken over.
   *
   * The accounts are resolved **here**, once per pass and after the claim
   * (ADR 0038): what the Master works is what Stalwart's directory says at this
   * moment, so a grant added or withdrawn needs no restart.
   */
  private async workPass(now: Date): Promise<PassSummary> {
    const summary: PassSummary = {
      claimed: false,
      accounts: 0,
      changes: 0,
      runs: 0,
      due: 0,
      tokens: 0,
      ms: 0,
      gaps: [],
    };
    try {
      await this.workClaimed(now, summary);
    } catch (err) {
      /*
       * A pass given up on stops where it is: the abort the supervisor took is its
       * own doing, not a failure of the installation, and the summary says what it
       * managed before it went. Anything else is thrown, as before.
       */
      if (!this.givenUp) throw err;
      summary.gaps.push("the pass was given up on, and stopped where it was");
    }
    return summary;
  }

  /** The body of a pass, from the claim on: what `workPass` wraps. */
  private async workClaimed(now: Date, summary: PassSummary): Promise<void> {
    this.reading = null;
    this.instructions.clear();
    const claim = await takeClaim(this.ctx, this.opts.holder, now);
    if (!claim) return;
    this.claimExpires = claim.expires;
    if (Date.parse(claim.expires) - now.getTime() <= CLAIM_RENEW_WITHIN_MS) {
      if (!(await renewClaim(this.ctx, this.opts.holder, now))) return;
      this.claimExpires = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
    }
    summary.claimed = true;
    /*
     * A claim this process has just taken is a fresh tenure.
     *
     * Everything this process believes about the durable state was read by the
     * tenure before it — its own, or another holder's — and a handover must not
     * leave this process writing an older position over a newer one. What is
     * re-read here is exactly what is durable: the cursors (both positions), and
     * the last ending, which is news this tenure has not read and is taken before
     * this pass can end anything of its own.
     */
    if (claim.takenAt !== this.claimTakenAt) {
      this.claimTakenAt = claim.takenAt;
      this.cursors.clear();
      this.cursorAt.clear();
      this.savedCursor.clear();
      this.cursorUnreadable.clear();
      this.notices.clear();
      this.noticeAt.clear();
      this.noticeSaved.clear();
      await this.loadLastEnded();
    }
    /*
     * The pass is the unit the agent's listings are read for: a mailbox or a
     * folder level a person changed between two passes is seen by the next one,
     * and a step inside this pass still reuses what the pass read. Scoped to
     * this context, so a browser request's own memory is not dropped as a side
     * effect of a pass that works nothing.
     */
    forgetRemembered(this.ctx);
    forgetMemoryStores();
    this.passState.clear();
    this.runState.clear();
    /*
     * The switch is read first, before the model is: off means no model call is
     * made at all, an unreadable document stops the pass, and the value this
     * process holds answers the members' surfaces even on a pass that has no
     * model to run.
     *
     * The model is re-read every pass, so a publish applies to the run after
     * this one (ten seconds), not to the next boot: the key is kept in the
     * document and read here as the Master. A document that cannot be read
     * leaves the model this process already runs on.
     */
    const agentSwitch = await readAgentSwitch(this.ctx, filesAccountId(this.ctx));
    const {
      access: model,
      instruction,
      limits,
      fellBack,
    } = await this.readInstallationForPass();
    /*
     * A pass that could not read the installation runs on the defaults, and that
     * is said instead of being left for somebody to notice: a limit that fell
     * back to its default is a run the group paid for without being told.
     */
    if (fellBack) summary.gaps.push(fellBack);
    if (!model) {
      setRunningModelAccess(null);
      summary.gaps.push("the installation names no model, so this pass worked nothing");
      return;
    }
    this.access = model;
    this.limits = limits;
    setRunningModelAccess(model);
    this.installation = instruction;
    /*
     * The day's ceiling is read before any account's changes are read
     * (ADR 0038): a spent day opens no run, so the changes are not even read —
     * nothing is consumed without a run behind it — while a run already open is
     * still worked: the ceiling refuses new work and never cuts one in flight.
     */
    const spentToday = this.dailySpent(limits.maxDailyTokens, now);
    if (spentToday) {
      /*
       * The reason is said when the pass's own document is due, not on every
       * pass: the status write counts a gap as work, so an unthrottled line here
       * rewrote `agent/status.json` every ten seconds for the rest of a spent
       * day. The gate itself is not throttled — nothing is read, every pass.
       */
      if (Date.now() - this.statusAt >= STATUS_EVERY_MS) {
        summary.gaps.push(
          `the installation has spent its day: ${spentToday} of ${limits.maxDailyTokens} tokens, so no change is read until the date changes`,
        );
        this.opts.log?.(
          `[gilbert] agent: the day's token ceiling is spent (${spentToday}/${limits.maxDailyTokens}); changes are not read this pass`,
        );
      }
    }
    const accounts = await this.opts.accounts();
    summary.accounts = accounts.length;
    /*
     * Said in the pass's own document, not only in the journal: an installation
     * whose Master holds no group works nothing at all, and a person watching the
     * group's conversation has no way to tell that from an agent with nothing to
     * say (2026-10-27: three messages into a group whose agent was idle, and not a
     * line anywhere).
     */
    if (accounts.length === 0)
      summary.gaps.push(
        "the Master works no group, so nothing is read: add it to a group in the directory",
      );
    if (!agentSwitch.enabled) {
      /*
       * Off still answers the people who wrote -- in chat and by mail, with a
       * fixed sentence and no model call -- and the owner chose that directly
       * rather than through an instruction's class-3 licence.
       */
      /*
       * A mail addressed to the agent **alone** lands in the Master's own
       * mailbox, not in a group's: the groups are what the agent works, and the
       * Master is the installation's own account. The off notice is the one
       * thing that has to read it.
       */
      const offAccounts = [...accounts];
      // The agent's own mailbox is the session's primary **mail** account, which
      // is not necessarily the account the installation keeps its documents in.
      const master =
        this.ctx.session.primaryAccounts?.[CAPABILITIES.mail] ?? filesAccountId(this.ctx);
      if (master && !offAccounts.includes(master)) offAccounts.push(master);
      await Promise.all(
        offAccounts.map(async (accountId) => {
          const problems: string[] = [];
          /*
           * The notice has its **own** position, restored before the age
           * question below: a boot while the agent is off answers the mentions
           * that arrived while it was down, and the hour's rule still applies to
           * a position that is genuinely old.
           *
           * It is a document of its own on purpose: the off path must not write
           * into the working cursor, or an installation switched off for an hour
           * loses the window the on path exists to keep — and the loss is written
           * down. Two readers with two freshness rules need two positions, and
           * neither may destroy the other's.
           */
          const unreadable = await this.restoreNotice(accountId);
          if (unreadable) problems.push(unreadable);
          /*
           * A notice is for what has just arrived. A position nobody has
           * advanced for an hour would answer every mention of that time: past
           * the hour, read from now. The age is the notice's own, and starting
           * afresh is a decision of this read — not something written into a
           * document another reader owns.
           */
          const fresh =
            now.getTime() - (this.noticeAt.get(accountId) ?? 0) <= OFF_READING_FRESH_MS;
          const reading = new Map<string, EventCursor>();
          const held = this.notices.get(accountId);
          if (fresh && held) reading.set(accountId, held);
          await offPath(
            { ctx: this.ctx, cursors: reading, self: this.ctx.username },
            accountId,
            problems,
          ).catch((err) => problems.push(errorMessage(err)));
          const reached = reading.get(accountId);
          if (reached) {
            this.notices.set(accountId, reached);
            try {
              await this.saveNotice(accountId);
            } catch (err) {
              problems.push(errorMessage(err));
            }
          }
          /*
           * The age is the read's, not the write's: a save that failed after a
           * reading that succeeded still leaves this process holding a current
           * position, and discarding it an hour later would skip the mentions
           * that arrived in between. Across a restart the document's own `at` is
           * what the hour is measured from, which is the boot this guards.
           */
          this.noticeAt.set(accountId, now.getTime());
          for (const problem of problems) summary.gaps.push(`${accountId}: ${problem}`);
          /*
           * The archive is housekeeping, not a decision: a switched-off agent
           * still keeps the group's runs folder to the year the owner chose.
           * Its hourly guard is tested **before** the listing, or every
           * switched-off pass would walk the folder to decide nothing.
           */
          if (now.getTime() - (this.archivedAt.get(accountId) ?? 0) < ARCHIVE_EVERY_MS)
            return;
          try {
            const read = await listRunsForWorking(this.ctx, accountId);
            for (const problem of read.problems)
              summary.gaps.push(`${accountId}: ${problem}`);
            const moved = new Set<string>();
            for (const gap of await this.archive(accountId, read.records, now, moved))
              summary.gaps.push(`${accountId}: ${gap}`);
          } catch (err) {
            summary.gaps.push(`${accountId}: ${errorMessage(err)}`);
          }
        }),
      );
      summary.gaps.push("the agent is turned off for this installation");
      return;
    }
    /*
     * A group the Master no longer works keeps no queued alarm: the queue is
     * this pass's accounts and nothing else, or a process that runs for weeks
     * carries one entry per fired timer per account it lost. The alarms are
     * handed to their accounts here, before any account starts, because the
     * accounts are worked together.
     */
    const handed = new Map<string, string[]>();
    for (const due of this.pending) {
      if (!accounts.includes(due.accountId)) continue;
      const list = handed.get(due.accountId) ?? [];
      list.push(due.runId);
      handed.set(due.accountId, list);
    }
    this.pending.length = 0;
    for (const accountId of this.runReadings.keys())
      if (!accounts.includes(accountId)) this.runReadings.delete(accountId);
    for (const key of this.stuckUntil.keys())
      if (!accounts.includes(key.split("\u0000")[0] ?? "")) this.stuckUntil.delete(key);
    /*
     * One account is one group, and the groups do not wait on each other: the
     * slowest is usually a model call, and a group whose turn came later was
     * paying for that wait every ten seconds. Each account keeps its own run
     * documents, cursors and timers; what they share is the installation's
     * claim (renewed once, below) and the pass summary.
     */
    try {
      await Promise.all(
        accounts.map(async (accountId) => {
          // A pass given up starts no new account: what is already in flight ends
          // on its own, and the pass after this one reads from the cursor left here.
          if (this.givenUp) return;
          this.opts.log?.(`[gilbert] agent: working ${accountId}`);
          let records: RunRecord[] | null = null;
          /*
           * One account that cannot be read is not the installation failing: a
           * single instruction this build cannot parse is a group to leave alone
           * for this pass, not a reason to stop working every other group — and the
           * pass that throws here would throw again on the next beat, for ever. The
           * reason goes into the pass's gaps, which the supervisor reports.
           */
          /*
           * The account's changes are read first: the FileNode state they end at
           * is the state the run listing is judged against, so the pass never
           * asks the account for that state separately. A read that fails is said
           * and the due runs are still worked from the state `workDue` reads for
           * itself — the handed alarm is not lost with the reading.
           */
          let read: AccountEvents | null = null;
          if (spentToday) {
            // A spent day reads nothing: no run may open, so no change is taken.
          } else if ((this.retryAfter.get(accountId) ?? 0) <= now.getTime()) {
            try {
              // The first pass of a process resumes from the cursor the last one
              // left (ADR 0037); a document this build cannot read is the pass's
              // gap, and the reading anchors afresh in the same breath.
              const problem = await this.restoreCursor(accountId);
              if (problem) summary.gaps.push(`${accountId}: ${problem}`);
              read = await readChangesForPass(this.ctx, this.cursors, accountId);
              // The cursor now stands where this pass read: the off path's age
              // check reads this instant, not its own last run.
              this.cursorAt.set(accountId, now.getTime());
            } catch (err) {
              summary.gaps.push(`${accountId}: ${errorMessage(err)}`);
            }
          }
          try {
            records = await this.workDue(
              accountId,
              now,
              summary,
              handed.get(accountId) ?? [],
              read?.cursor.files,
            );
            const moved = new Set<string>();
            for (const gap of await this.archive(accountId, records, now, moved))
              summary.gaps.push(`${accountId}: ${gap}`);
            /*
             * A run moved to its drawer is not in the working set any more: the
             * change batch is not handed it, so an old question cannot be answered
             * against a document that is no longer there. What the batch worked is
             * the account's working set as this pass leaves it, which is what the
             * waits are armed from.
             */
            const after =
              spentToday || this.givenUp
                ? records
                : await this.workChanges(
                    accountId,
                    now,
                    summary,
                    moved.size
                      ? records.filter((record) => !moved.has(record.run.id))
                      : records,
                    read ?? undefined,
                  );
            if (after) records = after;
            /*
             * An ending written and not said — the conversation refused the
             * message, or the process stopped between the write and the words — is
             * said once the way is clear. The record carries the debt (`said:
             * false`) until it is paid, which is what keeps a run that already
             * spoke from speaking again.
             */
            for (const { run: finished } of records) {
              if (finished.ended?.said !== false) continue;
              let said = false;
              try {
                said = await this.sayEnding(
                  accountId,
                  finished,
                  chatWoken(finished.startedBy.woke),
                );
              } catch (err) {
                /*
                 * The post failed: the debt stays and the pass says so. It is not a
                 * silence — a saying that can never leave is something a person has
                 * to be able to see — and it is not a `continue`, which swallowed
                 * both the failure and the reason.
                 */
                summary.gaps.push(
                  `${accountId}: ${finished.id}: its ending was not said: ${errorMessage(err)}`,
                );
                continue;
              }
              if (!said) continue;
              try {
                await this.markSaid(accountId, finished);
              } catch (err) {
                summary.gaps.push(
                  `${accountId}: ${finished.id}: its ending was said and could not be marked: ${errorMessage(err)}`,
                );
              }
            }
            await this.saveCursor(accountId);
            this.pruneStuck(accountId, records);
            /*
             * The filter on the pass side: the last state a store produced is
             * remembered as the cached set's state. The next pass reads the
             * account's state; when it is still that one, nothing but this
             * process's own run writes moved it, and the working set is the one
             * already held — no folder walk, no downloads. A person's write (a
             * stop among them) moves the state to a value this process did not
             * produce, so it is listed.
             */
            const selfState = this.passState.get(accountId);
            if (selfState && records)
              this.runReadings.set(accountId, { state: selfState, records });
          } catch (err) {
            /*
             * A broken provider is the installation's state, not one account's
             * trouble (ADR 0038): `noteModelFailure` counts a permanent refusal
             * and stops the pass on the third in a row; the runs stay `running`
             * and `workPass` puts the reason in the status a person reads. A
             * transient failure (5xx, a timeout) is said and retried.
             */
            if (err instanceof PassStopped) throw err;
            this.noteModelFailure(err);
            summary.gaps.push(`${accountId}: ${errorMessage(err)}`);
          }
          /*
           * The waits are armed **after** the due runs have been advanced: a re-arm
           * beside a run whose document has not moved would hand the same instant
           * over twice (`timers.ts`), and a process that restarts re-arms what the
           * installation left. Its own guard, because arming reads the account's run
           * documents: an unreadable one is a gap for this pass, not a reason to
           * stop the accounts after it — and the account whose work failed is armed
           * all the same, from the runs that can be read.
           */
          try {
            const problems: string[] = [];
            await this.timers.arm(this.ctx, accountId, problems, records ?? undefined);
            for (const problem of problems) summary.gaps.push(`${accountId}: ${problem}`);
          } catch (err) {
            summary.gaps.push(`${accountId}: ${errorMessage(err)}`);
          }
          this.opts.log?.(`[gilbert] agent: finished ${accountId}`);
        }),
      );
    } catch (err) {
      /*
       * The provider is broken, and three refusals in a row say so (ADR 0038):
       * the pass stops here, the runs stay `running`, and the status document
       * carries the reason. Nothing was consumed that nobody answered.
       */
      if (!(err instanceof PassStopped)) throw err;
      summary.gaps.push(err.reason);
      this.opts.log?.(`[gilbert] agent: the pass stopped: ${err.reason}`);
      return;
    }
    /*
     * The memory is read on the first change that needs it, not at the top of
     * every pass: a quiet pass pays for no store it never consults. A sheet it
     * could not read is said in the pass's own gaps, as before.
     */
    for (const problem of await this.memoryProblems())
      summary.gaps.push(`memory: ${problem}`);
    return;
  }

  /**
   * The sheets this pass's memory reading could not use, or none if it never
   * read.
   *
   * A reading that failed was already reported by the account that needed it;
   * awaiting the rejected promise here would turn that gap into a failed pass.
   */
  private async memoryProblems(): Promise<string[]> {
    if (!this.reading) return [];
    try {
      return (await this.reading).problems;
    } catch {
      return [];
    }
  }

  /** Move the old runs this pass read, and answer what could not be moved. */
  private async archive(
    accountId: string,
    records: readonly RunRecord[],
    now: Date,
    moved: Set<string>,
  ): Promise<string[]> {
    /*
     * Housekeeping, once an hour: a pass every ten seconds has no business
     * walking the working set for old runs, and a switched-off agent even less.
     * The first pass after a boot does it; the rest say nothing.
     */
    if (now.getTime() - (this.archivedAt.get(accountId) ?? 0) < ARCHIVE_EVERY_MS)
      return [];
    const gaps = await archiveOldRuns(this.ctx, accountId, records, now, {
      max: ARCHIVE_PER_PASS,
      beforeMove: () => this.keepClaim(),
      moved,
    });
    this.archivedAt.set(accountId, now.getTime());
    return gaps;
  }

  /** Every run of one account whose wait has come due, worked again. */
  private async workDue(
    accountId: string,
    now: Date,
    summary: PassSummary,
    handed: readonly string[],
    /** The FileNode state this pass's changes read ended at, when one was read. */
    state?: string,
  ): Promise<RunRecord[]> {
    /*
     * The alarms hand every dated wait over exactly once, and the documents ask
     * the same question again: a process that has just started has fired nothing
     * yet, so a wait that came due while it was down is due on its first pass.
     *
     * One listing answers both questions: the waits that are due, and the runs
     * a process did not finish — a run left `running` with no wait (a restart, a
     * crash, a pass that failed after the run was opened). Two listings asked
     * `runs/` the same thing twice, every pass, for every account.
     */
    const currentState = state ?? (await appFolderState(this.ctx, accountId));
    const read = this.runReadings.get(accountId);
    let records: RunRecord[];
    if (read?.state === currentState) {
      // Nothing in the account moved since the last pass: the set it read is
      // still the set, and a quiet pass walks no folder and downloads nothing.
      records = read.records;
    } else {
      const listed = await listRunsForWorking(this.ctx, accountId, currentState);
      for (const problem of listed.problems)
        summary.gaps.push(`${accountId}: ${problem}`);
      records = listed.records;
      this.runReadings.set(accountId, { state: currentState, records });
    }
    const at = new Map(records.map((record, index) => [record.run.id, index]));
    const runs = new Set(handed);
    for (const { run } of records) {
      if (isRunDue(run, now)) runs.add(run.id);
      if (
        run.state === "running" &&
        run.waiting === null &&
        (this.stuckUntil.get(`${accountId}\u0000${run.id}`) ?? 0) <= now.getTime()
      )
        runs.add(run.id);
    }
    for (const id of runs) {
      // A pass given up on starts no further run: what it already worked is on the
      // record, and the pass after it picks the rest up.
      if (this.givenUp) break;
      const index = at.get(id);
      const record = index === undefined ? null : records[index];
      if (!record) continue;
      /*
       * One run that fails is **that run's** failure. The pass goes on with the
       * others and, above all, with the account's own bookkeeping — the cursor,
       * the archive, the debts of every other run. A throw here would leave the
       * whole account unworked for that pass and for every pass after it, which
       * is a defect in one run turning into an installation that stopped.
       */
      try {
        /*
         * A run waiting on a person is picked up only when the question's deadline
         * has come (ADR 0029, 0030): the work then goes on without the answer, with
         * a step that says what did not come, rather than waiting for ever.
         */
        let due = record.run;
        if (due.state === "blocked") {
          if (!isRunDue(due, now)) continue;
          const overdue = answerOverdue(due, now.toISOString());
          /*
           * The transition is **written before the run is worked**: the step it
           * adds and the step it spends are then what the record holds, and a
           * model call whose spend never landed would make the declared ceiling a
           * number the loop can pass — which is what an overdue run paid for on
           * every pass that failed. A write that does not land leaves the run
           * blocked and still due, and the next pass tries again.
           */
          const stored = await this.store(accountId, overdue, record.state);
          if (!stored) continue;
          due = overdue;
          if (index !== undefined) records[index] = { state: stored, run: overdue };
        } else if (due.state !== "running") continue;
        summary.due += 1;
        /*
         * A run nothing waits on is the crash path: it has no date, so the clock
         * cannot say when to try it again. One minute between attempts keeps a
         * failure from paying for a model call every ten seconds; the first
         * attempt after a restart is immediate.
         */
        const key = `${accountId}\u0000${due.id}`;
        /*
         * A run a pass left on purpose is not the crash path (R6): it is resumed at
         * once, and only a run nothing explains waits the minute.
         */
        const stuck = due.waiting === null && due.slice === undefined;
        if (stuck) this.stuckUntil.set(key, now.getTime() + STUCK_RETRY_MS);
        const worked = await this.workRun(
          accountId,
          due,
          undefined,
          record.state,
          // The questions the pass already read, so this run does not re-ask one.
          openWaits(records, due.id),
          now,
        );
        const stillStuck = worked?.state === "running" && worked.waiting === null;
        if (!stillStuck) this.stuckUntil.delete(key);
        // The archive and the change batch see the document as this pass left it.
        if (worked && index !== undefined)
          records[index] = {
            state: this.runState.get(key) ?? record.state,
            run: worked,
          };
      } catch (err) {
        this.noteModelFailure(err);
        summary.gaps.push(`${accountId}: ${record.run.id}: ${errorMessage(err)}`);
      }
    }
    // What the pass read is also what the archive decides on: a run this pass
    // just ended is on the list with its ending, and goes in its drawer now.
    return records;
  }

  /**
   * Count a model call that failed for good, and stop the pass on the third in
   * a row (ADR 0038). A transient failure is not counted; a success resets.
   */
  private noteModelFailure(err: unknown): void {
    if (!(err instanceof ModelError) || !err.permanent) return;
    this.permanentFailures += 1;
    if (this.permanentFailures < PERMANENT_FAILURES_MAX) return;
    throw new PassStopped(
      `the installation's model refused ${PERMANENT_FAILURES_MAX} calls in a row: ${errorMessage(err)} — a run already open stays running until the provider answers.`,
    );
  }

  /**
   * One account's changes, each put to the decision turn, and every change the
   * group's instruction covers given its own run.
   *
   * A change no instruction covers costs no model call and no step. One change
   * opens **one** run (ADR 0038): a group has one instruction, so there is no
   * second to choose between and nothing to route. The same change is not a second
   * run — the runs the account already holds are read for it once, when the first
   * change is covered, and a run whose `startedBy` names this change is what the
   * record says that change has been answered by: one still running is continued
   * from its own document, and one that has ended is left as the answer it is, so a
   * pass that re-reads a change it did not finish cannot work it twice. One change
   * reaches this loop once per read — a node's create and its update are one event
   * (`events.ts`) — so the record is the whole of what "the same change" is
   * recognised by. A change that **answers** a question this account is waiting on
   * is neither: the run that asked is continued and no run of its own is opened
   * (`runAnsweredBy`).
   */
  private async workChanges(
    accountId: string,
    now: Date,
    summary: PassSummary,
    records: readonly RunRecord[],
    /** The changes this pass already read; `workChanges` makes its own without. */
    read?: AccountEvents,
  ): Promise<RunRecord[] | null> {
    /*
     * The batched changes of one account. Kept as a function over what it needs
     * rather than as a method over the whole class: the cursor, the prose and
     * the run work are all it touches, and naming them is what lets a reader see
     * that without reading the rest of the loop.
     */
    const access = this.access;
    if (!access) return null;
    /*
     * A batch that failed is not retried ten seconds later: the same change,
     * the same provider, the same failure -- and each retry pays a model call.
     * A minute's pause per account bounds the cost while a failure is real.
     */
    if ((this.retryAfter.get(accountId) ?? 0) > now.getTime()) return null;
    try {
      const after = await workChanges(
        {
          ctx: this.ctx,
          cursors: this.cursors,
          access,
          proseAbove: (a) => this.proseAbove(a),
          instructionOf: (a) => this.instructionOf(a),
          memory: () => this.memory(),
          readingCall: (a, e, meter) => this.readingCall(a, e, meter),
          runAnsweredBy: (a, e, r) => this.runAnsweredBy(a, e, r),
          workRun: (a, r, f, oq, written) =>
            this.workRun(a, r, f, undefined, oq, now, written),
          authoriseAnswer: (x) => this.authoriseAnswer(x),
          openRun: (a, e, r, about, by) => this.openRun(a, e, r, about, by),
          noteDrop: (a, path, at) => noteFile(this.ctx, a, path, at),
          dueDrops: (a, at) => dropsDue(this.ctx, a, at),
          forgetDrop: (a, folder, answered) =>
            dropForgotten(this.ctx, a, folder, answered),
          forgetDropPath: (a, path) => dropPathForgotten(this.ctx, a, path),
          readEventFile: (a, path, meter) => this.readEventFile(a, path, meter),
          modelAnswered: () => {
            this.permanentFailures = 0;
          },
        },
        accountId,
        now,
        summary,
        records,
        read,
      );
      this.retryAfter.delete(accountId);
      this.retryCount.delete(accountId);
      return after;
    } catch (err) {
      /*
       * A failed pass waits a little, and a little longer each time: the failures
       * that cost a group its work were Stalwart's own ceiling —
       * `maxConcurrentRequests` — and a flat minute of silence answered a limit
       * that clears in a second. The schedule doubles from two seconds to a
       * half-minute, with a quarter of jitter so two accounts refused together do
       * not come back together.
       */
      const attempt = (this.retryCount.get(accountId) ?? 0) + 1;
      this.retryCount.set(accountId, attempt);
      const base = Math.min(2_000 * 2 ** (attempt - 1), 30_000);
      const wait = Math.round(base * (0.75 + Math.random() * 0.5));
      this.retryAfter.set(accountId, now.getTime() + wait);
      await this.sayThePassFailed(accountId, err);
      throw err;
    }
  }

  /**
   * Say it in the group's own conversation when the pass cannot read its work.
   *
   * A group whose pass keeps failing saw nothing at all: no run, no notice, no
   * line anywhere — a person wrote three times into a conversation that looked
   * alive and heard nothing back (live, 2026-10-27, where every pass of the
   * account ended in Stalwart's `maxConcurrentRequests`). Silence is only honest
   * when there is nothing to say; a failure the account can be told about is
   * something to say.
   *
   * Once per reason per half hour: a failing pass repeats every minute, and a
   * message per minute is a second fault on top of the first.
   */
  private async sayThePassFailed(accountId: string, err: unknown): Promise<void> {
    /*
     * Only a failure to **read** is the group's business. A run's own refused step
     * — a model that used a bad argument or named a tool that turn does not offer —
     * is on that run's record, and saying it here told a group "I could not read
     * this group's changes" three times in one minute about work it could read
     * perfectly well (live, 2026-10-27).
     */
    if (!(err instanceof JmapError) && !(err instanceof UpstreamError)) return;
    const reason = errorMessage(err).slice(0, 200);
    /* One line an hour, whatever the reason: a failing pass repeats every minute,
       and a message per minute is a second fault on top of the first. */
    const last = this.failureSaid.get(accountId) ?? 0;
    if (Date.now() - last < 60 * 60_000) return;
    this.failureSaid.set(accountId, Date.now());
    try {
      await postChatMessage(
        this.ctx,
        accountId,
        this.ctx.username,
        `I could not read this group's changes: ${reason} Nothing has been worked since, and I will try again.`,
      );
    } catch {
      // The pass's own failure is already the gap it reports; a notice that
      // cannot be posted must not become a second exception.
    }
  }

  /**
   * The call the decision turn's own reads are made against.
   *
   * Those reads are the write-free half of the catalogue, which asks nobody's
   * authority, so the run this carries is never consulted by the guard: it is a
   * stand-in for the runs this change would open, and the runs the loop actually
   * writes are the ones the decision names.
   */
  private readingCall(
    accountId: string,
    event: AccountEvent,
    meter: UsageMeter,
  ): ToolCall {
    const embed = this.embedder(meter);
    return {
      ctx: this.ctx,
      accountId,
      readImage: (image) => this.eyes(image, meter),
      ...(embed ? { embed } : {}),
      // A model call a reading tool makes inside the decision turn (a `brief`)
      // belongs to that turn's meter, and so to the day's counter.
      meter,
      run: startRun({
        id: randomUUID(),
        startedBy: { woke: wokeOf(event) },
      }),
    };
  }

  /**
   * What the account holds for a case, as the pass reads it once before a run's
   * first turn: the knowledge base's page titles and the group's Files, two levels,
   * names only (ADR 0038).
   *
   * These are the same lookups the model made by hand in the failing runs, and it
   * made ten of them before its first act. They are read through the tools' own
   * reading half, which no area narrows — reading is free (ADR 0038), so a group
   * that declares no knowledge still sees the titles of what the base holds — and
   * an answer that fails leaves its block absent rather than failing the run.
   */
  private async caseHeld(accountId: string, run: RunDoc): Promise<CaseHeld> {
    const catalogue = catalogueFor(this.catalogue, await this.areasOfRun(accountId, run));
    const embed = this.embedder();
    const call: ToolCall = {
      ctx: this.ctx,
      accountId,
      readImage: this.eyes,
      ...(embed ? { embed } : {}),
      run,
    };
    const look = async (raw: Record<string, unknown>): Promise<unknown> => {
      try {
        return await runTool(catalogue, call, "open", raw);
      } catch (err) {
        this.opts.log?.(
          `[gilbert] agent: run ${run.id} could not read part of its case: ${errorMessage(err)}`,
        );
        return null;
      }
    };
    const strings = (answer: unknown, key: string, field: string): string[] => {
      if (!isRecord(answer) || !Array.isArray(answer[key])) return [];
      return answer[key].flatMap((one) =>
        isRecord(one) && typeof one[field] === "string" ? [one[field]] : [],
      );
    };
    /*
     * A knowledge base is named by its pages' titles: the standing instruction is
     * prose and names no page, so the turn is told what the base holds and opens the
     * one it needs — and the case's note keeps what it read.
     */
    const pages = strings(await look({ what: "pages" }), "pages", "title");
    /*
     * The case's place: the group's own Files, two levels, names only — the level a
     * person browsing it sees. A folder is marked with a trailing slash so the model
     * knows what it can ask for, and a level is bounded rather than paged: what the
     * turn needs is the shape of the place, not its inventory.
     */
    const top = await look({ what: "files", limit: CASE_PLACE_MAX });
    const place = strings(top, "nodes", "path");
    const folders = (isRecord(top) && Array.isArray(top.nodes) ? top.nodes : []).flatMap(
      (one) =>
        isRecord(one) && one.nodeType === "directory" && typeof one.path === "string"
          ? [one.path]
          : [],
    );
    for (const folder of folders.slice(0, CASE_PLACE_FOLDERS_MAX)) {
      // The block is bounded, so a level read after it is full is a call nobody reads.
      if (place.length >= CASE_PLACE_LINES_MAX) break;
      place.push(
        ...strings(
          await look({ what: "files", path: folder, limit: CASE_PLACE_MAX }),
          "nodes",
          "path",
        ),
      );
    }
    const held: CaseHeld = {};
    if (pages.length) held.pages = pages.slice(0, CASE_PLACE_MAX);
    if (place.length) held.place = place.slice(0, CASE_PLACE_LINES_MAX);
    /*
     * The last report this case sent: the group's own conversation, searched for the
     * case's key and read for the newest word from the agent's own address. A report
     * is what an instruction can forbid repeating, and an agent that has not seen the
     * sentence has no way to obey.
     */
    if (run.caseKey) {
      const said = await look({ what: "chats", query: run.caseKey, limit: 10 });
      const messages =
        isRecord(said) && Array.isArray(said.messages) ? said.messages : [];
      const mine = messages.find(
        (one) =>
          isRecord(one) &&
          typeof one.text === "string" &&
          sameAddress(typeof one.from === "string" ? one.from : "", this.ctx.username),
      );
      if (isRecord(mine) && typeof mine.text === "string")
        held.lastReport = {
          at: typeof mine.at === "string" ? mine.at : "",
          text: mine.text,
        };
    }
    /*
     * The thread the waking message belongs to (ADR 0038): the reference a case is
     * known by, and the people it involves, live across the whole conversation — one
     * line each, no bodies. A message the server no longer holds answers nothing, and
     * the case simply starts without it.
     */
    const messageId = mailWoken(run.startedBy.woke);
    if (messageId) {
      try {
        const lines = await threadLines(this.ctx, accountId, messageId);
        if (lines.length > 1) held.thread = lines;
      } catch (err) {
        this.opts.log?.(
          `[gilbert] agent: run ${run.id} could not read its thread: ${errorMessage(err)}`,
        );
      }
    }
    return held;
  }

  /**
   * The case's note, read from its own file (ADR 0034).
   *
   * The key is the case the run works, or the run itself until the case has a name:
   * a change that names no case yet still keeps what its turns learned, and the first
   * `note` call that names the case moves the note with it.
   */
  private async noteOfCase(accountId: string, run: RunDoc): Promise<string | null> {
    try {
      const held = await readCaseNote(this.ctx, accountId, run.caseKey ?? run.id);
      return held?.text ?? null;
    } catch (err) {
      this.opts.log?.(
        `[gilbert] agent: run ${run.id} could not read its case note: ${errorMessage(err)}`,
      );
      return null;
    }
  }

  /** The cases already on file, names only — the index a turn recognises one by. */
  private async casesOnFile(accountId: string): Promise<string[]> {
    try {
      return await listCases(this.ctx, accountId);
    } catch (err) {
      this.opts.log?.(
        `[gilbert] agent: ${accountId} could not list its cases: ${errorMessage(err)}`,
      );
      return [];
    }
  }
  /** Open the run a change the group's instruction covers is answered by. */
  private async openRun(
    accountId: string,
    event: AccountEvent,
    instruction: InstructionDoc,
    /** What the change said, and who set it off (the pass read both). */
    about?: string,
    by?: string,
  ): Promise<RunDoc> {
    const run = startRun({
      id: randomUUID(),
      startedBy: {
        woke: wokeOf(event),
        // What the change said, in its own words, as the pass read it: the run
        // says why it exists without reading the source again.
        ...(about ? { about } : {}),
        ...(by ? { by } : {}),
        // The whole drop this run answers, so its plan reads the names instead
        // of listing the folder again (ADR 0034).
        ...(event.also?.length ? { batch: [...event.also] } : {}),
        // The write matrix the areas give at this instant (ADR 0038): the run says
        // where it may act, and a later edit does not move it. What wakes it is the
        // instruction's own surfaces, read by the pass.
        surfaces: writeSurfacesOf(instruction.areas),
      },
      // What held the run, recorded and never enforced (ADR 0038): a reader can
      // see the limits in force, and a pass that fell back to the defaults leaves
      // them visible in the run that paid for it.
      limits: {
        maxRunTokens: this.limits.maxRunTokens,
        maxRunSteps: this.limits.maxRunSteps,
        maxDailyTokens: this.limits.maxDailyTokens,
      },
    });
    await createRun(this.ctx, accountId, run);
    return run;
  }

  /**
   * The run a person's answer continues: the one parked on this very question.
   *
   * A question is asked in the group's own conversation (ADR 0029, 0038), so its
   * answer arrives there as a message of its own: what ties it to the run that
   * asked is the message it replies to — the very sentence the run recorded as
   * its wait — and the sender being a person rather than the agent. So the change
   * is the message, the message is read at the path the change names
   * (`groupChat.ts`), and `repliesToAuthor` (`shared/chat.ts`) answers whether it
   * is addressed to anything the agent wrote; the run that asked is the one whose
   * `waiting.asked` is that parent, and the step the record gains names the
   * message the answer itself came in.
   *
   * A mail answers nothing: an outward message is a draft a person sends
   * (ADR 0038), so no run ever waits on one. Nothing else is read: a change on
   * another surface, a removal, a message that is not one, a message that replies
   * to nobody and a question no run of this account is parked on all answer null
   * without a single extra read.
   */
  private async runAnsweredBy(
    accountId: string,
    event: AccountEvent,
    records: readonly RunRecord[],
  ): Promise<AnsweredRun | "already" | null> {
    if (event.source !== "chat" || event.change === "destroyed") return null;
    const message = await readChatMessageAt(this.ctx, accountId, event.where);
    if (!message) return null;
    const question: RunMessageRef = {
      channel: "chat",
      id: String(message.replyTo ?? ""),
    };
    const parent = await readChatMessage(this.ctx, accountId, question.id);
    if (!repliesToAuthor(message, parent, this.ctx.username)) return null;
    /*
     * The answer continues **every** run parked on that question: a group has one
     * conversation, and the runs that needed the same answer were parked on the
     * same sentence (`tools/chat.ts`), so one reply moves all of them. A run this
     * pass already continued is left as it is — the answer takes a run out of
     * `blocked` at once while the cursor moves only at the end of the batch, so a
     * pass that died in between re-reads this change — and the step the answer
     * wrote is what says it was already taken.
     */
    const waiting = runsAwaiting(records, question).filter(
      (run) => !runAnswered(run, message.id),
    );
    if (!waiting.length)
      return answeredAlready(records, "chat", message.id) ? "already" : null;
    return {
      runs: waiting.map((run) =>
        takeAnswer(run, question, { channel: "chat", id: message.id }, message.text),
      ),
      asked: parent?.text ?? "",
      said: message.text,
      from: message.from,
      at: message.at,
      message: { channel: "chat", id: message.id },
    };
  }

  /**
   * Forget the stuck-run back-off of runs this account no longer holds.
   *
   * The map is keyed by account and run, and a run that was archived never
   * comes back to it; without this a long-lived process keeps one entry per run
   * that was ever stuck.
   */
  private pruneStuck(accountId: string, records: readonly RunRecord[] | null): void {
    const prefix = `${accountId}\u0000`;
    const live = new Set((records ?? []).map((record) => `${prefix}${record.run.id}`));
    for (const key of this.stuckUntil.keys())
      if (key.startsWith(prefix) && !live.has(key)) this.stuckUntil.delete(key);
  }

  /**
   * The cursor the last process left, or nothing on this account's first read.
   *
   * Called once per account per process: the first account body that runs finds
   * no in-memory cursor and takes the document's. A document this build cannot
   * read is answered with the sentence the pass says, and the reading anchors
   * afresh — the same ending the server's `cannotCalculateChanges` has.
   */
  private async restoreCursor(accountId: string): Promise<string | null> {
    if (this.cursors.has(accountId)) return null;
    try {
      const held = await readCursor(this.ctx, accountId);
      if (!held) return null;
      this.cursors.set(accountId, held.cursor);
      this.cursorAt.set(accountId, held.at);
      this.savedCursor.set(accountId, JSON.stringify(held.cursor));
      return null;
    } catch (err) {
      /*
       * A document this build cannot read is **not** rewritten by this pass: the
       * reading anchors afresh in memory and the sentence stays true — the
       * document is left exactly as it is, for whoever looks at what made it
       * unreadable.
       */
      this.cursorUnreadable.add(accountId);
      return errorMessage(err);
    }
  }

  /**
   * The switched-off pass's own position, or nothing on this account's first.
   *
   * Its document is its own (`notices.json`), so a cursor this build cannot read
   * does not stop the notices and a notice never touches the working window.
   */
  private async restoreNotice(accountId: string): Promise<string | null> {
    if (this.notices.has(accountId)) return null;
    try {
      const held = await readCursor(this.ctx, accountId, NOTICE_CURSOR_FILE);
      if (!held) return null;
      this.notices.set(accountId, held.cursor);
      this.noticeAt.set(accountId, held.at);
      this.noticeSaved.set(accountId, JSON.stringify(held.cursor));
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  }

  /** Record how far the notices have read, in their own document. */
  private async saveNotice(accountId: string): Promise<void> {
    const cursor = this.notices.get(accountId);
    if (!cursor) return;
    const reached = JSON.stringify(cursor);
    if (this.noticeSaved.get(accountId) === reached) return;
    await this.keepClaim();
    let produced: string | null = null;
    await writeCursor(this.ctx, accountId, cursor, {
      file: NOTICE_CURSOR_FILE,
      onState: (state) => {
        produced = state;
      },
    });
    if (produced) {
      cursor.files = produced;
      this.notices.set(accountId, cursor);
    }
    this.noticeSaved.set(accountId, JSON.stringify(cursor));
  }

  /**
   * Write the cursor a batch ended at, once.
   *
   * A quiet account writes nothing: the document is rewritten only when the
   * reading moved, which is what keeps a pass that worked nothing to its reads
   * (ADR 0032's claim economy, and the reason a cursor is not a heartbeat).
   *
   * **The write is itself a change**, in the account it lands in, so the state
   * it produced is where this process's reading has now reached: it is taken
   * back into the cursor, and the next pass starts past our own document
   * instead of finding it. Without that the document records the state the read
   * ended at, the write moves that state, and every pass rewrites the file — a
   * change that kicks the next pass through the same switch every other write
   * does.
   *
   * **What may write it** is the claim, and nothing else. The account-wide
   * FileNode state cannot serve as this document's compare-and-set token: every
   * run write of the same pass moves it, so a conditional write would lose on
   * the state this process itself produced a moment earlier — a guard that fails
   * for a reason unrelated to who is writing. The claim is the authority here
   * (`keepClaim` refuses a holder whose claim is not its own), which is also why
   * a tenure change re-reads the document rather than trusting the map.
   */
  private async saveCursor(accountId: string): Promise<void> {
    // A cursor this build could not read is left exactly as it is.
    if (this.cursorUnreadable.has(accountId)) return;
    const cursor = this.cursors.get(accountId);
    if (!cursor) return;
    const reached = JSON.stringify(cursor);
    if (this.savedCursor.get(accountId) === reached) return;
    await this.keepClaim();
    let produced: string | null = null;
    await writeCursor(this.ctx, accountId, cursor, {
      onState: (state) => {
        produced = state;
      },
    });
    if (produced) {
      cursor.files = produced;
      this.cursors.set(accountId, cursor);
    }
    this.savedCursor.set(accountId, JSON.stringify(cursor));
  }

  /**
   * Leave the last pass where a person can read it.
   *
   * Written after a pass that worked something or found a gap, and otherwise at
   * most once a minute: a quiet pass is not an event, but a reader still needs to
   * know the pump is turning, and a write every thirty seconds would be one the
   * installation pays for saying nothing. A document that cannot be written is
   * the pass's gap, never a failed pass.
   */
  private async recordStatus(summary: PassSummary): Promise<void> {
    // A peer's installation is not this process's to write about: the one that
    // holds the claim says what the last pass did.
    if (!summary.claimed) return;
    // An installation whose session names no Files account has nowhere to leave
    // the document; the pass has already said the other gaps, and a write to no
    // account would add a sentence about a folder nobody has.
    const accountId = filesAccountId(this.ctx);
    if (!accountId) return;
    const at = new Date();
    const worked =
      summary.changes + summary.runs + summary.due > 0 || summary.gaps.length > 0;
    if (!worked && at.getTime() - this.statusAt < STATUS_EVERY_MS) return;
    /*
     * The daily counter (ADR 0038): what the document already held for today,
     * plus what this pass spent. A date it does not carry is yesterday's, and
     * the reset is this line rather than a scheduled write.
     */
    const date = at.toISOString().slice(0, 10);
    const before = this.statusSpent?.date === date ? this.statusSpent.tokens : 0;
    const spent = { date, tokens: before + summary.tokens };
    /*
     * The measures go to the collector the installation document names,
     * before the document is written, so a refusal is one of the gaps the
     * document then carries: a week read from the documents is the measure
     * without a collector, and a collector that is down is said rather than
     * silently absent (ADR 0038).
     */
    const collector = this.limits.otlp;
    if (collector) {
      const measures = [
        ...this.outbox.splice(0),
        {
          kind: "pass" as const,
          at: at.toISOString(),
          model: this.access?.model ?? null,
          tokens: summary.tokens,
          ms: summary.ms,
          steps: 0,
          calls: 0,
          refusals: 0,
          ending: "pass",
          gaps: summary.gaps.length,
        },
      ];
      try {
        await emitMeasures(collector, measures);
      } catch (err) {
        // Dropped rather than retried: the run documents hold the same measures,
        // and a collector that is down must not make every pass owe them.
        this.outbox.length = 0;
        summary.gaps.push(`otlp: ${errorMessage(err)}`);
      }
    } else {
      this.outbox.length = 0;
    }
    const doc: PassStatusDoc = {
      v: 1,
      at: at.toISOString(),
      ms: summary.ms,
      claimed: summary.claimed,
      accounts: summary.accounts,
      changes: summary.changes,
      runs: summary.runs,
      due: summary.due,
      gaps: summary.gaps,
      spent,
      ...(this.lastEnded ? { lastEnded: this.lastEnded } : {}),
    };
    /*
     * A pass that has nothing new to say does not upload a document to say it.
     *
     * Every write of a document is one **blob upload**, and Stalwart refuses the
     * installation once its blob quota is spent — "You have exceeded the blob
     * upload quota of 10000 files or 500000000 bytes", which stopped the agent on
     * 2026-10-27. The quota counts uploads, so a garbage collector frees nothing:
     * what saves it is not writing. `at` and `ms` move on every pass, so two
     * documents are never byte-identical; the comparison ignores them, and a
     * heartbeat is written at most once per `STATUS_EVERY_MS` so the surface still
     * says when the pass last ran.
     */
    const content = (one: PassStatusDoc) =>
      JSON.stringify({ ...one, at: undefined, ms: undefined });
    const unchanged =
      this.lastStatus !== undefined && content(this.lastStatus) === content(doc);
    if (unchanged && at.getTime() - this.statusAt < STATUS_EVERY_MS) {
      this.statusAt = at.getTime();
      return;
    }
    try {
      await writeAppFileAt(this.ctx, accountId, PASS_STATUS_FILE, doc);
      this.lastStatus = doc;
      this.statusAt = at.getTime();
      this.statusSpent = spent;
    } catch (err) {
      summary.gaps.push(`status: ${errorMessage(err)}`);
    }
  }

  /**
   * Work one run: choose a plan, work its steps out, write them whole, spend,
   * choose again.
   *
   * Every stop leaves the record saying which one it was — the model's `done`,
   * the liveness valve reached, a stall, or a call that parked the run on a
   * person. Every
   * call is its own step with its own outcome and its own spend, and a refusal —
   * an act beyond what the run carries, or a call that failed — is a failed step
   * on the run, never a silent skip. The model is shown every call's outcome
   * before it chooses again.
   */
  private async workRun(
    accountId: string,
    run: RunDoc,
    facts?: Record<string, string>,
    state?: string,
    /** The questions the group already has open, so this run does not re-ask. */
    openQuestions?: readonly RunWait[],
    /**
     * The pass's own clock, which every date this working sets is measured on:
     * a run left `running` is due again a minute later **by the pass**, and a
     * deadline taken from the wall clock would be judged by the other one.
     */
    now = new Date(),
    /**
     * The words the change carried, already read by the pass that decided it: the
     * turn is handed the message rather than spending its first step fetching it
     * (ADR 0038). A run resumed by a later pass has none, and its note carries what
     * the earlier turns kept.
     */
    written?: { from?: string; text: string; quoted?: string },
  ): Promise<RunDoc | null> {
    const access = this.access;
    if (!access) return null;
    this.opts.log?.(`[gilbert] agent: run ${run.id} — working it in ${accountId}`);
    let current = run;
    /*
     * A pass that left this run on purpose is resumed where it stopped (R6): the mark
     * is cleared here, so a process that dies mid-run is still read as a crash and pays
     * the minute's backoff.
     */
    current = resumeRun(current);
    /** When this pass began working on this run: the slice is measured from here. */
    const workStarted = Date.now();
    /*
     * A step left `open` by an earlier process is an act whose outcome was
     * never written: it may have landed (a send, a write) and re-running it
     * would do it twice. It is marked failed once, here, so the model reads
     * what may have happened instead of being shown an open step and choosing
     * it again. A live pass never reaches this with an open step: its waves are
     * recorded before the document is written.
     */
    if (current.plan.some((step) => step.state === "open"))
      current = current.plan.reduce(
        (doc, step, at) =>
          step.state === "open"
            ? recordStep(doc, at, {
                state: "failed",
                outcome:
                  "the process stopped before this step's outcome was written; it may have happened, and was not repeated.",
              })
            : doc,
        current,
      );
    /* The compare-and-set token the last write produced; the next write reuses
       it, so a step does not pay for a read of its own document. */
    let token = state;
    /*
     * What the memory recalls for this run (ADR 0038): the entities the change
     * and its facts name, their facts valid at that moment and one hop of their
     * relations, against the store the pass read — the same one reading the
     * decision turn was handed. Retrieved by the change's own words, and by
     * vector too where the installation embeds. The selection is recorded on the
     * run, so a wrong conclusion traces to the fact that carried it, and every
     * turn of this working is handed it.
     */
    const above = await this.proseAbove(accountId);
    /*
     * The recall embeds the change's words where the installation offers
     * embeddings, and that is a model call: its meter goes on the run and on the
     * day like any other (ADR 0038).
     */
    const recallMeter = usageMeter();
    const selection = await recallFor(
      access,
      await this.memory(),
      memoryWords(run, facts),
      recallMeter,
    );
    if (
      recallMeter.calls > 0 ||
      recallMeter.promptTokens > 0 ||
      recallMeter.completionTokens > 0
    ) {
      current = spendRun(current, {
        calls: recallMeter.calls,
        promptTokens: recallMeter.promptTokens,
        completionTokens: recallMeter.completionTokens,
        cachedPromptTokens: recallMeter.cachedTokens,
      });
      this.passTokens += recallMeter.promptTokens + recallMeter.completionTokens;
    }
    current = recordRecall(
      current,
      selection.facts.map((fact) => fact.id),
    );
    /*
     * The case, read once before the first turn: the knowledge base's titles and the
     * shape of the group's Files (ADR 0038). A person with this change on the desk
     * has both open, and the failing runs spent their first ten steps opening them.
     */
    const held = await this.caseHeld(accountId, current);
    /* The cases already on file: the index a turn recognises one of its own by. */
    const caseKeys = await this.casesOnFile(accountId);
    let previous: string | null = null;
    /*
     * A refusal is not an ending: an answer the parser cannot read and a call the
     * account refuses are each a step that ended, and the next turn reads what
     * happened. Nothing a run spends ends it (ADR 0038); the one valve is the
     * liveness bound below.
     */
    for (;;) {
      /*
       * One valve, and it is about liveness, not money: a run that has asked the
       * model a hundred times has not finished, and nothing a harness can say
       * afterwards is worth an agent stuck in a loop. It is not a budget — no
       * step, call, token or clock amount ends a run because of what it cost —
       * and the number is far above any run the work has shown (the worst live
       * run of 2026-10-26 spent twenty-three).
       */
      if (current.spent.calls >= RUN_MODEL_CALLS_MAX) {
        return await this.endRun(
          accountId,
          current,
          "stopped",
          {
            at: new Date().toISOString(),
            why: `the run was still asking after ${RUN_MODEL_CALLS_MAX} model calls, so it was stopped: it had not finished.`,
          },
          token,
        );
      }
      /*
       * The pass's own slice (R6): past the bound, and only here — a **turn boundary**,
       * every step of the wave written and nothing left open — the run is marked as
       * left on purpose and the pass moves to the next group. The next pass resumes it
       * at once; nothing of the work is lost, and no step is left `open` to be read as
       * an act whose outcome was never written.
       */
      if (Date.now() - workStarted > (this.opts.sliceMs ?? SLICE_MS)) {
        const sliced = sliceRun(current, new Date().toISOString());
        if ((await this.store(accountId, sliced, token)) === null) return null;
        this.opts.log?.(
          `[gilbert] agent: run ${current.id} — left for the next pass, mid-work`,
        );
        return sliced;
      }
      /*
       * The case's scratchpad, read from its own file for this turn (ADR 0034): the
       * increments of one case read what the one before learned, and a run resumed by
       * a later pass reads what its own earlier turns wrote. It is one document read,
       * not a step.
       */
      let note = await this.noteOfCase(accountId, current);
      /*
       * The transcript is appended and never rewritten (ADR 0038), so what bounds a
       * turn is a summary: once the steps above the mark carry more than a turn
       * should, the model folds everything older than the last few into the case's
       * note, and those steps keep their place in the turn as one line each. A
       * summarising call that fails leaves the transcript as it was — the turn is
       * then refused at the window and says so, rather than losing the past.
       */
      const fold = compactAt(current);
      if (fold !== null) {
        const foldMeter = usageMeter();
        current = spendRun(current, { calls: 1 });
        try {
          const summary = await summarisePlan(
            access,
            {
              woke: current.startedBy.woke ?? "the run was started by an instruction",
              ...(note ? { note } : {}),
              folding: current.plan.slice(current.compactedUpTo ?? 0, fold),
              kept: current.plan.length - fold,
            },
            { meter: foldMeter },
          );
          await writeCaseNote(
            this.ctx,
            accountId,
            current.caseKey ?? current.id,
            summary,
          );
          note = summary.trim();
          current = compactRun(current, fold);
        } catch (err) {
          this.opts.log?.(
            `[gilbert] agent: run ${current.id} could not fold its transcript: ${errorMessage(err)}`,
          );
        }
        /*
         * The tokens are the run's whatever the call answered: a provider that billed
         * a fold which then failed still billed it, and a tally that skipped it is
         * optimistic exactly where the daily ceiling counts.
         */
        current = spendRun(current, {
          promptTokens: foldMeter.promptTokens,
          completionTokens: foldMeter.completionTokens,
          cachedPromptTokens: foldMeter.cachedTokens,
        });
        this.passTokens += foldMeter.promptTokens + foldMeter.completionTokens;
      }
      const prose = above;
      const startedMs = Date.now();
      const question = {
        woke: current.startedBy.woke ?? "the run was started by an instruction",
        plan: current.plan,
        prose,
        // The case's working memory: written by the model, carried whole (ADR 0034).
        ...(note ? { note } : {}),
        // The cases already on file, names only, so one of them is recognised.
        ...(caseKeys?.length ? { cases: caseKeys } : {}),
        // How much of the plan that note already summarises (ADR 0038).
        ...(current.compactedUpTo ? { compactedUpTo: current.compactedUpTo } : {}),
        // The message the run was woken by, as the pass read it (ADR 0038).
        ...(written ? { written } : {}),
        // The account's own shape for this case — page titles and the Files' top two
        // levels — read once, so the run's first steps are acts and not looks.
        ...(Object.keys(held).length ? { case: held } : {}),
        ...(facts ? { facts } : {}),
        memory: selection.facts,
        ...(openQuestions?.length
          ? {
              // The turn reads at most eight lines; the tool that must not ask a
              // question twice is handed the whole list (`openWaits`).
              openQuestions: openQuestions
                .slice(0, 8)
                .map((wait) => `${wait.asked?.channel ?? "chat"}: ${wait.what}`),
            }
          : {}),
        ...(current.startedBy.batch?.length ? { batch: current.startedBy.batch } : {}),
        ...(current.startedBy.surfaces ? { surfaces: current.startedBy.surfaces } : {}),
        authorisations: current.authorisations,
      };
      // Counted before the call: a provider that times out was paid for, and a
      // tally that skips it is optimistic exactly where it matters most.
      current = spendRun(current, { calls: 1 });
      const meter = usageMeter();
      let choice: Awaited<ReturnType<typeof chooseStep>>;
      try {
        choice = await chooseStep(
          catalogueFor(this.catalogue, await this.areasOfRun(accountId, current)),
          access,
          question,
          { meter },
        );
        this.permanentFailures = 0;
      } catch (err) {
        /*
         * The turn cannot be sent at all: the prompt is larger than the window the
         * provider declares, so there is no room for an answer. That is a harness
         * failure, not a budget — the run is refused with the reason and the
         * window, and a person reads why.
         */
        if (err instanceof ModelError && err.code === "model_prompt_over_window") {
          current = spendRun(current, { ms: Date.now() - startedMs });
          return await this.endRun(
            accountId,
            current,
            "refused",
            {
              at: new Date().toISOString(),
              why: err.message,
            },
            token,
          );
        }
        /*
         * An answer this build refused is a step the record shows, not a silence:
         * the model is told what was wrong with it before it chooses again. A
         * call that could not be made at all is not an answer, and leaves the run
         * where it is for the next pass.
         */
        if (!(err instanceof ModelError) || err.code !== "model_answer_malformed") {
          /*
           * The call was counted before it was made: a provider that times out
           * was paid for, and a tally that skipped it would retry the same run
           * for ever without the tally ever showing it. The document is written
           * before the failure leaves, and a store that cannot be written leaves
           * the run to the next pass.
           */
          current = spendRun(current, {
            ms: Date.now() - startedMs,
            promptTokens: meter.promptTokens,
            completionTokens: meter.completionTokens,
            cachedPromptTokens: meter.cachedTokens,
          });
          this.passTokens += meter.promptTokens + meter.completionTokens;
          // The backoff (ADR 0038): the run is still `running`, and the next
          // pass does not ask the same broken provider again at once.
          this.stuckUntil.set(
            `${accountId}\u0000${current.id}`,
            now.getTime() + STUCK_RETRY_MS,
          );
          try {
            await this.store(accountId, current, token);
          } catch {
            // The model error is the reason this pass stops; the run is the
            // next pass's to read.
          }
          throw err;
        }
        current = spendRun(current, {
          promptTokens: meter.promptTokens,
          completionTokens: meter.completionTokens,
          cachedPromptTokens: meter.cachedTokens,
        });
        this.passTokens += meter.promptTokens + meter.completionTokens;
        /*
         * A refusal is a step that ended, and it spends a step of the tally: the
         * run stops on the liveness valve, never on a count of refusals the record
         * cannot show (ADR 0030). The refusal itself is written below, before the
         * next turn is asked.
         */
        current = this.withStep(
          current,
          "the model's answer",
          `refused: ${errorMessage(err)}`,
          false,
        );
        current = spendRun(current, { ms: Date.now() - startedMs });
        const written = await this.store(accountId, current, token);
        if (!written) return null;
        token = written;
        continue;
      }
      current = spendRun(current, {
        ms: Date.now() - startedMs,
        promptTokens: meter.promptTokens,
        completionTokens: meter.completionTokens,
        cachedPromptTokens: meter.cachedTokens,
      });
      this.passTokens += meter.promptTokens + meter.completionTokens;
      if (choice.kind === "done") {
        /*
         * A `done` is a claim about the work, and the run's own plan is the
         * evidence for it: a live run ended `done` after the only mail call it
         * made had been refused, and its own report conceded it had checked one
         * side. A step is refused once for it — the model is told what failed and
         * asked to finish or to say what it could not do — and a second `done`
         * the model still chooses is accepted: the failed step and this one stay
         * on the record, so the claim is checkable.
         */
        const refused = unrecoveredRefusals(current.plan);
        const finished = current.plan.filter((step) => step.state === "done").length;
        /*
         * Both checks count: the mechanical one and the judge's are one answer to
         * "the claim has been looked at", so a `done` after either is accepted
         * with that step beside it (ADR 0038).
         */
        const checked = current.plan.filter(
          (step) => step.what === DONE_CHECKED || step.what === JUDGE_CHECKED,
        ).length;
        /*
         * A `done` is a claim about work, and the plan is what stands under it. A
         * run whose plan carries a refused step, or **no step that finished at
         * all**, is asked once to finish or to say what it could not do. The
         * second `done` is accepted when a step finished under it — the failed
         * steps and this one stay on the record, so the claim is checkable — and
         * ends the run `refused` when nothing did: the run says it did nothing
         * rather than pretending (ADR 0030, 0038).
         */
        const gap =
          finished === 0
            ? "no step of the plan finished, so there is nothing the run can claim"
            : refused > 0 && checked === 0
              ? `the plan carries ${refused} refused step(s): finish the work, or say what you could not do`
              : null;
        /*
         * The question is put **once**: asking costs a step, and a model that
         * answers it by claiming the same thing again has nothing left to add —
         * the run closes `refused` with the gap in the record rather than asking
         * in a circle.
         */
        if (gap && checked === 0) {
          current = this.withStep(current, DONE_CHECKED, gap, false);
          const kept = await this.store(accountId, current, token);
          if (!kept) return null;
          token = kept;
          continue;
        }
        /*
         * The mechanical check sees a plan with nothing finished and a plan
         * carrying a refusal. It cannot see the case ADR 0038 names: a refused
         * step, a later step that succeeded, and a report standing on both. On
         * that suspect plan the judge is asked **once**, and its verdict is a
         * step of the record; the run is then asked once more with it in front.
         *
         * And when the group has declared **the shape a report takes**, every report
         * is judged — including the one written after a verdict that did not stand,
         * which is the report the shape most needs to hold. That declaration is the
         * one thing the harness reads about prose — that it is there — so the shape
         * itself is the judge's to read and never the harness's to parse. A model that
         * repeats a report without correcting it is bounded by the turn valve, and it
         * sees every verdict in its plan.
         */
        const judged = current.plan.filter((step) => step.what === JUDGE_CHECKED).length;
        const firstFailed = current.plan.findIndex((step) => step.state === "failed");
        const suspect =
          firstFailed >= 0 &&
          current.plan.some((step, at) => at > firstFailed && step.state === "done");
        const shape = (await this.instructionOf(accountId))?.report;
        const judge = shape !== undefined || (suspect && judged === 0);
        if (judge) {
          const put = await this.judgeReport(
            accountId,
            current,
            token,
            choice.why,
            prose,
            shape,
            access,
          );
          if (put === null) return null;
          current = put.run;
          token = put.token;
          // A claim that stands is accepted now; one that does not is put back to
          // the model once, with the verdict in front of it (ADR 0038).
          if (put.stands)
            return await this.endRun(
              accountId,
              current,
              "done",
              { at: new Date().toISOString(), why: choice.why },
              token,
            );
          continue;
        }
        if (finished === 0)
          return await this.endRun(
            accountId,
            current,
            "refused",
            {
              at: new Date().toISOString(),
              why: `no step of the plan finished: ${choice.why}`,
            },
            token,
          );
        return await this.endRun(
          accountId,
          current,
          "done",
          { at: new Date().toISOString(), why: choice.why },
          token,
        );
      }
      /*
       * The calls the catalogue refused are written as failed steps before the
       * plan runs: the model's next turn reads its own mistake beside the valid
       * calls that did run, which is the repair it never got when the whole
       * answer was thrown away. A refusal spends the step it cost (ADR 0030).
       */
      for (const refused of choice.refused ?? []) {
        current = this.withStep(
          current,
          `${refused.name} ${boundedText(refused.args)}`,
          `refused: ${refused.problem}`,
          false,
        );
      }

      const batch = choice.calls.map((call) => `${call.name} ${boundedText(call.args)}`);
      // What the model asked for, dependencies and all: the same answer twice is
      // the stall below, whether or not its steps are ordered. The comparison
      // reads the **whole** arguments, not the clip the record keeps: two long
      // calls that differ only after four kilobytes are two different calls, and
      // ending the run as a stall would refuse the second one unseen.
      const chosen = choice.calls
        .map(
          (call, at) =>
            `${batch[at]}${call.needs ? ` after ${call.needs.step} when ${call.needs.when}` : ""}`,
        )
        .join(" | ");
      const chosenWhole = choice.calls
        .map(
          (call) =>
            `${call.name} ${JSON.stringify(call.args)}${call.needs ? ` after ${call.needs.step} when ${call.needs.when}` : ""}`,
        )
        .join(" | ");
      if (chosenWhole === previous) {
        // The same answer twice cannot make progress, and running it again is the
        // endless turn this stops: the record says the model chose it twice.
        current = this.withStep(
          current,
          chosen,
          "the same calls were chosen twice and made no progress",
          false,
        );
        return await this.endRun(
          accountId,
          current,
          "stopped",
          {
            at: new Date().toISOString(),
            why: `the model chose the same calls twice (${chosen}) and made no progress, so the run stopped.`,
          },
          token,
        );
      }
      previous = chosenWhole;

      /*
       * The answer becomes the plan's newest steps, each with what it waits on —
       * the model's own index into this answer, moved into the run's plan — and
       * then the answer is worked out: the steps whose dependencies have ended
       * run **together**, each outcome is read, and the steps that waited on it
       * follow. The plan the model wrote decides the order; the loop invents
       * none, and a step no branch of the plan reaches is left unrun on the
       * record rather than guessed at (ADR 0030).
       */
      const base = current.plan.length;
      /*
       * Two calls with the same tool and the same arguments in **one answer** are
       * one act: the guard further down catches a repeat across turns, and a live
       * run spent seven identical `files.list` calls inside a single plan because
       * nothing looked at the answer itself. The second one is recorded as
       * skipped, so the model reads that it was already made — unless a later
       * step of the same answer waits on it, in which case it stays and the wave
       * guard decides.
       */
      const firstOf = new Map<string, number>();
      const waitedOn = new Set(
        choice.calls
          .map((call) => call.needs?.step)
          .filter((one): one is number => typeof one === "number"),
      );
      for (const [at, call] of choice.calls.entries()) {
        const key = askOf(call.name, call.args);
        const seenAt = firstOf.get(key);
        current = appendStep(
          current,
          `${call.name} ${boundedText(call.args)}`,
          shiftNeeds(call.needs, base),
          key,
        );
        if (seenAt !== undefined && !waitedOn.has(at))
          current = recordStep(current, current.plan.length - 1, {
            state: "skipped",
            outcome: `the same call is step ${seenAt + 1} of this answer: it is made there, not twice.`,
          });
        else if (seenAt === undefined) firstOf.set(key, at);
      }
      /*
       * The document is written **before** the answer is acted on: what the run
       * is about to do is on the record while it is still to do (ADR 0030). The
       * process is disposable by law and a container dies between two steps, so a
       * plan held only in memory would leave the effect in the account with
       * nothing that says what asked for it. The outcomes are written after the
       * wave, on the same call, further down.
       */
      const planned = await this.store(accountId, current, token);
      if (!planned) return null;
      token = planned;
      let wait: RunWait | null = null;
      /** What the wave said in the conversation, when it said anything (ADR 0038). */
      let spoke: string | null = null;
      for (;;) {
        const { ready, left } = readiness(current.plan, base);
        if (!ready.length && !left.length) break;
        for (const step of left)
          current = recordStep(current, step.at, {
            state: "skipped",
            outcome: step.why,
          });
        if (!ready.length) continue;
        const wave: Array<{ at: number; call: StepCall }> = [];
        for (const at of ready) {
          const call = choice.calls[at - base];
          if (!call) continue;
          /*
           * One report per run (ADR 0038). A run that has already told the group
           * what it did is heard: a second `say` posts the same answer again, and a
           * person reads that as the agent repeating itself. The step is refused
           * with the reason, so the next turn answers `done`.
           */
          if (reportsInChat(call) && current.plan.some((step) => step.spoke === true)) {
            current = recordStep(current, at, {
              state: "failed",
              outcome:
                "refused: this run has already reported in the conversation; answer `done` instead of saying it again",
            });
            continue;
          }
          /*
           * A call identical to one this run already made and finished is the
           * same act: a retry after a failure whose effect landed — a send whose
           * submission timed out — would otherwise happen twice, and a person's
           * licence covers one act. The earlier outcome is this step's answer,
           * and nothing is asked of the account.
           *
           * Identical is the whole call (`ask`, a digest), never the line the
           * record keeps: that line is clipped at four kilobytes, and two
           * different writes with the same opening would be one act — the
           * second document silently never written. A step of a document
           * written before the digest existed is compared by its line, which is
           * the most that document holds.
           */
          const what = `${call.name} ${boundedText(call.args)}`;
          const ask = askOf(call.name, call.args);
          const earlier = current.plan.findIndex(
            (step, index) =>
              index < at &&
              (step.ask === undefined ? step.what === what : step.ask === ask) &&
              (step.state === "done" ||
                (step.state === "failed" &&
                  !repeatable(this.catalogue, call.name, call.args))),
          );
          if (earlier >= 0) {
            const held = current.plan[earlier];
            current = recordStep(current, at, {
              state: held?.state === "done" ? "done" : "failed",
              outcome:
                held?.state === "done"
                  ? (held.outcome ?? "")
                  : "an earlier attempt ended without its outcome, so it was not made again: it may have happened.",
            });
            /*
             * A repeat the loop refuses to make is still a step that ended, and
             * it spends a step: a model that keeps proposing the same listings
             * stops on the liveness valve with a sentence, instead of growing the
             * plan forever and dying on a counter.
             */
            if (held?.state !== "done") current = spendRun(current, { steps: 1 });
            continue;
          }
          wave.push({ at, call });
        }
        /*
         * A wave runs together, up to the server's own ceiling: the steps that
         * are ready at one moment wait on nothing that is still to end, so they
         * are made together and each is awaited by its own step, and never more
         * than `TOOL_WAVE_MAX` of them at once. A refusal never rejects the
         * wave — it is its own failed step, and its siblings' steps are on the
         * record beside it.
         */
        const ranMs = Date.now();
        /*
         * The pass's one reading of the memory goes into every call, so the one
         * write that reaches it (`memory.remember`) is made against the reading
         * the selections were made from rather than listing the store again
         * (ADR 0033).
         */
        const store = await this.memory();
        const settled = await mapLimit(wave, TOOL_WAVE_MAX, async ({ call }) => {
          /*
           * Each call gets its own meter: a tool may make a model call of its own
           * (a reader's answer, a picture transcribed, a sentence embedded), and
           * what it spends is the run's and the day's like every other call
           * (ADR 0038) — one meter per call, summed below.
           */
          const meter = usageMeter();
          const embed = this.embedder(meter);
          const began = Date.now();
          try {
            const value = await runTool(
              this.catalogue,
              {
                ctx: this.ctx,
                accountId,
                run: current,
                memory: store,
                ...(openQuestions?.length ? { openWaits: openQuestions } : {}),
                readImage: (image) => this.eyes(image, meter),
                ...(embed ? { embed } : {}),
                meter,
              },
              call.name,
              call.args,
            );
            return {
              status: "fulfilled" as const,
              ms: Date.now() - began,
              value,
              meter,
            };
          } catch (reason) {
            return {
              status: "rejected" as const,
              ms: Date.now() - began,
              reason,
              meter,
            };
          }
        });
        const elapsedMs = Date.now() - ranMs;
        for (const [which, { at, call }] of wave.entries()) {
          const result = settled[which];
          /*
           * What the call's own model call cost, whichever way the call ended: a
           * reader that answered, a picture transcribed, a sentence embedded is a
           * billed call, and one a tool made before failing is billed as well.
           */
          const counted = result?.meter;
          if (
            counted &&
            (counted.calls > 0 ||
              counted.promptTokens > 0 ||
              counted.completionTokens > 0)
          ) {
            current = spendRun(current, {
              calls: counted.calls,
              promptTokens: counted.promptTokens,
              completionTokens: counted.completionTokens,
              cachedPromptTokens: counted.cachedTokens,
            });
            this.passTokens += counted.promptTokens + counted.completionTokens;
          }
          if (result?.status === "fulfilled") {
            /*
             * What came back is somebody else's text: a credential-shaped field
             * is emptied before it reaches the record, and the step says what was
             * withheld (ADR 0038, `redact.ts`).
             */
            const clean = redactSecrets(result.value);
            /*
             * Whether this step said something in the group's conversation: the
             * fact `spoke` reads. `say` with the `say` action has been heard by
             * the people who asked, whether or not it threaded its answer to the
             * waking message; `say` with `ask` asks a question and says nothing
             * about what was done, so it does not make the run a report
             * (ADR 0030, 0038).
             */
            const said = reportsInChat(call);
            // The report is the last phase (ADR 0038): what it said ends the run
            // after this wave, rather than the model being asked for a `done`.
            // The sentence is the words it asked to say, not the step's answer
            // (a message id): the ending a person reads is the report itself.
            if (said)
              spoke =
                isRecord(call.args) && typeof call.args.text === "string"
                  ? boundedText(call.args.text)
                  : boundedText(clean.value);
            const source = sourceOf(clean.value);
            /*
             * The case a `note` call filed itself under (ADR 0034): the tool writes
             * the note into the account's own bookkeeping, so what the run records is
             * which case it worked — the text lives in one place, and every later turn
             * of this run and of the case reads it there.
             */
            const named = caseOf(result.value);
            if (named !== undefined) current = withCase(current, named);
            current = recordStep(current, at, {
              state: "done",
              outcome: `${boundedText(clean.value)}${clean.withheld.length ? ` (withheld: ${clean.withheld.join(", ")})` : ""}`,
              ...(said ? { spoke: true } : {}),
              ...(result.ms === undefined ? {} : { ms: result.ms }),
            });
            /*
             * What the step actually touched, so the report can be checked against
             * what was read: `evidence` was in the document and always empty, and a
             * `done` that admitted "this covers the Files side only" had nothing
             * under it. A reference — an object's id or a document's path — never a
             * copy of what came back.
             */
            if (source && !current.evidence.some((one) => one.source === source))
              current = recordEvidence(current, {
                claim: `${call.name} ${boundedText(call.args)}`,
                source,
              });
            // Each call spends what its tool declares; the wave's own wall time
            // is spent once below, because the calls ran together.
            const tool = this.catalogue.find((one) => one.name === call.name);
            current = spendRun(current, { ...(tool?.spend ?? {}) });
            wait = waitOf(result.value) ?? wait;
          } else {
            current = recordStep(current, at, {
              state: "failed",
              outcome: `refused: ${errorMessage(result?.reason)}`,
              ...(result?.ms === undefined ? {} : { ms: result.ms }),
            });
            /*
             * An attempt that ended refused spends a step whatever its tool
             * declares: a reading tool spends nothing, and a model that keeps
             * proposing a refused call would otherwise grow a plan of failures
             * with its budget untouched — the live run that appended 74 steps and
             * died of a counter instead of its ceiling.
             */
            current = spendRun(current, { steps: 1 });
          }
        }
        current = spendRun(current, { ms: elapsedMs });
      }

      /*
       * A wait is honoured after the whole answer, not instead of it: every step
       * the plan reached has run and is on the record, and the run then waits. A
       * question parks the run on the person it asked (ADR 0029): the run is
       * `blocked` because it is waiting for somebody, which is what every reader
       * of an answer asks of it. Its deadline is a second fact -- `wait.until` is
       * what the alarm arms -- and it never decides whether the run is parked: a
       * question with a date is still a question, and one with no date at all was
       * written by an older build and only an answer moves it.
       */
      if (wait) {
        current = waitUntil(current, wait);
        /*
         * The park is an ending like the others and takes the one exit they all
         * take (ADR 0030): it owes no words — the question it left is the words —
         * but it is written by the same function, so what the loop last ended is
         * the whole truth of the loop's last act, a run waiting on a person
         * included.
         */
        return await this.endRun(
          accountId,
          current,
          "blocked",
          {
            at: new Date().toISOString(),
            why: `waiting on a person: ${wait.what}`,
          },
          token,
        );
      }
      // The outcomes are written on the document the wave ran against, whole.
      const settledWrite = await this.store(accountId, current, token);
      if (!settledWrite) return null;
      token = settledWrite;
      /*
       * The report ends the run, whatever it has spent (ADR 0038). A `say`
       * that landed is the group's answer, and asking the model for a `done`
       * afterwards is the turn that kept exploring on the live eval of
       * 2026-10-22: the work was filed and said, and the run went on reading
       * the same two messages until the valve stopped it.
       */
      if (spoke) {
        /*
         * A spoken report is a claim like a `done` (ADR 0030, 0038): a refused
         * step the model was not told about sends it back once, rather than a
         * report that stands on a step that failed. The judge stays with the
         * `done` answer; this is the check a report owes.
         */
        const refused = unrecoveredRefusals(current.plan);
        const checked = current.plan.filter(
          (step) => step.what === DONE_CHECKED || step.what === JUDGE_CHECKED,
        ).length;
        if (refused > 0 && checked === 0) {
          current = this.withStep(
            current,
            DONE_CHECKED,
            `the plan carries ${refused} refused step(s), and this run has already said what it did in the conversation: finish the work and answer \`done\``,
            false,
          );
          const kept = await this.store(accountId, current, token);
          if (!kept) return null;
          token = kept;
          continue;
        }
        /*
         * A spoken report is judged like a `done` when the group declared the shape
         * one takes: `say` is how a report is made, so a run that ends here ends on
         * a claim, and a claim is checked where it is made (ADR 0038).
         */
        const reportShape = (await this.instructionOf(accountId))?.report;
        if (reportShape !== undefined) {
          const put = await this.judgeReport(
            accountId,
            current,
            token,
            spoke,
            prose,
            reportShape,
            access,
          );
          if (put === null) return null;
          current = put.run;
          token = put.token;
          if (!put.stands) continue;
        }
        return await this.endRun(
          accountId,
          current,
          "done",
          { at: new Date().toISOString(), why: spoke },
          token,
        );
      }
    }
  }

  /**
   * Put a report to the judge, and record the verdict as a step (ADR 0038).
   *
   * One call, wherever a report is made — the sentence a `done` answer carries and
   * the message a `say` ends the run with — so a group that declared the shape of
   * its report has **every** report read, not only the ones a suspect plan sends
   * back. The verdict is a step of the record either way; whether a report that
   * does not stand is put back to the model is the caller's, because the two paths
   * differ in nothing but where the words came from.
   *
   * The call is on the run's tally whether it answered or failed: a provider that
   * billed for a judge which then threw still billed, and a tally that skipped it
   * would under-count the day.
   */
  private async judgeReport(
    accountId: string,
    run: RunDoc,
    token: string | undefined,
    report: string,
    prose: Partial<Record<ProseLevel, string>>,
    shape: string | undefined,
    access: ModelAccess,
  ): Promise<{ run: RunDoc; token: string; stands: boolean } | null> {
    const started = Date.now();
    const meter = usageMeter();
    let current = spendRun(run, { calls: 1 });
    let verdict: { stands: boolean; why: string };
    try {
      verdict = await judgeRun(
        access,
        {
          woke: current.startedBy.woke ?? "the run was started by an instruction",
          ...(prose.group ? { instruction: prose.group } : {}),
          ...(shape === undefined ? {} : { report: shape }),
          done: report,
          plan: current.plan,
          evidence: current.evidence,
        },
        { meter },
      );
    } catch (err) {
      /*
       * The judge could not be asked: the call was paid for, so it is on the
       * tally, and the failure leaves the run where it is rather than believing a
       * report nobody checked.
       */
      current = spendRun(current, {
        ms: Date.now() - started,
        promptTokens: meter.promptTokens,
        completionTokens: meter.completionTokens,
        cachedPromptTokens: meter.cachedTokens,
      });
      this.passTokens += meter.promptTokens + meter.completionTokens;
      await this.store(accountId, current, token).catch(() => undefined);
      throw err;
    }
    current = spendRun(current, {
      ms: Date.now() - started,
      promptTokens: meter.promptTokens,
      completionTokens: meter.completionTokens,
      cachedPromptTokens: meter.cachedTokens,
    });
    this.passTokens += meter.promptTokens + meter.completionTokens;
    current = this.withStep(
      current,
      JUDGE_CHECKED,
      verdict.stands ? `stands: ${verdict.why}` : `does not stand: ${verdict.why}`,
      true,
    );
    const kept = await this.store(accountId, current, token);
    if (!kept) return null;
    return { run: current, token: kept, stands: verdict.stands };
  }

  /**
   * End the run, write it, and say it where a person is listening.
   *
   * A run that stops without a word is the defect this closes (ADR 0030): a
   * person's request was worked, its files landed, and the run ended before it
   * wrote a line — so the request looked unanswered
   * and the queue looked stuck. The ending's own sentence is what is said, so
   * the record and the conversation cannot tell two stories.
   *
   * **What speaks.** Every run that ends otherwise than `done`, `blocked` and
   * `cancelled`: a question it asked and a stop a person took are already words
   * between them, and a failure is news nobody else carries. A `done` run speaks
   * when a person woke it in the conversation **and it has not spoken there** —
   * the person asked, so the person hears the answer; a run whose own report is
   * on the conversation has been heard, and a background run keeps its record.
   *
   * The saying is a message of the group's own conversation (`groupChat.ts`),
   * a reply to the message that woke it when there is one. A saying that cannot
   * be posted leaves the ending still owed on the record and is reported as the
   * pass's own gap — never a silence, and never a step appended to a run that
   * has ended. The ending is written **before** it is
   * said — the document is the arbiter of what happened, so a run a person
   * stopped during its last call does not say an ending that never landed, and
   * the saying is marked on the record once it has left (`markSaid`, the one
   * edge out of an ended run), so a run that already
   * spoke is not read as owing words. A process that dies between the two leaves
   * an ending owed, and the pass that follows says it.
   *
   * **The one ending written elsewhere.** A person's stop is not this function's:
   * the stop route writes `cancelled` itself, because it is the person's act
   * rather than the loop's, and the ending it replaces is withdrawn with its
   * debt — the words the loop owed belonged to an ending that no longer happened.
   * For the same reason `lastEnded` is the last ending the **loop** wrote, not the
   * last ending the installation saw.
   */
  private async endRun(
    accountId: string,
    run: RunDoc,
    ending: RunEnding,
    end: RunEnd,
    token?: string,
  ): Promise<RunDoc | null> {
    const current = run;
    const woke = chatWoken(run.startedBy.woke);
    /*
     * A run that already spoke in the conversation is heard: its own report is
     * the word, and repeating the ending beside it would be two messages for one
     * piece of work. What a `done` run has to say is said when it said nothing —
     * which is the live case this closes (files saved, no line at all).
     */
    const spoke = run.plan.some((step) => step.spoke === true);
    const owed =
      ending === "stopped" ||
      ending === "refused" ||
      (ending === "done" && woke !== null && !spoke);
    const ended = finishRun(current, ending, owed ? { ...end, said: false } : end);
    const written = await this.store(accountId, ended, token);
    // The document was not this process's to end: somebody stopped it first, and
    // an ending that did not land is not one to announce.
    if (!written) return null;
    /*
     * A run that ends without having named its case leaves the note it kept under
     * its own id; nothing reads it again, and a folder of run ids crowds the cases
     * a turn is told about (ADR 0034). A blocked run keeps its note: it is still
     * the work in hand.
     */
    if (ending !== "blocked" && ended.caseKey === undefined)
      await forgetRunNote(this.ctx, accountId, ended.id).catch((err) =>
        this.opts.log?.(
          `[gilbert] agent: run ${ended.id} could not drop its note under the run id: ${errorMessage(err)}`,
        ),
      );
    /*
     * What a reader sees without opening a group's list: the last run this process
     * ended, written into the pass's own document below.
     */
    this.lastEnded = { id: ended.id, ending, why: end.why };
    /*
     * One line when a run closes, with the refusals it carries: the choosing
     * turn's refusals never reached the journal, so an installation whose runs
     * were being refused looked like one whose agent had nothing to do. The line
     * names the run, its ending and how many steps were refused; the first
     * refusal's own sentence is on the step.
     */
    const refused = ended.plan.filter((step) => step.state === "failed").length;
    this.opts.log?.(
      `[gilbert] agent: run ${ended.id} ended ${ending}${refused ? `, ${refused} step(s) refused` : ""}`,
    );
    /*
     * The measure of this run, kept for the pass to send: a run's own document
     * says what happened, and the trend over a week is what the pass's document
     * and the collector carry (ADR 0038). Buffered rather than sent here, so one
     * pass is one request and the collector's absence is the pass's business.
     */
    this.outbox.push({
      kind: "run",
      at: end.at,
      model: this.access?.model ?? null,
      tokens: (ended.spent.promptTokens ?? 0) + (ended.spent.completionTokens ?? 0),
      promptTokens: ended.spent.promptTokens ?? 0,
      completionTokens: ended.spent.completionTokens ?? 0,
      ms: ended.spent.ms,
      steps: ended.spent.steps,
      calls: ended.spent.calls,
      refusals: refused,
      ending,
    });
    if (!owed) return ended;
    /*
     * The words, then the mark — and a failure of either is the caller's to
     * record, never a step.
     *
     * The plan is the work a run chose; an ending is not work, so a failed
     * saying is not a step to append to a run that has already ended. Appending
     * one threw here (an ended run does not grow), inside the ending, and took
     * the account's whole pass with it — the same pass that would have said the
     * ending next time. The debt is already on the record (`said: false`), so
     * nothing is lost by letting the failure out: the pass reports it as its own
     * gap, and the next pass finds the debt and says it.
     */
    const said = await this.sayEnding(accountId, ended, woke);
    /*
     * Nothing was said, so nothing is marked: the debt stays `false` on the
     * document, which is true — those words were never spoken. It is not
     * forgiven, and it is not retried for ever either: an ending the record no
     * longer carries (a stop, a later ending, a run already archived) is nobody's
     * to announce.
     */
    if (!said) return ended;
    await this.markSaid(accountId, ended);
    return { ...ended, ended: { ...(ended.ended as RunEnd), said: true } };
  }

  /**
   * The one edge out of an ended run: an ending that owed words is marked said.
   *
   * A run that has ended accepts exactly one more write, and this is it. It is
   * guarded on **the ending it marks** — the `at` and `why` the words were
   * written for — so a document that moved in between (a person stopped it, a
   * later ending replaced it) is not marked by a writer announcing something
   * that no longer happened. A mark that cannot land throws rather than returning
   * quietly: a debt left `false` with nobody told is a message said twice on the
   * next pass.
   */
  private async markSaid(accountId: string, run: RunDoc): Promise<void> {
    await this.keepClaim();
    const key = `${accountId}\u0000${run.id}`;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const held = await readRun(this.ctx, accountId, run.id);
      if (!held) return;
      if (held.run.ended?.at !== run.ended?.at || held.run.ended?.why !== run.ended?.why)
        return;
      if (held.run.ended?.said === true) return;
      const marked: RunDoc = {
        ...held.run,
        ended: { ...(held.run.ended as RunEnd), said: true },
      };
      let produced: string | undefined;
      try {
        await replaceRun(this.ctx, accountId, marked, {
          ifInState: held.state,
          onState: (fresh) => {
            produced = fresh;
          },
        });
        const next = produced ?? held.state;
        this.passState.set(accountId, next);
        this.runState.set(key, next);
        return;
      } catch (err) {
        if (retryStateMismatch(err, attempt)) break;
      }
    }
    throw new Error(
      `the run "${run.id}" ended and its saying could not be marked: another write kept winning the race for the account.`,
    );
  }

  /**
   * Say how a run ended, in the group's conversation, as a reply to what woke it.
   *
   * Every ending that owes words is said here, in one place, so the ending a run
   * reaches and the ending a later pass picks up cannot be phrased twice. A run
   * woken by mail is said here too: an answer to that person's message would be
   * mail the agent sends outward, which ADR 0028 gives only to an instruction that
   * declares it sends, so the group reads the failure where its people are. A
   * refusal is the caller's to record — never swallowed here.
   */
  private async sayEnding(
    accountId: string,
    run: RunDoc,
    woke: string | null,
  ): Promise<boolean> {
    const ended = run.ended;
    if (!ended) return false;
    /*
     * Only the ending the document still carries is said. A person can stop the
     * run in the moment between its last write and these words, and the record
     * is the arbiter of what happened: a stop that landed first makes this
     * ending somebody else's, and announcing it would be telling a person the
     * opposite of what they did.
     */
    const held = await readRun(this.ctx, accountId, run.id);
    if (
      !held ||
      held.run.state !== run.state ||
      held.run.ended?.at !== ended.at ||
      held.run.ended?.why !== ended.why
    )
      return false;
    const text =
      run.state === "done"
        ? `Done: ${ended.why}`
        : `I could not finish this one: ${ended.why}`;
    const asked = woke ? await readChatMessageAt(this.ctx, accountId, woke) : null;
    await postChatMessage(this.ctx, accountId, this.ctx.username, text, {
      ...(asked?.id ? { replyTo: asked.id } : {}),
    });
    return true;
  }

  /**
   * What a person's answer authorises, recorded on the run it continued
   * (ADR 0028, 0029).
   *
   * A run that asked a question is continued by the sentence that answers it,
   * and that sentence can also be the word the class asks for: the reading is a
   * call (`readAnswerAuthority`), and each act it reports is recorded with the
   * person's own words, the address it came from and the message it arrived in —
   * the trace ADR 0028 asks for. What bounds it is `mayRun`: an authorisation
   * licenses the act it names and no other, so a sentence read too generously
   * still moves nothing. An answer the reading cannot use is a step that says so
   * and grants nothing; the answer itself still continues the run.
   */
  private async authoriseAnswer(answer: AnsweredRun): Promise<RunDoc[]> {
    const access = this.access;
    if (!access) return answer.runs;
    /*
     * One reading for the whole answer, and the licence written on every run it
     * continued: the model is asked what the person's words authorise **once**,
     * and each run carries the authority it acts under. The spend therefore
     * lands on the first run only — the provider billed one call, and a day's
     * counter that added one per run would over-count what the installation paid.
     */
    const [first, ...rest] = answer.runs;
    if (!first) return [];
    let run = spendRun(first, { calls: 1 });
    const meter = usageMeter();
    /*
     * Whether the person who answered is an installation administrator is asked
     * **here**, of the directory, as the Master: only that marker lets the
     * reading report an override (ADR 0028). A directory that will not answer is
     * a no, and the answer still continues the runs.
     *
     * The call is a model call like every other: its tokens are spent on the run
     * **and on the day's counter** (`passTokens`), whether it answers or is
     * refused — before this, the daily ceiling under-counted every answer.
     */
    let granted: Awaited<ReturnType<typeof readAnswerAuthority>>;
    try {
      granted = await readAnswerAuthority(
        access,
        { asked: answer.asked, said: answer.said, from: answer.from },
        { admin: await this.isAdministrator(answer.from), meter },
      );
    } catch (err) {
      run = spendRun(run, {
        promptTokens: meter.promptTokens,
        completionTokens: meter.completionTokens,
        cachedPromptTokens: meter.cachedTokens,
      });
      this.passTokens += meter.promptTokens + meter.completionTokens;
      if (!(err instanceof ModelError) || err.code !== "model_answer_malformed")
        throw err;
      return [
        this.withStep(
          run,
          "the answer's authorisation",
          `refused: ${errorMessage(err)}`,
          false,
        ),
        ...rest,
      ];
    }
    run = spendRun(run, {
      promptTokens: meter.promptTokens,
      completionTokens: meter.completionTokens,
      cachedPromptTokens: meter.cachedTokens,
    });
    this.passTokens += meter.promptTokens + meter.completionTokens;
    return [run, ...rest].map((one) => {
      let next = one;
      for (const licensed of granted)
        next = takeAuthorisation(next, {
          what: answer.said,
          authority: licensed.authority,
          act: { target: licensed.target, content: licensed.content },
          by: answer.from,
          at: answer.at,
          from: answer.message,
        });
      return next;
    });
  }

  /**
   * Whether one address is an installation administrator, as the directory says.
   *
   * The agent acts as the Master, which is an administrator, so it can present
   * the person's account to the server and read what that account may do
   * (`fetchAccountIntrospection`). Impersonation is the only way to ask: the
   * permission list belongs to the account, and the directory will not compose one
   * for somebody else's. Any refusal — an app-password session, an account that
   * is gone, a directory that did not answer — is a no.
   */
  private async isAdministrator(address: string): Promise<boolean> {
    return await administratorAt(this.ctx, address);
  }

  /**
   * The installation's model's eyes, as a reading tool asks for them (ADR 0038).
   *
   * Bound once, so a catalogue that turns a picture into words goes through the
   * one model the installation chose and the one switch the operator set, and a
   * refusal — a model that cannot see, a provider that would not answer — arrives
   * as a document the tool could not read rather than as a failed pass.
   */
  private readonly eyes: ImageReader = async (image, meter) => {
    const access = this.access;
    if (!access) return { problem: "this installation has no model to read with." };
    return await readImage(access, image, meter ? { meter } : {});
  };

  /**
   * The one document a file change names, read before the decision turn.
   *
   * The change says where it is, so the process can hand the turn the document
   * instead of paying a lookup call per wake to ask for what it already has.
   * A document that cannot be read is the turn's to find out the ordinary way:
   * this is a shortcut, never a reason to stop the pass.
   */
  private async readEventFile(
    accountId: string,
    path: string,
    meter: UsageMeter,
  ): Promise<{ path: string; text: string } | null> {
    try {
      const found = await readVisibleFileBytes(this.ctx, accountId, path, READ_BYTES_MAX);
      if (!found) return null;
      const read = await readFileText(
        {
          type: documentType(found.file),
          name: found.name,
          bytes: found.bytes,
        },
        (image) => this.eyes(image, meter),
        meter,
      );
      return read.text ? { path, text: read.text } : null;
    } catch {
      return null;
    }
  }

  /**
   * When this process last held the claim until, as the document states it.
   *
   * The pass renews it lazily, on the way to a run write, rather than once at
   * the top: a pass works several accounts, each run allowed minutes, and a claim
   * renewed only when the pass begins lapses under one long enough to be taken
   * over by a second holder while this one keeps writing.
   */
  private claimExpires: string | null = null;
  /** The renewal in flight, so parallel accounts do not send it twice. */
  private claimRenewal: Promise<void> | null = null;

  /**
   * The installation's own line, as this pass read it.
   *
   * Read from the installation's document at the top of every pass, not taken
   * once at the boot (owner decision 2026-10-18): an edit is in force at the next
   * pass, like a group's own instruction. The boot's reading is the fallback for
   * a document that cannot be read now, so a bad edit does not silence the agent.
   */
  private installation: string | undefined;

  /**
   * The provider and the instruction, from one read of the installation.
   *
   * The document is read **once** per pass: the model is re-read so a publish
   * applies to the run after this one, and the instruction is the same
   * document's. An absent or unreadable document is not created by a pass — the
   * boot is what makes one — and leaves the model and the prose this process
   * already runs on.
   */
  private async readInstallationForPass(): Promise<{
    access: ModelAccess | null;
    instruction: string | undefined;
    limits: InstallationDocument["limits"];
    /** Why the defaults are in force, when the document could not be read. */
    fellBack?: string;
  }> {
    const fallback = (why: string) => ({
      access: this.access,
      instruction: this.opts.installation,
      limits: installationDefaults().limits,
      fellBack: `the installation's document could not be read (${why}), so this pass works on the defaults — ${installationDefaults().limits.maxRunTokens} tokens and ${installationDefaults().limits.maxRunSteps} steps recorded per run.`,
    });
    const accountId = filesAccountId(this.ctx);
    if (!accountId) return fallback("this deployment names no Master account");
    try {
      const found = await readAppFileAt(this.ctx, accountId, INSTALLATION_FILE);
      /*
       * Absent is not a gap: the boot creates the document, so a loop that cannot
       * find one is a test or a deployment whose boot has not run, and the model
       * this process already runs on is the designed answer. A document that is
       * **there and unusable** is the gap, and it is said.
       */
      if (!found)
        return {
          access: this.access,
          instruction: this.opts.installation,
          limits: installationDefaults().limits,
        };
      const parsed = parseInstallationDocumentDetailed(found.text);
      if ("problem" in parsed) return fallback(parsed.problem);
      return {
        access: modelAccess(parsed.doc, this.allowPrivate),
        instruction: parsed.doc.agent.instruction || undefined,
        limits: parsed.doc.limits,
      };
    } catch (err) {
      return fallback(errorMessage(err));
    }
  }

  /**
   * The areas one run may change: what its group's instruction declares and what
   * the run's own surface matrix named (ADR 0038).
   *
   * The instruction is **read here** rather than expected to have been read: a run
   * picked up from a wait or an answer is worked before the change batch reads
   * anything, and the pass's map would then be empty — the selection would fall
   * back to the run's surfaces alone, which cannot name an area that has none
   * (`contacts`). Reading it is one document per account per pass, cached.
   */
  private async areasOfRun(
    accountId: string,
    run: RunDoc,
  ): Promise<readonly AreaName[] | null> {
    const held = await this.instructionOf(accountId);
    return selectedAreas(held?.areas ?? [], run.startedBy.surfaces);
  }

  /**
   * The group's instruction, as this pass read it: one document per account, read
   * once and shared by the prose, the run's matrix and the areas.
   */
  private async instructionOf(accountId: string): Promise<InstructionDoc | null> {
    const held = this.instructions.get(accountId);
    if (held !== undefined) return held;
    const doc = await readInstruction(this.ctx, accountId);
    this.instructions.set(accountId, doc);
    return doc;
  }

  /** The two prose levels above the work, as this pass read them (ADR 0038). */
  private async proseAbove(
    accountId: string,
  ): Promise<Partial<Record<ProseLevel, string>>> {
    const group = await this.instructionOf(accountId);
    return {
      ...(this.installation ? { installation: this.installation } : {}),
      ...(group ? { group: group.instruction } : {}),
    };
  }

  /**
   * The installation's memory, as this pass read it (ADR 0038).
   *
   * Read from the **Master's** own account and never from the group's the run
   * lives in: one memory serves the installation, which is the whole point of it
   * — a group reasons with what the rest of the installation knows. It is read
   * **once per pass**, at the pass's clock (which is what the TTL is applied
   * against), and the one reading answers the retrieval a call carries and the
   * writes `remember fact` makes, so a store of many thousands of documents is
   * not walked again for every change; a fact written during a pass is visible
   * to the next one, which is the price of that (`agent/memory.ts`).
   */
  private async memory(): Promise<MemoryStore> {
    this.reading ??= listMemory(this.ctx, filesAccountId(this.ctx));
    return await this.reading;
  }

  /**
   * The installation's vectors, where its provider offers embeddings
   * (ADR 0038): a fact is written with the vector its sentence was embedded
   * into. Absent without the capability, and then a write carries no vector and
   * the retrieval is exact.
   */
  private embedder(
    meter?: UsageMeter,
  ): ((text: string) => Promise<number[] | null>) | undefined {
    const access = this.access;
    if (!access?.model.embeddings) return undefined;
    return async (text: string) => (await embedTexts(access, [text], meter))?.[0] ?? null;
  }

  /** Append a step and record how it ended, in one place for every step. */
  private withStep(run: RunDoc, what: string, outcome: string, done: boolean): RunDoc {
    const grown = appendStep(run, what);
    const ended = recordStep(grown, grown.plan.length - 1, {
      state: done ? "done" : "failed",
      outcome,
    });
    // A step that ended refused spends a step: the liveness valve is the ceiling
    // a run stops on, and an answer the loop could not use is one of its steps.
    return done ? ended : spendRun(ended, { steps: 1 });
  }

  /**
   * Write the run whole, under a token the last write produced.
   *
   * `state` is the compare-and-set token of the document this pass already
   * read or wrote: with it, the write needs no read of its own. Without it —
   * the first write of a run this pass did not read — the document is read
   * once, which is also where a stop and an ending are seen. Every stop moves
   * the account's state, so a write that arrives after one is refused and the
   * conflict path reads the ending rather than overwriting it. The answer is
   * the token the write produced, for the next one.
   */
  private async store(
    accountId: string,
    run: RunDoc,
    state?: string,
  ): Promise<string | null> {
    /*
     * A person's stop outranks this write. The press is recorded in this process
     * (`stops.ts`) because the compare-and-set alone lets the loop win the race
     * indefinitely: it writes a step every few seconds, so a stop that retries
     * loses every attempt and the run carries on. Here the intent is read before
     * the write, the document is ended as `cancelled` on the person's behalf, and
     * the step that was in flight is dropped — no plan continues from a record
     * somebody has stopped.
     */
    const stopping = stopAsked(accountId, run.id);
    if (stopping) {
      forgetStop(accountId, run.id);
      const held = await readRun(this.ctx, accountId, run.id);
      if (held && (held.run.state === "running" || held.run.state === "blocked")) {
        await replaceRun(
          this.ctx,
          accountId,
          finishRun(held.run, "cancelled", {
            at: stopping.at,
            why: `stopped by ${stopping.by}`,
          }),
          { ifInState: held.state },
        ).catch(() => undefined);
      }
      return null;
    }
    await this.keepClaim();
    // A token from **this run's** own writes is newer than the record's; the
    // account-wide state says nothing about this document, and must never stand
    // in for it. A run this pass did not read has none and must be read (the
    // missing document is not this process's to create).
    const key = `${accountId}\u0000${run.id}`;
    let token = state ? (this.runState.get(key) ?? state) : undefined;
    if (!token) {
      const before = await readRun(this.ctx, accountId, run.id);
      // A document that is not there is not this process's to create: it was
      // archived or removed, and a write here would put a second copy of the
      // record back at the working path.
      if (!before) return null;
      // `blocked` is the one state the loop may write over: it is what an answer
      // takes the run out of (ADR 0029). Every ending — `cancelled` among them —
      // is the document's, not this process's.
      if (before.run.state !== "running" && before.run.state !== "blocked") return null;
      token = before.state;
      this.passState.set(accountId, token);
      this.runState.set(key, token);
    }
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      let produced: string | undefined;
      try {
        await replaceRun(this.ctx, accountId, run, {
          ifInState: token,
          onState: (fresh) => {
            produced = fresh;
          },
        });
        // A write that found the document already holding these bytes makes no
        // set, so it produces no state: the token in hand is still the current
        // one, because nothing moved.
        const next = produced ?? token;
        this.passState.set(accountId, next);
        this.runState.set(key, next);
        return next;
      } catch (err) {
        if (retryStateMismatch(err, attempt)) break;
        /*
         * The document moved under this write: somebody may have stopped the
         * run. A stopped run is left where the person put it, never overwritten
         * by the step that was already in flight — and the working stops with
         * it, rather than planning on from a document that is no longer its own.
         */
        const held = await readRun(this.ctx, accountId, run.id);
        if (!held) return null;
        if (held.run.state !== "running" && held.run.state !== "blocked") return null;
        token = held.state;
        this.passState.set(accountId, token);
        this.runState.set(key, token);
      }
    }
    throw new Error(
      `the run "${run.id}" could not be written: another write kept winning the race for the account.`,
    );
  }

  /**
   * Renew the claim when the pass has come within half its life, before a write.
   *
   * A claim that is no longer this process's is not a warning: the run this write
   * belongs to is somebody else's to work now, and continuing would be two agents
   * over one installation (ADR 0032).
   */
  private async keepClaim(): Promise<void> {
    if (this.claimRenewal) return await this.claimRenewal;
    const expires = this.claimExpires ? Date.parse(this.claimExpires) : 0;
    if (expires - Date.now() > CLAIM_RENEW_WITHIN_MS) return;
    /*
     * Accounts are worked together now, and each write renews the claim when it
     * is close to expiring. One renewal at a time: a second writer waits on the
     * answer of the first rather than sending the same renewal twice.
     */
    this.claimRenewal = (async () => {
      const now = new Date();
      if (!(await renewClaim(this.ctx, this.opts.holder, now)))
        throw new Error("the installation's claim is no longer this process's.");
      this.claimExpires = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
    })().finally(() => {
      this.claimRenewal = null;
    });
    return await this.claimRenewal;
  }
}

/**
 * What a run's own change and facts name, as the one text the memory is read
 * against (ADR 0033): the change that woke it in the group's own words, and
 * what the decision found that change to be about — "shipper: Maersk" is how
 * the change names the shipper, and a fact about it is recalled by that name.
 */
function memoryWords(run: RunDoc, facts?: Record<string, string>): string {
  return [
    run.startedBy.woke ?? "",
    ...Object.entries(facts ?? {}).map(([name, value]) => `${name}: ${value}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** The model's own index into its answer, moved into the run's plan. */
function shiftNeeds(needs: RunStepNeeds | null, base: number): RunStepNeeds | null {
  return needs ? { step: needs.step + base, when: needs.when } : null;
}

/** The steps of one answer that can be taken now, and those no branch reaches. */
interface StepReadiness {
  /** The plan indices of the steps whose dependencies have ended as they need. */
  ready: number[];
  /** The steps no branch of the plan reaches, each with why it is left unrun. */
  left: Array<{ at: number; why: string }>;
}

/**
 * Which of one answer's steps can run now, and which were left unrun (ADR 0030).
 *
 * A step that waits on nothing is ready as soon as the run reaches it. One that
 * waits on a step ending a given way is ready once that step has ended that way,
 * and left unrun once it has ended the other way — or was itself left unrun —
 * because the branch this step is for did not happen. A step whose dependency
 * has not ended yet is neither: it belongs to a later moment of the same answer.
 * Only the steps this answer appended are looked at, and a dependency of one is
 * always among them, because a step waits on a step named before it.
 */
function readiness(plan: readonly RunStep[], base: number): StepReadiness {
  const ready: number[] = [];
  const left: Array<{ at: number; why: string }> = [];
  for (let at = base; at < plan.length; at++) {
    const step = plan[at];
    if (step?.state !== "open") continue;
    if (!step.needs) {
      ready.push(at);
      continue;
    }
    const waited = plan[step.needs.step];
    if (!waited || waited.state === "open") continue;
    if (waited.state === step.needs.when) {
      ready.push(at);
      continue;
    }
    left.push({
      at,
      why:
        waited.state === "skipped"
          ? `left unrun: it waits on step ${step.needs.step + 1}, which was itself left unrun`
          : `left unrun: it waits on step ${step.needs.step + 1} ending ${step.needs.when}, and that step ended ${waited.state}`,
    });
  }
  return { ready, left };
}

/**
 * Whether one address is an installation administrator, as the directory says.
 *
 * The agent acts as the Master, which is one, so it can present the person's
 * account to the server and read what that account may do: a permission list is
 * the account's own, and impersonation is the only way to ask for somebody
 * else's. Any refusal — an app-password session, a missing account, a silent
 * directory — is a no, and the answer still continues its run.
 *
 * `introspect` is a seam for the test: production always passes the real read.
 */
export async function administratorAt(
  ctx: Pick<Ctx, "authorization" | "username">,
  address: string,
  introspect: typeof fetchAccountIntrospection = fetchAccountIntrospection,
): Promise<boolean> {
  try {
    const authorization = impersonationAuthorization(
      { authorization: ctx.authorization, username: ctx.username, appPassword: false },
      address,
    );
    if (!authorization) return false;
    const intro = await introspect(authorization, upstreamFor(address));
    return isStalwartAdmin(intro.permissions);
  } catch {
    return false;
  }
}

/** Whether a run of the account already carries the step an answer wrote. */
function answeredAlready(
  records: readonly RunRecord[],
  channel: RunMessageRef["channel"],
  id: string,
): boolean {
  const what = `the answer in ${channel} ${id}`;
  return records.some(({ run }) => run.plan.some((step) => step.what === what));
}

/**
 * The runs of the account parked on this very question.
 *
 * A run that ended blocked keeps the sentence it asked in (`finishRun`), which is
 * what a message coming back can be recognised against (ADR 0029): the question's
 * own address, matched on the document, rather than anything about the message
 * that answers it. There is more than one when two runs needed the same answer —
 * a question is asked once and both park on it (`tools/chat.ts`) — and the one
 * reply continues them all.
 */
function runsAwaiting(records: readonly RunRecord[], asked: RunMessageRef): RunDoc[] {
  return records.flatMap(({ run }) =>
    run.state === "blocked" &&
    run.waiting?.asked?.channel === asked.channel &&
    run.waiting?.asked?.id === asked.id
      ? [run]
      : [],
  );
}

/** Whether one run already carries the step an answer in this message wrote. */
function runAnswered(run: RunDoc, id: string): boolean {
  const what = `the answer in chat ${id}`;
  return run.plan.some((step) => step.what === what);
}

/** The wait a tool's answer left behind, or null when it left none. */
function waitOf(outcome: unknown): RunWait | null {
  if (!isRecord(outcome)) return null;
  const wait = outcome.wait;
  return isRunWait(wait) ? wait : null;
}

/**
 * The object a call's answer names, when it names one.
 *
 * The reference a run writes into `evidence`: an object's id (a message, a card,
 * an event, a chat message) or a document's path. One lookup for the three names
 * every tool's answer uses, so evidence is collected in one place instead of
 * each tool declaring its own.
 */
function sourceOf(outcome: unknown): string | null {
  if (!isRecord(outcome)) return null;
  for (const key of ["id", "path", "folder"]) {
    const held = outcome[key];
    if (typeof held === "string" && held) return held;
  }
  return null;
}
