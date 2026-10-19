/**
 * The loop that works a run (ADR 0031, 0032, 0034, 0035, 0036).
 *
 * One pass answers whatever the installation's own accounts have changed and
 * whatever a run was waiting for: it takes the installation's claim, resolves the
 * accounts the Master works — its groups, asked afresh on **every** pass, so one
 * the Master joins is worked by the next pass and one it leaves stops being
 * worked, with no restart — then works the runs whose wait has come due, reads
 * each account's changes, and for each change asks the **decision turn** which
 * rules apply. A change no rule watches costs no model call and no step; every
 * rule that applies opens or continues its own run (ADR 0035), and each run is
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
 * memory the Master's account holds **once** (ADR 0037) and takes the
 * **selection** each change's own words name — with its nearest links and the
 * group's standing set, inside a ceiling — hands it to both turns fenced as
 * data, and records on the run which facts it carried, so a wrong conclusion
 * traces to the fact that carried it. A change with nothing to recall is worked
 * exactly as it was before the memory existed.
 *
 * **Every call is told the three levels of prose the record names** (ADR 0035),
 * outermost first: the installation's own line, read from its document at the
 * boot; the group's standing instruction, one document in the group's account
 * read once per pass, so an edit is in force at the next one; and the rule's own
 * instruction, re-read for every turn of the run it started. A level that says
 * nothing contributes nothing, and the order is the builder's alone
 * (`prose.ts`), never a caller's.
 *
 * **A sentence that answers a run is also read for what it authorises**
 * (ADR 0032): the reading is one call (`readAnswerAuthority`), what it reports is
 * recorded on the run with the person's own words and the message they wrote it
 * in, and the guard is what bounds it — an authorisation licenses the act it
 * names and no other. An override is refused by the reading, because class 4 is
 * an installation administrator's and a chat does not prove it.
 *
 * **The loop never decides what may be done.** A chosen call is run through
 * `runTool`, the only door to a writing tool: the authority guard (`mayRun`, ADR
 * 0032) answers, the loop never overrides it, and a refusal — an act beyond what
 * the run carries, or a call that failed — is written on the run as a failed step
 * rather than skipped, so the record shows what was refused and the model is told
 * it before it chooses again. An answer the choosing turn could not use at all —
 * an unknown tool, a call that is not a call, arguments a tool cannot take, any
 * key this build does not know — is refused whole and recorded the same way.
 *
 * **The run document is the product** (ADR 0034): the model is shown exactly what
 * the document holds — the change that woke the run, the plan with what each step
 * waited on, and what each step answered — so a run picked up by the next holder
 * continues from the record and never from a process's memory.
 *
 * There is no timer of its own here: a pass is the caller's to ask for, and the
 * waits' alarms are armed per account (`timers.ts`) so a process that starts
 * re-arms what the installation left.
 */

import { randomUUID } from "node:crypto";
import { appFolderState, type Ctx, filesAccountId, readAppFileAt } from "../appFolder.js";
import { groupMembers } from "../groupAccess.js";
import { readChatMessage, readChatMessageAt } from "../groupChat.js";
import { appFolderInstallationStore, readInstallation } from "../installation.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import { impersonationAuthorization } from "../sessions.js";
import { CAPABILITIES } from "../shared/capabilities.js";
import { repliesToAuthor } from "../shared/chat.js";
import { errorMessage } from "../shared/errors.js";
import {
  INSTALLATION_FILE,
  parseInstallationDocumentDetailed,
} from "../shared/installation.js";
import { isRecord } from "../shared/json.js";
import { recallFacts } from "../shared/memory.js";
import {
  appendStep,
  finishRun,
  isRunDue,
  isRunWait,
  type RunDoc,
  type RunMessageRef,
  type RunStep,
  type RunStepNeeds,
  type RunWait,
  recordRecall,
  recordStep,
  spendRun,
  startRun,
  takeAnswer,
  takeAuthorisation,
  waitUntil,
} from "../shared/run.js";
import { fetchAccountIntrospection, isStalwartAdmin, upstreamFor } from "../upstream.js";
import { clientOf } from "../util.js";
import type { AccountEvent } from "./accountEvent.js";
import { archiveOldRuns } from "./archive.js";
import { offPath, wokeOf, workChanges } from "./changes.js";
import { CLAIM_TTL_MS, releaseClaim, renewClaim, takeClaim } from "./claim.js";
import type { EventCursor } from "./events.js";
import { readInstruction } from "./instruction.js";
import { listFacts, type MemoryStore } from "./memory.js";
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
import {
  type AnyTool,
  type ImageReader,
  isGroupAddress,
  readMessageForAnswer,
  runTool,
  TOOLS,
} from "./tools.js";

