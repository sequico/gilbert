/**
 * The loop that works a run (ADR 0027, 0028, 0030, 0031, 0032).
 *
 * One pass answers whatever the installation's own accounts have changed and
 * whatever a run was waiting for: it takes the installation's claim, resolves the
 * accounts the Master works — its groups, asked afresh on **every** pass, so one
 * the Master joins is worked by the next pass and one it leaves stops being
 * worked, with no restart — then works the runs whose wait has come due, reads
 * each account's changes, and for each change asks the **decision turn** which
 * rules apply. A change no rule watches costs no model call and no step; every
 * rule that applies opens or continues its own run (ADR 0031), and each run is
 * worked by the **choosing turn** — the model asks for a plan of one or more
 * steps, each naming what it waits on, the loop **writes that plan on the run
 * before it acts on any of it**, runs the steps whose dependencies have ended
 * **together**, reads each outcome and takes the branch that outcome names,
 * writes each outcome and its own spend on the run, spends the budget, and asks
 * again, until the model says done, a step parks the run on a person, or the
 * budget ends it. A step no branch of the plan reaches is left unrun, and the
 * record says which step and which outcome left it — the loop invents no
 * ordering of its own.
 *
 * **Every call starts from what the installation knows.** The pass reads the
 * memory the Master's account holds **once** (ADR 0033) and takes the
 * **selection** each change's own words name — with its nearest links and the
 * group's standing set, inside a ceiling — hands it to both turns fenced as
 * data, and records on the run which facts it carried, so a wrong conclusion
 * traces to the fact that carried it. A change with nothing to recall is worked
 * exactly as it was before the memory existed.
 *
 * **Every call is told the three levels of prose the record names** (ADR 0031),
 * outermost first: the installation's own line, read from its document at the
 * boot; the group's standing instruction, one document in the group's account
 * read once per pass, so an edit is in force at the next one; and the rule's own
 * instruction, re-read for every turn of the run it started. A level that says
 * nothing contributes nothing, and the order is the builder's alone
 * (`prose.ts`), never a caller's.
 *
 * **A sentence that answers a run is also read for what it authorises**
 * (ADR 0028): the reading is one call (`readAnswerAuthority`), what it reports is
 * recorded on the run with the person's own words and the message they wrote it
 * in, and the guard is what bounds it — an authorisation licenses the act it
 * names and no other. An override is refused by the reading, because class 4 is
 * an installation administrator's and a chat does not prove it.
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
import { groupMembers } from "../groupAccess.js";
import { postChatMessage, readChatMessage, readChatMessageAt } from "../groupChat.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import { forgetRemembered } from "../requestMemory.js";
import { impersonationAuthorization } from "../sessions.js";
import {
  isPassStatusDoc,
  PASS_STATUS_FILE,
  type PassStatusDoc,
} from "../shared/agent.js";
import { CAPABILITIES } from "../shared/capabilities.js";
import { repliesToAuthor } from "../shared/chat.js";
import { mapLimit } from "../shared/concurrency.js";
import { errorMessage } from "../shared/errors.js";
import {
  INSTALLATION_FILE,
  parseInstallationDocumentDetailed,
} from "../shared/installation.js";
import { isRecord } from "../shared/json.js";
import { recallFacts } from "../shared/memory.js";
import {
  answerOverdue,
  appendStep,
  finishRun,
  isRunDue,
  isRunWait,
  RUN_STEPS_MAX,
  type RunDoc,
  type RunEnd,
  type RunEnding,
  type RunMessageRef,
  type RunStep,
  type RunStepNeeds,
  type RunWait,
  recordAnswerRefusal,
  recordRecall,
  recordStep,
  spendRun,
  startRun,
  takeAnswer,
  takeAuthorisation,
  waitUntil,
} from "../shared/run.js";

export { RUN_STEPS_MAX } from "../shared/run.js";

import { fetchAccountIntrospection, isStalwartAdmin, upstreamFor } from "../upstream.js";
import { clientOf } from "../util.js";
import type { AccountEvent } from "./accountEvent.js";
import { archiveOldRuns } from "./archive.js";
import {
  chatWoken,
  offPath,
  readChangesForPass,
  wokeOf,
  workChanges,
} from "./changes.js";
import { CLAIM_TTL_MS, releaseClaim, renewClaim, takeClaim } from "./claim.js";
import { NOTICE_CURSOR_FILE, readCursor, writeCursor } from "./cursors.js";
import type { AccountEvents, EventCursor } from "./events.js";
import { readInstruction } from "./instruction.js";
import { forgetMemoryStores, listFacts, type MemoryStore } from "./memory.js";
import {
  boundedText,
  chooseStep,
  type ModelAccess,
  ModelError,
  modelAccess,
  readAnswerAuthority,
  readImage,
  type StepCall,
  setRunningModelAccess,
  usageMeter,
} from "./model.js";
import type { ProseLevel } from "./prose.js";
import {
  forgetDrop as dropForgotten,
  forgetPath as dropPathForgotten,
  dueDrops as dropsDue,
  noteFile,
} from "./queue.js";
import type { RuleDoc } from "./rule.js";
import { readRule } from "./rules.js";
import {
  createRun,
  listRunsForWorking,
  type RunRecord,
  readRun,
  replaceRun,
} from "./runs.js";
import { readAgentSwitch } from "./switch.js";
import { type DueWait, WaitTimers } from "./timers.js";
import { READ_BYTES_MAX, readFileText } from "./tools/content.js";
import {
  type AnyTool,
  type ImageReader,
  isGroupAddress,
  readMessageForAnswer,
  runTool,
  TOOLS,
} from "./tools.js";

/**
 * The other ceilings a run's budget is measured against (ADR 0027).
 *
 * Steps, time and model calls: the run stops when any of the three is spent, so
 * a loop that cannot finish stops and says so (ADR 0030). The step ceiling is
 * `@gilbert/shared`'s (one answer may not carry more), and the two here are the
 * loop's own; neither is configuration, because an installation has one model
 * and one agent, and the number a run may spend is not a question the
 * administration is asked.
 */
