import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { postWith } from "../testkit.js";

/**
 * What the mock answers for a query's total, which is the one number the
 * sidebar's counts are made of.
 *
 * The client's arithmetic for a write it just made (`keywordCountDelta`) moves
 * the sidebar's numbers the way the server counts them: `Email/query` with
 * `calculateTotal` and **`collapseThreads`**, where one conversation is one.
 * That is an assumption about the server standing behind every count, so it is
 * pinned here, next to the simulation that stands in for Stalwart — a thread of
 * several messages is one total collapsed and several uncollapsed, and the
 * totals the mock reports agree with the ids it answers.
 *
 * Mock port: must not collide with any other test file — the runner executes
 * files as parallel child processes, each binding its own mock.
 */

const PORT = 18901;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-query-totals";

const mock = await import("./index.js");
const { createApp } = await import("../app.js");

const app = createApp();
let cookie = "";

const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

type Body = ReturnType<typeof JSON.parse>;

async function call(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Body }> {
  const res = await app.request(path, {
    ...init,
    headers: {
      ...HEADERS,
      ...(init.headers as Record<string, string>),
      ...(cookie ? { cookie } : {}),
    },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const post = postWith(call);

type MethodCall = [string, Record<string, unknown>, string];

/** One `Email/query` total, asked the way the sidebar asks for its numbers. */
async function total(filter: unknown, collapseThreads: boolean): Promise<number> {
  const res = await post("/api/jmap", {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/query",
        { accountId: "a1", filter, collapseThreads, limit: 0, calculateTotal: true },
        "q",
      ],
    ],
  });
  assert.equal(res.status, 200, "Email/query should answer");
  const q = (res.body?.methodResponses as MethodCall[] | undefined)?.find(
    (r) => r[2] === "q",
  );
  assert.ok(q, "Email/query should answer");
  return (q[1] as { total?: number }).total ?? 0;
}

before(async () => {
  const res = await post("/api/auth/login", {
    username: "demo@example.com",
    password: "demo-password",
  });
  assert.equal(res.status, 200, "login should succeed against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a conversation counts once collapsed, and once per message uncollapsed", async () => {
  const filter = { inMailbox: "inbox" };
  const collapsed = await total(filter, true);
  const uncollapsed = await total(filter, false);

  // The mock's inbox holds a conversation of several messages, so the two
  // readings cannot agree: that difference *is* the thread collapsing.
  assert.ok(
    collapsed < uncollapsed,
    `the inbox holds a thread of several messages (collapsed ${collapsed}, uncollapsed ${uncollapsed})`,
  );

  // And each total is the number of ids the same query answers with, which is
  // what makes `limit: 0, calculateTotal: true` a count of rows and not of
  // something else the client would then be moving the wrong way.
  for (const [collapseThreads, expected] of [
    [true, collapsed],
    [false, uncollapsed],
  ] as const) {
    const res = await post("/api/jmap", {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        ["Email/query", { accountId: "a1", filter, collapseThreads, limit: 500 }, "q"],
      ],
    });
    const q = ((res.body?.methodResponses ?? []) as MethodCall[]).find(
      (r) => r[2] === "q",
    )!;
    assert.equal(
      (q[1] as { ids: string[] }).ids.length,
      expected,
      "the total agrees with the ids at the same collapsing",
    );
  }
});

test("a keyword's total moves when one message of a conversation is written", async () => {
  /*
   * The exact shape the sidebar lives on: starring messages *inside* a
   * conversation moves the conversation's total by one, not by the number of
   * messages starred -- which is what the client's optimistic move mirrors.
   */
  const filter = { hasKeyword: "$flagged" };

  const send = (methodCalls: MethodCall[]) =>
    post("/api/jmap", {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls,
    });
  const answer = async (
    methodCalls: MethodCall[],
    id: string,
  ): Promise<Record<string, unknown>> => {
    const r = (
      ((await send(methodCalls)).body?.methodResponses ?? []) as MethodCall[]
    ).find((x) => x[2] === id);
    assert.ok(r, `${methodCalls[0]![0]} should answer`);
    return r[1];
  };
  /** Whether any of these messages carries the keyword. */
  const carries = async (ids: string[]): Promise<boolean> => {
    const got = await answer(
      [["Email/get", { accountId: "a1", ids, properties: ["keywords"] }, "e"]],
      "e",
    );
    return (got.list as Array<{ keywords: Record<string, boolean> }>).some(
      (x) => x.keywords.$flagged,
    );
  };
  const setStarred = (ids: string[], on: boolean) =>
    answer(
      [
        [
          "Email/set",
          {
            accountId: "a1",
            update: Object.fromEntries(
              ids.map((id) => [id, { "keywords/$flagged": on ? true : null }]),
            ),
          },
          "s",
        ],
      ],
      "s",
    );

  /*
   * The newest row of the inbox that is a conversation: what a reader stars
   * when they star a row with conversation view on.
   */
  const rows = await answer(
    [
      [
        "Email/query",
        {
          accountId: "a1",
          filter: { inMailbox: "inbox" },
          collapseThreads: true,
          limit: 50,
        },
        "q",
      ],
    ],
    "q",
  );
  let emails: string[] = [];
  for (const row of (rows.ids as string[]) ?? []) {
    const one = await answer(
      [["Email/get", { accountId: "a1", ids: [row], properties: ["threadId"] }, "e"]],
      "e",
    );
    const threadId = (one.list as Array<{ threadId: string }>)[0]!.threadId;
    const t = await answer(
      [["Thread/get", { accountId: "a1", ids: [threadId] }, "t"]],
      "t",
    );
    const ids = (t.list as Array<{ emailIds: string[] }>)[0]!.emailIds;
    if (ids.length > 1) {
      emails = ids;
      break;
    }
  }
  assert.ok(emails.length > 1, "the inbox holds a conversation of several messages");

  /*
   * From nothing starred in it, so the move is the whole of what is asserted:
   * whatever the fixture holds, the conversation starts outside the count.
   */
  await setStarred(emails, false);
  const cleared = await total(filter, true);
  const clearedUncollapsed = await total(filter, false);
  assert.equal(await carries(emails), false, "the conversation starts unstarred");

  const s = await setStarred(emails, true);
  assert.equal(
    Object.keys((s.updated as object) ?? {}).length,
    emails.length,
    "every message of the conversation took the star",
  );

  assert.equal(
    await total(filter, true),
    cleared + 1,
    "a conversation whose messages all carry the keyword is one",
  );
  assert.equal(
    await total(filter, false),
    clearedUncollapsed + emails.length,
    "and one per message when the sidebar counts messages",
  );
});