/**
 * The ceilings a run's budget is measured against (ADR 0031).
 *
 * Steps, time and model calls: the run stops when any of the three is spent, so
 * a loop that cannot finish stops and says so (ADR 0034). The ceilings are the
 * loop's own and not the run's, because a run measured against a ceiling it
 * carried itself is a run that could raise it; they are not configuration
 * either, because an installation has one model and one agent, and the number a
 * run may spend is not a question the administration is asked.
 */
export const RUN_STEPS_MAX = 20;
const RUN_CALLS_MAX = 40;
const RUN_MS_MAX = 5 * 60_000;

/**
 * How close to lapsing the claim is renewed.
 *
 * Holding a claim is not an event, so an ordinary pass costs one read and no
 * upload (ADR 0036); a holder renews only once the window it is believed in is
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
  /**
   * What a change log could not cover, named rather than read as silence
   * (`events.ts`): the pages before the gap were worked, and what fell in it is
   * lost.
   */
  gaps: string[];
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
   * group's (ADR 0035). Read from the installation's document at the boot, like
   * the model: which document a booted process runs on is fixed at the boot.
   */
  installation?: string;
  /**
   * The tools a run's steps are taken with. The product's catalogue by default;
   * a caller may hand a narrower one, and what it holds is also what the model is
   * offered.
   */
  catalogue?: readonly AnyTool[];
}

/**
 * One process's loop, and the process state it carries.
 *
 * An instance is the whole of it: the reading cursors and the alarms live here
 * and nowhere else, so a restart begins with a fresh instance and the run
 * documents decide what happens next.
 */
