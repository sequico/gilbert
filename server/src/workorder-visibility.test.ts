import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort } from "./testkit.js";

/**
 * The "this is my device" box does not decide what a workorder looks like.
 *
 * That box (ADR 0017) bounds what a session may *administer* — administration is
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

test("a member sees its groups' workorders with or without the device box", async () => {
  for (const remember of [false, true]) {
    const cookie = await signIn("gilbert@example.com", "gilbert-password", remember);
    const { workorders } = await list(cookie);
    assert.deepEqual(
      workorders.map((w) => w.uid),
      ["container-northwind"],
      `the group it is a member of (remember=${remember})`,
    );
    assert.equal(
      workorders.every((w) => w.canAdminister === false),
      true,
      "and it administers none of them",
    );
    assert.equal(await read(cookie, "container-northwind"), 200, "its part is readable");
    assert.equal(await read(cookie, "maintenance-line1"), 404, "another group's is not");
    assert.equal(await read(cookie, "maintenance-line2"), 404);
  }
});

test("an administrator reads the whole registry with or without the device box", async () => {
  for (const remember of [false, true]) {
    const cookie = await signIn("demo@example.com", "demo-password", remember);
    const { workorders } = await list(cookie);
    assert.deepEqual(
      workorders.map((w) => w.uid).sort(),
      ["container-northwind", "maintenance-line1", "maintenance-line2"],
      `every workorder the installation holds (remember=${remember})`,
    );
    assert.equal(
      workorders.every((w) => w.canAdminister === true),
      true,
      "and the surface offers what the account is",
    );
  }
});
