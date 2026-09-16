import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * The agent fixture (ADR 0003): the principal the worker authenticates as, and
 * the reach it is supposed to have.
 *
 * The ADR's live probes fix what a real 0.16.21 server shows for this identity
 * (resolutions 12 and 14, 2026-09-10): the agent's session lists the group's
 * account with `isPersonal: false`, its `myRights` on the group's mailboxes
 * include `maySubmit`, it reads and writes the group's own Files, and a
 * submission with the group's own identity files itself in the group's Sent.
 * The mock reproduces each of those, because a fixture missing the grant would
 * leave every agent test passing against nothing at all. What it does not
 * reproduce is recorded where it matters -- in the mock itself.
 *
 * Mock port: must not collide with any other test file -- the runner executes
 * files as parallel child processes, each binding its own mock.
 */

const PORT = 18842;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_AGENT_ADDRESS = "gilbert@example.com";
process.env.MOCK_AGENT_PASSWORD = "gilbert-password";
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = "gilbert@example.com";
const AGENT_PASS = "gilbert-password";
const GROUP_ACCOUNT = "a3";
const GROUP_INBOX = "g-inbox";
const GROUP_SENT = "g-sent";
const GROUP_IDENTITY = "gi1";

const AGENT_AUTH = `Basic ${Buffer.from(`${AGENT}:${AGENT_PASS}`).toString("base64")}`;
const CORE = "urn:ietf:params:jmap:core";
const FILENODE = "urn:ietf:params:jmap:filenode";
const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";

type MethodCall = [string, Record<string, unknown>, string];
type Obj = Record<string, unknown>;

