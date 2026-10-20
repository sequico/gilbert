import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort } from "./testkit.js";

/**
 * The "this is my device" box does not decide what a workorder looks like.
 *
 * That box (ADR 0015) bounds what a session may *administer* — administration is
 * the installation's to offer, and a borrowed machine may be refused it. Reading
 * is not administering, and the rule the owner set is explicit: a **member** sees
 * the workorders their groups are competent for, their own groups' parts and the
 * global checklist, whether or not the box was ticked; an **administrator** reads
 * the whole registry the same way. What the box changes is what a write is
 * allowed to do, never what a read returns.
 *
 * This fails if a device condition ever creeps back into visibility — the shape
 * of the bug it was written for, where the read asked "may this session
 * administer anywhere" instead of "who is this account".
 */
const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-workorder-visibility";
process.env.LOGIN_RATE_LIMIT = "10000";
process.env.GILBERT_AGENT_ADDRESS = "gilbert@example.com";
process.env.GILBERT_AGENT_PASSWORD = "gilbert-password";
// The installation asks for the own-device rule, which is the whole point here.
process.env.ADMINISTRATION_NEEDS_OWN_DEVICE = "1";

const mock = await import("./mock/index.js");
const { createApp, useDurableSessions } = await import("./app.js");

// A process that names a Master serves durable sessions (installation-session.test.ts).
await useDurableSessions(
  { read: async () => null, write: async () => {} },
  { ttlSeconds: 3600, rememberTtlSeconds: 86_400 },
);

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** A sign-in whose body says whether this device is marked as the person's own. */
const signIn = async (username: string, password: string, remember: boolean) => {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ username, password, remember }),
  });
  assert.equal(res.status, 200, await res.text());
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
};

const list = async (cookie: string) => {
  const res = await app.request("/api/workorders", { headers: { ...HEADERS, cookie } });
  assert.equal(res.status, 200);
  return (await res.json()) as {
    workorders: Array<{ uid: string; canAdminister?: boolean }>;
  };
};

const read = async (cookie: string, uid: string) => {
  const res = await app.request(`/api/workorders/${uid}`, {
    headers: { ...HEADERS, cookie },
  });
  // The body is not read for its content, but a response nobody reads is a
  // request left open — and a file that leaves one open does not exit.
  await res.text();
  return res.status;
};

test("a workorder carrying a global section is every user's to see", async () => {
  /*
   * The rule the owner set: a workorder with a section assigned to **no** group
   * carries the part of the process the whole installation shares, so the
   * workorder itself is visible to every user of the system — administrator or
   * not — and its global section with it. Group sections stay with their own
   * group's members. An administrator sees everything, always.
   *
   * `bob@example.com` is in **no** group at all, which is the session that shows
   * the difference: before this rule a caller with no group saw no workorder
   * whatever, including the ones whose sections nobody was assigned.
   */
  const cookie = await signIn("bob@example.com", "bob-password", false);
  const { workorders } = await list(cookie);
  assert.deepEqual(
    workorders.map((w) => w.uid).sort(),
    ["container-northwind", "maintenance-line1", "maintenance-line2"],
    "every workorder holding a global section, and only those",
  );
  assert.equal(
    workorders.some((w) => w.uid === "design-brief"),
    false,
    "and none whose sections are all a group's",
  );
});

test("a group's section is its own members', and absent for everyone else", async () => {
  /*
   * The other half of the rule, and the direction it must not widen. The
   * container workorder holds a global section **and** one assigned to a3;
   * `customs` is the assigned one. The demo user is in a3 and reads both; bob is
   * in nothing and reads the global one alone — never an empty part and never a
   * refusal, which is how a part a reader cannot reach has always been served
   * (ADR 0024).
   */
  const member = await signIn("demo@example.com", "demo-password", false);
  const outsider = await signIn("bob@example.com", "bob-password", false);

  const parts = async (cookie: string) => {
    const res = await app.request("/api/workorders/container-northwind", {
      headers: { ...HEADERS, cookie },
    });
    assert.equal(res.status, 200);
    const { workorder } = (await res.json()) as {
      workorder: { parts: Array<{ scope: string; group: string | null }> };
    };
    return workorder.parts;
  };

  const mine = await parts(member);
  assert.deepEqual(
    mine.map((p) => p.scope).sort(),
    ["global", "group"],
    "a member of the assigned group reads both parts",
  );
  const theirs = await parts(outsider);
  assert.deepEqual(
    theirs.map((p) => p.scope),
    ["global"],
    "and a reader outside it reads the global one alone",
  );
});

