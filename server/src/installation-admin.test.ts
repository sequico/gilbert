import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { InstallationPublished, InstallationView } from "./installationAdmin.js";
import type { UpstreamSession } from "./upstream.js";

/**
 * The installation's own document as the administration surface reads and
 * publishes it: only an admin may do either; text that is not a document is
 * refused with the reason and writes nothing; a valid publish is what the next
 * read returns, and the answer says when it applies — the running process keeps
 * the configuration it booted with, and the next boot reads what was written.
 *
 * The document is the one `bootstrap.ts` reads at boot
 * (`shared/installation.ts`), so a publish that got past the shared validator
 * but could not be booted from would be the one failure worth refusing: the
 * no-secret cases below are pinned for that reason.
 *
 * Mock port: must not collide with any other test file — the runner executes
 * files as parallel child processes, each binding its own mock.
 */

const PORT = 18860;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_TARGET_USER = "bob@example.com";
process.env.MOCK_TARGET_PASS = "bob-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-installation-admin";
process.env.LOGIN_RATE_LIMIT = "10000";
// The installation under test names no agent: this surface does not read one.
delete process.env.GILBERT_AGENT_ADDRESS;
delete process.env.GILBERT_AGENT_PASSWORD;

const ADMIN = "demo@example.com";
const ADMIN_PASS = "demo-password";
const BOB = "bob@example.com";
const BOB_PASS = "bob-password";

type Body = Record<string, unknown>;

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");
const { bootDocumentAccount, publishInstallation, readInstallationForAdmin } =
  await import("./installationAdmin.js");
const { filesAccountId, writeAppFile } = await import("./appFolder.js");
const { fetchUpstreamSession } = await import("./upstream.js");
const { INSTALLATION_EPOCH_START } = await import("./shared/installation.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

async function call(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Body | null; cookie: string }> {
  const res = await app.request(path, {
    ...init,
    headers: {
      ...HEADERS,
      ...(init.headers as Record<string, string>),
      ...(cookie ? { cookie } : {}),
    },
  });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Body) : null,
    cookie: setCookie ? setCookie.split(";")[0]! : cookie,
  };
}