/** The agent's own session, as the worker derives it at boot. */
async function agentSession(): Promise<{
  username: string;
  accounts: Record<string, { name: string; isPersonal: boolean }>;
  primaryAccounts: Record<string, string>;
}> {
  const res = await fetch(`${BASE}/.well-known/jmap`, {
    headers: { authorization: AGENT_AUTH },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Awaited<ReturnType<typeof agentSession>>;
}

async function jmap(
  authorization: string,
  using: string[],
  methodCalls: unknown[],
): Promise<MethodCall[]> {
  const res = await fetch(`${BASE}/jmap/`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ using, methodCalls }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { methodResponses: MethodCall[] };
  return body.methodResponses;
}

function responseOf(responses: MethodCall[], callId: string): MethodCall {
  const found = responses.find((r) => r[2] === callId);
  assert.ok(found, `${callId} should answer`);
  return found;
}

const createdId = (call: MethodCall, key: string): string =>
  (call[1].created as Record<string, { id: string }>)[key]!.id;

async function upload(authorization: string, text: string): Promise<string> {
  const res = await fetch(`${BASE}/jmap/upload/${GROUP_ACCOUNT}/`, {
    method: "POST",
    headers: { authorization, "content-type": "message/rfc822" },
    body: text,
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { blobId: string }).blobId;
}

/** The account's FileNode state, the token a conditional write carries. */
async function fileNodeState(authorization: string): Promise<string> {
  const responses = await jmap(
    authorization,
    [CORE, FILENODE],
    [["FileNode/get", { accountId: GROUP_ACCOUNT, ids: [] }, "s"]],
  );
  return String(responseOf(responses, "s")[1].state);
}

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the agent signs in as itself and its session lists the group it was granted", async () => {
  const session = await agentSession();
  assert.equal(session.username, AGENT, "the session is the agent's own");

  const group = session.accounts[GROUP_ACCOUNT];
  assert.ok(group, "the group account must be in the agent's session");
  assert.equal(group.isPersonal, false, "a grant is never a personal account");
  assert.equal(group.name, "team@example.org");

  // Its own account is the personal one, and the account somebody shared with
  // the demo user is not in here at all: a grant on a group is not a share.
  const own = session.primaryAccounts[FILENODE]!;
  assert.equal(session.accounts[own]!.isPersonal, true);
  assert.deepEqual(
    Object.keys(session.accounts).sort(),
    [own, GROUP_ACCOUNT, "a5"].sort(),
    // a3 is team@example.org, a5 is design@example.org: the agent holds its
    // own account and the groups it was granted on, nothing else.
  );
});

test("the group's mailboxes answer the agent with maySubmit", async () => {
  const responses = await jmap(
    AGENT_AUTH,
    [CORE, MAIL],
    [["Mailbox/get", { accountId: GROUP_ACCOUNT, ids: null }, "m"]],
  );
  const list = responseOf(responses, "m")[1].list as Array<{
    id: string;
    role: string | null;
    myRights: Record<string, boolean>;
  }>;
  assert.deepEqual(
    list.map((m) => m.id).sort(),
    [GROUP_INBOX, GROUP_SENT],
    "the group answers with a real tree -- that is what makes it a mailbox",
  );
  const inbox = list.find((m) => m.id === GROUP_INBOX)!;
  assert.equal(inbox.role, "inbox");
  assert.equal(
    inbox.myRights.maySubmit,
    true,
    "a group agent sends as the group: maySubmit is the signal (ADR 0003)",
  );
  assert.equal(inbox.myRights.mayAddItems, true);
  assert.equal(inbox.myRights.maySetKeywords, true, "labels are what agent work rides");
});

test("the agent writes its own app folder into the group's account, conditionally", async () => {
  const using = [CORE, FILENODE];
  const ownAccount = (await agentSession()).primaryAccounts[FILENODE]!;
  const state = await fileNodeState(AGENT_AUTH);

  /*
   * The group account already carries a `gilbert` folder of its own (the
   * identity assignments live in it), and a create of a name a sibling holds is
   * refused `alreadyExists` -- so this asks for the folder the way production
   * does, take it if it is there and make it if it is not.
   */
  const existing = await jmap(AGENT_AUTH, using, [
    [
      "FileNode/query",
      { accountId: GROUP_ACCOUNT, filter: { isTopLevel: true }, limit: 1000 },
      "q",
    ],
  ]);
  const topIds = responseOf(existing, "q")[1].ids as string[];
  const top = await jmap(AGENT_AUTH, using, [
    [
      "FileNode/get",
      { accountId: GROUP_ACCOUNT, ids: topIds, properties: ["id", "name", "nodeType"] },
      "g",
    ],
  ]);
  const found = (
    responseOf(top, "g")[1].list as Array<{ id: string; name: string; nodeType: string }>
  ).find((n) => n.nodeType === "directory" && n.name === "gilbert");
  assert.ok(found, "the group's own gilbert folder is there to be found, not made");
  const appId = found.id;

  // The normal path builds the folder the store writes into, on demand.
  const dir = await jmap(AGENT_AUTH, using, [
    [
      "FileNode/set",
      {
        accountId: GROUP_ACCOUNT,
        create: { agent: { name: "agent", nodeType: "directory", parentId: appId } },
      },
      "a",
    ],
  ]);
  assert.equal(responseOf(dir, "a")[0], "FileNode/set");
  const agentDir = createdId(responseOf(dir, "a"), "agent");

  /*
   * The token read before that write is stale now, and a conditional write
   * carrying it is refused: this is the write that would have overwritten
   * somebody else's work.
   */
  const stale = await jmap(AGENT_AUTH, using, [
    [
      "FileNode/set",
      {
        accountId: GROUP_ACCOUNT,
        ifInState: state,
        create: { later: { name: "later", nodeType: "directory", parentId: appId } },
      },
      "l",
    ],
  ]);
  assert.equal(responseOf(stale, "l")[0], "error");
  assert.equal((responseOf(stale, "l")[1] as { type: string }).type, "stateMismatch");

  /*
   * And the refusal a second worker gets for that same folder, which is the
   * answer `ensureChildFolder` reads as "somebody made it while you were
   * deciding" rather than as a failure. A mock that let the second create
   * through would leave that branch untested here and broken on a real server.
   */
  const again = await jmap(AGENT_AUTH, using, [
    [
      "FileNode/set",
      {
        accountId: GROUP_ACCOUNT,
        create: { agent: { name: "agent", nodeType: "directory", parentId: appId } },
      },
      "a",
    ],
  ]);
  const refused = responseOf(again, "a")[1].notCreated as Record<
    string,
    { type: string; existingId?: string }
  >;
  assert.equal(refused.agent!.type, "alreadyExists");
  assert.equal(
    refused.agent!.existingId,
    agentDir,
    "and it names the folder that is there",
  );

  const blobId = await upload(AGENT_AUTH, '{"v":1}');
  const doc = await jmap(AGENT_AUTH, using, [
    [
      "FileNode/set",
      {
        accountId: GROUP_ACCOUNT,
        create: {
          f: {
            parentId: agentDir,
            name: "config.json",
            nodeType: "file",
            blobId,
            type: "application/json",
          },
        },
      },
      "f",
    ],
  ]);
  const docId = createdId(responseOf(doc, "f"), "f");

  const read = await jmap(AGENT_AUTH, using, [
    ["FileNode/get", { accountId: GROUP_ACCOUNT, ids: [docId] }, "g"],
    ["FileNode/get", { accountId: ownAccount, ids: [appId] }, "own"],
  ]);
  const file = (responseOf(read, "g")[1].list as Array<Record<string, unknown>>)[0]!;
  assert.equal(file.name, "config.json");
  assert.equal(file.parentId, agentDir);
  assert.deepEqual(
    responseOf(read, "own")[1].notFound,
    [appId],
    "the agent's own account is not where the group's folder lives",
  );
});

test("mail landing in the group's inbox is visible to query, get and changes", async () => {
  const using = [CORE, MAIL];
  const before = await jmap(AGENT_AUTH, using, [
    ["Email/get", { accountId: GROUP_ACCOUNT, ids: [] }, "g"],
  ]);
  const stateBefore = String(responseOf(before, "g")[1].state);

  const raw =
    "Subject: Invoice 2203 needs filing\r\n" +
    "From: Finance Team <finance@example.org>\r\n" +
    "To: Team <team@example.org>\r\n" +
    "Cc: Ada Lovelace <ada@example.org>\r\n" +
    "Message-ID: <inv-2203@example.org>\r\n" +
    "\r\nThe quarterly invoice is attached. Please file it.\r\n";
  const blobId = await upload(AGENT_AUTH, raw);

  const imported = await jmap(AGENT_AUTH, using, [
    [
      "Email/import",
      {
        accountId: GROUP_ACCOUNT,
        emails: {
          m: { blobId, mailboxIds: { [GROUP_INBOX]: true }, keywords: {} },
        },
      },
      "i",
    ],
  ]);
  assert.equal(responseOf(imported, "i")[0], "Email/import");
  const emailId = createdId(responseOf(imported, "i"), "m");

  // A JMAP filter finds it -- which is all a rule has to work with.
  const found = await jmap(AGENT_AUTH, using, [
    [
      "Email/query",
      {
        accountId: GROUP_ACCOUNT,
        filter: {
          operator: "AND",
          conditions: [
            { inMailbox: GROUP_INBOX },
            { text: "quarterly invoice" },
            { from: "finance@example.org" },
          ],
        },
        limit: 50,
      },
      "q",
    ],
    [
      "Email/query",
      {
        accountId: GROUP_ACCOUNT,
        filter: { inMailbox: GROUP_INBOX, body: "please file it" },
        limit: 50,
      },
      "qb",
    ],
  ]);
  assert.ok((responseOf(found, "q")[1].ids as string[]).includes(emailId));
  assert.ok(
    (responseOf(found, "qb")[1].ids as string[]).includes(emailId),
    "a body filter matches the message text",
  );

  // And it carries the properties a filter or a mail view reads.
  const got = await jmap(AGENT_AUTH, using, [
    [
      "Email/get",
      {
        accountId: GROUP_ACCOUNT,
        ids: [emailId],
        properties: [
          "mailboxIds",
          "keywords",
          "receivedAt",
          "size",
          "subject",
          "from",
          "to",
          "cc",
          "preview",
          "textBody",
        ],
      },
      "g",
    ],
  ]);
  const email = (responseOf(got, "g")[1].list as Array<Record<string, never>>)[0]!;
  assert.equal(email.subject, "Invoice 2203 needs filing");
  assert.deepEqual(email.from, [{ name: "Finance Team", email: "finance@example.org" }]);
  assert.deepEqual(email.to, [{ name: "Team", email: "team@example.org" }]);
  assert.deepEqual(email.cc, [{ name: "Ada Lovelace", email: "ada@example.org" }]);
  assert.deepEqual(email.mailboxIds, { [GROUP_INBOX]: true });
  assert.equal(email.size, raw.length);
  const receivedAt = String(email.receivedAt);
  assert.ok(receivedAt.endsWith("Z"), "receivedAt is an instant");
  assert.equal(Number.isNaN(Date.parse(receivedAt)), false);
  assert.match(String(email.preview), /quarterly invoice/);
  assert.equal(
    (email.textBody as unknown as Array<{ type: string }>)[0]!.type,
    "text/plain",
  );

  // Reconciliation from a recorded state sees it, which is how a worker wakes.
  const changes = await jmap(AGENT_AUTH, using, [
    ["Email/changes", { accountId: GROUP_ACCOUNT, sinceState: stateBefore }, "c"],
  ]);
  const seen = responseOf(changes, "c")[1];
  assert.ok(
    (seen.created as string[]).includes(emailId),
    "the arrival is in the change log",
  );
  assert.notEqual(seen.newState, stateBefore, "and the state moved on");

  // The same change is not reported to another account, and not by another
  // account's state: the log is per account, the token per type.
  const ownAccount = (await agentSession()).primaryAccounts[FILENODE]!;
  const otherAccount = await jmap(AGENT_AUTH, using, [
    ["Email/changes", { accountId: ownAccount, sinceState: "0" }, "c"],
  ]);
  assert.deepEqual(responseOf(otherAccount, "c")[1].created, []);
});

test("a submission from the group account sends as the group and files itself in its Sent", async () => {
  const using = [CORE, MAIL, SUBMISSION];
  const draft = await jmap(AGENT_AUTH, using, [
    [
      "Email/set",
      {
        accountId: GROUP_ACCOUNT,
        create: {
          m: {
            mailboxIds: { [GROUP_INBOX]: true },
            keywords: { $draft: true },
            subject: "Re: Q3 planning document",
            from: [{ name: "Team", email: "team@example.org" }],
            to: [{ name: "Ada Lovelace", email: "ada@example.org" }],
            bodyStructure: {
              partId: "1",
              type: "text/plain",
              subParts: [],
            },
            bodyValues: {
              "1": {
                value: "The figures are agreed.",
                isEncodingProblem: false,
                isTruncated: false,
              },
            },
          },
        },
      },
      "e",
    ],
  ]);
  const emailId = createdId(responseOf(draft, "e"), "m");

  const sent = await jmap(AGENT_AUTH, using, [
    [
      "EmailSubmission/set",
      {
        accountId: GROUP_ACCOUNT,
        create: {
          s: {
            identityId: GROUP_IDENTITY,
            emailId,
            envelope: {
              mailFrom: { email: "team@example.org" },
              rcptTo: [{ email: "ada@example.org" }],
            },
          },
        },
        onSuccessUpdateEmail: {
          "#s": {
            [`mailboxIds/${GROUP_SENT}`]: true,
            [`mailboxIds/${GROUP_INBOX}`]: null,
            "keywords/$draft": null,
          },
        },
      },
      "s",
    ],
  ]);
  assert.equal(responseOf(sent, "s")[0], "EmailSubmission/set");
  const submission = (responseOf(sent, "s")[1].created as Record<string, Obj>).s!;
  assert.equal(
    submission.undoStatus,
    "final",
    "a plain send leaves at once, the way the live probe saw it",
  );
  assert.ok(!Number.isNaN(Date.parse(String(submission.sendAt))));

  // onSuccessUpdateEmail moved the message into the group's own Sent folder.
  const read = await jmap(AGENT_AUTH, using, [
    ["Email/get", { accountId: GROUP_ACCOUNT, ids: [emailId] }, "g"],
    [
      "Email/query",
      { accountId: GROUP_ACCOUNT, filter: { inMailbox: GROUP_SENT }, limit: 50 },
      "q",
    ],
    ["EmailSubmission/get", { accountId: GROUP_ACCOUNT, ids: null }, "sub"],
  ]);
  const email = (responseOf(read, "g")[1].list as Array<Record<string, never>>)[0]!;
  assert.deepEqual(email.mailboxIds, { [GROUP_SENT]: true }, "filed in the group's Sent");
  assert.equal(
    (email.keywords as unknown as Record<string, unknown>).$draft,
    undefined,
    "and no longer a draft",
  );
  assert.ok(
    (responseOf(read, "q")[1].ids as string[]).includes(emailId),
    "the group's Sent mailbox holds it",
  );

  // The submission carries the group's own identity and its envelope, which is
  // what "sending as the group" means on the wire.
  const rows = responseOf(read, "sub")[1].list as Array<{
    id: string;
    identityId: string;
    envelope: { mailFrom: { email: string } };
  }>;
  const row = rows.find((r) => r.id === submission.id)!;
  assert.equal(row.identityId, GROUP_IDENTITY);
  assert.equal(row.envelope.mailFrom.email, "team@example.org");
});
