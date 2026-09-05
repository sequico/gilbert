import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The mock models a group (team) mailbox the demo user is a member of: an extra
 * non-personal account that answers with its own folder tree, messages and
 * identity. This pins the mock's half of the group-mailbox feature so the
 * client can be built against it.
 */

const PORT = 18798;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-group-mailbox";

const mock = await import("./index.js");
const { createApp } = await import("../app.js");

const app = createApp();
let cookie = "";

const HEADERS = { "content-type": "application/json", "x-requested-with": "ihasmail" };

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

const post = (path: string, body: unknown) =>
  call(path, { method: "POST", body: JSON.stringify(body) });

type MethodCall = [string, Record<string, unknown>, string];

function responseOf(body: Body, callId: string): MethodCall | undefined {
  const responses = body?.methodResponses as MethodCall[] | undefined;
  return responses?.find((r) => r[2] === callId);
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

test("the session lists the group account alongside the personal one", async () => {
  const res = await call("/api/auth/session");
  assert.equal(res.status, 200);
  const group = res.body.accounts?.a3 as
    | { isPersonal?: boolean; name?: string }
    | undefined;
  assert.ok(group, "the group account should be present in the session");
  assert.equal(group.isPersonal, false);
  assert.equal(group.name, "team@example.org");
});

test("Mailbox/get on the group returns its own folder tree, not the reader's", async () => {
  const res = await post("/api/jmap", {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [["Mailbox/get", { accountId: "a3", ids: null }, "m"]],
  });
  assert.equal(res.status, 200);
  const m = responseOf(res.body, "m");
  assert.ok(m, "Mailbox/get should answer");
  const list = m[1].list as Array<{ id: string; role: string | null }>;
  assert.deepEqual(list.map((x) => x.id).sort(), ["g-inbox", "g-sent"]);
  assert.equal(list.find((x) => x.id === "g-inbox")?.role, "inbox");
});

test("Email/query on the group returns the group's messages", async () => {
  const res = await post("/api/jmap", {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/query",
        { accountId: "a3", filter: { inMailbox: "g-inbox" }, limit: 50 },
        "q",
      ],
    ],
  });
  assert.equal(res.status, 200);
  const q = responseOf(res.body, "q");
  assert.ok(q, "Email/query should answer");
  const ids = q[1].ids as string[];
  assert.equal(ids.length, 2, "the group inbox holds the welcome plus one more");
  assert.ok(ids.includes("ge1"), "the welcome message is among them");
});

test("Email/query on the group's Sent returns the team's sent message", async () => {
  const res = await post("/api/jmap", {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/query",
        { accountId: "a3", filter: { inMailbox: "g-sent" }, limit: 50 },
        "q",
      ],
    ],
  });
  assert.equal(res.status, 200);
  const q = responseOf(res.body, "q");
  assert.ok(q, "Email/query should answer");
  assert.equal((q[1].ids as string[]).length, 1);
});

test("the directory lists a group principal for the team", async () => {
  const res = await post("/api/jmap", {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:principals"],
    methodCalls: [["Principal/get", { accountId: "a1", ids: ["pr-team"] }, "g"]],
  });
  assert.equal(res.status, 200);
  const g = responseOf(res.body, "g");
  assert.ok(g, "Principal/get should answer");
  const list = g[1].list as Array<{ id: string; type: string; email: string | null }>;
  assert.equal(list[0]?.id, "pr-team");
  assert.equal(list[0]?.type, "group");
  assert.equal(list[0]?.email, "team@example.org");
});

test("a folder-share account answers Mailbox/get with no mail", async () => {
  const res = await post("/api/jmap", {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [["Mailbox/get", { accountId: "a2", ids: null }, "m"]],
  });
  assert.equal(res.status, 200);
  const m = responseOf(res.body, "m");
  assert.ok(m, "Mailbox/get should answer");
  // A person who shared calendars, address books and files is not a mailbox
  // the reader can open; only the group account carries mail. The client's
  // "mailbox accounts" probe keys off exactly this.
  assert.deepEqual(m[1].list, []);
});

test("Identity/get on the group returns the team identity", async () => {
  const res = await post("/api/jmap", {
    using: [
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
      "urn:ietf:params:jmap:submission",
    ],
    methodCalls: [["Identity/get", { accountId: "a3", ids: null }, "i"]],
  });
  assert.equal(res.status, 200);
  const i = responseOf(res.body, "i");
  assert.ok(i, "Identity/get should answer");
  const list = i[1].list as Array<{ id: string; email: string }>;
  assert.deepEqual(
    list.map((x) => ({ id: x.id, email: x.email })),
    [{ id: "gi1", email: "team@example.org" }],
  );
});

test("Email/set on the group marks its own message read and recounts", async () => {
  const res = await post("/api/jmap", {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/set",
        {
          accountId: "a3",
          update: { ge1: { keywords: { $seen: true } } },
        },
        "s",
      ],
      ["Mailbox/get", { accountId: "a3", ids: ["g-inbox"] }, "m"],
    ],
  });
  assert.equal(res.status, 200);
  const s = responseOf(res.body, "s");
  assert.ok(s, "Email/set should answer");
  assert.deepEqual(Object.keys(s[1].updated ?? {}), ["ge1"]);
  const m = responseOf(res.body, "m");
  assert.ok(m, "Mailbox/get should answer");
  const inbox = (
    m[1].list as Array<{ id: string; totalEmails: number; unreadEmails: number }>
  )[0];
  assert.equal(inbox?.id, "g-inbox");
  // Two in the inbox, one of them (ge1) just marked read.
  assert.equal(inbox?.totalEmails, 2);
  assert.equal(inbox?.unreadEmails, 1);
});

test("Email/set on the folder-share account cannot touch group mail", async () => {
  const res = await post("/api/jmap", {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/set",
        {
          accountId: "a2",
          update: { ge1: { keywords: { $seen: false } } },
        },
        "s",
      ],
    ],
  });
  assert.equal(res.status, 200);
  const s = responseOf(res.body, "s");
  assert.ok(s, "Email/set should answer");
  // a2 holds no mail of its own, so the group message is not reachable there.
  assert.deepEqual(s[1].updated, {});
});