export class AgentLoop {
  /** Where each account's reading has reached, by account. */
  private readonly cursors = new Map<string, EventCursor>();
  /** The runs the alarms have handed over, worked on the next pass. */
  private readonly pending: DueWait[] = [];
  /**
   * The installation's memory as **this** pass read it (ADR 0037).
   *
   * Resolved the first time a pass needs it and reused for the rest of that
   * pass, so the whole store is walked once rather than once per change and once
   * per remembered fact. The pass clears it as it begins, so every pass reads the
   * memory afresh and a fact written during one is visible to the next.
   */
  private reading: Promise<MemoryStore> | null = null;
  /**
   * The prose levels above a rule's own, by account, as **this** pass read them
   * (ADR 0035).
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
   * One pass: claim the installation, then work every account's runs and
   * changes.
   *
   * A peer that holds the claim is answered with one read and no work at all —
   * this process is not the installation's agent while another is, and not even
   * the accounts are resolved — and the claim is renewed while it works, so a
   * holder that is busy is not taken over.
   *
   * The accounts are resolved **here**, once per pass and after the claim
   * (ADR 0031): what the Master works is what Stalwart's directory says at this
   * moment, so a grant added or withdrawn needs no restart.
   */
  async pass(now = new Date()): Promise<PassSummary> {
    this.reading = null;
    this.above.clear();
    const summary: PassSummary = {
      claimed: false,
      accounts: 0,
      changes: 0,
      runs: 0,
      due: 0,
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
     * The model is re-read every pass, so a publish applies to the run after
     * this one (ten seconds), not to the next boot: the key is kept in the
     * document and read here as the Master. A document that cannot be read
     * leaves the model this process already runs on.
     */
    const model = await this.readModel();
    if (!model) {
      setRunningModelAccess(null);
      summary.gaps.push("the installation names no model, so this pass worked nothing");
      return summary;
    }
    this.access = model;
    setRunningModelAccess(model);
    this.installation = await this.readInstallationLine();
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
      for (const accountId of accounts) {
        await offPath(
          { ctx: this.ctx, cursors: this.cursors, self: this.ctx.username },
          accountId,
        ).catch(() => undefined);
        /*
         * The archive is housekeeping, not a decision: a switched-off agent
         * still keeps the group's runs folder to the year the owner chose.
         */
        try {
          const read = await listRunsForWorking(this.ctx, accountId);
          for (const problem of read.problems)
            summary.gaps.push(`${accountId}: ${problem}`);
          for (const gap of await this.archive(accountId, read.records, now))
            summary.gaps.push(`${accountId}: ${gap}`);
        } catch (err) {
          summary.gaps.push(`${accountId}: ${errorMessage(err)}`);
        }
      }
      summary.gaps.push("the agent is turned off for this installation");
      return summary;
    }
    /*
     * A group the Master no longer works keeps no queued alarm: the queue is
     * this pass's accounts and nothing else, or a process that runs for weeks
     * carries one entry per fired timer per account it lost.
     */
    for (let at = this.pending.length - 1; at >= 0; at--) {
      const due = this.pending[at];
      if (due && !accounts.includes(due.accountId)) this.pending.splice(at, 1);
    }
    for (const accountId of accounts) {
      /*
       * One account that cannot be read is not the installation failing: a
       * single rule sheet this build cannot parse is a group to leave alone for
       * this pass, not a reason to stop working every other group — and the
       * pass that throws here would throw again on the next beat, for ever. The
       * reason goes into the pass's gaps, which the supervisor reports.
       */
      try {
        const records = await this.workDue(accountId, now, summary);
        for (const gap of await this.archive(accountId, records, now))
          summary.gaps.push(`${accountId}: ${gap}`);
        await this.workChanges(accountId, now, summary, records);
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
        await this.timers.arm(this.ctx, accountId, problems);
        for (const problem of problems) summary.gaps.push(`${accountId}: ${problem}`);
      } catch (err) {
        summary.gaps.push(`${accountId}: ${errorMessage(err)}`);
      }
    }
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
  ): Promise<string[]> {
    return await archiveOldRuns(this.ctx, accountId, records, now, {
      max: ARCHIVE_PER_PASS,
      beforeMove: () => this.keepClaim(),
    });
  }

