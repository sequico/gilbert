/**
 * The process that asks the loop for a pass (ADR 0031, 0034, 0036).
 *
 * What is pinned here is the supervisor's own contract, one mechanism per test,
 * and each of them is a mechanism rather than a run of the code:
 *
 * - a handshake that is missing stops at the boot, exactly as it does without
 *   this module, and no agent is started or announced;
 * - an installation that has chosen no model has no agent — the process answers
 *   null rather than running one on a provider nobody chose;
 * - a pass is asked on the interval, and one at a time;
 * - a pass that throws is logged and the next one still runs;
 * - a claim a peer holds is waited out, not fought for, and not reported as a
 *   failure;
 * - `stop()` gives up the schedule.
 *
 * The loop is a stand-in: what the supervisor owes a caller is when it asks and
 * what it does with the answer, and the loop's own work is pinned in
 * `loop.test.ts`. Nothing here needs a model, a provider or a mail server.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BootConfiguration } from "../bootstrap.js";
import type { UpstreamSession } from "../upstream.js";
import type { PassSummary } from "./loop.js";
import type { PassableLoop } from "./supervisor.js";

/*
 * The environment is staged before anything that reads it is imported, because
 * the configuration is resolved when `config.ts` first loads: a test process has
 * no deployment's secret, and stating one here is what keeps it from minting an
 * ephemeral one and warning about it.
 */
process.env.APP_SECRET = "test-secret-for-the-agent-supervisor";

const { environmentConfiguration } = await import("../configuration.js");
const { installationDefaults } = await import("../shared/installation.js");
const { startAgent, supervise } = await import("./supervisor.js");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* The loop the supervisor asks, and the lines it writes               */
/* ------------------------------------------------------------------ */

/** A pass of the loop, with nothing claimed unless the stand-in says otherwise. */
function passSummary(claimed: boolean): PassSummary {
  return { claimed, changes: 0, runs: 0, due: 0, gaps: [] };
}

interface StandIn {
  loop: PassableLoop;
  /** How many passes were asked of it. */
  passes: number;
  /** The most passes in flight at once, which must never be two. */
  mostAtOnce: number;
  /** Whether a pass answers that a peer holds the installation. */
  held: boolean;
  /** Make the next `count` passes throw instead of working. */
  failNext: (count: number) => void;
  /** Whether the loop's own alarms were given up. */
  stopped: boolean;
}

function standInLoop(): StandIn {
  let failures = 0;
  let active = 0;
  const state: StandIn = {
    passes: 0,
    mostAtOnce: 0,
    held: false,
    stopped: false,
    failNext: (count: number) => {
      failures = count;
    },
    loop: {
      async pass(): Promise<PassSummary> {
        state.passes += 1;
        active += 1;
        state.mostAtOnce = Math.max(state.mostAtOnce, active);
        await sleep(1);
        active -= 1;
        if (failures > 0) {
          failures -= 1;
          throw new Error("the mail server did not answer");
        }
        return passSummary(!state.held);
      },
      stop(): void {
        state.stopped = true;
      },
    },
  };
  return state;
}

