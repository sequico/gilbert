import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { waitForPort } from "./testkit.js";

/**
 * The write funnel's no-op rule, against the mock Stalwart.
 *
 * Every durable document Gilbert keeps is written by uploading a blob and
 * pointing a `FileNode` at it, and Stalwart charges the account for every blob
 * while nothing ever reclaims one (JMAP offers no blob removal). Gilbert
 * rewrites the same documents constantly — a job at every stage of a run, a
 * notebook on every fact, a claim on every tick — so the account drifts into
 * the upload quota (1000 files or 50000000 bytes) and then *every* write in it
 * fails, a person saving a group's standing instruction included.
 *
 * `writeFile` (`server/src/appFolder.ts`) is the one place that decides a write
 * whose bytes are already stored needs neither an upload nor a `FileNode/set`,
 * and this is where that guarantee is pinned: the mock counts the uploads it was
 * asked for (`uploads`, `server/src/mock/index.ts`), and that count *is* the
 * quota. The account state token is asserted alongside it, because a skipped
 * write must not advance it either — a no-op that bumped the state would
 * invalidate another writer's compare-and-set token for nothing.
 */

const PORT = 18868;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-appfolder-write";

const mock = await import("./mock/index.js");
const { fetchUpstreamSession } = await import("./upstream.js");
const { isStateMismatch } = await import("./jmap.js");
const {
  appFolderState,
  filesAccountId,
  findAppFileAt,
  readAppFileAt,
  readAppJsonAt,
  readVisibleFileAt,
  writeAppBytesAt,
  writeAppFileAt,
  writeBytesIntoVisibleFolder,
} = await import("./appFolder.js");
type Ctx = import("./appFolder.js").Ctx;

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const utf8 = new TextEncoder();

let ctx: Ctx;
let accountId: string;

before(async () => {
  // Importing the mock starts it listening (it is a process, not a factory),
  // which is what the server's own suites rely on too.
  await waitForPort(BASE, AUTH);
  const session = await fetchUpstreamSession(AUTH, BASE);
  ctx = { authorization: AUTH, session, username: "demo@example.com" };
  accountId = filesAccountId(ctx);
  assert.ok(accountId, "the demo account owns Files");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the same document written twice consumes one upload and leaves the state where it was", async () => {
  const path = "write-skip/same.json";
  const document = { v: 1, note: "a standing instruction", steps: ["a", "b"] };

  const uploadedBefore = mock.uploads.count;
  await writeAppFileAt(ctx, accountId, path, document);
  assert.equal(
    mock.uploads.count,
    uploadedBefore + 1,
    "the first write uploads the bytes it stores",
  );

  const first = (await findAppFileAt(ctx, accountId, path)).file;
  assert.ok(first?.id, "the write left a node to point at");
  // The token a conditional writer would carry, read once everything the first
  // write creates — the folders included — is in place.
  const state = await appFolderState(ctx, accountId);

  await writeAppFileAt(ctx, accountId, path, document);

  assert.equal(
    mock.uploads.count,
    uploadedBefore + 1,
    "rewriting the same document buys no second blob",
  );
  assert.equal(
    await appFolderState(ctx, accountId),
    state,
    "and does not advance the account's FileNode state",
  );
  const second = (await findAppFileAt(ctx, accountId, path)).file;
  assert.equal(second?.id, first.id, "the node is the one that was already there");
  assert.deepEqual(await readAppJsonAt(ctx, accountId, path), document);

  // The same document *value* is the same bytes however it was constructed:
  // key order is the writer's, not the caller's, so an equal document rebuilt
  // from a read is still not a write.
  const reread = (await readAppJsonAt(ctx, accountId, path)) as Record<string, unknown>;
  await writeAppFileAt(ctx, accountId, path, { ...reread, steps: ["a", "b"] });
  assert.equal(
    mock.uploads.count,
    uploadedBefore + 1,
    "an equal document rebuilt is equal",
  );
});

