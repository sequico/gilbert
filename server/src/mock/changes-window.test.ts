import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort } from "../testkit.js";

/**
 * A `sinceState` older than the change log's window.
 *
 * A real server keeps a bounded window of changes per type and account, and a
 * client that fell further behind than the window reaches is refused
 * `cannotCalculateChanges` -- which is the answer the mail store recovers from,
 * by dropping its token and reading from the state the server hands it
 * (`applyChanges` in `web/src/store/mail/`). A log that answers the window it
 * still holds as though it were the whole change set, with
 * `hasMoreChanges: false`, loses every change in between while telling the
 * client nothing is missing, and leaves that recovery path unexercised here.
 *
 * Pinned so a log that stops distinguishing "nothing changed" from "the changes
 * are gone" fails this file.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_DEMO = "1";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const HEADERS = { authorization: AUTH, "content-type": "application/json" };

type MethodCall = [string, Record<string, unknown>, string];

async function jmap(methodCalls: unknown[]): Promise<MethodCall[]> {
  const res = await fetch(`${BASE}/jmap/`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls,
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { methodResponses: MethodCall[] };
  return body.methodResponses;
}

const responseOf = (responses: MethodCall[], id: string): MethodCall => {
  const found = responses.find((r) => r[2] === id);
  assert.ok(found, `${id} should answer`);
  return found;
};

/** The account's Email state, as a client records it before it reads changes. */
async function emailState(): Promise<string> {
  const answer = responseOf(
    await jmap([["Email/get", { accountId: ACCOUNT, ids: [] }, "g"]]),
    "g",
  )[1] as { state?: unknown };
  assert.equal(typeof answer.state, "string");
  return answer.state as string;
}

/** One message delivered, which is one entry in the Email change log. */
async function addEmail(subject: string): Promise<string> {
  const answer = responseOf(
    await jmap([
      [
        "Email/set",
        {
          accountId: ACCOUNT,
          create: { c: { subject, mailboxIds: { inbox: true } } },
        },
        "s",
      ],
    ]),
    "s",
  )[1] as { newState: string };
  return answer.newState;
}

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a sinceState past the change log's window is refused, not answered", async () => {
  const before = await emailState();
  const firstState = await addEmail("filler 0");
  // Past the window's 200 entries, so what the log still holds no longer
  // reaches back to `before`.
  for (let i = 1; i < 201; i++) await addEmail(`filler ${i}`);
  const after = await emailState();

  const stale = responseOf(
    await jmap([
      ["Email/changes", { accountId: ACCOUNT, sinceState: before, maxChanges: 500 }, "c"],
    ]),
    "c",
  );
  assert.equal(stale[0], "error", "a caller behind the window is refused");
  assert.equal(
    (stale[1] as { type: string }).type,
    "cannotCalculateChanges",
    "and the refusal is the one the client recovers from",
  );

  // The state the first change left is still inside the window: the change
  // recorded at it is the one that fell out, not the ones after it.
  const answerable = responseOf(
    await jmap([
      [
        "Email/changes",
        { accountId: ACCOUNT, sinceState: firstState, maxChanges: 500 },
        "a",
      ],
    ]),
    "a",
  );
  assert.equal(answerable[0], "Email/changes", "a caller inside the window is answered");
  assert.equal(
    (answerable[1] as { created: string[] }).created.length,
    200,
    "and is handed what the window still holds",
  );

  const current = responseOf(
    await jmap([
      ["Email/changes", { accountId: ACCOUNT, sinceState: after, maxChanges: 500 }, "n"],
    ]),
    "n",
  );
  assert.equal(current[0], "Email/changes");
  assert.deepEqual(
    (current[1] as { created: string[]; hasMoreChanges: boolean }).created,
    [],
  );
  assert.equal((current[1] as { hasMoreChanges: boolean }).hasMoreChanges, false);
});