const RUN_CALLS_MAX = 40;
const RUN_MS_MAX = 5 * 60_000;

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
const TOOL_WAVE_MAX = 4;

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
const STATUS_EVERY_MS = 60_000;
/** How long a run left running without a wait waits before it is tried again. */
const STUCK_RETRY_MS = 60_000;

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
 * An answer a run's question received that was not its sender's own word.
 *
 * The run is still blocked: the answer did not continue it, and the record says
 * why, so the surface can show the person what their message was taken for.
 */
export interface RefusedAnswer {
  /** The run the answer would have continued, with the token a write needs. */
  record: RunRecord;
  at: string;
  /** The trust reading's code. */
  code: string;
  from: string;
  message: RunMessageRef;
}

/** A run a person's answer continued, and what the reading of that answer needs. */
export interface AnsweredRun {
  run: RunDoc;
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
   * group's (ADR 0031). Read from the installation's document at the boot, like
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
   * A pass is not an event and used to write nothing: a pass that hung in a model
   * call or a folder read was indistinguishable from an agent that had stopped,
   * because the only line there was came **after** the pass returned. Progress
   * recorded as it happens is what a stall is read from — the last line names the
   * account and run that never finished — and it needs no watchdog: a missing end
   * line is the fact.
   */
  log?: (line: string) => void;
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
  /** The last run the loop ended, for the status document a person reads. */
  private lastEnded: PassStatusDoc["lastEnded"] | null = null;

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
        return;
      }
      const parsed = JSON.parse(found.text) as unknown;
      if (!isPassStatusDoc(parsed)) return;
      this.lastEnded = parsed.lastEnded ?? null;
    } catch {
      // Kept, not blanked: the read failed, and that is not an ending.
    }
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
   * The prose levels above a rule's own, by account, as **this** pass read them
   * (ADR 0031).
   *
   * The installation's line is the boot's own document and costs nothing here;
   * the group's standing instruction is one document in the group's account, read
   * once per pass rather than once per call, so a pass that works ten runs of one
   * group reads it once. Cleared as the pass begins, so an instruction a group
   * edited is in force at the next pass with no restart.
   */
  private readonly above = new Map<string, Partial<Record<ProseLevel, string>>>();
  private readonly timers: WaitTimers;
  private readonly catalogue: readonly AnyTool[];

  /** The model the current pass runs on, re-read from the document each pass. */
  private access: ModelAccess | null;
  /** The operator's switch on private provider addresses. */
  private readonly allowPrivate: boolean;
  /** When an account's change batch may be tried again after it failed. */
  private readonly retryAfter = new Map<string, number>();
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
  /** One roster read per account per pass: an answer is a mail-minute apart. */
  private readonly members = new Map<string, Promise<string[] | null>>();
  /** One Message-IDs read per asked message, kept for the pass. */
  private readonly messageIds = new Map<string, string[]>();
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
    private readonly ctx: Ctx,
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
  async pass(now = new Date()): Promise<PassSummary> {
    const started = Date.now();
    const summary = await this.workPass(now);
    summary.ms = Date.now() - started;
    await this.recordStatus(summary);
    return summary;
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
   * (ADR 0027): what the Master works is what Stalwart's directory says at this
   * moment, so a grant added or withdrawn needs no restart.
   */
  private async workPass(now: Date): Promise<PassSummary> {
    this.reading = null;
    this.above.clear();
    const summary: PassSummary = {
      claimed: false,
      accounts: 0,
      changes: 0,
      runs: 0,
      due: 0,
      ms: 0,
      gaps: [],
    };
    const claim = await takeClaim(this.ctx, this.opts.holder, now);
    if (!claim) return summary;
    this.claimExpires = claim.expires;
    if (Date.parse(claim.expires) - now.getTime() <= CLAIM_RENEW_WITHIN_MS) {
      if (!(await renewClaim(this.ctx, this.opts.holder, now))) return summary;
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
    this.members.clear();
    this.messageIds.clear();
    /*
     * The model is re-read every pass, so a publish applies to the run after
     * this one (ten seconds), not to the next boot: the key is kept in the
     * document and read here as the Master. A document that cannot be read
     * leaves the model this process already runs on.
     */
    const { access: model, instruction } = await this.readInstallationForPass();
    if (!model) {
      setRunningModelAccess(null);
      summary.gaps.push("the installation names no model, so this pass worked nothing");
      return summary;
    }
    this.access = model;
    setRunningModelAccess(model);
    this.installation = instruction;
    const accounts = await this.opts.accounts();
    summary.accounts = accounts.length;
    // The switch is read before the model: off means no call is made at all.
    const agentSwitch = await readAgentSwitch(this.ctx, filesAccountId(this.ctx));
    if (!agentSwitch.enabled) {
      /*
       * Off still answers the people who wrote -- in chat and by mail, with a
       * fixed sentence and no model call -- and the owner chose that directly
       * rather than through a rule's class-3 licence.
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
           * It is a document of its own on purpose. This branch used to delete
           * the shared working cursor and write its own fresh anchor into it, so
           * an installation switched off for an hour lost the window the on path
           * exists to keep — and the loss was written down. Two readers with two
           * freshness rules need two positions, and neither may destroy the
           * other's.
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
      return summary;
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
    await Promise.all(
      accounts.map(async (accountId) => {
        this.opts.log?.(`[gilbert] agent: working ${accountId}`);
        let records: RunRecord[] | null = null;
        /*
         * One account that cannot be read is not the installation failing: a
         * single rule sheet this build cannot parse is a group to leave alone for
         * this pass, not a reason to stop working every other group — and the
         * pass that throws here would throw again on the next beat, for ever. The
         * reason goes into the pass's gaps, which the supervisor reports.
         */
        /*
         * The account's changes are read first: the FileNode state they end at
         * is the state the run listing is judged against, so the pass no longer
         * asks the account for that state separately. A read that fails is said
         * and the due runs are still worked from the state `workDue` reads for
         * itself — the handed alarm is not lost with the reading.
         */
        let read: AccountEvents | null = null;
        if ((this.retryAfter.get(accountId) ?? 0) <= now.getTime()) {
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
          const after = await this.workChanges(
            accountId,
            now,
            summary,
            moved.size ? records.filter((record) => !moved.has(record.run.id)) : records,
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
    /*
     * The memory is read on the first change that needs it, not at the top of
     * every pass: a quiet pass pays for no store it never consults. A sheet it
     * could not read is said in the pass's own gaps, as before.
     */
    for (const problem of await this.memoryProblems())
      summary.gaps.push(`memory: ${problem}`);
    return summary;
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
      const index = at.get(id);
      const record = index === undefined ? null : records[index];
      if (!record) continue;
      /*
       * One run that fails is **that run's** failure. The pass goes on with the
       * others and, above all, with the account's own bookkeeping — the cursor,
       * the archive, the debts of every other run. A throw here used to leave the
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
           * adds and the budget it spends are then what the record holds, and a
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
        const stuck = due.waiting === null;
        if (stuck) this.stuckUntil.set(key, now.getTime() + STUCK_RETRY_MS);
        const worked = await this.workRun(accountId, due, undefined, record.state);
        const stillStuck = worked?.state === "running" && worked.waiting === null;
        if (!stillStuck) this.stuckUntil.delete(key);
        // The archive and the change batch see the document as this pass left it.
        if (worked && index !== undefined)
          records[index] = {
            state: this.runState.get(key) ?? record.state,
            run: worked,
          };
      } catch (err) {
        summary.gaps.push(`${accountId}: ${record.run.id}: ${errorMessage(err)}`);
      }
    }
    // What the pass read is also what the archive decides on: a run this pass
    // just ended is on the list with its ending, and goes in its drawer now.
    return records;
  }

  /**
   * One account's changes, each put to the decision turn, and every rule that
   * fits it given its own run.
   *
   * A change no rule watches costs no model call and no step. Every rule the
   * decision turn names opens or continues **its own** run (ADR 0031): two rules
   * over one change are two runs, each naming its own rule and the change that
   * woke it. The same rule over the same change is not a second run — the runs
   * the account already holds are read for it once, when the first change is
   * covered, and a run whose `startedBy` names this rule and this change is what
   * the record says that change has been answered by: one still running is
   * continued from its own document, and one that has ended is left as the
   * answer it is, so a pass that re-reads a change it did not finish cannot work
   * it twice. One change reaches this loop once per read — a node's create and
   * its update are one event (`events.ts`) — so the record is the whole of what
   * "the same change" is recognised by. A change that **answers** a question this
   * account is waiting on is neither: the run that asked is continued and no run
   * of its own is opened (`runAnsweredBy`).
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
          memory: () => this.memory(),
          readingCall: (a, e, c) => this.readingCall(a, e, c),
          runAnsweredBy: (a, e, r) => this.runAnsweredBy(a, e, r),
          workRun: (a, r, f, oq) => this.workRun(a, r, f, undefined, oq),
          authoriseAnswer: (x) => this.authoriseAnswer(x),
          openRun: (a, e, r, from) => this.openRun(a, e, r, from),
          recordRefusal: (a, refused) => this.recordRefusal(a, refused),
          noteDrop: (a, path, at) => noteFile(this.ctx, a, path, at),
          dueDrops: (a, at) => dropsDue(this.ctx, a, at),
          forgetDrop: (a, folder) => dropForgotten(this.ctx, a, folder),
          forgetDropPath: (a, path) => dropPathForgotten(this.ctx, a, path),
          readEventFile: (a, path) => this.readEventFile(a, path),
        },
        accountId,
        now,
        summary,
        records,
        read,
      );
      this.retryAfter.delete(accountId);
      return after;
    } catch (err) {
      this.retryAfter.set(accountId, now.getTime() + 60_000);
      throw err;
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
    candidates: readonly RuleDoc[],
  ): { ctx: Ctx; accountId: string; run: RunDoc; readImage: ImageReader } {
    return {
      ctx: this.ctx,
      accountId,
      readImage: this.eyes,
      run: startRun({
        id: randomUUID(),
        startedBy: {
          rule: candidates[0]?.id ?? null,
          instruction: null,
          woke: wokeOf(event),
        },
      }),
    };
  }

  /** Open the run a change a rule covers is answered by. */
  private async openRun(
    accountId: string,
    event: AccountEvent,
    rule: RuleDoc,
    wakeFrom: string | null,
  ): Promise<RunDoc> {
    const run = startRun({
      id: randomUUID(),
      startedBy: {
        rule: rule.id,
        instruction: null,
        woke: wokeOf(event),
        // The rule's own declaration, carried by the run: the guard reads it,
        // and so does the correspondent it answers.
        sends: rule.sends,
        wakeFrom,
        // The whole drop this run answers, so its plan reads the names instead
        // of listing the folder again (ADR 0034).
        ...(event.also?.length ? { batch: [...event.also] } : {}),
        // The matrix the rule carries at this instant (ADR 0031): the run says
        // where it may act, and a later edit of the rule does not move it.
        surfaces: { ...rule.surfaces },
      },
    });
    await createRun(this.ctx, accountId, run);
    return run;
  }

  /**
   * The run a change answers: the one this account parked on this very question.
   *
   * A person's answer arrives in the group's own chat as a message of its own,
   * addressed to nothing the change log can see: what ties it to the run that
   * asked is the message it replies to — the very sentence the run recorded as
   * its wait — and the sender being the agent rather than the person. So the
   * change is the message, the message is read at the path the change names
   * (`groupChat.ts`), and `repliesToAuthor` (`shared/chat.ts`) answers whether it
   * is addressed to anything the agent wrote; the run that asked is the one whose
   * `waiting.asked` is that parent, and the step the record gains names the
   * message the answer itself came in.
   *
   * Nothing else is read: a change on another surface, a removal, a message that
   * is not one, a message that replies to nobody and a question no run of this
   * account is parked on all answer null without a single extra read.
   */
  private async runAnsweredBy(
    accountId: string,
    event: AccountEvent,
    records: readonly RunRecord[],
  ): Promise<AnsweredRun | "already" | RefusedAnswer | null> {
    if (event.source === "mail")
      return await this.mailAnsweredBy(accountId, event, records);
    if (event.source !== "chat" || event.change === "destroyed") return null;
    const message = await readChatMessageAt(this.ctx, accountId, event.where);
    if (!message) return null;
    const question: RunMessageRef = {
      channel: "chat",
      id: String(message.replyTo ?? ""),
    };
    const parent = await readChatMessage(this.ctx, accountId, question.id);
    if (!repliesToAuthor(message, parent, this.ctx.username)) return null;
    // The answer takes the run out of `blocked` at once, and the cursor only
    // moves at the end of the batch: a pass that died in between re-reads this
    // change. The step the answer wrote is what says it was already taken.
    if (answeredAlready(records, "chat", message.id)) return "already";
    const parked = runAwaiting(records, question);
    if (!parked) return null;
    return {
      run: takeAnswer(
        parked,
        question,
        { channel: "chat", id: message.id },
        message.text,
      ),
      asked: parent?.text ?? "",
      said: message.text,
      from: message.from,
      at: message.at,
      message: { channel: "chat", id: message.id },
    };
  }

  /**
   * The run a **mail** message answers (ADR 0029).
   *
   * Mail is correlated the way mail is: by the thread. A reply carries the message
   * ids it answers (`inReplyTo`, `references`), and the run that asked is the one
   * whose question — the message it recorded as its wait — is one of them. Nothing
   * is read when no run of this account waits on mail; the sender must not be the
   * group itself, because the question went out from the group's own identity.
   */
  private async mailAnsweredBy(
    accountId: string,
    event: AccountEvent,
    records: readonly RunRecord[],
  ): Promise<AnsweredRun | "already" | RefusedAnswer | null> {
    if (event.change === "destroyed") return null;
    const parked = records.filter(
      ({ run }) => run.state === "blocked" && run.waiting?.asked?.channel === "mail",
    );
    if (!parked.length) return null;
    // Who may speak: the principals with access to this group, and the agent
    // itself (an echo is refused as its own). A server that will not name the
    // roster answers nobody, rather than trusting the sender line.
    const members = await this.membersOf(accountId);
    if (!members) return null;
    const reply = await readMessageForAnswer(this.ctx, accountId, event.where, {
      own: this.ctx.username,
      known: [...members, this.ctx.username],
    });
    if (!reply?.thread.length || !reply.from || !reply.text.trim()) return null;
    if (await isGroupAddress(this.ctx, accountId, reply.from)) return null;
    if (answeredAlready(records, "mail", event.where)) return "already";
    /*
     * The thread says which run this answers, and that answer is needed before
     * the word is judged: a reply that is not its sender's own word is recorded
     * on the run it would have continued, so the person's answer and its
     * refusal are both on the record.
     */
    const askedIds = parked
      .map((record) => record.run.waiting?.asked?.id)
      .filter((id): id is string => typeof id === "string");
    const idsOf = await this.messageIdsOf(accountId, askedIds);
    for (const record of parked) {
      const asked = record.run.waiting?.asked;
      if (!asked) continue;
      const ids = idsOf.get(asked.id) ?? [];
      if (!ids.some((id) => reply.thread.includes(id))) continue;
      const message: RunMessageRef = { channel: "mail", id: event.where };
      if (!reply.word)
        return {
          record,
          at: reply.at ?? new Date().toISOString(),
          code: reply.refusal ?? "not_authenticated",
          from: reply.from,
          message,
        };
      return {
        run: takeAnswer(record.run, asked, message, reply.text),
        asked: record.run.waiting?.what ?? "",
        said: reply.text,
        from: reply.from,
        at: reply.at ?? new Date().toISOString(),
        message,
      };
    }
    return null;
  }

  /**
   * One roster read per account per pass.
   *
   * A page of mail changes asks who may speak about every one of them, and the
   * roster is the same answer within the pass; the next pass reads it again, so
   * a membership change is seen.
   */
  private membersOf(accountId: string): Promise<string[] | null> {
    const held = this.members.get(accountId);
    if (held) return held;
    const read = groupMembers(this.ctx, accountId);
    this.members.set(accountId, read);
    return read;
  }

  /**
   * The Message-IDs each of these messages was filed under, in one read: a
   * reply names them in its thread.
   *
   * Asking per parked run made a mail answer cost one round trip for every
   * question the account is waiting on, and the same asked ids are read again
   * for every new mail of the page; each is fetched once per pass.
   */
  private async messageIdsOf(
    accountId: string,
    emailIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const idsOf = new Map<string, string[]>();
    const missing = emailIds.filter((id) => !this.messageIds.has(id));
    if (missing.length) {
      const client = clientOf(this.ctx);
      const size = client.maxObjectsInGet;
      for (let at = 0; at < missing.length; at += size) {
        const answer = await client.call<{
          list?: Array<{ id?: unknown; messageId?: unknown }>;
        }>(
          "Email/get",
          { accountId, ids: missing.slice(at, at + size), properties: ["messageId"] },
          [CAPABILITIES.mail],
        );
        for (const one of answer.list ?? []) {
          if (typeof one.id !== "string") continue;
          this.messageIds.set(
            one.id,
            Array.isArray(one.messageId)
              ? one.messageId.filter((id): id is string => typeof id === "string")
              : [],
          );
        }
      }
    }
    for (const id of emailIds) idsOf.set(id, this.messageIds.get(id) ?? []);
    return idsOf;
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
    this.noticeAt.set(accountId, Date.now());
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
      ...(this.lastEnded ? { lastEnded: this.lastEnded } : {}),
    };
    try {
      await writeAppFileAt(this.ctx, accountId, PASS_STATUS_FILE, doc);
      this.statusAt = at.getTime();
    } catch (err) {
      summary.gaps.push(`status: ${errorMessage(err)}`);
    }
  }

  /**
   * Work one run: choose a plan, work its steps out, write them whole, spend,
   * choose again.
   *
   * Every stop leaves the record saying which one it was — the model's `done`,
   * the budget spent, a stall, or a call that parked the run on a person. Every
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
    openQuestions?: readonly string[],
  ): Promise<RunDoc | null> {
    const access = this.access;
    if (!access) return null;
    this.opts.log?.(`[gilbert] agent: run ${run.id} — working it in ${accountId}`);
    /** The message a person wrote, when one woke this run: what a report replies to. */
    const woke = chatWoken(run.startedBy.woke);
    let current = run;
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
     * What the memory recalls for this run (ADR 0033): the change it answers, the
     * facts that change was found to be about, and the group's standing set,
     * against the store the pass read — the same one reading the decision turn
     * was handed. The selection is recorded on the run, so a wrong conclusion
     * traces to the fact that carried it, and every turn of this working is
     * handed it.
     */
    const above = await this.proseAbove(accountId);
    const selection = recallFacts(
      (await this.memory()).facts,
      memoryWords(run, facts),
      accountId,
    );
    current = recordRecall(
      current,
      selection.map((fact) => fact.id),
    );
    let previous: string | null = null;
    /*
     * A refusal is not an ending: an answer the parser cannot read, an answer
     * that asks for more steps than the run has left, and a call the account
     * refuses are each a step that ended, and each spends a step of the budget
     * (`loop.ts`'s wave below). The run therefore stops on the budget it
     * declares — twenty steps, forty calls, five minutes — and not on a counter
     * nobody reading the record can see: a live run died after three all-refused
     * rounds with its budget untouched, which is the ending this replaces.
     */
    for (;;) {
      const over = overBudget(current);
      if (over) {
        return await this.endRun(
          accountId,
          current,
          "out-of-budget",
          {
            at: new Date().toISOString(),
            why: `the budget ended the run: ${over}, so the work did not finish.`,
          },
          token,
        );
      }
      const prose = await this.proseOf(accountId, current, above);
      const startedMs = Date.now();
      const question = {
        woke: current.startedBy.woke ?? "the run was started by an instruction",
        plan: current.plan,
        prose,
        ...(facts ? { facts } : {}),
        memory: selection,
        ...(openQuestions?.length ? { openQuestions } : {}),
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
        choice = await chooseStep(this.catalogue, access, question, { meter });
      } catch (err) {
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
           * for ever without ever reaching the budget. The document is written
           * before the failure leaves, and a store that cannot be written leaves
           * the run to the next pass.
           */
          current = spendRun(current, {
            ms: Date.now() - startedMs,
            promptTokens: meter.promptTokens,
            completionTokens: meter.completionTokens,
            cachedPromptTokens: meter.cachedTokens,
          });
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
      if (choice.kind === "done") {
        return await this.endRun(
          accountId,
          current,
          "done",
          { at: new Date().toISOString(), why: choice.why },
          token,
        );
      }
      /*
       * The plan has to fit the steps the run has left. The parser refuses an
       * answer larger than the whole ceiling, but a run already part-way
       * through its budget can still be asked for more than remains; the refusal
       * is recorded as a step that made no progress and the run is asked again.
       * The budget is the only ceiling a refusal reaches (ADR 0030): a refusal
       * spends the step it cost, and nothing else ends the run here.
       */
      const room = RUN_STEPS_MAX - current.spent.steps;
      const asked = choice.calls.reduce((sum, call) => {
        const tool = this.catalogue.find((one) => one.name === call.name);
        return sum + (tool?.spend.steps ?? 0);
      }, 0);
      if (asked > room) {
        current = this.withStep(
          current,
          "the model's answer",
          `refused: it asked for ${asked} steps with ${room} left in the run's budget`,
          false,
        );
        const kept = await this.store(accountId, current, token);
        if (!kept) return null;
        token = kept;
        continue;
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
          "out-of-budget",
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
      for (const call of choice.calls)
        current = appendStep(
          current,
          `${call.name} ${boundedText(call.args)}`,
          shiftNeeds(call.needs, base),
        );
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
           * A call identical to one this run already made and finished is the
           * same act: a retry after a failure whose effect landed — a send whose
           * submission timed out — would otherwise happen twice, and a person's
           * licence covers one act. The earlier outcome is this step's answer,
           * and nothing is asked of the account.
           */
          const what = `${call.name} ${boundedText(call.args)}`;
          const earlier = current.plan.findIndex(
            (step, index) =>
              index < at &&
              step.what === what &&
              (step.state === "done" ||
                (step.state === "failed" && !this.repeatable(step.what))),
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
             * stops on the budget with a sentence, instead of growing the plan
             * forever and dying on a counter.
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
          try {
            return {
              status: "fulfilled" as const,
              value: await runTool(
                this.catalogue,
                {
                  ctx: this.ctx,
                  accountId,
                  run: current,
                  memory: store,
                  readImage: this.eyes,
                },
                call.name,
                call.args,
              ),
            };
          } catch (reason) {
            return { status: "rejected" as const, reason };
          }
        });
        const elapsedMs = Date.now() - ranMs;
        for (const [which, { at, call }] of wave.entries()) {
          const result = settled[which];
          if (result?.status === "fulfilled") {
            /*
             * Whether this step said something in the group's conversation: the
             * fact `spoke` reads. A `chat.say` that ended done has been heard by
             * the people who asked, whether or not it threaded its answer to the
             * waking message; a `chat.ask` asks a question and says nothing about
             * what was done, so it does not make the run a report (ADR 0030).
             */
            const said = call.name === "chat.say";
            current = recordStep(current, at, {
              state: "done",
              outcome: boundedText(result.value),
              ...(said ? { spoke: true } : {}),
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
    }
  }

  /**
   * End the run, write it, and say it where a person is listening.
   *
   * A run that stops without a word is the defect this closes (ADR 0030): a
   * person's request was worked, its files landed, and the run ended
   * `out-of-budget` before it wrote a line — so the request looked unanswered
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
      ending === "out-of-budget" || (ending === "done" && woke !== null && !spoke);
    const ended = finishRun(current, ending, owed ? { ...end, said: false } : end);
    const written = await this.store(accountId, ended, token);
    // The document was not this process's to end: somebody stopped it first, and
    // an ending that did not land is not one to announce.
    if (!written) return null;
    /*
     * What a reader sees without opening a group's list: the last run this process
     * ended, written into the pass's own document below.
     */
    this.lastEnded = { id: ended.id, ending, why: end.why };
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
   * mail the agent sends outward, which ADR 0028 gives only to a rule that
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
   * Persist an answer's refusal on the run it would have continued.
   *
   * The run stays blocked; the record gains the code the trust reading answered
   * and the message it came from, so a person can be told why their answer did
   * not move the work. A write that cannot land leaves the refusal for the next
   * pass, which re-reads the same change.
   */
  private async recordRefusal(
    accountId: string,
    refused: RefusedAnswer,
  ): Promise<RunDoc | null> {
    const run = recordAnswerRefusal(refused.record.run, {
      at: refused.at,
      code: refused.code,
      from: refused.from,
      message: refused.message,
    });
    const token = await this.store(accountId, run, refused.record.state);
    return token ? run : null;
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
  private async authoriseAnswer(answer: AnsweredRun): Promise<RunDoc> {
    const access = this.access;
    if (!access) return answer.run;
    let run = spendRun(answer.run, { calls: 1 });
    const meter = usageMeter();
    try {
      /*
       * Whether the person who answered is an installation administrator is
       * asked **here**, of the directory, as the Master: only that marker lets
       * the reading report an override (ADR 0028). A directory that will not
       * answer is a no, and the answer still continues the run.
       */
      const granted = await readAnswerAuthority(
        access,
        { asked: answer.asked, said: answer.said, from: answer.from },
        { admin: await this.isAdministrator(answer.from), meter },
      );
      run = spendRun(run, {
        promptTokens: meter.promptTokens,
        completionTokens: meter.completionTokens,
        cachedPromptTokens: meter.cachedTokens,
      });
      for (const one of granted)
        run = takeAuthorisation(run, {
          what: answer.said,
          authority: one.authority,
          act: { target: one.target, content: one.content },
          by: answer.from,
          at: answer.at,
          from: answer.message,
        });
      return run;
    } catch (err) {
      if (!(err instanceof ModelError) || err.code !== "model_answer_malformed")
        throw err;
      return this.withStep(
        run,
        "the answer's authorisation",
        `refused: ${errorMessage(err)}`,
        false,
      );
    }
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
   * The installation's model's eyes, as a reading tool asks for them (ADR 0027).
   *
   * Bound once, so a catalogue that turns a picture into words goes through the
   * one model the installation chose and the one switch the operator set, and a
   * refusal — a model that cannot see, a provider that would not answer — arrives
   * as a document the tool could not read rather than as a failed pass.
   */
  private readonly eyes: ImageReader = async (image) => {
    const access = this.access;
    if (!access) return { problem: "this installation has no model to read with." };
    return await readImage(access, image);
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
        this.eyes,
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
  }> {
    const accountId = filesAccountId(this.ctx);
    if (!accountId) return { access: this.access, instruction: this.opts.installation };
    try {
      const found = await readAppFileAt(this.ctx, accountId, INSTALLATION_FILE);
      if (!found) return { access: this.access, instruction: this.opts.installation };
      const parsed = parseInstallationDocumentDetailed(found.text);
      if ("problem" in parsed)
        return { access: this.access, instruction: this.opts.installation };
      return {
        access: modelAccess(parsed.doc, this.allowPrivate),
        instruction: parsed.doc.agent.instruction || undefined,
      };
    } catch {
      return { access: this.access, instruction: this.opts.installation };
    }
  }

  /** The two prose levels above a rule's own, as this pass read them (ADR 0031). */
  private async proseAbove(
    accountId: string,
  ): Promise<Partial<Record<ProseLevel, string>>> {
    const held = this.above.get(accountId);
    if (held) return held;
    const group = await readInstruction(this.ctx, accountId);
    const levels: Partial<Record<ProseLevel, string>> = {
      ...(this.installation ? { installation: this.installation } : {}),
      ...(group ? { group } : {}),
    };
    this.above.set(accountId, levels);
    return levels;
  }

  /** The prose a run's call carries: the two levels above, then the rule's own. */
  private async proseOf(
    accountId: string,
    run: RunDoc,
    above: Partial<Record<ProseLevel, string>>,
  ): Promise<Partial<Record<ProseLevel, string>>> {
    const id = run.startedBy.rule;
    if (!id) return above;
    const record = await readRule(this.ctx, accountId, id);
    return record ? { ...above, rule: record.rule.instruction } : above;
  }

  /**
   * The installation's memory, as this pass read it (ADR 0033).
   *
   * Read from the **Master's** own account and never from the group's the run
   * lives in: one memory serves the installation, which is the whole point of it
   * — a group reasons with what the rest of the installation knows. It is read
   * **once per pass** and the one reading answers the selection a call carries
   * and the write `memory.remember` makes, so a store of many thousands of facts
   * is not walked again for every change; a fact written during a pass is visible
   * to the next one, which is the price of that (`agent/memory.ts`).
   */
  private async memory(): Promise<MemoryStore> {
    this.reading ??= listFacts(this.ctx, filesAccountId(this.ctx));
    return await this.reading;
  }

  /**
   * Whether a failed step may be attempted again.
   *
   * Only a reversible act may: its failure is the account's answer, and asking
   * again asks the same question. A destructive or outward act that failed may
   * have landed — a submission that timed out is the case this exists for — and
   * a person's authority covers one act, so it is not repeated silently.
   */
  private repeatable(what: string): boolean {
    const name = what.split(" ")[0] ?? "";
    return this.catalogue.find((tool) => tool.name === name)?.authority === "reversible";
  }

  /** Append a step and record how it ended, in one place for every step. */
  private withStep(run: RunDoc, what: string, outcome: string, done: boolean): RunDoc {
    const grown = appendStep(run, what);
    const ended = recordStep(grown, grown.plan.length - 1, {
      state: done ? "done" : "failed",
      outcome,
    });
    // A step that ended refused spends a step: the budget is the ceiling a run
    // stops on, and an answer the loop could not use is one of its steps.
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
 * The run of an account that is parked on this very question.
 *
 * A run that ended blocked keeps the sentence it asked in (`finishRun`), which is
 * what a message coming back can be recognised against (ADR 0029): the question's
 * own address, matched on the document, rather than anything about the message
 * that answers it.
 */
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

function runAwaiting(records: readonly RunRecord[], asked: RunMessageRef): RunDoc | null {
  for (const { run } of records) {
    if (run.state !== "blocked") continue;
    const waiting = run.waiting?.asked;
    if (waiting && waiting.channel === asked.channel && waiting.id === asked.id)
      return run;
  }
  return null;
}

/** The ceiling a run has spent, or null when it has budget left (ADR 0027). */
function overBudget(run: RunDoc): string | null {
  if (run.spent.steps >= RUN_STEPS_MAX) return `it took ${RUN_STEPS_MAX} steps`;
  if (run.spent.calls >= RUN_CALLS_MAX) return `it made ${RUN_CALLS_MAX} model calls`;
  if (run.spent.ms >= RUN_MS_MAX) return `it spent ${RUN_MS_MAX} ms of work`;
  return null;
}

/** The wait a tool's answer left behind, or null when it left none. */
function waitOf(outcome: unknown): RunWait | null {
  if (!isRecord(outcome)) return null;
  const wait = outcome.wait;
  return isRunWait(wait) ? wait : null;
}
