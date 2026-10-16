/**
 * The agent the server's boot starts (ADR 0031, 0034, 0036).
 *
 * What is pinned here is the supervisor's own contract, one mechanism per test,
 * and each of them is a mechanism rather than a run of the code:
 *
 * - an installation that has chosen no model leaves the agent idle with one line
 *   — the process answers null rather than running on a provider nobody chose;
 * - a Master that works no group has an agent all the same, because the groups
 *   are read on every pass and not decided at the start;
 * - the accounts one pass works are read from the mail server each time, so a
 *   group added in Stalwart's directory is picked up without a restart;
 * - anything else the agent cannot resolve is a line too, never a failed boot;
 * - a pass is asked every ten seconds, and one at a time;
 * - a pass that worked and found nothing to do writes nothing at all;
 * - the Master working no group is said once, and once again when it holds one;
 * - a pass that throws is logged and the next one still runs;
 * - a claim a peer holds is waited out, not fought for, and not reported as a
 *   failure;
 * - `stop()` gives up the schedule.
 *
 * The loop is a stand-in: what the supervisor owes a caller is when it asks and
 * what it does with the answer, and the loop's own work is pinned in
 * `loop.test.ts`. The two reads the accounts are resolved with are asked of a
 * mail server that is deliberately tiny — a session and a mail store, and no
 * more (`mailServer` below) — because what is pinned is that the answer is read
 * afresh, not what Stalwart answers.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import type { BootConfiguration } from "../bootstrap.js";
import { freePort } from "../testkit.js";
import type { UpstreamSession } from "../upstream.js";
import type { PassSummary } from "./loop.js";
import type { PassableLoop } from "./supervisor.js";

/*
 * The environment is staged before anything that reads it is imported, because
 * the configuration is resolved when `config.ts` first loads: a test process has
 * no deployment's secret, and stating one here is what keeps it from minting an
 * ephemeral one and warning about it. `STALWART_URL` is the tiny mail server
 * below, which is where `resolveGroupAccounts` re-reads the Master's session.
 */
process.env.APP_SECRET = "test-secret-for-the-agent-supervisor";
const SESSION_PORT = await freePort();
process.env.STALWART_URL = `http://127.0.0.1:${SESSION_PORT}`;

const { environmentConfiguration } = await import("../configuration.js");
const { installationDefaults } = await import("../shared/installation.js");
const { resolveGroupAccounts, startAgent, supervise, AGENT_PASS_INTERVAL_MS } =
  await import("./supervisor.js");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until `done` answers true, or give up after a generous bound.
 *
 * The supervisor's own schedule is what a test here is standing on, and the
 * passes it asks are the caller's to observe. A test that needs a pass to have
 * happened therefore waits on the state that pass produced, never on a duration:
 * a sleep long enough on an idle box is a window too short on a loaded one, and
 * a full-suite run is the loaded case — which is how the claim test went flaky
 * (`0 !== 1`, a pass that had not fitted inside the window). The bound is long
 * enough that reaching it is a real failure of the mechanism being pinned, not
 * of the machine.
 */
async function waitFor(done: () => boolean, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done() && Date.now() < until) await sleep(5);
}

/* ------------------------------------------------------------------ */
/* The loop the supervisor asks, and the lines it writes               */
/* ------------------------------------------------------------------ */

/** A pass of the loop, with nothing claimed unless the stand-in says otherwise. */
function passSummary(claimed: boolean, accounts = 1): PassSummary {
  return { claimed, accounts, changes: 0, runs: 0, due: 0, gaps: [] };
}

