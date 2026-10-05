import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort, type MethodCall, responseOf } from "../testkit.js";

/**
 * The mock's compare-and-set, its FileNode change log and its clock.
 *
 * ADR 0003 gives the agent design no lock to take: every write that must not
 * lose a race carries the state it read as `ifInState` -- the lease on a
 * document, the expected-owner patch on a job -- so a mock that accepted any
 * token would leave every one of those paths untested. These pin the mock
 * behaviours the design rests on: a stale `ifInState` is refused with the
 * RFC's `stateMismatch`, each data type carries its own state, `FileNode/
 * changes` reports updates and destroys as well as creates, and the clock can
 * be moved by a test instead of being waited for.
 *
 * `MOCK_NOW` is set before the mock is imported, so the boot override is
 * exercised too.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_NOW = "2026-09-10T09:00:00Z";
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
const GROUP_ACCOUNT = "a3";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const HEADERS = { authorization: AUTH, "content-type": "application/json" };

async function jmap(methodCalls: unknown[], using?: string[]): Promise<MethodCall[]> {
  const res = await fetch(`${BASE}/jmap/`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      using: using ?? ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls,
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { methodResponses: MethodCall[] };
  return body.methodResponses;
}

/** Every node of an account, so a refused write can be shown to have left none. */
async function nodeNames(accountId: string): Promise<string[]> {
  const responses = await jmap([["FileNode/get", { accountId, ids: null }, "g"]]);
  const list = responseOf(responses, "g")[1].list as Array<{ name: string }>;
  return list.map((n) => n.name).sort();
}

async function createNode(
  accountId: string,
  name: string,
  ifInState?: string,
): Promise<MethodCall> {
  const responses = await jmap([
    [
      "FileNode/set",
      {
        accountId,
        ...(ifInState ? { ifInState } : {}),
        create: { n: { name, nodeType: "directory", parentId: null } },
      },
      "n",
    ],
  ]);
  return responseOf(responses, "n");
}

