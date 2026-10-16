import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { InstallationPublished, InstallationView } from "./installationAdmin.js";
import { freePort, jsonCallAs, loginWith } from "./testkit.js";
import type { UpstreamSession } from "./upstream.js";

/**
 * The installation's own document as the administration surface reads and
 * publishes it: only an admin may do either; text that is not a document is
 * refused with the reason and writes nothing; a valid publish is what the next
 * read returns, and the answer says when it applies — the running process keeps
 * the configuration it booted with, and the next boot reads what was written.
 *
 * Both halves of the door open onto **the Master's** account: the account
 * `GILBERT_AGENT_ADDRESS` names, whose own `gilbert` app folder a boot reads
 * the document from, reached by the same impersonation the policy publish uses.
 * That is what these tests are about first — an administrator whose own account
 * is somewhere else administers the installation's document, and the administrator's
 * own Files stays untouched — and about the deployment that names no Master at
 * all, which has no document to read and says so as a value rather than opening
 * the door onto whoever asked.
 *
 * The document is the one `bootstrap.ts` reads at boot
 * (`shared/installation.ts`), so a publish that got past the shared validator
 * but could not be booted from would be the one failure worth refusing: the
 * no-secret cases below are pinned for that reason. The write is conditional
 * and its epoch is derived from what is stored, which is pinned here too: a
 * publish that loses its race is refused with its own code and leaves the
 * stored document exactly as it was, and a save from a stale editor cannot move
 * the stored epoch backwards.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_TARGET_USER = "bob@example.com";
process.env.MOCK_TARGET_PASS = "bob-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-installation-admin";
process.env.LOGIN_RATE_LIMIT = "10000";
// The installation under test names no agent: the Master the tests below name
// is the account whose own document a boot reads, and it is named by the test
// rather than by the environment this process was started in.
delete process.env.GILBERT_AGENT_ADDRESS;
delete process.env.GILBERT_AGENT_PASSWORD;

const ADMIN = "demo@example.com";
const ADMIN_PASS = "demo-password";
const BOB = "bob@example.com";
const BOB_PASS = "bob-password";
/** The Master these tests name: the account a boot signs in as, and the one it reads. */
const MASTER = BOB;

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");
const { publishInstallation, readInstallationForAdmin } = await import(
  "./installationAdmin.js"
);
const { filesAccountId, readAppFileAt, writeAppFile } = await import("./appFolder.js");
const { fetchUpstreamSession } = await import("./upstream.js");
const { INSTALLATION_EPOCH_START } = await import("./shared/installation.js");
const cfg = await import("./config.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

const call = jsonCallAs(app, HEADERS);

const login = loginWith(call);

/**
 * What this deployment names as its Master.
 *
 * The address is read from the configuration at request time (`masterAddress`),
 * which is the same value a boot hands over, so a test can ask for the two
 * states a deployment can be in — one Master, or none — without a second
 * process.
 */
function nameMaster(address: string): void {
  cfg.useConfiguration({ ...cfg.config, agent: { ...cfg.config.agent, address } });
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

/** The Master's own session, as a client of that account would hold it. */
async function masterCtx() {
  const authorization = `Basic ${Buffer.from(`${MASTER}:${BOB_PASS}`).toString("base64")}`;
  const session = await fetchUpstreamSession(authorization, `http://127.0.0.1:${PORT}`);
  return { authorization, session, username: MASTER };
}

/** The document an account holds, read straight from it rather than through the door. */
async function documentIn(
  ctx: Awaited<ReturnType<typeof adminCtx>>,
  accountId: string,
): Promise<string | null> {
  const found = await readAppFileAt(ctx, accountId, "installation.json");
  return found ? found.text : null;
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
  nameMaster(MASTER);
  const read = await call("/api/admin/installation", bobCookie);
  assert.equal(read.status, 403, "only an admin reads the installation document");
  const write = await publish(bobCookie, VALID);
  assert.equal(write.status, 403, "only an admin publishes the installation document");
  // A refused publish wrote nothing: the admin still reads an account with no
  // document (this is the first test, so nothing has published yet).
  const view = await readView();
  assert.equal(view.present, false, "the 403 wrote nothing");
});

test("a deployment that names no Master opens no door, and says so as a value", async () => {
  /*
   * The refusal this change exists for. A process without
   * `GILBERT_AGENT_ADDRESS` has no account whose own app folder a boot reads,
   * so there is no document this surface could be about: the read and the
   * publish both answer with that fact rather than reading somebody else's
   * Files and calling it the installation's. The answer is a value with a code
   * and the server's own words, which is what the client shows.
   */
  nameMaster("");
  const read = await call("/api/admin/installation", adminCookie);
  assert.equal(
    read.status,
    409,
    "the read is refused, not answered with somebody's own Files",
  );
  assert.equal((read.body as { error?: string }).error, "no_master");
  assert.ok(
    (read.body as { message: string }).message.includes("GILBERT_AGENT_ADDRESS"),
    "and the message names what a deployment has to state",
  );

  const write = await publish(adminCookie, VALID);
  assert.equal(write.status, 409, "so is the publish");
  assert.equal((write.body as { error?: string }).error, "no_master");
  assert.equal(
    (write.body as { installation?: unknown }).installation,
    undefined,
    "and a refusal carries no document",
  );
});

test("the door opens onto the Master's own account, by impersonation", async () => {
  /*
   * The claim of a surface called "Installation": what it reads and writes is
   * the document the next boot runs on — the one in the account this
   * deployment signs in as — and not the administrator's own copy. The
   * administrator here is not the Master, which is the case a surface
   * addressing the administrator's own account would publish into the wrong
   * place: the document belongs to the account this deployment signs in as.
   */
  nameMaster(MASTER);
  const admin = await adminCtx();
  const master = await masterCtx();
  const adminAccount = filesAccountId(admin);
  const masterAccount = filesAccountId(master);
  assert.ok(adminAccount && masterAccount, "both sessions hold a Files account");
  assert.notEqual(
    adminAccount,
    masterAccount,
    "the mock sends the Master to a Files account of its own, so the two are tellable apart",
  );

  const res = await publish(adminCookie, VALID);
  assert.equal(res.status, 200);
  const outcome = (res.body as { outcome: InstallationPublished }).outcome;
  assert.equal(
    outcome.account,
    masterAccount,
    "the write landed in the Master's account",
  );
  assert.equal(outcome.master, MASTER, "and the answer names the Master it acted as");
  assert.ok(
    outcome.location.includes(masterAccount),
    `the answer says where: ${outcome.location}`,
  );

  assert.equal(
    await documentIn(master, masterAccount),
    outcome.document,
    "the Master's own app folder is what holds the document now",
  );
  assert.equal(
    await documentIn(admin, adminAccount),
    null,
    "and the administrator's own Files was not written to at all",
  );

  const view = await readView();
  assert.equal(view.account, masterAccount, "the read is the same account");
  assert.equal(view.master, MASTER);
  assert.equal(view.document, outcome.document);
});

test("the read says where the document lives, and whose account that is", async () => {
  nameMaster(BOB);
  const master = await masterCtx();
  const masterAccount = filesAccountId(master);
  assert.ok(masterAccount, "the Master's session holds a Files account");

  const view = await readView();
  assert.equal(view.present, true, "the Master's account holds what was published");
  assert.ok(view.document);
  assert.equal(view.problem, null, "and it is a document this build can boot from");
  assert.equal(view.account, masterAccount);
  assert.ok(
    view.location.includes("installation.json"),
    `the answer says where the document lives: ${view.location}`,
  );
  assert.equal(view.master, MASTER, "the answer names the Master whose document it is");
});

test("text that is not a document is refused with the reason and writes nothing", async () => {
  nameMaster(MASTER);
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
  nameMaster(MASTER);
  const before = (await readView()).document ?? "";
  const previousEpoch = (JSON.parse(before) as { epoch: number }).epoch;

  const res = await publish(adminCookie, VALID_AGAIN);
  assert.equal(res.status, 200);
  const outcome = (res.body as { outcome: InstallationPublished }).outcome;

  // What was written, as a document: the validator's defaults filled in, the
  // fields this publish stated kept.
  const written = JSON.parse(outcome.document) as {
    epoch: number;
    server: { port: number; basePath: string };
    branding: { appName: string };
    secret: string;
  };
  assert.equal(written.server.port, 9443, "the published value is what was stored");
  assert.equal(written.branding.appName, "Gilbert Test");
  assert.equal(
    written.secret,
    "an-installation-secret-long-enough-to-seal-a-session-with",
  );
  // The text stated no epoch, so the document's own default would have stood —
  // and what is written instead is the *stored* document's epoch moved on by
  // one, which is what a write of this document does.
  assert.equal(
    written.epoch,
    previousEpoch + 1,
    "the epoch written is the stored one's, moved on by one",
  );
  assert.equal(outcome.epoch, written.epoch, "the answer reports the stored epoch");
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

test("the model's key is write-only: no answer hands it back, none keeps it and an empty one clears it", async () => {
  /*
   * The installation's model lives in its own document (ADR 0011, 0031), and
   * its key is write-only the way an app password is: the surface can set it and
   * nothing reads it back. So the text both halves of this door answer with has
   * the key **taken out** — while the document the account holds keeps it, or the
   * model could never be called — and the three things a save can say about it
   * are told apart by the field itself: stating none keeps the stored one,
   * stating a value writes it, and stating an empty one clears it.
   */
  nameMaster(MASTER);
  const key = "sk-a-key-the-surface-never-reads-back";
  const withProvider = JSON.stringify({
    ...(JSON.parse(VALID) as Record<string, unknown>),
    agent: {
      provider: {
        provider: "ollama",
        model: "a-small-model",
        baseUrl: "https://models.example.com/v1",
        apiKey: key,
      },
    },
  });

  const published = await publish(adminCookie, withProvider);
  assert.equal(published.status, 200);
  const outcome = (published.body as { outcome: InstallationPublished }).outcome;
  assert.equal(
    outcome.document.includes(key),
    false,
    "the publish's own answer never carries the key",
  );
  assert.equal(
    "apiKey" in
      (JSON.parse(outcome.document) as { agent: { provider: Record<string, unknown> } })
        .agent.provider,
    false,
    "the key is not stated in what is handed back: a text read back as it is states nothing about it",
  );

  const master = await masterCtx();
  const masterAccount = filesAccountId(master);
  assert.ok(masterAccount);
  const stored = await documentIn(master, masterAccount);
  assert.equal(
    (JSON.parse(stored ?? "") as { agent: { provider: { apiKey: string } } }).agent
      .provider.apiKey,
    key,
    "the document the account holds keeps the key, so the model can still be called",
  );

  const view = await readView();
  assert.equal(
    view.document,
    outcome.document,
    "the read returns what the publish wrote",
  );
  assert.equal((view.document ?? "").includes(key), false, "and never the key");

  // A save made from the text the surface showed — which cannot contain the key
  // — keeps the stored one rather than clearing the model's credential.
  const resaved = await publish(adminCookie, view.document ?? "");
  assert.equal(resaved.status, 200);
  assert.equal(
    (
      JSON.parse((await documentIn(master, masterAccount)) ?? "") as {
        agent: { provider: { apiKey: string } };
      }
    ).agent.provider.apiKey,
    key,
    "a publish that states no key keeps the stored one",
  );

  // A save that states an **empty** key is the third thing one can say: the
  // provider needs none — a model on the deployment's own network — and the
  // stored key is cleared rather than kept.
  const cleared = await publish(
    adminCookie,
    JSON.stringify(
      {
        ...(JSON.parse(VALID) as Record<string, unknown>),
        agent: {
          provider: {
            provider: "ollama",
            model: "a-small-model",
            baseUrl: "https://models.example.com/v1",
            apiKey: "",
          },
        },
      },
      null,
      2,
    ),
  );
  assert.equal(cleared.status, 200);
  assert.equal(
    (
      JSON.parse((await documentIn(master, masterAccount)) ?? "") as {
        agent: { provider: { apiKey: string } };
      }
    ).agent.provider.apiKey,
    "",
    "a save that states an empty key clears the stored one",
  );
  const clearedView = await readView();
  assert.equal(
    "apiKey" in
      (
        JSON.parse(clearedView.document ?? "") as {
          agent: { provider: Record<string, unknown> };
        }
      ).agent.provider,
    false,
    "and the text a read hands back says nothing about it, empty or not",
  );

  // A provider that is absent clears the model, and its key with it: that is
  // how an installation stops having an agent.
  const clearedProvider = await publish(adminCookie, VALID_AGAIN);
  assert.equal(clearedProvider.status, 200);
  assert.equal(
    (
      JSON.parse((await documentIn(master, masterAccount)) ?? "") as {
        agent: { provider?: unknown };
      }
    ).agent.provider,
    undefined,
    "and a document with no provider clears the model",
  );

  // A document that is otherwise unreadable still carries its key — a hand edit,
  // a half-finished upload — and a read must not hand that back either: the key
  // is emptied from the text whatever else is wrong with the document, and the
  // reason a boot would refuse it is still shown.
  await writeAppFile(master, masterAccount, "installation.json", {
    server: { port: 70000 },
    agent: {
      provider: {
        provider: "ollama",
        model: "a-small-model",
        baseUrl: "https://models.example.com/v1",
        apiKey: key,
      },
    },
    secret: "an-installation-secret-long-enough-to-seal-a-session-with",
  });
  const broken = await readView();
  assert.equal(
    (broken.document ?? "").includes(key),
    false,
    "a document a boot would refuse never hands the key back either",
  );
  assert.ok(broken.problem, "and the reason it is refused is still shown");

  // Leave a document this build can read, for the tests that follow.
  assert.equal((await publish(adminCookie, VALID)).status, 200);
});

test("a save from a stale editor does not move the stored epoch backwards", async () => {
  /*
   * The editor's copy is old, so it carries an old epoch — here the very first
   * one a document can carry. The text is a valid document and it is published:
   * what must not happen is the stored document being written back at that
   * epoch, which would claim to a later reader that this installation is older
   * than the document it replaced. The write moves on from what the account
   * holds, whatever the submitted text says.
   */
  nameMaster(MASTER);
  const storedBefore = (await readView()).document;
  assert.ok(storedBefore);
  const previousEpoch = (JSON.parse(storedBefore) as { epoch: number }).epoch;
  assert.ok(
    previousEpoch > INSTALLATION_EPOCH_START,
    "there is an epoch to move on from rather than the first one",
  );

  const stale = JSON.stringify({
    ...(JSON.parse(VALID) as Record<string, unknown>),
    epoch: INSTALLATION_EPOCH_START,
    branding: { appName: "Gilbert From A Stale Editor" },
  });
  const res = await publish(adminCookie, stale);
  assert.equal(res.status, 200);
  const outcome = (res.body as { outcome: InstallationPublished }).outcome;
  assert.equal(
    outcome.epoch,
    previousEpoch + 1,
    "the stored epoch moved on by one from what was there, not back to the submitted one",
  );
  const written = JSON.parse(outcome.document) as {
    epoch: number;
    branding: { appName: string };
  };
  assert.equal(written.epoch, previousEpoch + 1);
  assert.equal(
    written.branding.appName,
    "Gilbert From A Stale Editor",
    "and the publish still published what it was given",
  );
});

test("a publish that loses its race is refused with its code, and stores nothing", async () => {
  /*
   * The write carries the state the account stated, so a document that moved
   * after that read is refused rather than overwritten: the account keeps the
   * document and the epoch it had, and the answer is a refusal with its own
   * code rather than a success nobody can tell apart from a write.
   *
   * The race is the mock's (`casLoses`): the folder moves as the conditional
   * write arrives, exactly as a real folder somebody else wrote to moves. The
   * account is the Master's, because that is the account the door acts as.
   */
  nameMaster(MASTER);
  const before = await readView();
  const beforeEpoch = (JSON.parse(before.document ?? "") as { epoch: number }).epoch;

  const raced = await (async () => {
    mock.casLoses.forAddress = MASTER;
    mock.casLoses.count = 1;
    try {
      return await publish(adminCookie, VALID_AGAIN);
    } finally {
      mock.casLoses.forAddress = "";
      mock.casLoses.count = 0;
    }
  })();

  assert.equal(raced.status, 409, "a write that lost its race is refused");
  assert.equal((raced.body as { error?: string }).error, "installation_moved");
  assert.ok(
    ((raced.body as { message: string }).message ?? "").length > 0,
    "with the server's own words about it",
  );

  const after = await readView();
  assert.equal(
    after.document,
    before.document,
    "the stored document is byte for byte what it was",
  );
  assert.equal(
    (JSON.parse(after.document ?? "") as { epoch: number }).epoch,
    beforeEpoch,
    "and it kept the epoch it had",
  );
});

test("a document that is there but unreadable is shown, with the boot's reason", async () => {
  /*
   * Written straight into the Master's app folder, the way a hand-edit or a
   * half-finished upload leaves it. The surface has to hand the text back so a
   * person can repair it, and say why a boot would refuse it — that is the one
   * case where withholding the document would leave the editor as the only
   * place it exists.
   */
  nameMaster(MASTER);
  const master = await masterCtx();
  const accountId = filesAccountId(master);
  assert.ok(accountId, "the Master's session holds a Files account");
  await writeAppFile(master, accountId, "installation.json", { server: { port: 8080 } });

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
  assert.equal(read.refused.code, "no_files_account");

  const write = await publishInstallation(ctx, VALID);
  assert.ok("refused" in write, "the publish refuses rather than throwing");
  assert.equal(write.refused.status, 409);
  assert.match(write.refused.message, /no Files account/);
});
