import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * A group's identities, and the roster they belong to (ADR 0007).
 *
 * A group mailbox holds **one identity per member**: the group's own address,
 * each member's own display name and signature. The administration writes them
 * as the installation's agent, because Stalwart refuses to impersonate a group
 * mailbox at all, and it answers the whole list beside the roster those
 * identities belong to — so the surface can say which member an identity is
 * for, and which members have none yet.
 *
 * The writes this file pins are `id: null` — which **adopts** the identity the
 * group already carries for that member, and **creates** one for a `name` the
 * group carries nothing for — and an `id` that is not one of the group's own,
 * which is refused by name instead of being written through. The member an
 * identity belongs to is the caller's to say: it is the `name` in the patch,
 * and nothing about the account decides it.
 *
 * The person's side is pinned here too. A person's own identity list is the
 * account that sends for them, and the groups beneath it are the non-personal
 * accounts their session holds that answered as a group — an account carrying
 * at least one identity addressed as the account itself — each read with their
 * own credential. An account that answered nothing of its own is somebody's
 * shared folder and is left out. A read the server refuses answers
 * `readable: false` with no identities, which is an answer rather than a
 * failure: the surface says which group it could not read instead of showing it
 * as a group that holds none.
 *
 * Mock port: must not collide with any other test file — the runner executes
 * files as parallel child processes, each binding its own mock.
 */

const PORT = 19933;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-identity-groups";
process.env.LOGIN_RATE_LIMIT = "10000";
process.env.GILBERT_AGENT_ADDRESS = "gilbert@example.com";
process.env.GILBERT_AGENT_PASSWORD = "gilbert-password";

const DEMO = "demo@example.com";
const DEMO_PASS = "demo-password";
const AGENT = "gilbert@example.com";
const AGENT_PASS = "gilbert-password";
const TEAM = "team@example.org";
const DESIGN = "design@example.org";
const LEGAL = "legal@example.org";
const BASE = `http://127.0.0.1:${PORT}`;

const mock = await import("./mock/index.js");
const { createApp, useDurableSessions } = await import("./app.js");
const { fetchUpstreamSession } = await import("./upstream.js");

/*
 * This deployment names an agent, and a deployment that names one keeps its
 * sessions in an account's own document (the guard `createApp` applies). The
 * store here is the smallest one that satisfies it — what this file is about is
 * identities, not session durability.
 */
await useDurableSessions(
  { read: async () => null, write: async () => {} },
  { ttlSeconds: 3600, rememberTtlSeconds: 86_400 },
);

const app = createApp();
let cookie = "";
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

async function call(path: string, init: RequestInit = {}) {
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
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

const post = (path: string, body: unknown) =>
  call(path, { method: "POST", body: JSON.stringify(body) });

const group = (name: string) =>
  call(`/api/admin/identities/group?name=${encodeURIComponent(name)}`);

const person = (address: string) =>
  call(`/api/admin/identities/user?address=${encodeURIComponent(address)}`);

/** One identity, as the routes answer it. */
interface Row {
  id: string;
  name: string;
  email: string;
  textSignature: string;
}

/** A group's answers: every identity it holds, the roster, and who is assigned which. */
interface GroupView {
  name: string;
  granted: boolean;
  identities: Row[];
  members: string[] | null;
  assignments: Record<string, string>;
  groupSenderId: string | null;
}

/** One group of a person's own identity list. */
interface PersonGroupRow {
  name: string;
  identities: Row[];
  readable: boolean;
}

before(async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: DEMO, password: DEMO_PASS }),
  });
  assert.equal(res.status, 200, "the administrator signs in against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the demo's group holds an identity for the demo user, and assigns it to them", async () => {
  /*
   * The demo environment, and the state it puts a reader in: a group whose
   * demo member has an identity of their own there, assigned to them. That is
   * what makes the composer in that mailbox offer a personal sender — the
   * assignment, and not a display name that happens to match (ADR 0007).
   *
   * A group with no assignment is a working state too: the member sends as the
   * group's own identity, which is what the agent sends as. What this pins is
   * that the demo is not *that* state, so the common case is the one the demo
   * shows.
   */
  const mine = (await person(DEMO)).body as unknown as { identities?: Row[] };
  const own = (mine.identities ?? []).find((row) => row.email === DEMO);
  assert.ok(own, "the demo user's own account holds an identity carrying their address");

  const held = (await group(TEAM)).body as unknown as GroupView;
  const bound = held.identities.find((row) => row.id === held.assignments[DEMO]);
  assert.ok(
    bound,
    `the demo user must be assigned one of the group's identities; it holds ${JSON.stringify(
      held.identities.map((row) => row.name),
    )} and assigns ${JSON.stringify(held.assignments)}`,
  );
  assert.equal(bound.email, TEAM, "and that identity sends from the group's address");
  assert.equal(
    bound.name,
    own.name,
    "carrying the demo user's own display name, which is what the administration writes",
  );
  assert.equal(
    held.assignments[DEMO] === held.groupSenderId,
    false,
    "and it is not the group's own identity, so the demo shows the per-member case",
  );
});

