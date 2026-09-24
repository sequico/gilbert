import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { postWith } from "./testkit.js";

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
const TEAM = "team@example.org";
const DESIGN = "design@example.org";
const LEGAL = "legal@example.org";

const mock = await import("./mock/index.js");
const { createApp, useDurableSessions } = await import("./app.js");

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

const post = postWith(call);

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

test("the composer's question is answered as the member, and only the member's own part", async () => {
  /*
   * `GET /identities/assignment` is what the composer asks (ADR 0007): the
   * identity assigned to **the person signed in**. The group's own identity —
   * what they send as when nothing is assigned — is not answered here: it is
   * step 2 of the cascade, one rule both tiers import
   * (`@gilbert/shared/identityAssignment`), and the client derives it from the
   * address the session calls the account rather than reading it back.
   */
  const view = (await group(TEAM)).body as unknown as GroupView;
  const mine = await call(`/api/identities/assignment?group=${encodeURIComponent(TEAM)}`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const answer = mine.body as unknown as {
    group: string;
    assignedId: string | null;
  };
  assert.equal(answer.group, TEAM);
  assert.equal(
    answer.assignedId,
    view.assignments[DEMO],
    "the member's own assignment, read as the member",
  );
  assert.deepEqual(
    Object.keys(answer).sort(),
    ["assignedId", "group"],
    "and nothing else: the group's own identity is a rule, not this account's record",
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

test("the first assignment a group ever gets is written, for one upload", async () => {
  /*
   * The app folder does not exist until something writes it, and creating it
   * moves the account FileNode state -- so a state read before the folder
   * existed is a token no write will pass. Nothing writes an assignment in the
   * design group's fixture, so this is that first write, and the folder is
   * created before the state is read for exactly that reason.
   *
   * What the order saves is the upload. A write uploads its bytes before the
   * FileNode set that can refuse them, and JMAP has no blob removal: the account
   * pays for that blob and never gets it back. One upload is what this write may
   * spend; a write that read the state before the folder existed spends two, the
   * second for a document that was already written.
   */
  const before = (await group(DESIGN)).body as unknown as GroupView;
  assert.deepEqual(before.assignments, {}, "nothing is assigned here yet");

  const realFetch = globalThis.fetch;
  const uploads: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && String(input).includes("/upload/"))
      uploads.push(String(input));
    return realFetch(input, init);
  }) as typeof fetch;

  let written: { status: number; body: Record<string, unknown> | null };
  try {
    written = await post("/api/admin/identities/group", {
      name: DESIGN,
      member: AGENT,
      id: null,
      patch: { name: "Gilbert", email: DESIGN },
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(
    uploads.length,
    1,
    `one upload, and no second for an attempt that was refused: ${JSON.stringify(uploads)}`,
  );
  const after = (await group(DESIGN)).body as unknown as GroupView;
  assert.equal(after.assignments[AGENT], written.body?.id, "and it is recorded");
});

test("a write that lands between the state and the list is not overwritten", async () => {
  /*
   * Two administrators acting on one group at once is what the conditional
   * write exists for, and the order it reads in is what keeps them from losing
   * each other's work: the account's FileNode state is read **before** the
   * assignment list, so a write that lands in the window between the two leaves
   * this one holding a token older than its own list — refused by the server,
   * and the retry then merges into the list as it now reads. Read the list first
   * and the two disagree the other way round: a token newer than the data is a
   * conditional write that passes while overwriting the entry it never saw.
   *
   * The other administrator's write is interposed on this one's state read,
   * which is exactly the window in question.
   */
  const before = (await group(DESIGN)).body as unknown as GroupView;
  const mine = before.assignments[AGENT];
  assert.ok(mine, "the fixture assigns the agent an identity of its own");
  const other = before.identities.find((row) => row.id !== mine)?.id;
  assert.ok(other, "and the group holds another identity to assign instead");

  const realFetch = globalThis.fetch;
  let interposed = false;
  let rival: { status: number; body: Record<string, unknown> | null } = {
    status: 0,
    body: null,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (!interposed && body.includes("FileNode/get") && body.includes('"ids":[]')) {
      interposed = true;
      const res = await post("/api/admin/identities/group", {
        name: DESIGN,
        member: AGENT,
        id: other,
        patch: {},
      });
      rival = { status: res.status, body: res.body };
    }
    return realFetch(input, init);
  }) as typeof fetch;

  let written: { status: number; body: Record<string, unknown> | null };
  try {
    written = await post("/api/admin/identities/group", {
      name: DESIGN,
      member: "",
      id: null,
      patch: { name: "Nobodys", email: DESIGN },
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(interposed, true, "the other administrator's write landed mid-read");
  assert.equal(rival.status, 200, JSON.stringify(rival.body));
  assert.equal(written.status, 200, JSON.stringify(written.body));
  const after = (await group(DESIGN)).body as unknown as GroupView;
  assert.equal(
    after.assignments[AGENT],
    other,
    "the assignment that landed in the window is still recorded",
  );
  assert.equal(
    Object.values(after.assignments).includes(written.body?.id as string),
    false,
    "and this write assigned nobody",
  );
  assert.ok(
    after.identities.some((row) => row.id === written.body?.id),
    "though the identity it wrote is the group's",
  );
});

test("a member's own sender can be deleted, and the group's own identity cannot", async () => {
  /*
   * The trash on a member's row (ADR 0007): the identity they were assigned is
   * removed and the assignment with it, so they fall back to the group's own
   * identity — what a member with no identity of their own sends as. The
   * group's own is refused by name, because everybody falls back to it.
   */
  let view = (await group(TEAM)).body as unknown as GroupView;
  let assignedId = view.assignments[DEMO];
  if (!assignedId) {
    const wrote = await post("/api/admin/identities/group", {
      name: TEAM,
      member: DEMO,
      id: null,
      patch: { name: "Demo User", email: TEAM },
    });
    assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
    view = (await group(TEAM)).body as unknown as GroupView;
    assignedId = view.assignments[DEMO];
  }
  assert.ok(assignedId, "the member has a per-member identity to delete");
  const before = view.identities.length;
  const groupSenderId = view.groupSenderId;

  const gone = await post("/api/admin/identities/group/delete", {
    name: TEAM,
    id: assignedId,
  });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));

  const after = (await group(TEAM)).body as unknown as GroupView;
  assert.equal(
    after.identities.some((row) => row.id === assignedId),
    false,
    "the identity is gone",
  );
  assert.equal(after.assignments[DEMO] ?? null, null, "and the assignment with it");
  assert.equal(after.groupSenderId, groupSenderId, "the group's own identity is untouched");
  assert.equal(after.identities.length, before - 1);

  const refuse = await post("/api/admin/identities/group/delete", {
    name: TEAM,
    id: after.groupSenderId,
  });
  assert.equal(refuse.status, 400, JSON.stringify(refuse.body));
  assert.equal(refuse.body?.error, "identity_is_group");

  const missing = await post("/api/admin/identities/group/delete", {
    name: TEAM,
    id: "nope",
  });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
});
