/**
 * One account's changes, and the runs they open or continue.
 *
 * Split from the loop it serves: this walks the account's change batch, asks
 * the decision turn which rules cover each change, continues the run a person
 * answered and opens one per rule named. It reads the pass's cursor and the
 * installation's prose and memory through `ChangesDeps`, so nothing here holds
 * the loop's claim or its alarms.
 */

import type { Ctx } from "../appFolder.js";
import { recallFacts } from "../shared/memory.js";
import type { RunDoc } from "../shared/run.js";
import { spendRun } from "../shared/run.js";
import type { AccountEvent } from "./accountEvent.js";
import { anchorEvents, type EventCursor, readAccountEvents } from "./events.js";
import type { AnsweredRun, PassSummary } from "./loop.js";
import type { MemoryStore } from "./memory.js";
import type { ModelAccess } from "./model.js";
import { decideEvent, usageMeter } from "./model.js";
import type { ProseLevel } from "./prose.js";
import { type RuleDoc, ruleApplies } from "./rule.js";
import { listRules } from "./rules.js";
import { listRuns, type RunRecord } from "./runs.js";

/** What the changes of one account need from the loop that asked for them. */
export interface ChangesDeps {
  ctx: Ctx;
  cursors: Map<string, EventCursor>;
  access: ModelAccess;
  proseAbove(accountId: string): Promise<Partial<Record<ProseLevel, string>>>;
  memory(): Promise<MemoryStore>;
  readingCall(
    accountId: string,
    event: AccountEvent,
    candidates: readonly RuleDoc[],
  ): { ctx: Ctx; accountId: string; run: RunDoc };
  runAnsweredBy(
    accountId: string,
    event: AccountEvent,
    records: readonly RunRecord[],
  ): Promise<AnsweredRun | "already" | null>;
  workRun(
    accountId: string,
    run: RunDoc,
    now: Date,
    facts?: Record<string, string>,
  ): Promise<void>;
  authoriseAnswer(answer: AnsweredRun): Promise<RunDoc>;
  openRun(accountId: string, event: AccountEvent, rule: RuleDoc): Promise<RunDoc>;
}

/** What woke a run, in the group's own words, from the event's own parts. */
export function wokeOf(event: AccountEvent): string {
  return `${event.source} ${event.change}: ${event.where}`;
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
/** The decision turn's tokens, on the run it opened or continued. */
function withUsage(
  run: RunDoc,
  meter: { promptTokens: number; completionTokens: number },
): RunDoc {
  if (!meter.promptTokens && !meter.completionTokens) return run;
  return spendRun(run, {
    promptTokens: meter.promptTokens,
    completionTokens: meter.completionTokens,
  });
}

export async function workChanges(
  deps: ChangesDeps,
  accountId: string,
  now: Date,
  summary: PassSummary,
): Promise<void> {
  let cursor = deps.cursors.get(accountId);
  if (!cursor) {
    // A first read anchors at where the account stands now: a process that
    // starts asks for the changes after it started, never for the whole
    // history (`events.ts`).
    cursor = await anchorEvents(deps.ctx, accountId);
    deps.cursors.set(accountId, cursor);
  }
  const read = await readAccountEvents(deps.ctx, accountId, cursor);
  if (read.gap) summary.gaps.push(read.gap);
  const rules = (await listRules(deps.ctx, accountId)).map((record) => record.rule);
  /** The runs the account already held, asked for once and only when needed. */
  let held: RunRecord[] | null = null;
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
    /*
     * What the installation holds and the group wrote above the rule: the
     * installation's own line and the group's standing instruction reach the
     * decision turn too, because which rules apply is asked of the same agent
     * (ADR 0035).
     */
    const meter = usageMeter();
    const decision = await decideEvent(
      deps.access,
      {
        event,
        rules,
        prose: await deps.proseAbove(accountId),
        memory: recallFacts((await deps.memory()).facts, woke, accountId),
      },
      deps.readingCall(accountId, event, candidates),
      { meter },
    );
    if (decision.kind !== "decision") continue;
    /*
     * The run this change answers, when it answers one, is asked for **once**
     * per event and before the rules: one person's reply continues the run that
     * asked and opens no run of its own (ADR 0033). Asking inside the rules
     * loop worked the same answer once per rule the decision named, the second
     * time from the document as it stood before the first working — which
     * wiped the steps the first had just recorded.
     */
    held ??= await listRuns(deps.ctx, accountId);
    const answer = await deps.runAnsweredBy(accountId, event, held);
    if (answer === "already") continue;
    if (answer) {
      summary.due += 1;
      await deps.workRun(
        accountId,
        withUsage(await deps.authoriseAnswer(answer), meter),
        now,
        decision.facts,
      );
      continue;
    }
    for (const named of decision.rules) {
      const rule = rules.find((candidate) => candidate.id === named);
      if (!rule) continue;
      const key = startKey(named, woke);
      // A run of the account that already names this rule and this change is
      // that change being worked, or the answer it already has: never a second
      // run over it.
      held ??= await listRuns(deps.ctx, accountId);
      const open = runsByStart(held).get(key);
      if (open) {
        if (open.state === "running")
          await deps.workRun(accountId, withUsage(open, meter), now, decision.facts);
        continue;
      }
      const run = await deps.openRun(accountId, event, rule);
      summary.runs += 1;
      await deps.workRun(accountId, withUsage(run, meter), now, decision.facts);
    }
  }
  // The cursor moves only once the batch is answered: a read that failed
  // half-way is read again rather than lost as silence.
  deps.cursors.set(accountId, read.cursor);
}