test("a workorder of group sections only is reached by its group, not by everyone", async () => {
  /*
   * `design-brief`'s template assigns **every** section to a5, the agent's own
   * group, which the demo user is not in. So there is no global section to make
   * it public and no wider reading to make: the agent reads it, the demo user
   * does not, and neither of them administers the installation here.
   */
  const agent = await signIn("gilbert@example.com", "gilbert-password", false);
  const outsider = await signIn("bob@example.com", "bob-password", false);
  assert.equal(await read(agent, "design-brief"), 200, "a member of its group reads it");
  assert.equal(
    await read(outsider, "design-brief"),
    404,
    "and a reader in no group, and no administrator, does not",
  );
  assert.equal(
    (await list(outsider)).workorders.some((w) => w.uid === "design-brief"),
    false,
    "it is not in the list either",
  );
});

test("whoever may see a part may check it, and the check carries their name", async () => {
  /*
   * The owner's rule: a part's readers are its checkers. No role is asked for,
   * because administration is a rule about **templates** — only an
   * administrator approves a checklist template (ADR 0020) — and about nothing
   * on this surface. What a checked step carries is the signature: `by`, taken
   * from the authenticated session, so the act is accountable in the record
   * rather than gated by a role.
   *
   * The session below is `gilbert@example.com`, which this file's environment
   * names as the installation's **agent** (`GILBERT_AGENT_ADDRESS`) and which is
   * not an administrator. So the two requirements are one case, and the test
   * covers both: the agent checks the global checklist and its group's part
   * through the same door a person uses — it has no door of its own — and each
   * step comes back stamped with its session's address.
   */
  const cookie = await signIn("gilbert@example.com", "gilbert-password", false);
  const view = await app.request("/api/workorders/container-northwind", {
    headers: { ...HEADERS, cookie },
  });
  const { workorder } = (await view.json()) as {
    workorder: {
      parts: Array<{
        scope: string;
        group?: string;
        canCheck?: boolean;
        checklist: { steps: Array<{ path: string; state: string; by?: string }> };
      }>;
    };
  };
  const own = workorder.parts.find((part) => part.scope === "group");
  const global = workorder.parts.find((part) => part.scope === "global");
  assert.ok(own && global, "the member reads the global checklist and its own part");
  assert.equal(own.canCheck, true, "its own part is theirs to check");
  assert.equal(global.canCheck, true, "and so is the global one, which it also reads");

  const check = async (body: Record<string, unknown>) => {
    const res = await app.request("/api/workorders/check", {
      method: "POST",
      headers: { ...HEADERS, cookie },
      body: JSON.stringify(body),
    });
    await res.text();
    return res.status;
  };

  assert.equal(
    await check({
      uid: "container-northwind",
      scope: "group",
      group: own.group,
      path: own.checklist.steps[0]?.path,
      state: "done",
    }),
    200,
    "a non-administrator checks their own group's step",
  );
  /*
   * `final.handover` and not a step of the group's part: the two are different
   * documents, and a path that belongs to a part the caller is in is still not a
   * step of the root. It is chosen because the fixture left it **open** and
   * unsigned, so what it carries afterwards is this check's own act rather than
   * the seed's stamp.
   */
  const path = "final.handover";
  assert.equal(
    await check({ uid: "container-northwind", scope: "global", path, state: "done" }),
    200,
    "and the installation's own checklist is not the administration's",
  );

  const after = await app.request("/api/workorders/container-northwind", {
    headers: { ...HEADERS, cookie },
  });
  const settled = ((await after.json()) as { workorder: typeof workorder }).workorder;
  const signed = settled.parts
    .find((part) => part.scope === "global")
    ?.checklist.steps.find((step) => step.path === path);
  assert.equal(signed?.state, "done", "the step is the one that was checked");
  assert.equal(
    signed?.by,
    "gilbert@example.com",
    "and it records who signed it, taken from the session rather than the seed",
  );
});

test("an administrator reads the whole registry with or without the device box", async () => {
  for (const remember of [false, true]) {
    const cookie = await signIn("demo@example.com", "demo-password", remember);
    const { workorders } = await list(cookie);
    assert.deepEqual(
      workorders.map((w) => w.uid).sort(),
      ["container-northwind", "design-brief", "maintenance-line1", "maintenance-line2"],
      `every workorder the installation holds, a group's parts included (remember=${remember})`,
    );
    assert.equal(
      workorders.every((w) => w.canAdminister === true),
      true,
      "and the surface offers what the account is",
    );
  }
});