interface StandIn {
  loop: PassableLoop;
  /** How many passes were asked of it. */
  passes: number;
  /** The most passes in flight at once, which must never be two. */
  mostAtOnce: number;
  /** How long a pass takes. A pass slower than the interval is the guard's case. */
  holdMs: number;
  /** Whether a pass answers that a peer holds the installation. */
  held: boolean;
  /** The accounts a pass answers it worked: zero is a Master holding no group. */
  accounts: number;
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
    holdMs: 1,
    held: false,
    accounts: 1,
    stopped: false,
    failNext: (count: number) => {
      failures = count;
    },
    loop: {
      async pass(): Promise<PassSummary> {
        state.passes += 1;
        active += 1;
        state.mostAtOnce = Math.max(state.mostAtOnce, active);
        await sleep(state.holdMs);
        active -= 1;
        if (failures > 0) {
          failures -= 1;
          throw new Error("the mail server did not answer");
        }
        return passSummary(!state.held, state.accounts);
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

/** The lines a pass wrote, which is every line but the one the start writes. */
const passLinesIn = (lines: readonly string[]): string[] =>
  lines.filter((line) => !line.includes("asking for a pass every"));

/* ------------------------------------------------------------------ */
/* The mail server the accounts are resolved against                   */
/* ------------------------------------------------------------------ */

/**
 * The smallest mail server `resolveGroupAccounts` can be asked of: a session
 * resource and a mail store, and nothing else.
 *
 * The groups a session lists are held in `groupAccounts` and **mutated by the
 * tests**, which is the whole point: a group added to this list between two
 * reads is an administrator adding the Master to a group in Stalwart's own
 * directory, and the session that lists it is only ever seen by a caller that
 * asks the server again. The mail store answers a folder for any account, which
 * is what makes an account a group mailbox to the one classifier
 * (`groupAccess.ts`'s probe).
 */
let groupAccounts: Array<[string, { name: string; isPersonal: boolean }]> = [];

const mailServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const send = (body: unknown): void => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url?.startsWith("/.well-known/jmap")) {
    send({
      capabilities: {},
      accounts: Object.fromEntries([
        ...groupAccounts,
        ["own", { name: "gilbert@example.com", isPersonal: true }],
      ]),
      primaryAccounts: {},
      username: "gilbert@example.com",
      apiUrl: `http://127.0.0.1:${SESSION_PORT}/jmap/`,
      state: "1",
    });
    return;
  }
  send({
    methodResponses: [
      ["Mailbox/get", { list: [{ id: "inbox", name: "Inbox", role: "inbox" }] }, "r"],
    ],
  });
});
await new Promise<void>((resolve) =>
  mailServer.listen(SESSION_PORT, "127.0.0.1", resolve),
);
after(() => mailServer.close());

/* ------------------------------------------------------------------ */
/* The boot, and the installation the agent resolves itself against     */
/* ------------------------------------------------------------------ */

/**
 * The session a boot hands over.
 *
 * `apiUrl`/`baseUrl` are a port nothing listens on: the session is only ever a
 * stand-in for a boot that has happened (`startAgent` never signs in — the
 * server's boot did), and nothing resolves the agent's groups from it — that
 * read goes to the mail server every pass (`resolveGroupAccounts`).
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

/** The account a stand-in boot's session carries: group-shaped, and nothing else. */
const GROUP_ACCOUNT = { name: "team@example.org", isPersonal: false };

interface BootOptions {
  /** A model in the installation's document. On unless a test says otherwise. */
  model?: boolean;
  /** What the boot's own session carries. The agent works what the server answers. */
  accounts?: Record<string, unknown>;
}

/** A boot that resolved, as the agent sees it. */
function bootState(options: BootOptions = {}): BootConfiguration {
  return {
    installation: {
      ...installationDefaults(),
      secret: "an-installation-secret-long-enough-to-seal-a-session-with",
      agent:
        options.model === false
          ? {}
          : {
              provider: {
                provider: "example",
                model: "a-model",
                baseUrl: "https://models.example.com/v1",
                apiKey: "a-key",
              },
            },
    },
    configuration: environmentConfiguration({
      APP_SECRET: "test-secret-for-the-agent-supervisor",
    }),
    master: {
      address: "gilbert@example.com",
      authorization: "Basic dGVzdA==",
      session: {
        ...SESSION,
        accounts: options.accounts ?? { ag1: GROUP_ACCOUNT },
      },
    },
    accountId: "ag1",
    created: false,
    stalwartUrl: "http://127.0.0.1:1",
  };
}

/* ------------------------------------------------------------------ */

test("an installation that has chosen no model leaves the agent idle, with one line", async () => {
  const { lines, log } = collector();
  const agent = await startAgent(bootState({ model: false }), { log });
  assert.equal(agent, null, "there is no agent to supervise");
  assert.deepEqual(lines, [
    "[gilbert] agent: this installation has chosen no model, so the agent stays idle until one is chosen (ADR 0031)",
  ]);
});

test("a Master that works no group has an agent all the same", async (t) => {
  /*
   * The shape this replaces decided the question once, at the start, and
   * answered null — which is exactly what made a group added in Stalwart's
   * directory need a restart. Nothing about the Master's groups is decided by
   * the boot now: it starts an agent, and every pass asks for the accounts
   * (`resolveGroupAccounts` below, `loop.ts`).
   *
   * What this server answers is a session and a mail store and nothing else, so
   * the pass that follows fails on the claim and says so — the pass is not what
   * this test pins. What is pinned is the boot's own decision, and the one line
   * a start writes: the interval it will ask on, and no verdict about groups.
   */
  const { lines, log } = collector();
  const agent = await startAgent(bootState(), { log });
  assert.ok(agent, "there is an agent, whatever the Master works");
  t.after(() => agent.stop());
  assert.match(
    lines[0] ?? "",
    /asking for a pass every/,
    "and the start writes the one line it writes",
  );
});

