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
import { appFolderState, type Ctx, filesAccountId } from "../appFolder.js";
import { retryStateMismatch, WRITE_ATTEMPTS } from "../jmap.js";
import { errorMessage } from "../shared/errors.js";
import { isRecord } from "../shared/json.js";
import { recallFacts } from "../shared/memory.js";
import {
  appendStep,
  finishRun,
  isRunWait,
  type RunDoc,
  type RunStep,
  type RunStepNeeds,
  type RunWait,
  recordRecall,
  recordStep,
  spendRun,
  startRun,
  waitUntil,
} from "../shared/run.js";
import type { AccountEvent } from "./accountEvent.js";
import { CLAIM_TTL_MS, renewClaim, takeClaim } from "./claim.js";
import { anchorEvents, type EventCursor, readAccountEvents } from "./events.js";
import { listFacts, type MemoryStore } from "./memory.js";
import {
  boundedText,
  chooseStep,
  decideEvent,
  type ModelAccess,
  ModelError,
} from "./model.js";
import { type RuleDoc, ruleApplies } from "./rule.js";
import { listRules, readRule } from "./rules.js";
import {
  createRun,
  dueRuns,
  listRuns,
  type RunRecord,
  readRun,
  replaceRun,
} from "./runs.js";
import { type DueWait, WaitTimers } from "./timers.js";
import { type AnyTool, runTool, TOOLS } from "./tools.js";

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
export const RUN_CALLS_MAX = 40;
export const RUN_MS_MAX = 5 * 60_000;

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
  access: ModelAccess;
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
  private readonly timers: WaitTimers;
  private readonly catalogue: readonly AnyTool[];

  constructor(
    private readonly ctx: Ctx,
    private readonly opts: AgentLoopOptions,
  ) {
    this.catalogue = opts.catalogue ?? TOOLS;
    this.timers = new WaitTimers((due) => {
      this.pending.push(due);
    });
  }

  /** Boot: work what the installation left, and re-arm every wait it holds. */
  async start(now = new Date()): Promise<PassSummary> {
    return await this.pass(now);
  }

  /** Give up the alarms, on the way down. The claim lapses on its own. */
  stop(): void {
    this.timers.stop();
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
    if (Date.parse(claim.expires) - now.getTime() <= CLAIM_RENEW_WITHIN_MS) {
      if (!(await renewClaim(this.ctx, this.opts.holder, now))) return summary;
    }
    summary.claimed = true;
    const accounts = await this.opts.accounts();
    summary.accounts = accounts.length;
    for (const accountId of accounts) {
      await this.workDue(accountId, now, summary);
      await this.workChanges(accountId, now, summary);
      /*
       * The waits are armed **after** the due runs have been advanced: a re-arm
       * beside a run whose document has not moved would hand the same instant
       * over twice (`timers.ts`), and a process that restarts re-arms what the
       * installation left.
       */
      await this.timers.arm(this.ctx, accountId);
    }
    return summary;
  }

  /** Every run of one account whose wait has come due, worked again. */
  private async workDue(
    accountId: string,
    now: Date,
    summary: PassSummary,
  ): Promise<void> {
    const handed = this.pending.filter((due) => due.accountId === accountId);
    for (let at = this.pending.length - 1; at >= 0; at--) {
      if (this.pending[at]?.accountId === accountId) this.pending.splice(at, 1);
    }
    /*
     * The alarms hand every dated wait over exactly once, and the documents ask
     * the same question again: a process that has just started has fired nothing
     * yet, so a wait that came due while it was down is due on its first pass.
     */
    const runs = new Set(handed.map((due) => due.runId));
    for (const { run } of await dueRuns(this.ctx, accountId, now)) runs.add(run.id);
    for (const id of runs) {
      const record = await readRun(this.ctx, accountId, id);
      if (record?.run.state !== "running") continue;
      summary.due += 1;
      await this.workRun(accountId, record.run, now);
    }
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
   * "the same change" is recognised by.
   */
  private async workChanges(
    accountId: string,
    now: Date,
    summary: PassSummary,
  ): Promise<void> {
    let cursor = this.cursors.get(accountId);
    if (!cursor) {
      // A first read anchors at where the account stands now: a process that
      // starts asks for the changes after it started, never for the whole
      // history (`events.ts`).
      cursor = await anchorEvents(this.ctx, accountId);
      this.cursors.set(accountId, cursor);
    }
    const read = await readAccountEvents(this.ctx, accountId, cursor);
    if (read.gap) summary.gaps.push(read.gap);
    const rules = (await listRules(this.ctx, accountId)).map((record) => record.rule);
    /** The runs the account already held, asked for once and only when needed. */
    let started: Map<string, RunDoc> | null = null;
    for (const event of read.events) {
      summary.changes += 1;
      const candidates = rules.filter((rule) => ruleApplies(rule, event));
      // A change no rule watches costs no model call and no step (ADR 0035).
      if (!candidates.length) continue;
      const woke = wokeOf(event);
      /*
       * The installation's memory, read once for the whole pass (ADR 0037) and
       * handed to the decision turn as the selection this change's own words
       * name. Each run is handed the one its own words name, which is the same
       * change beside the facts the decision found.
       */
      const decision = await decideEvent(
        this.opts.access,
        {
          event,
          rules,
          prose: {},
          memory: recallFacts((await this.memory()).facts, woke, accountId),
        },
        this.readingCall(accountId, event, candidates),
      );
      if (decision.kind !== "decision") continue;
      for (const named of decision.rules) {
        const rule = rules.find((candidate) => candidate.id === named);
        if (!rule) continue;
        const key = startKey(named, woke);
        // A run of the account that already names this rule and this change is
        // that change being worked, or the answer it already has: never a second
        // run over it.
        started ??= runsByStart(await listRuns(this.ctx, accountId));
        const held = started.get(key);
        if (held) {
          if (held.state === "running")
            await this.workRun(accountId, held, now, decision.facts);
          continue;
        }
        const run = await this.openRun(accountId, event, rule);
        summary.runs += 1;
        await this.workRun(accountId, run, now, decision.facts);
      }
    }
    // The cursor moves only once the batch is answered: a read that failed
    // half-way is read again rather than lost as silence.
    this.cursors.set(accountId, read.cursor);
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
      startedBy: { rule: rule.id, instruction: null, woke: wokeOf(event) },
    });
    await createRun(this.ctx, accountId, run);
    return run;
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
  ): Promise<void> {
    let current = run;
    /*
     * What the memory recalls for this run (ADR 0037): the change it answers, the
     * facts that change was found to be about, and the group's standing set,
     * against the store the pass read — the same one reading the decision turn
     * was handed. The selection is recorded on the run, so a wrong conclusion
     * traces to the fact that carried it, and every turn of this working is
     * handed it.
     */
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
    for (;;) {
      const over = overBudget(current);
      if (over) {
        await this.store(
          accountId,
          finishRun(current, "out-of-budget", {
            at: now.toISOString(),
            why: `the budget ended the run: ${over}, so the work did not finish.`,
          }),
        );
        return;
      }
      const prose = await this.proseOf(accountId, current);
      const startedMs = Date.now();
      const question = {
        woke: current.startedBy.woke ?? "the run was started by an instruction",
        plan: current.plan,
        prose,
        ...(facts ? { facts } : {}),
        memory: selection,
      };
      let choice: Awaited<ReturnType<typeof chooseStep>>;
      try {
        choice = await chooseStep(this.catalogue, this.opts.access, question);
      } catch (err) {
        /*
         * An answer this build refused is a step the record shows, not a silence:
         * the model is told what was wrong with it before it chooses again. A
         * call that could not be made at all is not an answer, and leaves the run
         * where it is for the next pass.
         */
        if (!(err instanceof ModelError) || err.code !== "model_answer_malformed")
          throw err;
        current = this.withStep(
          current,
          "the model's answer",
          `refused: ${errorMessage(err)}`,
          false,
        );
        current = spendRun(current, { calls: 1, ms: Date.now() - startedMs });
        await this.store(accountId, current);
        continue;
      }
      current = spendRun(current, { calls: 1, ms: Date.now() - startedMs });
      if (choice.kind === "done") {
        await this.store(
          accountId,
          finishRun(current, "done", {
            at: now.toISOString(),
            why: choice.why,
          }),
        );
        return;
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
        await this.store(
          accountId,
          finishRun(current, "out-of-budget", {
            at: now.toISOString(),
            why: `the model chose the same calls twice (${chosen}) and made no progress, so the run stopped.`,
          }),
        );
        return;
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
      await this.store(accountId, current);
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
        const wave = ready.flatMap((at) => {
          const call = choice.calls[at - base];
          return call ? [{ at, call }] : [];
        });
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
              { ctx: this.ctx, accountId, run: current, memory: store },
              call.name,
              call.args,
            ),
          ),
        );
        const elapsedMs = Date.now() - ranMs;
        for (const [which, { at, call }] of wave.entries()) {
          const result = settled[which];
          if (result?.status === "fulfilled") {
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
      await this.store(accountId, current);
      if (wait) return;
    }
  }

  /** The rule's own instruction, for the run that rule started. */
  private async proseOf(accountId: string, run: RunDoc): Promise<{ rule?: string }> {
    const id = run.startedBy.rule;
    if (!id) return {};
    const record = await readRule(this.ctx, accountId, id);
    return record ? { rule: record.rule.instruction } : {};
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
   * refused rather than overwritten, and the attempt is retried once.
   */
  private async store(accountId: string, run: RunDoc): Promise<void> {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const token = await appFolderState(this.ctx, accountId);
      try {
        await replaceRun(this.ctx, accountId, run, { ifInState: token });
        return;
      } catch (err) {
        if (retryStateMismatch(err, attempt)) break;
      }
    }
    throw new Error(
      `the run "${run.id}" could not be written: another write kept winning the race for the account.`,
    );
  }
}