/** The lines a supervised process wrote, and the one it is watched through. */
function collector(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

const failuresIn = (lines: readonly string[]): string[] =>
  lines.filter((line) => line.includes("the pass failed"));

/* ------------------------------------------------------------------ */
/* The boot, and the installation it resolves                          */
/* ------------------------------------------------------------------ */

/**
 * The session a boot hands over when nothing asks it anything.
 *
 * The gate on the model answers before any account is read, so a stand-in boot
 * that states no provider never gets a session it could use.
 */
const SESSION = {
  capabilities: {},
  accounts: {},
  primaryAccounts: {},
  username: "gilbert@example.com",
  apiUrl: "http://127.0.0.1:1/api",
  downloadUrl: "http://127.0.0.1:1/download",
  uploadUrl: "http://127.0.0.1:1/upload",
  eventSourceUrl: "http://127.0.0.1:1/eventsource",
  state: "1",
  baseUrl: "http://127.0.0.1:1",
} satisfies UpstreamSession;

/** A boot that resolved, as the supervisor sees it. */
function bootState(withModel: boolean): BootConfiguration {
  return {
    installation: {
      ...installationDefaults(),
      secret: "an-installation-secret-long-enough-to-seal-a-session-with",
      agent: withModel
        ? {
            provider: {
              provider: "example",
              model: "a-model",
              baseUrl: "https://models.example.com/v1",
              apiKey: "a-key",
            },
          }
        : {},
    },
    configuration: environmentConfiguration({
      APP_SECRET: "test-secret-for-the-agent-supervisor",
    }),
    master: {
      address: "gilbert@example.com",
      authorization: "Basic dGVzdA==",
      session: SESSION,
    },
    accountId: "ag1",
    created: false,
    stalwartUrl: "http://127.0.0.1:1",
  };
}

/* ------------------------------------------------------------------ */

test("a handshake that is missing stops at the boot, and no agent is started", async () => {
  const { lines, log } = collector();
  await assert.rejects(
    startAgent({
      // No handshake at all: the boot these two share is what refuses it.
      env: {},
      log,
      exit: (code: number): never => {
        throw new Error(`the boot would have exited ${code}`);
      },
    }),
    /would have exited 1/,
    "the boot's own refusal is what a process without the handshake gets",
  );
  assert.equal(lines.length, 1, "one line, the boot's own");
  assert.match(lines[0] ?? "", /STALWART_URL is not set/);
  assert.equal(
    lines.some((line) => line.includes("agent:")),
    false,
    "and no agent line, which is what a deployment nobody switched on sees",
  );
});

test("an installation that has chosen no model has no agent", async () => {
  const { lines, log } = collector();
  const agent = await startAgent({
    boot: async () => bootState(false),
    log,
  });
  assert.equal(agent, null, "there is no agent to supervise");
  assert.deepEqual(lines, [
    "[gilbert] agent: this installation has chosen no model, so it has no agent",
  ]);
});

test("a pass is asked on the interval, one at a time", async (t) => {
  const stand = standInLoop();
  const { lines, log } = collector();
  const process = supervise({ loop: stand.loop, intervalMs: 10, log });
  t.after(() => process.stop());
  await sleep(70);
  assert.ok(stand.passes >= 3, `the interval kept asking (${stand.passes} passes)`);
  assert.equal(stand.mostAtOnce, 1, "a slower pass is never overtaken");
  assert.equal(failuresIn(lines).length, 0, "and nothing was reported as failed");
});

test("a pass that throws is logged, and the next one still runs", async (t) => {
  const stand = standInLoop();
  const { lines, log } = collector();
  stand.failNext(2);
  const process = supervise({ loop: stand.loop, intervalMs: 10, log });
  t.after(() => process.stop());
  await sleep(80);
  assert.ok(
    failuresIn(lines).length >= 2,
    `every failure is on the log (${failuresIn(lines).length})`,
  );
  assert.match(failuresIn(lines)[0] ?? "", /the mail server did not answer/);
  assert.ok(stand.passes >= 4, "and the schedule went on asking");
});

test("a claim a peer holds is waited out, not fought for and not a failure", async (t) => {
  const stand = standInLoop();
  stand.held = true;
  const { lines, log } = collector();
  const process = supervise({ loop: stand.loop, intervalMs: 10, log });
  t.after(() => process.stop());
  await sleep(60);
  assert.equal(
    lines.filter((line) => line.includes("another process holds")).length,
    1,
    "the held claim is said once, not once per pass",
  );
  assert.equal(failuresIn(lines).length, 0, "a held claim is not an error");
  assert.ok(stand.passes >= 2, "and the process keeps asking its turn");
  assert.ok(
    stand.passes <= 10,
    `and does not retry in a tight loop (${stand.passes} passes in 60 ms)`,
  );
});

test("a claim that lapses is taken over, and said once", async (t) => {
  const stand = standInLoop();
  stand.held = true;
  const { lines, log } = collector();
  const process = supervise({ loop: stand.loop, intervalMs: 10, log });
  t.after(() => process.stop());
  await sleep(40);
  // The peer's claim lapses (`CLAIM_TTL_MS`): the next pass is this process's.
  stand.held = false;
  await sleep(40);
  assert.equal(
    lines.filter((line) => line.includes("is this process's again")).length,
    1,
    "taking the installation over is said once as well",
  );
});

test("stop gives up the schedule and the loop's alarms", async (t) => {
  const stand = standInLoop();
  const { log } = collector();
  const process = supervise({ loop: stand.loop, intervalMs: 10, log });
  t.after(() => process.stop());
  await sleep(30);
  const before = stand.passes;
  process.stop();
  assert.equal(stand.stopped, true, "the loop's own alarms are given up");
  await sleep(40);
  assert.ok(
    stand.passes - before <= 1,
    `no pass is asked after the stop (${stand.passes - before} more)`,
  );
});
