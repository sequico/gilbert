import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRule, AgentScheduleEntry } from "./documents.js";

/**
 * Time triggers on documents (ADR 0003 §5).
 *
 * The planning, the due check and the advance are pure, so they are tested
 * against instants; `armTimers` is armed with a clock and a timer queue the
 * test owns, so the cap, the re-arm and the next occurrence after a fire are
 * pinned without a sleeping test.
 */

const { advance, armTimers, carryingForeign, dueEntries, planSchedule } = await import(
  "./scheduler.js"
);

const NOW = new Date("2026-09-10T10:00:30.000Z");

function rule(overrides: Partial<AgentRule> = {}): AgentRule {
  return {
    v: 1,
    id: "r1",
    version: 1,
    name: "Every hour",
    enabled: true,
    area: "mail",
    trigger: { on: "schedule", everyMinutes: 60 },
    tier: "T0",
    review: { mode: "never" },
    actions: [{ do: "noop" }],
    ...overrides,
  };
}

/**
 * A clock and a timer queue, so a test moves time instead of waiting for it.
 *
 * `advanceTo` runs each armed timer at its own instant, in order, so a timer
 * that arms another one — the capped re-check — is honoured where it falls
 * rather than collected at the end.
 */
function fakeTimers(startMs: number) {
  let now = startMs;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    /** The injection `armTimers` takes, so the globals are never touched. */
    opts: {
      now: (): number => now,
      setTimeoutFn: (fn: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
        const id = nextId++;
        pending.set(id, { at: now + Math.max(delayMs, 0), fn });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: (timer: ReturnType<typeof setTimeout>): void => {
        pending.delete(timer as unknown as number);
      },
    },
    now: (): number => now,
    /** Run every timer due at or before `targetMs`, then stand at `targetMs`. */
    advanceTo: (targetMs: number): void => {
      for (;;) {
        const next = [...pending.entries()]
          .filter(([, timer]) => timer.at <= targetMs)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
      }
      now = Math.max(now, targetMs);
    },
    /** How many timers are armed right now. */
    armed: (): number => pending.size,
  };
}

const at = (iso: string) => Date.parse(iso);

test("a schedule rule is planned to its next aligned instant", () => {
  const entries = planSchedule([rule()], NOW);
  assert.deepEqual(entries, [{ ruleId: "r1", at: "2026-09-10T11:00:00.000Z" }]);
});

test("an entry still in the future is kept, so a due time never slides", () => {
  const existing: AgentScheduleEntry[] = [
    { ruleId: "r1", at: "2026-09-10T10:45:00.000Z" },
  ];
  assert.deepEqual(planSchedule([rule()], NOW, existing), existing);
});

test("an entry in the past is planned forward", () => {
  const existing: AgentScheduleEntry[] = [
    { ruleId: "r1", at: "2026-09-10T09:00:00.000Z" },
  ];
  assert.deepEqual(planSchedule([rule()], NOW, existing), [
    { ruleId: "r1", at: "2026-09-10T11:00:00.000Z" },
  ]);
});

test("a disabled rule and a rule on another trigger are not planned", () => {
  assert.deepEqual(planSchedule([rule({ enabled: false })], NOW), []);
  assert.deepEqual(
    planSchedule([rule({ trigger: { on: "email" } })], NOW),
    [],
    "an email rule is triggered by mail, never by the clock",
  );
});

test("only entries whose instant has arrived are due", () => {
  const entries: AgentScheduleEntry[] = [
    { ruleId: "r1", at: "2026-09-10T10:00:00.000Z" },
    { ruleId: "r2", at: "2026-09-10T10:00:30.000Z" },
    { ruleId: "r3", at: "2026-09-10T10:01:00.000Z" },
  ];
  assert.deepEqual(
    dueEntries(entries, NOW).map((entry) => entry.ruleId),
    ["r1", "r2"],
  );
});

test("advance re-plans what fired and carries the rest over", () => {
  const entries: AgentScheduleEntry[] = [
    { ruleId: "r1", at: "2026-09-10T10:00:00.000Z" },
    { ruleId: "r2", at: "2026-09-10T10:30:00.000Z" },
  ];
  const advanced = advance(entries, [entries[0]!], [rule(), rule({ id: "r2" })], NOW);
  assert.deepEqual(advanced, [
    { ruleId: "r1", at: "2026-09-10T11:00:00.000Z" },
    { ruleId: "r2", at: "2026-09-10T10:30:00.000Z" },
  ]);
});

test("a timer reports its entry when the instant arrives", () => {
  const due: string[] = [];
  const clock = fakeTimers(at("2026-09-10T10:00:00.000Z"));
  const entry: AgentScheduleEntry = { ruleId: "r1", at: "2026-09-10T10:00:00.040Z" };
  const dispose = armTimers([entry], (fired) => due.push(fired.ruleId), {
    maxDelayMs: 1_000,
    ...clock.opts,
  });
  clock.advanceTo(at("2026-09-10T10:00:00.040Z"));
  dispose();
  assert.deepEqual(due, ["r1"]);
});