/** What woke a run, in the group's own words, from the event's own parts. */
function wokeOf(event: AccountEvent): string {
  return `${event.source} ${event.change}: ${event.where}`;
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
 * Which rule and which change a run is the answer to: its own `startedBy`.
 *
 * The change is named the way the run carries it (`wokeOf`), so the pair a run
 * is filed under and the pair a change is looked up by are one string and not
 * two spellings that could drift.
 */
function startKey(rule: string, woke: string): string {
  return `${rule}\n${woke}`;
}

/**
 * The account's runs by what started them: one entry per rule-and-change pair.
 *
 * A run an instruction started names no rule and no change, and is not an answer
 * to one — nothing here. Two runs of one pair cannot be written by this build,
 * and the one a pass can continue is the one still running, so that is the one
 * kept when a hand-written pair of documents says otherwise.
 *
 * shortcut: a change is named by its surface, its kind and its address, which is
 * all the change log hands over — so a document created again at a path a rule
 * already answered is read as the change that was answered, not as a new one.
 * Upgrade when an event can name the state it happened at, or the object's own
 * version, which is what tells a recurrence from a replay.
 */
function runsByStart(records: readonly RunRecord[]): Map<string, RunDoc> {
  const byStart = new Map<string, RunDoc>();
  for (const { run } of records) {
    const { rule, woke } = run.startedBy;
    if (!rule || !woke) continue;
    const key = startKey(rule, woke);
    const held = byStart.get(key);
    if (!held || (held.state !== "running" && run.state === "running"))
      byStart.set(key, run);
  }
  return byStart;
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