test("changed content consumes an upload and the new document is readable", async () => {
  const path = "write-skip/changed.json";
  await writeAppFileAt(ctx, accountId, path, { v: 1 });
  const afterFirst = mock.uploads.count;

  // Same byte length, different bytes: the case the size check alone cannot
  // settle, and the one the funnel has to read the blob back for.
  await writeAppFileAt(ctx, accountId, path, { v: 2 });
  assert.equal(mock.uploads.count, afterFirst + 1, "changed content is uploaded");
  assert.deepEqual(await readAppJsonAt(ctx, accountId, path), { v: 2 });

  // A different length costs no download at all: the size already proves the
  // document moved on.
  await writeAppFileAt(ctx, accountId, path, { v: 2, longer: "certainly" });
  assert.equal(mock.uploads.count, afterFirst + 2);
  assert.deepEqual(await readAppJsonAt(ctx, accountId, path), {
    v: 2,
    longer: "certainly",
  });
});

test("a conditional write of unchanged content succeeds without an upload, and a changed one still respects ifInState", async () => {
  const path = "write-skip/conditional.json";
  // A token read before the document existed, so it is stale by the time it is
  // used: what a writer re-applying a change after losing its race carries.
  const stale = await appFolderState(ctx, accountId);

  await writeAppFileAt(ctx, accountId, path, { v: 1 });
  assert.notEqual(await appFolderState(ctx, accountId), stale, "the write moved it");
  const uploaded = mock.uploads.count;

  // Unchanged content: the write is conditional on what the document *is*, and
  // it already is that, so nothing is uploaded, nothing is set, and the caller
  // is not told it lost a race it did not need to run.
  await writeAppFileAt(ctx, accountId, path, { v: 1 }, { ifInState: stale });
  assert.equal(
    mock.uploads.count,
    uploaded,
    "an unchanged conditional write buys nothing",
  );
  assert.deepEqual(await readAppJsonAt(ctx, accountId, path), { v: 1 });

  // Changed content against the same stale token: the compare-and-set is the
  // mock's own `stateMismatch` refusal, and the document is untouched by it.
  await assert.rejects(
    () => writeAppFileAt(ctx, accountId, path, { v: 3 }, { ifInState: stale }),
    (err: unknown) => isStateMismatch(err),
    "a stale token with changed content is still refused",
  );
  assert.deepEqual(await readAppJsonAt(ctx, accountId, path), { v: 1 });

  // The current token lands the change, which is the half of the pair that
  // proves the refusal above was `ifInState` and not the write itself.
  await writeAppFileAt(
    ctx,
    accountId,
    path,
    { v: 3 },
    { ifInState: await appFolderState(ctx, accountId) },
  );
  assert.deepEqual(await readAppJsonAt(ctx, accountId, path), { v: 3 });
});

test("the byte writers skip the same bytes too", async () => {
  const bytes = utf8.encode("Team agenda\n");
  const appPath = "write-skip/bytes.txt";

  await writeAppBytesAt(ctx, accountId, appPath, bytes, "text/plain");
  const uploaded = mock.uploads.count;
  const state = await appFolderState(ctx, accountId);

  await writeAppBytesAt(ctx, accountId, appPath, bytes, "text/plain");
  assert.equal(mock.uploads.count, uploaded, "the same bytes buy no second blob");
  assert.equal(
    await appFolderState(ctx, accountId),
    state,
    "and the state does not advance",
  );
  assert.equal((await readAppFileAt(ctx, accountId, appPath))?.text, "Team agenda\n");

  // Bytes of the same length that are not the same bytes: read back, compared,
  // and written because they differ.
  await writeAppBytesAt(
    ctx,
    accountId,
    appPath,
    utf8.encode("Team agenda!"),
    "text/plain",
  );
  assert.equal(mock.uploads.count, uploaded + 1);
  assert.equal((await readAppFileAt(ctx, accountId, appPath))?.text, "Team agenda!");

  // The writer into the visible tree is the same funnel, and it hands back the
  // id of the node: the id a caller names is the one already there.
  const folder = "write-skip-visible";
  const first = await writeBytesIntoVisibleFolder(
    ctx,
    accountId,
    folder,
    "agenda.txt",
    bytes,
    "text/plain",
  );
  const uploadedVisible = mock.uploads.count;
  const second = await writeBytesIntoVisibleFolder(
    ctx,
    accountId,
    folder,
    "agenda.txt",
    bytes,
    "text/plain",
  );
  assert.equal(mock.uploads.count, uploadedVisible, "the same bytes buy no second blob");
  assert.equal(second, first, "the node id is the one the file already had");
  assert.equal(
    (await readVisibleFileAt(ctx, accountId, `${folder}/agenda.txt`))?.text,
    "Team agenda\n",
  );
});