test("a group answers its identities, its roster and who is assigned which", async () => {
  const first = await group(TEAM);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const view = first.body as unknown as GroupView;
  assert.equal(view.name, TEAM);
  assert.equal(view.granted, true, "the agent is granted on this group");
  assert.deepEqual(
    view.identities.map((row) => row.email),
    [TEAM, TEAM],
    "every identity of a group carries the group's own address",
  );
  assert.deepEqual(
    view.members,
    [DEMO, AGENT].sort(),
    "the roster is read as the agent: the members of the group, the agent among them",
  );

  /*
   * The binding, as the administration's own record: a member address to an id
   * of this group. It is read, not inferred from a display name — which is what
   * the composer in a group mailbox follows, so a rename in somebody's own
   * account cannot move who sends as what.
   */
  const assigned = view.identities.find((row) => row.name === "Demo User");
  assert.ok(assigned, "the fixture gives the demo user an identity of their own");
  assert.equal(view.assignments[DEMO], assigned.id, "and the demo user is assigned it");
  assert.equal(
    assigned.id,
    view.groupSenderId === assigned.id ? view.groupSenderId : assigned.id,
  );

  /*
   * The group's own identity: the one an unassigned member sends as, and the one
   * the agent sends as. It is an answer rather than a leftover, and it heads the
   * list of identities no member is assigned.
   */
  assert.ok(view.groupSenderId, "the group has an identity of its own");
  const own = view.identities.find((row) => row.id === view.groupSenderId)!;
  assert.equal(own.name, "Team", "which is the group's own voice");
});

