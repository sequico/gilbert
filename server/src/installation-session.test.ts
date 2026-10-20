import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort, jsonCallAs, loginWith } from "./testkit.js";

/**
 * The installation's own account, on the session (ADR 0024).
 *
 * The global checklist and the registry live in the Master's own account, and
 * no member's session is a member of it, so the id is on no list a session
 * holds. A FileNode change names only the account, so the client cannot turn
 * the frame into a read without the server stating the id — this is that fact,
 * and the assertion that it is not one of the session's own accounts is the
 * whole reason it has to be stated.
 */
const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-the-installation-account";
process.env.LOGIN_RATE_LIMIT = "10000";
process.env.GILBERT_AGENT_ADDRESS = "gilbert@example.com";
process.env.GILBERT_AGENT_PASSWORD = "gilbert-password";

const BASE = `http://127.0.0.1:${PORT}`;
const DEMO = "demo@example.com";

const mock = await import("./mock/index.js");
const { createApp, useDurableSessions } = await import("./app.js");
const { signInAsMaster } = await import("./bootstrap.js");
const { filesAccountId } = await import("./appFolder.js");

// A process that names a Master serves durable sessions or does not come up;
// the document here is a stub, since the fact under test is not stored.
await useDurableSessions(
  { read: async () => null, write: async () => {} },
  { ttlSeconds: 3600, rememberTtlSeconds: 86_400 },
);

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});
const login = loginWith(jsonCallAs(app, HEADERS));

test("the session names the installation's own account, which no member holds", async () => {
  const master = await signInAsMaster({
    stalwartUrl: BASE,
    masterAddress: "gilbert@example.com",
    masterPassword: "gilbert-password",
  });
  const masterCtx = {
    authorization: master.authorization,
    session: master.session,
    username: master.address,
  };

  const res = await login(DEMO, "demo-password");
  assert.equal(res.status, 200);
  const body = res.body as {
    gilbert: { installationAccount?: unknown };
    accounts?: Record<string, unknown>;
  };
  const installationAccount = body.gilbert.installationAccount;
  assert.equal(
    installationAccount,
    filesAccountId(masterCtx),
    "the fact is the account the global checklist and the registry live in",
  );
  assert.equal(
    Object.keys(body.accounts ?? {}).includes(installationAccount as string),
    false,
    "no member's session holds it, which is why the server has to state it",
  );
});
