/**
 * The in-process side of a run's waits (ADR 0030).
 *
 * A wait is a **date in the run document**, never a timer here: the document is
 * what a process that has just started reads, and this is only the alarm beside
 * it. That is the whole of the design — `arm` reads an account's runs and arms
 * every date they carry, so a restart loses no wait and a container that dies
 * is not an incident; a holder that takes the installation over re-arms the same
 * waits from the same documents (ADR 0032).
 *
 * A **question left for a person carries its deadline** (ADR 0029): it is armed
 * exactly like any other date, and when it fires the run goes on without the
 * answer with a step that says so. A question written by a build before that
 * carries no date at all; it is never armed, because the answer arrives in the
 * group's own account as an event (`events.ts`) rather than at an instant this
 * process can compute. A run that has ended is never armed either — a date kept
 * beside an ending is not a wait, and firing it would start a run whose end
 * nobody re-opened. Which of these a run is is the document's own answer
 * (`waitDueAt`), never derived a second time here.
 *
 * Firing says one thing: this run's date has come. The caller re-reads the run
 * and decides what that means, because the document may have moved in the hours
 * between arming and firing — the answer may have arrived, the budget may have
 * run out, the wait may have been replaced.
 *
 * **The contract that keeps one date from firing twice.** `arm` promises to
 * hand over every wait of every running run exactly once per due instant: a due
 * run it has already fired is not fired again while its document still carries
 * the same instant, however many times `arm` runs beside it. What the caller
 * owes is the other half — every due run it is handed is to be read and acted
 * on, and its document advanced (a new wait, or an ending), **before** it arms
 * the account again. With both halves kept, a re-arm beside a run that has
 * already fired changes nothing; with the caller's half skipped, this process
 * still refuses to fire the same instant twice, but the next holder reads the
 * unadvanced document (ADR 0032) and the wait is handed over afresh.
 */

import type { Ctx } from "../appFolder.js";
import { waitDueAt } from "../shared/run.js";
import { listRunsForWorking, type RunRecord } from "./runs.js";

/**
 * The longest a single `setTimeout` may be asked to wait.
 *
 * A delay past the platform's own bound overflows and fires at once, which
 * would make a wait months out come due the moment it was armed. A longer wait
 * is armed in a hop and re-armed when the hop expires.
 */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** One run whose date has come. */
export interface DueWait {
  accountId: string;
  runId: string;
}

/** What one run's wait is called here: the account it lives in, and its id. */
function waitKey(accountId: string, runId: string): string {
  return `${accountId}\u0000${runId}`;
}

/**
 * The waits one process holds, and the alarm that ends them.
 *
 * An instance is the whole of the process-side state: nothing here is module
 * level, so a test (or a restart) begins with a fresh one and the runs decide
 * what is armed.
 */
export class WaitTimers {
  private readonly waits = new Map<string, NodeJS.Timeout>();

  /** The instant each run's wait was already fired at, by account and run. */
  private readonly fired = new Map<string, number>();

  constructor(private readonly onDue: (due: DueWait) => void) {}

  /**
   * Arm every wait `accountId` holds, and answer which runs were armed.
   *
   * Reading the runs rather than being handed them is the point: this is what
   * boot does, and what a holder does when it takes the installation over. A
   * run whose document cannot be read stops the arming with its own path and
   * reason (`runs.ts`) — the account's other waits are not armed behind a
   * document nobody can explain, and the caller reports it rather than serving
   * a process that believes it has armed them all.
   *
   * A run this process has already fired at the instant its document still
   * carries is left alone: the caller owes the advance between the two arms, and
   * arming it again would hand the same date over twice.
   */
  async arm(
    ctx: Ctx,
    accountId: string,
    problems: string[] = [],
    /** What the pass already read, so arming does not walk the folder again. */
    records?: readonly RunRecord[],
  ): Promise<string[]> {
    const armed: string[] = [];
    const waiting = new Set<string>();
    let held = records;
    if (!held) {
      const read = await listRunsForWorking(ctx, accountId);
      problems.push(...read.problems);
      held = read.records;
    }
    for (const { run } of held) {
      const until = waitDueAt(run);
      if (!until) continue;
      const key = waitKey(accountId, run.id);
      waiting.add(key);
      const dueMs = Date.parse(until);
      if (this.fired.get(key) === dueMs) continue;
      this.schedule(accountId, run.id, dueMs);
      armed.push(run.id);
    }
    /*
     * A run that ended carries no wait any more, and its fired instant is not
     * worth remembering: keeping it made the map grow with every dated run the
     * process ever fired. The account's prefix keeps other accounts' entries.
     */
    const prefix = `${accountId}\u0000`;
    for (const key of this.fired.keys())
      if (key.startsWith(prefix) && !waiting.has(key)) this.fired.delete(key);
    return armed;
  }

  /** Forget every wait this process armed, on the way down. */
  stop(): void {
    for (const at of this.waits.values()) clearTimeout(at);
    this.waits.clear();
    this.fired.clear();
  }

  private schedule(accountId: string, runId: string, dueMs: number): void {
    const key = waitKey(accountId, runId);
    const previous = this.waits.get(key);
    if (previous) clearTimeout(previous);
    const delay = Math.min(Math.max(dueMs - Date.now(), 0), MAX_DELAY_MS);
    const at = setTimeout(() => {
      // The date can still be ahead when the hop, not the wait, was the delay:
      // arm the rest of it rather than firing early.
      if (dueMs > Date.now()) {
        this.schedule(accountId, runId, dueMs);
        return;
      }
      this.waits.delete(key);
      // Recorded before the hand-over, so a re-arm that arrives while the
      // caller is still working on the run cannot arm the same instant again.
      this.fired.set(key, dueMs);
      this.onDue({ accountId, runId });
    }, delay);
    // A wait is a passenger: it must never keep a disposable process alive, and
    // the document is what survives the process either way.
    at.unref();
    this.waits.set(key, at);
  }
}