const createdId = (call: MethodCall): string =>
  (call[1].created as Record<string, { id: string }>).n!.id;

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the clock is what MOCK_NOW says, and moves on request", async () => {
  // The boot override: a node created now carries the fake instant, not the
  // wall clock the runner happens to sit at.
  const first = await createNode(ACCOUNT, "clock-a");
  assert.equal(first[0], "FileNode/set");
  const responses = await jmap([
    ["FileNode/get", { accountId: ACCOUNT, ids: [createdId(first)] }, "g"],
  ]);
  const stamped = String(
    (responseOf(responses, "g")[1].list as Array<{ created: string }>)[0]!.created,
  );
  assert.ok(
    stamped.startsWith("2026-09-10T09:00"),
    `a node created under MOCK_NOW carries that instant, got ${stamped}`,
  );

  // `{ now }` moves the mock's notion of now.
  const moved = await fetch(`${BASE}/mock/clock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ now: "2027-01-01T00:00:00Z" }),
  });
  assert.equal(moved.status, 200);
  assert.equal(((await moved.json()) as { now: string }).now, "2027-01-01T00:00:00.000Z");
  const second = await createNode(ACCOUNT, "clock-b");
  const after = await jmap([
    ["FileNode/get", { accountId: ACCOUNT, ids: [createdId(second)] }, "g"],
  ]);
  assert.ok(
    String(
      (responseOf(after, "g")[1].list as Array<{ created: string }>)[0]!.created,
    ).startsWith("2027-01-01T00:00"),
    "a node created after the move carries the moved instant",
  );

  // `{ advanceMs }` is relative to the mock's own now, not to the wall clock.
  const advanced = await fetch(`${BASE}/mock/clock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ advanceMs: 3_600_000 }),
  });
  {
    /* The mock's clock is an offset against real time, not a frozen instant,
       so it ticks between the two calls: the advance has to land an hour after
       the mock's own now, within the milliseconds this test takes. A clock
       advanced from the wall clock instead would land four months away. */
    const advancedAt = Date.parse(((await advanced.json()) as { now: string }).now);
    const expected = Date.parse("2027-01-01T01:00:00Z");
    assert.ok(
      advancedAt >= expected && advancedAt < expected + 1000,
      `an advance is relative to the mock's now, got ${new Date(advancedAt).toISOString()}`,
    );
  }

  // A body that asks for neither is refused rather than silently ignored.
  const bad = await fetch(`${BASE}/mock/clock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);
});

test("a stale ifInState is refused and a fresh one is applied", async () => {
  const accountId = GROUP_ACCOUNT;
  const read = await jmap([["FileNode/get", { accountId, ids: [] }, "g"]]);
  const state = String(responseOf(read, "g")[1].state);

  const fresh = await createNode(accountId, "cas-first", state);
  assert.equal(fresh[0], "FileNode/set", "the state that was read is accepted");
  const afterFirst = String(fresh[1].newState);
  assert.notEqual(afterFirst, state, "the set moves the FileNode state on");

  // Any write in the account moves the state, so the token read before it is
  // stale for everybody -- which is the whole concurrency primitive.
  const stale = await createNode(accountId, "cas-refused", state);
  assert.equal(stale[0], "error", "the call is what fails, not the object");
  assert.equal((stale[1] as { type: string }).type, "stateMismatch");

  const again = await createNode(accountId, "cas-second", afterFirst);
  assert.equal(again[0], "FileNode/set", "the state the set reported is accepted");

  // The refused write left nothing behind, and the two accepted ones are there.
  const names = await nodeNames(accountId);
  assert.equal(names.includes("cas-refused"), false);
  assert.ok(names.includes("cas-first"), "the first write landed");
  assert.ok(names.includes("cas-second"), "the write on the fresh state landed");
  assert.notEqual(createdId(again), "", "and it came back with an id");
});

test("every type carries its own state, so one type's write is not another's", async () => {
  const accountId = GROUP_ACCOUNT;
  const before = await jmap([
    ["Mailbox/get", { accountId, ids: null }, "m"],
    ["FileNode/get", { accountId, ids: [] }, "f"],
    ["Email/get", { accountId, ids: [] }, "e"],
  ]);
  const mailboxBefore = String(responseOf(before, "m")[1].state);
  const fileBefore = String(responseOf(before, "f")[1].state);
  const emailBefore = String(responseOf(before, "e")[1].state);
  assert.notEqual(
    mailboxBefore,
    fileBefore,
    "mail folders and files were never one counter: their states must differ",
  );
  assert.notEqual(emailBefore, fileBefore, "nor mail and its own FileNode state");

  const written = await jmap([
    [
      "FileNode/set",
      {
        accountId,
        create: { n: { name: "own-state", nodeType: "directory", parentId: null } },
      },
      "n",
    ],
    ["Mailbox/get", { accountId, ids: null }, "m"],
    ["FileNode/get", { accountId, ids: [] }, "f"],
  ]);
  assert.equal(responseOf(written, "n")[0], "FileNode/set");
  assert.equal(
    String(responseOf(written, "m")[1].state),
    mailboxBefore,
    "a file write leaves the Mailbox state where it was",
  );
  assert.notEqual(
    String(responseOf(written, "f")[1].state),
    fileBefore,
    "and moves the FileNode state",
  );

  // A Mailbox/set is judged against the Mailbox state, so the token read
  // before the file write is still fresh for it.
  const mail = await jmap([
    [
      "Mailbox/set",
      {
        accountId,
        ifInState: mailboxBefore,
        create: { p: { name: "Cas proves", parentId: "g-inbox" } },
      },
      "p",
    ],
    ["Mailbox/get", { accountId, ids: null }, "m"],
  ]);
  assert.ok(
    (responseOf(mail, "p")[1].created as Record<string, unknown>).p,
    "the folder is created",
  );
  const mailboxAfter = String(responseOf(mail, "m")[1].state);
  assert.notEqual(mailboxAfter, mailboxBefore);

  const stale = await jmap([
    [
      "Mailbox/set",
      {
        accountId,
        ifInState: mailboxBefore,
        create: { p: { name: "never", parentId: "g-inbox" } },
      },
      "p",
    ],
  ]);
  assert.equal(responseOf(stale, "p")[0], "error");
  assert.equal((responseOf(stale, "p")[1] as { type: string }).type, "stateMismatch");
});

test("x:AppPassword/set honours ifInState too, on its own registry state", async () => {
  const using = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"];
  const write = (ifInState: string, description: string): unknown[] => [
    "x:AppPassword/set",
    { accountId: ACCOUNT, ifInState, create: { a: { description } } },
    "a",
  ];
  const read = await jmap(
    [["x:AppPassword/get", { accountId: ACCOUNT, ids: null }, "g"]],
    using,
  );
  const state = String(responseOf(read, "g")[1].state);

  const ok = await jmap([write(state, "worker credential")], using);
  assert.equal(responseOf(ok, "a")[0], "x:AppPassword/set");
  const secret = (responseOf(ok, "a")[1].created as Record<string, { secret: string }>).a!
    .secret;
  assert.match(secret, /^\$app\$/, "an app password carries its credential id");

  const again = await jmap([write(state, "second")], using);
  assert.equal(responseOf(again, "a")[0], "error", "the earlier state is stale now");
  assert.equal((responseOf(again, "a")[1] as { type: string }).type, "stateMismatch");

  const after = await jmap(
    [["x:AppPassword/get", { accountId: ACCOUNT, ids: null }, "g"]],
    using,
  );
  const rows = responseOf(after, "g")[1].list as Array<{ description: string }>;
  assert.deepEqual(
    rows.map((r) => r.description),
    ["worker credential"],
    "the refused create added nothing",
  );
});

test("FileNode/changes reports an update and a destroy, not only a create", async () => {
  const accountId = GROUP_ACCOUNT;
  const created = await createNode(accountId, "changes-node");
  const id = createdId(created);
  const stateAfterCreate = String(created[1].newState);

  const renamed = await jmap([
    [
      "FileNode/set",
      { accountId, update: { [id]: { name: "changes-node-renamed" } } },
      "u",
    ],
  ]);
  const stateAfterUpdate = String(responseOf(renamed, "u")[1].newState);
  assert.notEqual(stateAfterUpdate, stateAfterCreate);

  const fromCreate = await jmap([
    ["FileNode/changes", { accountId, sinceState: stateAfterCreate }, "c"],
  ]);
  const seen = responseOf(fromCreate, "c")[1];
  assert.deepEqual(seen.updated, [id], "the update is reported");
  assert.deepEqual(seen.created, []);
  assert.equal(seen.newState, stateAfterUpdate);
  assert.equal(seen.hasMoreChanges, false);

  const destroyCall = await jmap([
    ["FileNode/set", { accountId, destroy: [id] }, "d"],
    ["FileNode/changes", { accountId, sinceState: stateAfterUpdate }, "c"],
  ]);
  assert.deepEqual(responseOf(destroyCall, "d")[1].destroyed, [id]);
  const gone = responseOf(destroyCall, "c")[1];
  assert.deepEqual(gone.destroyed, [id], "the destroy is reported");
  assert.deepEqual(gone.updated, []);
  assert.equal(gone.newState, String(responseOf(destroyCall, "d")[1].newState));
  assert.equal(gone.hasMoreChanges, false);

  // A second ask from the state it was handed is empty: the anchor advanced.
  const empty = await jmap([
    ["FileNode/changes", { accountId, sinceState: String(gone.newState) }, "c"],
  ]);
  const after = responseOf(empty, "c")[1];
  assert.deepEqual(after.created, []);
  assert.deepEqual(after.updated, []);
  assert.deepEqual(after.destroyed, []);

  const read = await jmap([["FileNode/get", { accountId, ids: [id] }, "g"]]);
  assert.deepEqual(responseOf(read, "g")[1].notFound, [id], "and it is really gone");
});

test("Email/set refuses a stale state as well", async () => {
  const accountId = GROUP_ACCOUNT;
  const read = await jmap([["Email/get", { accountId, ids: [] }, "g"]]);
  const state = String(responseOf(read, "g")[1].state);

  const ok = await jmap([
    ["Email/set", { accountId, update: { ge1: { keywords: { $seen: true } } } }, "s"],
  ]);
  assert.equal(responseOf(ok, "s")[0], "Email/set");
  const after = String(responseOf(ok, "s")[1].newState);

  const stale = await jmap([
    ["Email/set", { accountId, ifInState: state, update: { ge1: {} } }, "s"],
  ]);
  assert.equal(responseOf(stale, "s")[0], "error");
  assert.equal((responseOf(stale, "s")[1] as { type: string }).type, "stateMismatch");

  const fresh = await jmap([
    ["Email/set", { accountId, ifInState: after, update: { ge1: {} } }, "s"],
  ]);
  assert.equal(
    responseOf(fresh, "s")[0],
    "Email/set",
    "the state the set reported is accepted",
  );
});

/*
 * The one behaviour here that is the mock's answer rather than a rule it was
 * given: an upload writes a blob and no node, so it leaves the state tokens
 * alone. Point (d) of the owed probe in `checkIfInState` asks a real server the
 * same question -- the production write path uploads after reading the token
 * and before the conditional write, so a server that moved the token on upload
 * would refuse every conditional write the agent makes. Pinning the choice here
 * means a change to the mock's answers is a failing test, not a silent edit.
 */
test("an upload does not move the FileNode state the mock hands out", async () => {
  const accountId = GROUP_ACCOUNT;
  const before = String(
    responseOf(await jmap([["FileNode/get", { accountId, ids: [] }, "g"]]), "g")[1].state,
  );
  const res = await fetch(`${BASE}/jmap/upload/${accountId}/`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "text/plain" },
    body: "a blob, not a node",
  });
  assert.equal(res.status, 200);
  const uploaded = (await res.json()) as { blobId: string };
  assert.ok(uploaded.blobId, "the upload answers with a blob id");

  const after = String(
    responseOf(await jmap([["FileNode/get", { accountId, ids: [] }, "g"]]), "g")[1].state,
  );
  assert.equal(after, before, "uploading a blob leaves the FileNode state where it was");

  const write = await jmap([
    [
      "FileNode/set",
      {
        accountId,
        ifInState: before,
        create: { u1: { name: "after-upload.json", parentId: null } },
      },
      "s",
    ],
  ]);
  assert.equal(
    responseOf(write, "s")[0],
    "FileNode/set",
    "the token read before the upload is still accepted after it",
  );
});