test("the groups are read from the server on every pass, not from the session the start held", async () => {
  /*
   * The membership itself is `loop.test.ts`'s mechanism (the loop asks for the
   * accounts on every pass); what is pinned here is that the answer is read from
   * the mail server each time rather than from the session the process started
   * with. The starting session in this test is the stand-in at a port nothing
   * listens on, and it knows of no group at all — so a caller that resolved from
   * it could never see the group added below.
   */
  const ctx: Ctx = {
    authorization: "Basic dGVzdA==",
    session: { ...SESSION, accounts: {} },
    username: "gilbert@example.com",
  };
  groupAccounts = [];
  assert.deepEqual(await resolveGroupAccounts(ctx), [], "nothing to work yet");

  groupAccounts = [["ag1", { name: "team@example.org", isPersonal: false }]];
  assert.deepEqual(
    await resolveGroupAccounts(ctx),
    ["ag1"],
    "the group added in the directory since is worked by the next read",
  );
});

test("an agent whose conditions cannot be resolved is a line, not a failed boot", async () => {
  /*
   * The guard's own shape: a document this build cannot read at all. It cannot
   * come from a boot of a build this one is (the parser is stricter), which is
   * the point — whatever else goes wrong while the agent resolves itself is one
   * line and an idle agent, never a server that fell over.
   */
  const { lines, log } = collector();
  const broken = bootState();
  (broken.installation as { agent?: unknown }).agent = undefined;
  const agent = await startAgent(broken, { log });
  assert.equal(agent, null, "no agent");
  assert.equal(lines.length, 1, "one line");
  assert.match(lines[0] ?? "", /it could not be started/);
});

test("a pass is asked on the interval, one at a time", async (t) => {
  const stand = standInLoop();
  /*
   * A pass slower than the interval, which is the case the guard is for: two
   * passes of one process in flight would work the same run twice, which is the
   * thing the claim prevents between processes. The stand-in's own passes are
   * shorter than the interval everywhere else, so this is where the guard shows.
   */
  stand.holdMs = 20;
  const { lines, log } = collector();
  const process = supervise({ loop: stand.loop, intervalMs: 5, log });
  t.after(() => process.stop());
  await sleep(120);
  assert.ok(stand.passes >= 3, `the interval kept asking (${stand.passes} passes)`);
  assert.equal(stand.mostAtOnce, 1, "a slower pass is never overtaken");
  assert.equal(failuresIn(lines).length, 0, "and nothing was reported as failed");
});

test("the interval is ten seconds, and the start says so", async (t) => {
  /*
   * The number itself is the owner's decision and not a setting: ten seconds is
   * what makes a group the Master is added to be worked by the next pass and a
   * dated wait be picked up close to its instant, and it is what the line a
   * person reads on the console states.
   */
  const stand = standInLoop();
  const { lines, log } = collector();
  const process = supervise({ loop: stand.loop, log });
  t.after(() => process.stop());
  assert.equal(AGENT_PASS_INTERVAL_MS, 10_000, "a pass is asked every ten seconds");
  assert.equal(
    lines[0],
    "[gilbert] agent: asking for a pass every 10 s",
    "and the start says which interval it is on",
  );
});

test("a pass that worked and found nothing to do writes nothing", async (t) => {
  /*
   * Asserted on the lines the process wrote rather than on the pass not
   * throwing: what a pass worked is the run documents, and a quiet installation
   * is a quiet console. The only other line here is the one the start writes.
   */
  const stand = standInLoop();
  const { lines, log } = collector();
  const process = supervise({ loop: stand.loop, intervalMs: 10, log });
  t.after(() => process.stop());
  await sleep(60);
  assert.ok(stand.passes >= 3, `the interval kept asking (${stand.passes} passes)`);
  assert.deepEqual(passLinesIn(lines), [], "no pass wrote a line");
});

test("the Master working no group is said once, and once again when it holds one", async (t) => {
  const stand = standInLoop();
  stand.accounts = 0;
  const { lines, log } = collector();
  const process = supervise({ loop: stand.loop, intervalMs: 10, log });
  t.after(() => process.stop());
  await sleep(60);
  assert.equal(
    passLinesIn(lines).filter((line) => line.includes("works no group")).length,
    1,
    "idle is a state, said once and not once per ten seconds",
  );

  // The Master is added to a group in Stalwart's directory: the next pass works
  // it and says so once.
  stand.accounts = 1;
  await sleep(60);
  assert.equal(
    passLinesIn(lines).filter((line) => line.includes("works no group")).length,
    1,
    "and the idle line is not written again",
  );
  assert.equal(
    passLinesIn(lines).filter((line) => line.includes("works a group again")).length,
    1,
    "picking a group up is said once as well",
  );
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
  await waitFor(() => lines.some((line) => line.includes("another process holds")));
  // The peer's claim lapses (`CLAIM_TTL_MS`): the next pass is this process's.
  stand.held = false;
  await waitFor(() => lines.some((line) => line.includes("is this process's again")));
  // Then it stays said once: every later pass holds the claim and repeats it
  // never. A delay here cannot make the count too low, only confirm it settled.
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