async function login(username: string, password: string) {
  return call("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

/** The administration's read, as the editor sees it. */
async function readView(): Promise<InstallationView> {
  const res = await call("/api/admin/installation", adminCookie);
  assert.equal(res.status, 200, "an admin reads the installation document");
  return (res.body as { installation: InstallationView }).installation;
}

/** One publish, as the editor makes it: the document text, whole. */
async function publish(cookie: string, text: string) {
  return call("/api/admin/installation", cookie, { method: "POST", body: text });
}

/** The session context the routes build, for the module-level test below. */
async function adminCtx() {
  const authorization = `Basic ${Buffer.from(`${ADMIN}:${ADMIN_PASS}`).toString("base64")}`;
  const session = await fetchUpstreamSession(authorization, `http://127.0.0.1:${PORT}`);
  return { authorization, session, username: ADMIN };
}

let adminCookie = "";
let bobCookie = "";

before(async () => {
  const admin = await login(ADMIN, ADMIN_PASS);
  assert.equal(admin.status, 200, "admin login should succeed against the mock");
  adminCookie = admin.cookie;
  const bob = await login(BOB, BOB_PASS);
  assert.equal(bob.status, 200, "bob should be able to sign in");
  bobCookie = bob.cookie;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** A document this build can boot from: the validator's fields plus a real secret. */
const VALID = JSON.stringify(
  {
    server: { port: 8443, basePath: "/mail" },
    branding: { appName: "Gilbert Test" },
    upstreams: { "example.com": "https://mail.example.com" },
    agent: { pages: 4 },
    secret: "an-installation-secret-long-enough-to-seal-a-session-with",
  },
  null,
  2,
);

/** The same document with a different port: a second publish that differs. */
const VALID_AGAIN = JSON.stringify(
  { ...(JSON.parse(VALID) as Record<string, unknown>), server: { port: 9443 } },
  null,
  2,
);

test("a non-admin cannot read or publish the installation document", async () => {
  const read = await call("/api/admin/installation", bobCookie);
  assert.equal(read.status, 403, "only an admin reads the installation document");
  const write = await publish(bobCookie, VALID);
  assert.equal(write.status, 403, "only an admin publishes the installation document");
  // A refused publish wrote nothing: the admin still reads an account with no
  // document (this is the first test, so nothing has published yet).
  const view = await readView();
  assert.equal(view.present, false, "the 403 wrote nothing");
});

test("an account that has never booted has no document, and the read says so", async () => {
  const view = await readView();
  assert.equal(view.present, false, "there is no document yet");
  assert.equal(view.document, null, "and the answer says so rather than inventing text");
  assert.equal(view.problem, null);
  assert.ok(view.account, "the answer names the account it looked in");
  assert.ok(
    view.location.includes("installation.json"),
    `the answer says where the document lives: ${view.location}`,
  );
  // This test process names no Master (no `GILBERT_AGENT_ADDRESS`), so the
  // answer says it cannot tell rather than claiming either. The rule itself is
  // pinned below, without an environment to fake.
  assert.equal(view.master, null);
  assert.equal(view.bootsFrom, "unknown");
});

test("the answer says whether the account it names is the one a boot reads", () => {
  // The rule behind `bootsFrom`, given a Master this deployment named: the
  // account the installation signs in as is read at boot, its neighbour's copy
  // is not, and a deployment that named none gets "unknown" rather than a lie
  // in either direction.
  assert.equal(bootDocumentAccount("demo@example.com", "demo@example.com"), "yes");
  assert.equal(bootDocumentAccount("DEMO@example.com ", "demo@example.com"), "yes");
  assert.equal(bootDocumentAccount("other@example.com", "demo@example.com"), "no");
  assert.equal(bootDocumentAccount("demo@example.com", ""), "unknown");
});

test("text that is not a document is refused with the reason and writes nothing", async () => {
  const before = await readView();
  const cases: Array<[string, string]> = [
    ["not json at all", "Not valid JSON"],
    [JSON.stringify([1, 2]), "must be a JSON object"],
    [JSON.stringify({ server: { port: 0 } }), '"server.port" must be between'],
    [JSON.stringify({ push: { mode: "carrier-pigeon" } }), '"push.mode" must be'],
    [JSON.stringify({ version: 99 }), "this build reads version"],
    // Valid to the shared validator, refused by the document's own writer: a
    // boot cannot invent a secret, so storing one would sign every session out
    // at the next restart.
    [JSON.stringify({ branding: { appName: "No secret" } }), "app secret"],
    [JSON.stringify({ secret: "change-me" }), "app secret"],
  ];
  for (const [bad, expected] of cases) {
    const res = await publish(adminCookie, bad);
    assert.equal(res.status, 400, `should refuse: ${bad.slice(0, 60)}`);
    const message = (res.body as { message: string }).message;
    assert.ok(
      message.includes(expected),
      `message should say: ${expected} — got: ${message}`,
    );
  }
  assert.deepEqual(
    await readView(),
    before,
    "no refused publish created, replaced or touched the document",
  );

  // The same refusal against a document that is there: what a read returns is
  // still the last valid publish, not a half-written copy of the bad text.
  const published = await publish(adminCookie, VALID);
  assert.equal(published.status, 200);
  const written = (published.body as { outcome: InstallationPublished }).outcome.document;
  const refused = await publish(adminCookie, "{ this is not JSON");
  assert.equal(refused.status, 400);
  assert.ok((refused.body as { message: string }).message.includes("Not valid JSON"));
  assert.equal(
    (await readView()).document,
    written,
    "the previous document is still what a read returns",
  );
});

test("a valid publish is what the next read returns, and the answer names when it applies", async () => {
  const res = await publish(adminCookie, VALID_AGAIN);
  assert.equal(res.status, 200);
  const outcome = (res.body as { outcome: InstallationPublished }).outcome;

  // What was written, as a document: the validator's defaults filled in, the
  // fields this publish stated kept.
  const written = JSON.parse(outcome.document) as {
    epoch: number;
    server: { port: number; basePath: string };
    branding: { appName: string };
    agent: { pages: number };
    secret: string;
  };
  assert.equal(written.server.port, 9443, "the published value is what was stored");
  assert.equal(written.branding.appName, "Gilbert Test");
  assert.equal(written.agent.pages, 4);
  assert.equal(
    written.secret,
    "an-installation-secret-long-enough-to-seal-a-session-with",
  );
  // The text stated no epoch, so the document's own default stood and the
  // write took the next one — every write of this document moves it on.
  assert.equal(written.epoch, INSTALLATION_EPOCH_START + 1);
  assert.equal(outcome.epoch, written.epoch, "the answer reports the stored epoch");

  // When it applies: the running process keeps the configuration it booted
  // with, and the next boot reads what was just written.
  assert.equal(outcome.applies, "next-boot", "the answer names when it applies");
  assert.match(outcome.message, /next boot/, "and says it in as many words");
  assert.ok(
    outcome.message.includes(outcome.location),
    "the answer names where it was written",
  );

  const view = await readView();
  assert.equal(view.present, true);
  assert.equal(
    view.document,
    outcome.document,
    "the next read returns exactly what the publish wrote",
  );
  assert.equal(view.problem, null, "and it is a document this build can boot from");
  assert.equal(outcome.account, view.account, "the answer names the account it wrote to");
  assert.deepEqual(await readView(), view, "and reading it again agrees");
});

test("a document that is there but unreadable is shown, with the boot's reason", async () => {
  /*
   * Written straight into the account's app folder, the way a hand-edit or a
   * half-finished upload leaves it. The surface has to hand the text back so a
   * person can repair it, and say why a boot would refuse it — that is the one
   * case where withholding the document would leave the editor as the only
   * place it exists.
   */
  const ctx = await adminCtx();
  const accountId = filesAccountId(ctx);
  assert.ok(accountId, "the admin's session holds a Files account");
  await writeAppFile(ctx, accountId, "installation.json", { server: { port: 8080 } });

  const view = await readView();
  assert.equal(view.present, true, "the document is there");
  assert.ok(view.document?.includes('"port"'), "and it is handed back as text");
  assert.ok(view.problem, "with the reason a boot would refuse it");
  assert.match(view.problem!, /app secret/);
});

test("an account with no Files account to hold the document is refused, not thrown at", async () => {
  /*
   * The one refusal this module meets before Stalwart does:
   * `filesAccountId` answers "" for a session whose accounts carry no FileNode
   * capability, and the store refuses to be built for it. Both halves of the
   * surface answer with that refusal rather than letting it out as a 500 — an
   * installation whose administrator is told what is wrong is the point of the
   * surface.
   */
  const session = {
    capabilities: {},
    accounts: {},
    primaryAccounts: {},
    username: "nobody@example.com",
    apiUrl: "",
    downloadUrl: "",
    uploadUrl: "",
    eventSourceUrl: "",
    state: "1",
    baseUrl: `http://127.0.0.1:${PORT}`,
  } satisfies UpstreamSession;
  const ctx = { authorization: "Basic x", session, username: "nobody@example.com" };

  const read = await readInstallationForAdmin(ctx);
  assert.ok("refused" in read, "the read refuses rather than throwing");
  assert.equal(read.refused.status, 409);
  assert.equal(read.refused.error, "no_files_account");

  const write = await publishInstallation(ctx, VALID);
  assert.ok("refused" in write, "the publish refuses rather than throwing");
  assert.equal(write.refused.status, 409);
  assert.match(write.refused.message, /no Files account/);
});
