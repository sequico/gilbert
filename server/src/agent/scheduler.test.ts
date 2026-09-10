import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRule, AgentScheduleEntry } from "./documents.js";

/**
 * Time triggers on documents (ADR 0003 §5).
 *
 * The planning, the due check and the advance are pure, so they are tested
 * against instants rather than a sleeping test; `armTimers` is tested with
 * short real timers, including the capped case, because the cap is what keeps a
 * far-future instant from being trusted to one long sleep.
 */

const { advance, armTimers, dueEntries, planSchedule } = await import("./scheduler.js");

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

test("a timer reports its entry when the instant arrives", async () => {
  const due: string[] = [];
  const entry: AgentScheduleEntry = {
    ruleId: "r1",
    at: new Date(Date.now() + 40).toISOString(),
  };
  const dispose = armTimers([entry], (fired) => due.push(fired.ruleId), {
    maxDelayMs: 1_000,
  });
  await sleep(90);
  dispose();
  assert.deepEqual(due, ["r1"]);
});

test("a capped timer re-checks instead of reporting a run that is not due", async () => {
  const due: string[] = [];
  const entry: AgentScheduleEntry = {
    ruleId: "r1",
    at: new Date(Date.now() + 120).toISOString(),
  };
  const dispose = armTimers([entry], (fired) => due.push(fired.ruleId), {
    maxDelayMs: 15,
  });
  await sleep(60);
  assert.deepEqual(due, [], "the first timers fired before the instant, so nothing ran");
  await sleep(140);
  dispose();
  assert.deepEqual(due, ["r1"], "and the entry ran once its instant arrived");
});

test("the disposer stops every timer, including a pending re-check", async () => {
  const due: string[] = [];
  const entry: AgentScheduleEntry = {
    ruleId: "r1",
    at: new Date(Date.now() + 40).toISOString(),
  };
  const dispose = armTimers([entry], (fired) => due.push(fired.ruleId), {
    maxDelayMs: 10,
  });
  dispose();
  await sleep(80);
  assert.deepEqual(due, []);
});