test("a capped timer re-arms for the rest instead of reporting a run that is not due", () => {
  const due: string[] = [];
  const clock = fakeTimers(at("2026-09-10T10:00:00.000Z"));
  const entry: AgentScheduleEntry = { ruleId: "r1", at: "2026-09-10T10:00:10.000Z" };
  const dispose = armTimers([entry], (fired) => due.push(fired.ruleId), {
    maxDelayMs: 1_000,
    ...clock.opts,
  });
  clock.advanceTo(at("2026-09-10T10:00:09.999Z"));
  assert.deepEqual(due, [], "nine caps fired before the instant, and none of them ran");
  assert.equal(clock.armed(), 1, "and the entry is armed for the rest, not dropped");
  clock.advanceTo(at("2026-09-10T10:00:10.000Z"));
  dispose();
  assert.deepEqual(
    due,
    ["r1"],
    "it ran when its own instant arrived, not when the cap did",
  );
});

test("the disposer stops every timer, including a pending re-check", () => {
  const due: string[] = [];
  const clock = fakeTimers(at("2026-09-10T10:00:00.000Z"));
  const entry: AgentScheduleEntry = { ruleId: "r1", at: "2026-09-10T10:00:10.000Z" };
  const dispose = armTimers([entry], (fired) => due.push(fired.ruleId), {
    maxDelayMs: 1_000,
    ...clock.opts,
  });
  dispose();
  assert.equal(clock.armed(), 0);
  clock.advanceTo(at("2026-09-10T11:00:00.000Z"));
  assert.deepEqual(due, []);
});

/**
 * The level is the scheduler, not the executor: `armSchedule` arms the global
 * timers and the mock's clock is not injectable, so an executor-level version
 * of this test would have to sleep for the next occurrence. What the scheduler
 * pins here is the same sequence the executor runs — the pass reads the due
 * runs out of the document, the fire moves the document on to the entry's next
 * occurrence, and the next arming is planned from that document.
 */
test("a run that fired arms its next occurrence, planned from the document the fire moved on", () => {
  const clock = fakeTimers(at("2026-09-10T10:00:00.000Z"));
  const rules = [rule({ id: "hourly" })];
  // The document as the store holds it: the instant that has just fired.
  const stored: AgentScheduleEntry[] = [
    { ruleId: "hourly", at: "2026-09-10T10:00:00.000Z" },
  ];

  const now = new Date(clock.now());
  const due = dueEntries(stored, now);
  assert.deepEqual(due, stored, "the pass reads the due runs out of the document");
  const afterFire = advance(stored, due, rules, now);
  assert.deepEqual(
    afterFire,
    [{ ruleId: "hourly", at: "2026-09-10T11:00:00.000Z" }],
    "and the fire moves the entry on to its next occurrence",
  );

  const fired: string[] = [];
  const dispose = armTimers(
    planSchedule(rules, now, afterFire),
    (entry) => fired.push(entry.at),
    { maxDelayMs: 60 * 60_000, ...clock.opts },
  );
  clock.advanceTo(at("2026-09-10T10:59:59.999Z"));
  assert.deepEqual(fired, [], "the entry that already ran is not armed again");
  clock.advanceTo(at("2026-09-10T11:00:00.000Z"));
  dispose();
  assert.deepEqual(fired, ["2026-09-10T11:00:00.000Z"], "the next occurrence runs");
});

test("an entry another area still owes keeps its instant instead of being re-planned away", () => {
  const now = new Date("2026-09-10T10:00:00.000Z");
  const rules = [rule(), rule({ id: "filing", area: "files", name: "File it" })];
  // The document as a shared account holds it: both entries are due at once,
  // and the claims on the two areas are held by two different workers.
  const stored: AgentScheduleEntry[] = [
    { ruleId: "r1", at: "2026-09-10T10:00:00.000Z" },
    { ruleId: "filing", at: "2026-09-10T10:00:00.000Z" },
  ];
  const next = carryingForeign(
    advance(planSchedule(rules, now, stored), [stored[0]!], rules, now),
    stored,
    rules,
    new Set(["r1"]),
  );
  const byRule = new Map(next.map((entry) => [entry.ruleId, entry.at]));
  assert.equal(
    byRule.get("filing"),
    "2026-09-10T10:00:00.000Z",
    "the area this worker does not hold keeps the instant its own worker fires",
  );
  assert.ok(
    Date.parse(byRule.get("r1") ?? "") > now.getTime(),
    "and the entry this worker did fire moved on to its next occurrence",
  );
});
