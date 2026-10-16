/**
 * The in-process side of a run's waits (ADR 0034).
 *
 * A wait is a **date in the run document**, never a timer here: the document is
 * what a process that has just started reads, and this is only the alarm beside
 * it. That is the whole of the design — `arm` reads an account's runs and arms
 * every date they carry, so a restart loses no wait and a container that dies
 * is not an incident; a holder that takes the installation over re-arms the same
 * waits from the same documents (ADR 0036).
 *
 * A wait with **no** date is a question left for a person (ADR 0033, 0034): it
 * is never armed, because the answer arrives in the group's own account as an
 * event (`events.ts`) rather than at an instant this process can compute. So is
 * a run that has ended, including one that ended blocked on a person and keeps
 * the question it left — a date on a stopped run is not a wait, and firing it
 * would start a run whose end nobody re-opened.
 *
 * Firing says one thing: this run's date has come. The caller re-reads the run
 * and decides what that means, because the document may have moved in the hours
 * between arming and firing — the answer may have arrived, the budget may have
 * run out, the wait may have been replaced.
 */

import type { Ctx } from "../appFolder.js";
import { listRuns } from "./runs.js";

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

/**
 * The waits one process holds, and the alarm that ends them.
 *
 * An instance is the whole of the process-side state: nothing here is module
 * level, so a test (or a restart) begins with a fresh one and the runs decide
 * what is armed.
 */
export class WaitTimers {
  private readonly waits = new Map<string, NodeJS.Timeout>();

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
   */
  async arm(ctx: Ctx, accountId: string): Promise<string[]> {
    const armed: string[] = [];
    for (const { run } of await listRuns(ctx, accountId)) {
      const until = run.state === "running" ? run.waiting?.until : null;
      if (!until) continue;
      this.schedule(accountId, run.id, Date.parse(until));
      armed.push(run.id);
    }
    return armed;
  }

  /** Forget every wait this process armed, on the way down. */
  stop(): void {
    for (const at of this.waits.values()) clearTimeout(at);
    this.waits.clear();
  }

  private schedule(accountId: string, runId: string, dueMs: number): void {
    const key = `${accountId}\u0000${runId}`;
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
      this.onDue({ accountId, runId });
    }, delay);
    // A wait is a passenger: it must never keep a disposable process alive, and
    // the document is what survives the process either way.
    at.unref();
    this.waits.set(key, at);
  }
}
