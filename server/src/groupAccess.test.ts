/**
 * The group classifier's one line, said once per state (ADR 0005).
 *
 * The classifier probes each candidate on **every** pass — the groups are
 * resolved afresh every ten seconds (`agent/supervisor.ts`) — so an account the
 * mail store cannot be asked about is a state of the installation rather than an
 * event, and the same sentence six times a minute is a sentence nobody reads.
 * What is pinned here is the deduplication itself and what it must not swallow:
 * another account's failure is its own line, and an account that answers again
 * and then breaks is a state that began again, and is said again.
 *
 * The stub stands in for the mail store, so "it answers" and "it refuses" are
 * the two things a probe can meet and nothing else.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import type { Ctx } from "./appFolder.js";
import { freePort } from "./testkit.js";
import type { UpstreamSession } from "./upstream.js";

const PORT = await freePort();
process.env.APP_SECRET = "a-test-secret-for-group-access";
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = "Basic YWdlbnRAZXhhbXBsZS5jb206YS1wYXNzd29yZA==";

/** Which account ids the stub answers with a folder tree, and which it refuses. */
let answersFor: (accountId: string) => boolean = () => true;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const body = JSON.parse(raw) as {
    methodCalls?: Array<[string, Record<string, unknown>, string]>;
  };
  const call = body.methodCalls?.[0];
  const accountId = String(call?.[1].accountId ?? "");
  const callId = call?.[2] ?? "r";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      methodResponses: [
        answersFor(accountId)
          ? [
              "Mailbox/get",
              {
                accountId,
                state: "1",
                list: [{ id: "mb-1", name: "Inbox", role: "inbox" }],
              },
              callId,
            ]
          : [
              "error",
              { type: "serverFail", description: "the account cannot be read" },
              callId,
            ],
      ],
    }),
  );
}

const stub = createServer((req, res) => {
  void answer(req, res);
});

before(async () => {
  await new Promise<void>((resolve) => stub.listen(PORT, "127.0.0.1", resolve));
});

after(() => {
  stub.close();
});

const { groupAccountsDetailed } = await import("./groupAccess.js");

/** A session whose candidates are the accounts given: id, then the name it answers as. */
function agentCtx(candidates: Record<string, string>): Ctx {
  const accounts: Record<string, unknown> = {};
  for (const [accountId, name] of Object.entries(candidates))
    accounts[accountId] = { name: `${name}@example.com`, isPersonal: false };
  return {
    authorization: AUTH,
    username: "agent@example.com",
    session: {
      apiUrl: `${BASE}/jmap/`,
      baseUrl: BASE,
      accounts,
    } as unknown as UpstreamSession,
  };
}

/** What the probe line said while `run` was making its pass. */
async function said<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((one) => String(one)).join(" "));
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.warn = real;
  }
}

test("an account the mail store cannot answer about is named once, and not on the pass after it", async () => {
  answersFor = () => false;
  const ctx = agentCtx({ "broken-one": "broken-one" });

  const first = await said(() => groupAccountsDetailed(ctx));
  assert.deepEqual(
    first.result.unreadable,
    ["broken-one@example.com"],
    "the account is not served as a group",
  );
  assert.equal(first.lines.length, 1, "the reason is said once");
  assert.match(first.lines[0] ?? "", /could not probe the account broken-one/);
  assert.match(
    first.lines[0] ?? "",
    /the account cannot be read/,
    "and it carries the mail store's own words",
  );

  const again = await said(() => groupAccountsDetailed(ctx));
  assert.deepEqual(
    again.result.unreadable,
    ["broken-one@example.com"],
    "the pass asks again",
  );
  assert.deepEqual(again.lines, [], "and says nothing while the answer is the same");
  const third = await said(() => groupAccountsDetailed(ctx));
  assert.deepEqual(third.lines, [], "however many passes go by");
});

test("another account's failure is its own line", async () => {
  answersFor = (accountId) => accountId === "ok-two";
  const ctx = agentCtx({ "ok-two": "ok-two", "broken-two": "broken-two" });

  const pass = await said(() => groupAccountsDetailed(ctx));
  assert.deepEqual(
    [...pass.result.groups.keys()],
    ["ok-two@example.com"],
    "the account that answers is the group",
  );
  assert.deepEqual(
    pass.result.unreadable,
    ["broken-two@example.com"],
    "and the one that cannot be read is named",
  );
  assert.equal(
    pass.lines.length,
    1,
    "one line, for the one account that is new to the state",
  );
  assert.match(pass.lines[0] ?? "", /could not probe the account broken-two/);
});

test("an account that answers again and breaks again is said again", async () => {
  answersFor = () => false;
  const ctx = agentCtx({ "broken-three": "broken-three" });

  const first = await said(() => groupAccountsDetailed(ctx));
  assert.equal(first.lines.length, 1, "the state begins with a line");

  // The account answers again: the state is over, and the line is owed again if
  // it ever comes back.
  answersFor = () => true;
  const healthy = await said(() => groupAccountsDetailed(ctx));
  assert.deepEqual(
    [...healthy.result.groups.keys()],
    ["broken-three@example.com"],
    "it is a group again",
  );
  assert.deepEqual(healthy.lines, [], "and nothing is said while it answers");

  answersFor = () => false;
  const brokenAgain = await said(() => groupAccountsDetailed(ctx));
  assert.equal(
    brokenAgain.lines.length,
    1,
    "the failure that begins a new state is said, however often it has been said before",
  );
});