  /** Every run of one account whose wait has come due, worked again. */
  private async workDue(
    accountId: string,
    now: Date,
    summary: PassSummary,
  ): Promise<RunRecord[]> {
    const handed = this.pending.filter((due) => due.accountId === accountId);
    for (let at = this.pending.length - 1; at >= 0; at--) {
      if (this.pending[at]?.accountId === accountId) this.pending.splice(at, 1);
    }
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
    const read = await listRunsForWorking(this.ctx, accountId);
    for (const problem of read.problems) summary.gaps.push(`${accountId}: ${problem}`);
    const records = read.records;
    const at = new Map(records.map((record, index) => [record.run.id, index]));
    const runs = new Set(handed.map((due) => due.runId));
    for (const { run } of records) {
      if (isRunDue(run, now)) runs.add(run.id);
      if (run.state === "running" && run.waiting === null) runs.add(run.id);
    }
    for (const id of runs) {
      const index = at.get(id);
      const record = index === undefined ? null : records[index];
      if (record?.run.state !== "running") continue;
      summary.due += 1;
      const worked = await this.workRun(accountId, record.run, now);
      // The archive and the change batch see the document as this pass left it.
      if (worked && index !== undefined) records[index] = { ...record, run: worked };
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
   * decision turn names opens or continues **its own** run (ADR 0035): two rules
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
  ): Promise<void> {
    /*
     * The batched changes of one account. Kept as a function over what it needs
     * rather than as a method over the whole class: the cursor, the prose and
     * the run work are all it touches, and naming them is what lets a reader see
     * that without reading the rest of the loop.
     */
    const access = this.access;
    if (!access) return;
    /*
     * A batch that failed is not retried ten seconds later: the same change,
     * the same provider, the same failure -- and each retry pays a model call.
     * A minute's pause per account bounds the cost while a failure is real.
     */
    if ((this.retryAfter.get(accountId) ?? 0) > now.getTime()) return;
    try {
      await workChanges(
        {
          ctx: this.ctx,
          cursors: this.cursors,
          access,
          proseAbove: (a) => this.proseAbove(a),
          memory: () => this.memory(),
          readingCall: (a, e, c) => this.readingCall(a, e, c),
          runAnsweredBy: (a, e, r) => this.runAnsweredBy(a, e, r),
          workRun: (a, r, n, f) => this.workRun(a, r, n, f),
          authoriseAnswer: (x) => this.authoriseAnswer(x),
          openRun: (a, e, r) => this.openRun(a, e, r),
        },
        accountId,
        now,
        summary,
        records,
      );
      this.retryAfter.delete(accountId);
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
  ): { ctx: Ctx; accountId: string; run: RunDoc } {
    return {
      ctx: this.ctx,
      accountId,
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
  ): Promise<RunDoc> {
    const run = startRun({
      id: randomUUID(),
      startedBy: {
        rule: rule.id,
        instruction: null,
        woke: wokeOf(event),
        // The rule's own declaration, carried by the run: the guard reads it.
        sends: rule.sends,
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
  ): Promise<AnsweredRun | "already" | null> {
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
   * The run a **mail** message answers (ADR 0033).
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
  ): Promise<AnsweredRun | "already" | null> {
    if (event.change === "destroyed") return null;
    const parked = records.filter(
      ({ run }) => run.state === "blocked" && run.waiting?.asked?.channel === "mail",
    );
    if (!parked.length) return null;
    // Who may speak: the principals with access to this group, and the agent
    // itself (an echo is refused as its own). A server that will not name the
    // roster answers nobody, rather than trusting the sender line.
    const members = await groupMembers(this.ctx, accountId);
    if (!members) return null;
    const reply = await readMessageForAnswer(this.ctx, accountId, event.where, {
      own: this.ctx.username,
      known: [...members, this.ctx.username],
    });
    if (!reply?.thread.length || !reply.from || !reply.text.trim()) return null;
    if (!reply.word) return null;
    if (await isGroupAddress(this.ctx, accountId, reply.from)) return null;
    if (answeredAlready(records, "mail", event.where)) return "already";
    const askedIds = parked
      .map((record) => record.run.waiting?.asked?.id)
      .filter((id): id is string => typeof id === "string");
    const idsOf = await this.messageIdsOf(accountId, askedIds);
    for (const record of parked) {
      const asked = record.run.waiting?.asked;
      if (!asked) continue;
      const ids = idsOf.get(asked.id) ?? [];
      if (!ids.some((id) => reply.thread.includes(id))) continue;
      return {
        run: takeAnswer(
          record.run,
          asked,
          { channel: "mail", id: event.where },
          reply.text,
        ),
        asked: record.run.waiting?.what ?? "",
        said: reply.text,
        from: reply.from,
        at: reply.at ?? new Date().toISOString(),
        message: { channel: "mail", id: event.where },
      };
    }
    return null;
  }

  /**
   * The Message-IDs each of these messages was filed under, in one read: a
   * reply names them in its thread.
   *
   * Asking per parked run made a mail answer cost one round trip for every
   * question the account is waiting on.
   */
  private async messageIdsOf(
    accountId: string,
    emailIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const idsOf = new Map<string, string[]>();
    if (!emailIds.length) return idsOf;
    const client = clientOf(this.ctx);
    const size = client.maxObjectsInGet;
    for (let at = 0; at < emailIds.length; at += size) {
      const answer = await client.call<{
        list?: Array<{ id?: unknown; messageId?: unknown }>;
      }>(
        "Email/get",
        { accountId, ids: emailIds.slice(at, at + size), properties: ["messageId"] },
        [CAPABILITIES.mail],
      );
      for (const one of answer.list ?? []) {
        if (typeof one.id !== "string") continue;
        idsOf.set(
          one.id,
          Array.isArray(one.messageId)
            ? one.messageId.filter((id): id is string => typeof id === "string")
            : [],
        );
      }
    }
    return idsOf;
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
    now: Date,
    facts?: Record<string, string>,
  ): Promise<RunDoc | null> {
    const access = this.access;
    if (!access) return null;
    let current = run;
    /*
     * What the memory recalls for this run (ADR 0037): the change it answers, the
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
     * An answer refused for its shape, or a round whose every step was refused,
     * is the model repeating itself rather than working: two malformed answers
     * in a row, or three all-refused rounds, end the run instead of paying for
     * the same refusal again. A successful step clears the count.
     */
    let refused = 0;
    for (;;) {
      const over = overBudget(current);
      if (over) {
        const ended = finishRun(current, "out-of-budget", {
          at: now.toISOString(),
          why: `the budget ended the run: ${over}, so the work did not finish.`,
        });
        return (await this.store(accountId, ended)) ? ended : null;
      }
      const prose = await this.proseOf(accountId, current, above);
      const startedMs = Date.now();
      const question = {
        woke: current.startedBy.woke ?? "the run was started by an instruction",
        plan: current.plan,
        prose,
        ...(facts ? { facts } : {}),
        memory: selection,
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
        if (!(err instanceof ModelError) || err.code !== "model_answer_malformed")
          throw err;
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
        refused += 1;
        if (refused >= 2) {
          const ended = finishRun(current, "out-of-budget", {
            at: now.toISOString(),
            why: `the model's answers were refused twice in a row, so the work did not finish: ${errorMessage(err)}`,
          });
          return (await this.store(accountId, ended)) ? ended : null;
        }
        if (!(await this.store(accountId, current))) return null;
        continue;
      }
      current = spendRun(current, {
        ms: Date.now() - startedMs,
        promptTokens: meter.promptTokens,
        completionTokens: meter.completionTokens,
        cachedPromptTokens: meter.cachedTokens,
      });
      if (choice.kind === "done") {
        const ended = finishRun(current, "done", {
          at: now.toISOString(),
          why: choice.why,
        });
        return (await this.store(accountId, ended)) ? ended : null;
      }

      const batch = choice.calls.map((call) => `${call.name} ${boundedText(call.args)}`);
      // What the model asked for, dependencies and all: the same answer twice is
      // the stall below, whether or not its steps are ordered.
      const chosen = choice.calls
        .map(
          (call, at) =>
            `${batch[at]}${call.needs ? ` after ${call.needs.step} when ${call.needs.when}` : ""}`,
        )
        .join(" | ");
      if (chosen === previous) {
        // The same answer twice cannot make progress, and running it again is the
        // endless turn this stops: the record says the model chose it twice.
        current = this.withStep(
          current,
          chosen,
          "the same calls were chosen twice and made no progress",
          false,
        );
        const ended = finishRun(current, "out-of-budget", {
          at: now.toISOString(),
          why: `the model chose the same calls twice (${chosen}) and made no progress, so the run stopped.`,
        });
        return (await this.store(accountId, ended)) ? ended : null;
      }
      previous = chosen;

      /*
       * The answer becomes the plan's newest steps, each with what it waits on —
       * the model's own index into this answer, moved into the run's plan — and
       * then the answer is worked out: the steps whose dependencies have ended
       * run **together**, each outcome is read, and the steps that waited on it
       * follow. The plan the model wrote decides the order; the loop invents
       * none, and a step no branch of the plan reaches is left unrun on the
       * record rather than guessed at (ADR 0034).
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
       * is about to do is on the record while it is still to do (ADR 0034). The
       * process is disposable by law and a container dies between two steps, so a
       * plan held only in memory would leave the effect in the account with
       * nothing that says what asked for it. The outcomes are written after the
       * wave, on the same call, further down.
       */
      if (!(await this.store(accountId, current))) return null;
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
            (step, index) => index < at && step.state === "done" && step.what === what,
          );
          if (earlier >= 0) {
            current = recordStep(current, at, {
              state: "done",
              outcome: current.plan[earlier]?.outcome ?? "",
            });
            continue;
          }
          wave.push({ at, call });
        }
        /*
         * A wave runs together: the steps that are ready at one moment wait on
         * nothing that is still to end, so they are made at once and each is
         * awaited by its own step. `allSettled` never rejects, so one call's
         * refusal is its own failed step and its siblings' steps are on the
         * record beside it.
         */
        const ranMs = Date.now();
        /*
         * The pass's one reading of the memory goes into every call, so the one
         * write that reaches it (`memory.remember`) is made against the reading
         * the selections were made from rather than listing the store again
         * (ADR 0037).
         */
        const store = await this.memory();
        const settled = await Promise.allSettled(
          wave.map(({ call }) =>
            runTool(
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
          ),
        );
        const elapsedMs = Date.now() - ranMs;
        let worked = false;
        for (const [which, { at, call }] of wave.entries()) {
          const result = settled[which];
          if (result?.status === "fulfilled") {
            worked = true;
            current = recordStep(current, at, {
              state: "done",
              outcome: boundedText(result.value),
            });
            // Each call spends what its tool declares; the wave's own wall time
            // is spent once below, because the calls ran together.
            const tool = this.catalogue.find((one) => one.name === call.name);
            current = spendRun(current, { ...(tool?.spend ?? {}) });
            wait = waitOf(result.value) ?? wait;
          } else
            current = recordStep(current, at, {
              state: "failed",
              outcome: `refused: ${errorMessage(result?.reason)}`,
            });
        }
        current = spendRun(current, { ms: elapsedMs });
        refused = worked ? 0 : refused + 1;
        if (refused >= 3) {
          const ended = finishRun(current, "out-of-budget", {
            at: now.toISOString(),
            why: "the last rounds were refused in full, so the work did not finish.",
          });
          return (await this.store(accountId, ended)) ? ended : null;
        }
      }

      /*
       * A wait is honoured after the whole answer, not instead of it: every step
       * the plan reached has run and is on the record, and the run then waits. A
       * wait with a date is the clock's, and the alarm picks it up; a wait with
       * none is a person's, and the run ends parked on the answer it left
       * (ADR 0033, 0034).
       */
      if (wait) {
        current = waitUntil(current, wait);
        if (wait.until === null)
          current = finishRun(current, "blocked", {
            at: now.toISOString(),
            why: `waiting on a person: ${wait.what}`,
          });
      }
      // The outcomes are written on the document the wave ran against, whole.
      if (!(await this.store(accountId, current))) return null;
      if (wait) return current;
    }
  }

  /**
   * What a person's answer authorises, recorded on the run it continued
   * (ADR 0032, 0033).
   *
   * A run that asked a question is continued by the sentence that answers it,
   * and that sentence can also be the word the class asks for: the reading is a
   * call (`readAnswerAuthority`), and each act it reports is recorded with the
   * person's own words, the address it came from and the message it arrived in —
   * the trace ADR 0032 asks for. What bounds it is `mayRun`: an authorisation
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
       * the reading report an override (ADR 0032). A directory that will not
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
   * The installation's model's eyes, as a reading tool asks for them (ADR 0031).
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
   * When this process last held the claim until, as the document states it.
   *
   * The pass renews it lazily, on the way to a run write, rather than once at
   * the top: a pass works several accounts, each run allowed minutes, and a claim
   * renewed only when the pass begins lapses under one long enough to be taken
   * over by a second holder while this one keeps writing.
   */
  private claimExpires: string | null = null;

  /**
   * The installation's own line, as this pass read it.
   *
   * Read from the installation's document at the top of every pass, not taken
   * once at the boot (owner decision 2026-10-18): an edit is in force at the next
   * pass, like a group's own instruction. The boot's reading is the fallback for
   * a document that cannot be read now, so a bad edit does not silence the agent.
   */
  private installation: string | undefined;

  /** The provider this pass runs on, or null when the document names none. */
  private async readModel(): Promise<ModelAccess | null> {
    try {
      const accountId = filesAccountId(this.ctx);
      const found = accountId
        ? await readAppFileAt(this.ctx, accountId, INSTALLATION_FILE)
        : null;
      // No document: a pass does not create one, and this deployment runs on
      // the model its boot read.
      if (!found) return this.access;
      const loaded = await readInstallation(appFolderInstallationStore(this.ctx));
      return modelAccess(loaded.document, this.allowPrivate);
    } catch {
      return this.access;
    }
  }

  private async readInstallationLine(): Promise<string | undefined> {
    const accountId = filesAccountId(this.ctx);
    if (!accountId) return this.opts.installation;
    try {
      const found = await readAppFileAt(this.ctx, accountId, INSTALLATION_FILE);
      if (!found?.text) return this.opts.installation;
      const parsed = parseInstallationDocumentDetailed(found.text);
      if ("problem" in parsed) return this.opts.installation;
      return parsed.doc.agent.instruction || undefined;
    } catch {
      return this.opts.installation;
    }
  }

  /** The two prose levels above a rule's own, as this pass read them (ADR 0035). */
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
   * The installation's memory, as this pass read it (ADR 0037).
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

  /** Append a step and record how it ended, in one place for every step. */
  private withStep(run: RunDoc, what: string, outcome: string, done: boolean): RunDoc {
    const grown = appendStep(run, what);
    return recordStep(grown, grown.plan.length - 1, {
      state: done ? "done" : "failed",
      outcome,
    });
  }

  /**
   * Write the run whole, under the account's state read just before the write.
   *
   * The token is read first and the document is written with it — the order every
   * conditional write here uses (`runs.ts`) — so a write landing in between is
   * refused rather than overwritten, and the attempt is retried once. A run a
   * person stopped is read first: its ending is left exactly as they put it.
   */
  private async store(accountId: string, run: RunDoc): Promise<boolean> {
    await this.keepClaim();
    /*
     * A run somebody stopped is not this process's to write any more. The check
     * is made **before** the token is read, because a stop that landed before
     * this store is not a lost race: the token read afterwards would be fresh
     * and the write would succeed over the ending.
     */
    const before = await readRun(this.ctx, accountId, run.id);
    // `blocked` is the one state the loop may write over: it is what an answer
    // takes the run out of (ADR 0033). Every ending — `cancelled` among them —
    // is the document's, not this process's.
    if (before && before.run.state !== "running" && before.run.state !== "blocked")
      return false;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const token = await appFolderState(this.ctx, accountId);
      try {
        await replaceRun(this.ctx, accountId, run, { ifInState: token });
        return true;
      } catch (err) {
        if (retryStateMismatch(err, attempt)) break;
        /*
         * The document moved under this write: somebody may have stopped the
         * run. A stopped run is left where the person put it, never overwritten
         * by the step that was already in flight — and the working stops with
         * it, rather than planning on from a document that is no longer its own.
         */
        const held = await readRun(this.ctx, accountId, run.id);
        if (held?.run.state !== "running") return false;
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
   * over one installation (ADR 0036).
   */
  private async keepClaim(): Promise<void> {
    const expires = this.claimExpires ? Date.parse(this.claimExpires) : 0;
    if (expires - Date.now() > CLAIM_RENEW_WITHIN_MS) return;
    const now = new Date();
    if (!(await renewClaim(this.ctx, this.opts.holder, now)))
      throw new Error("the installation's claim is no longer this process's.");
    this.claimExpires = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
  }
}

/**
 * What a run's own change and facts name, as the one text the memory is read
 * against (ADR 0037): the change that woke it in the group's own words, and
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
 * Which of one answer's steps can run now, and which were left unrun (ADR 0034).
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
 * what a message coming back can be recognised against (ADR 0033): the question's
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

/** The ceiling a run has spent, or null when it has budget left (ADR 0031). */
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