test("the composer's question is answered as the member, with the group's own behind it", async () => {
  /*
   * `GET /identities/assignment` is what the composer asks (ADR 0007): the
   * identity assigned to **the person signed in**, and the group's own, which is
   * what they send as when nothing is assigned to them. Both are ids of the
   * group's account, which the client resolves against the list it holds — so
   * the cascade that picks between them lives in one place.
   */
  const view = (await group(TEAM)).body as unknown as GroupView;
  const mine = await call(`/api/identities/assignment?group=${encodeURIComponent(TEAM)}`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const answer = mine.body as unknown as {
    group: string;
    assignedId: string | null;
    groupSenderId: string | null;
  };
  assert.equal(answer.group, TEAM);
  assert.equal(
    answer.assignedId,
    view.assignments[DEMO],
    "the member's own assignment, read as the member",
  );
  assert.equal(
    answer.groupSenderId,
    view.groupSenderId,
    "and the group's own identity beside it",
  );

  // A group the reader is not in is refused by the same rule every member
  // surface uses, rather than answering an empty assignment.
  const refused = await call(
    `/api/identities/assignment?group=${encodeURIComponent(LEGAL)}`,
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
});

test("an id-less write assigns a member an identity and does not make a second", async () => {
  const held = (await group(TEAM)).body as unknown as GroupView;
  const existing = held.identities.find((row) => row.name === "Gilbert");
  assert.equal(existing, undefined, "the fixture assigns nobody but the demo user");

  /*
   * The write that gives a member their own name in the group: `member` is the
   * person, `id: null` says they hold none here yet, and the account answers the
   * identity it created.
   */
  const created = await post("/api/admin/identities/group", {
    name: TEAM,
    member: AGENT,
    id: null,
    patch: { name: "Gilbert", email: TEAM, textSignature: "— the agent" },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body?.id as string;
  assert.ok(id, "a created identity answers its id");
  assert.equal(
    held.identities.some((row) => row.id === id),
    false,
    "a create answers a new identity",
  );

  const after = (await group(TEAM)).body as unknown as GroupView;
  assert.deepEqual(
    after.identities.map((row) => row.name).sort(),
    ["Demo User", "Gilbert", "Team"],
    "the group answers every identity it holds",
  );
  assert.equal(after.assignments[AGENT], id, "and the agent is assigned the new one");
  assert.equal(
    after.assignments[DEMO],
    held.assignments[DEMO],
    "while the demo user's assignment is untouched",
  );

  /*
   * The same write again — a double Save, a retried request, a stale tab. The
   * member already holds one, so it is written rather than replaced by a second:
   * the group holds one identity per member, and this route has no way to remove
   * one, so a duplicate would be unreachable by repair.
   */
  const replayed = await post("/api/admin/identities/group", {
    name: TEAM,
    member: AGENT,
    id: null,
    patch: { name: "Gilbert", email: TEAM, textSignature: "— the agent, again" },
  });
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal(
    replayed.body?.id,
    id,
    "the replay answers the identity the member already holds",
  );
  const grown = (await group(TEAM)).body as unknown as GroupView;
  assert.equal(
    grown.identities.length,
    after.identities.length,
    "the group's identity count does not grow",
  );
  const adopted = grown.identities.find((row) => row.id === id)!;
  assert.equal(adopted.textSignature, "— the agent, again", "and the write landed there");
});

test("an assignment can be moved, and a member can be given the group's own identity", async () => {
  const held = (await group(TEAM)).body as unknown as GroupView;
  const demoIdentity = held.identities.find((row) => row.name === "Demo User")!;
  const groupOwn = held.identities.find((row) => row.id === held.groupSenderId)!;

  /*
   * Assigned by id: the administration may give a member any identity the group
   * holds, the group's own included — which is how somebody is deliberately made
   * indistinguishable from the group rather than left there by accident.
   */
  const moved = await post("/api/admin/identities/group", {
    name: TEAM,
    member: DEMO,
    id: groupOwn.id,
    patch: { textSignature: "— the group's own" },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const after = (await group(TEAM)).body as unknown as GroupView;
  assert.equal(
    after.assignments[DEMO],
    groupOwn.id,
    "the member now sends as the group's own identity",
  );
  assert.equal(
    after.identities.find((row) => row.id === demoIdentity.id)?.textSignature,
    demoIdentity.textSignature,
    "and the identity they had is left exactly as it was",
  );

  // Put it back: the fixture's state is what the tests below read.
  await post("/api/admin/identities/group", {
    name: TEAM,
    member: DEMO,
    id: demoIdentity.id,
    patch: {},
  });
  // And the group's own identity keeps its stored signature (the fixture owns
  // it), since the write above went through its id.
  await post("/api/admin/identities/group", {
    name: TEAM,
    member: AGENT,
    id: groupOwn.id,
    patch: { name: "Team", textSignature: "" },
  });
});

test("an id belonging to another group is refused by name", async () => {
  const team = (await group(TEAM)).body as unknown as GroupView;
  const design = (await group(DESIGN)).body as unknown as GroupView;
  assert.equal(design.granted, true, "the agent is granted on the second group too");

  const foreign = team.identities[0]!.id;
  assert.equal(
    design.identities.some((row) => row.id === foreign),
    false,
    "the two groups hold identities of their own",
  );

  const refused = await post("/api/admin/identities/group", {
    name: DESIGN,
    member: AGENT,
    id: foreign,
    patch: { textSignature: "written from the wrong group" },
  });
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body?.error, "identity_not_found");

  const after = (await group(DESIGN)).body as unknown as GroupView;
  assert.deepEqual(
    after.identities.map((row) => row.id),
    design.identities.map((row) => row.id),
    "nothing was written through the refused id",
  );
  assert.equal(
    after.assignments[AGENT],
    undefined,
    "and no assignment was recorded for it either",
  );
});

test("a member that is not an address is refused before anything is written", async () => {
  const before = (await group(TEAM)).body as unknown as GroupView;
  const refused = await post("/api/admin/identities/group", {
    name: TEAM,
    member: "not-an-address",
    id: null,
    patch: { email: TEAM },
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body?.error, "invalid_member");
  const after = (await group(TEAM)).body as unknown as GroupView;
  assert.deepEqual(
    after.identities.map((row) => row.id),
    before.identities.map((row) => row.id),
    "the group holds exactly what it held",
  );
});

test("an identity can be written for nobody, and then assigned to somebody", async () => {
  /*
   * No member at all is a write an administrator really makes: the group's own
   * identity, or one nobody is assigned yet — which is a state and not a
   * mistake, because an identity nobody holds is what an unassigned member
   * sends as.
   */
  const created = await post("/api/admin/identities/group", {
    name: TEAM,
    member: "",
    id: null,
    patch: { name: "Nobodys", email: TEAM },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body?.id as string;
  const after = (await group(TEAM)).body as unknown as GroupView;
  assert.equal(
    Object.values(after.assignments).includes(id),
    false,
    "nothing was assigned to it",
  );
  assert.ok(
    after.identities.some((row) => row.id === id),
    "and the group holds it",
  );

  // Assigned by id afterwards: the same identity, now somebody's.
  const assigned = await post("/api/admin/identities/group", {
    name: TEAM,
    member: AGENT,
    id,
    patch: {},
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const grown = (await group(TEAM)).body as unknown as GroupView;
  assert.equal(grown.assignments[AGENT], id, "the identity is somebody's now");
  assert.equal(
    grown.identities.length,
    after.identities.length,
    "and no second identity was made for it",
  );
});

test("an agent that holds nothing on a group is answered, not refused", async () => {
  const read = await group(LEGAL);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const view = read.body as unknown as GroupView;
  assert.equal(view.granted, false, "the agent is not on this group");
  assert.deepEqual(view.identities, [], "and nothing of it is read");
  assert.equal(view.members, null, "no account the agent holds, so no roster either");

  const write = await post("/api/admin/identities/group", {
    name: LEGAL,
    member: DEMO,
    id: null,
    patch: { email: LEGAL },
  });
  assert.equal(write.status, 409, JSON.stringify(write.body));
  assert.equal(write.body?.error, "group_not_granted");
});

/**
 * A person's own groups, and the one read that refuses.
 *
 * The agent's session holds two group mailboxes, so impersonating it is the one
 * session in the mock with two of them, and the list is read with the
 * impersonated person's own credential rather than with the agent's. The
 * refusal is interposed on the upstream read: a method-level `forbidden` inside
 * an HTTP 200 is the shape a real server answers an account a session holds
 * through a share, and the surface has to report that as a group it could not
 * read rather than as a group with no identities.
 */
test("a person's groups answer what their account sends as, and which read refused", async () => {
  const upstream = await fetchUpstreamSession(
    `Basic ${Buffer.from(`${AGENT}:${AGENT_PASS}`).toString("base64")}`,
    BASE,
  );
  const designAccount = Object.entries(upstream.accounts ?? {}).find(
    ([, account]) => (account as { name?: string }).name === DESIGN,
  )?.[0];
  assert.ok(designAccount, "the mock's session holds the second group's account");

  const plain = (await person(AGENT)).body as unknown as { groups: PersonGroupRow[] };
  assert.deepEqual(
    plain.groups.map((row) => row.name).sort(),
    [TEAM, DESIGN].sort(),
    "the non-personal accounts the session holds are the groups it answers for",
  );
  for (const row of plain.groups) {
    assert.equal(row.readable, true, `${row.name} is read as the person`);
    assert.ok(row.identities.length >= 1, `${row.name} answers the identities it holds`);
  }

  /* The interposed read, restored whatever the request answers. */
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("Identity/get") && body.includes(`"${designAccount}"`)) {
      asked.push(body);
      return new Response(
        JSON.stringify({
          methodResponses: [
            [
              "error",
              {
                type: "forbidden",
                description:
                  "You are not allowed to read the identities of this account.",
              },
              "r",
            ],
          ],
          sessionState: "1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;

  let refused: { groups: PersonGroupRow[] };
  try {
    refused = (await person(AGENT)).body as unknown as typeof refused;
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(
    asked.length,
    1,
    "the refused group is asked for its own Identity/get, once",
  );
  const byName = new Map(refused.groups.map((row) => [row.name, row]));
  const answered = byName.get(TEAM);
  assert.equal(answered?.readable, true, "the group that answered is still listed");
  assert.ok((answered?.identities.length ?? 0) >= 1, "and its identities come with it");
  const unread = byName.get(DESIGN);
  assert.equal(
    unread?.readable,
    false,
    "a refused read is a group the person could not read, not one with no identities",
  );
  assert.deepEqual(unread?.identities, [], "so it carries none of its own");
});

/**
 * A share is not one of the person's groups.
 *
 * The client's one classifier reads it the same way (`web/src/lib/mailAccounts.ts`):
 * a group's account answers with an identity it sends as, addressed as the
 * account itself, and an account that answers nothing of its own is somebody's
 * shared folder. The administration lists what the person's own section lists,
 * so it answers a group only when the account answered as one — and a read it
 * refuses is still listed, as an account it could not read.
 */
test("an account that answers nothing of its own is no group of theirs", async () => {
  const upstream = await fetchUpstreamSession(
    `Basic ${Buffer.from(`${AGENT}:${AGENT_PASS}`).toString("base64")}`,
    BASE,
  );
  const designAccount = Object.entries(upstream.accounts ?? {}).find(
    ([, account]) => (account as { name?: string }).name === DESIGN,
  )?.[0];
  assert.ok(designAccount, "the mock's session holds the second group's account");

  /* Answer that one account's own `Identity/get` this way, and restore fetch. */
  const withRead = (responses: (accountId: string) => unknown[]) => {
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("Identity/get") && body.includes(`"${designAccount}"`)) {
        asked.push(body);
        return new Response(
          JSON.stringify({
            methodResponses: responses(designAccount),
            sessionState: "1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;
    return {
      asked,
      async run() {
        try {
          return (await person(AGENT)).body as unknown as { groups: PersonGroupRow[] };
        } finally {
          globalThis.fetch = realFetch;
        }
      },
    };
  };

  /* The empty list a share answers with: not a group of the person's at all. */
  const share = withRead((accountId) => [
    ["Identity/get", { accountId, state: "1", list: [] }, "r"],
  ]);
  const nothingOfItsOwn = await share.run();
  assert.equal(share.asked.length, 1, "the account is asked for its own list, once");
  assert.deepEqual(
    nothingOfItsOwn.groups.map((row) => row.name),
    [TEAM],
    "the account holding nothing of its own is not one of the person's groups",
  );

  /* An identity carrying somebody else's address is not the account answering. */
  const borrowed = withRead((accountId) => [
    [
      "Identity/get",
      {
        accountId,
        state: "1",
        list: [
          {
            id: "x1",
            name: "Somebody Else",
            email: "else@example.org",
            replyTo: null,
            bcc: null,
            textSignature: "",
            htmlSignature: "",
          },
        ],
      },
      "r",
    ],
  ]);
  const notItsOwn = await borrowed.run();
  assert.deepEqual(
    notItsOwn.groups.map((row) => row.name),
    [TEAM],
    "an identity carrying another address is not that account's own",
  );

  /* A refused read: an account that may be a group, and could not be read. */
  const refused = withRead(() => [
    [
      "error",
      {
        type: "forbidden",
        description: "You are not allowed to read the identities of this account.",
      },
      "r",
    ],
  ]);
  const unreadable = await refused.run();
  const byName = new Map(unreadable.groups.map((row) => [row.name, row]));
  const answered = byName.get(TEAM);
  assert.equal(answered?.readable, true, "the account that answered is still listed");
  assert.ok(
    answered?.identities.some((row) => row.email === TEAM),
    "and it answered with an identity addressed as itself",
  );
  const unread = byName.get(DESIGN);
  assert.equal(
    unread?.readable,
    false,
    "an account this read could not open is said to be unreadable, not dropped",
  );
  assert.deepEqual(unread?.identities, [], "so it carries none of its own");
});

test("the first assignment a group ever gets is written", async () => {
  /*
   * The app folder does not exist until something writes it, and creating it
   * moves the account FileNode state -- so a write that read the state before
   * the folder existed is refused as a lost race. Nothing writes an assignment
   * in the design group's fixture, so this is that first write.
   */
  const before = (await group(DESIGN)).body as unknown as GroupView;
  assert.deepEqual(before.assignments, {}, "nothing is assigned here yet");

  const written = await post("/api/admin/identities/group", {
    name: DESIGN,
    member: AGENT,
    id: null,
    patch: { name: "Gilbert", email: DESIGN },
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  const after = (await group(DESIGN)).body as unknown as GroupView;
  assert.equal(after.assignments[AGENT], written.body?.id, "and it is recorded");
});
