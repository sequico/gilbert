import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { isAppFolder } from "./shared/appFolder.js";
import { freePort, waitForPort } from "./testkit.js";

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

const PORT = await freePort();
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
  ensureAppFolder,
  FILENODE_CAP,
  fileChildren,
  filesAccountId,
  findAppFileAt,
  findAppFolder,
  readAppFileAt,
  readAppJsonAt,
  readAppJsonForWrite,
  readVisibleFileAt,
  writeAppBytesAt,
  writeAppFileAt,
  writeBytesIntoVisibleFolder,
} = await import("./appFolder.js");
const { clientOf } = await import("./util.js");
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

/**
 * The find-then-create the two tiers share (`@gilbert/shared/appFolder`).
 *
 * Every document Gilbert keeps lives in this folder, so the first boot creates
 * it and every later boot has to find the one that is there. A tier that
 * created instead of finding would answer with a second folder of the same name
 * — the account would then hold two `gilbert` folders, writes would land in
 * whichever came back first, and nothing would report a problem.
 */
test("the app folder is found after it has been created, not created again", async () => {
  const created = await ensureAppFolder(ctx, accountId);
  const again = await ensureAppFolder(ctx, accountId);
  assert.equal(again, created, "the second ask is answered by the folder already there");
  assert.equal(await findAppFolder(ctx, accountId), created);

  const top = await fileChildren(ctx, accountId, null, [
    "id",
    "name",
    "nodeType",
    "parentId",
  ]);
  assert.equal(
    top.filter(isAppFolder).length,
    1,
    "the account holds one app folder, however many writers asked for it",
  );
});

/**
 * A document that is there and cannot be read is not an absent one.
 *
 * `readAppJsonAt` answers both as `null`, which is right for a reader — a
 * corrupt document must not take a surface down. A writer about to *replace*
 * the document needs the difference: read as absent, a read-modify-write lands
 * the one change it was making over everything the account held.
 */
test("a file whose bytes do not come back is unreadable, not absent", async () => {
  const folderId = await ensureAppFolder(ctx, accountId);
  // A node whose blob this server does not hold: the file is there, so the
  // document is not absent, and its bytes cannot be read.
  await clientOf(ctx).call(
    "FileNode/set",
    {
      accountId,
      create: {
        n: {
          parentId: folderId,
          name: "unreadable.json",
          blobId: "no-such-blob",
          type: "application/json",
          nodeType: "file",
        },
      },
    },
    [FILENODE_CAP],
  );

  assert.equal(await readAppJsonAt(ctx, accountId, "unreadable.json"), null);
  assert.deepEqual(await readAppJsonForWrite(ctx, accountId, "unreadable.json"), {
    kind: "unreadable",
  });
  // A path with nothing at it is the one answer a writer may create over.
  assert.deepEqual(await readAppJsonForWrite(ctx, accountId, "unreadable/absent.json"), {
    kind: "absent",
  });
});

/**
 * A blob read that asks for a ceiling gets one.
 *
 * Every read of a stranger's bytes — an attachment, a file in the group's
 * Files — goes through `downloadBlob`, and before this it held whatever the
 * server sent: a body of unknown size was buffered whole and measured after.
 * The ceiling is enforced as the stream arrives, so what a sender put in a
 * message cannot become however many megabytes in the process.
 */
test("a blob past its ceiling is refused, and reads whole within it", async () => {
  const path = "oversize/big.json";
  await writeAppFileAt(ctx, accountId, path, { v: 1, pad: "x".repeat(5000) });
  const file = (await findAppFileAt(ctx, accountId, path)).file;
  assert.ok(file?.blobId, "the write left a blob to read");
  const client = clientOf(ctx);
  const blobId = String(file.blobId);

  await assert.rejects(
    () => client.downloadBlob(accountId, blobId, "big.json", "application/json", 100),
    /larger than the 100 bytes/,
    "a read with a ceiling of its own refuses the blob past it",
  );

  const whole = await client.downloadBlob(
    accountId,
    blobId,
    "big.json",
    "application/json",
  );
  assert.ok(whole.byteLength > 100, "and the same blob reads whole within the ceiling");
});

/**
 * The guard, at the writer a person actually reaches.
 *
 * `readAppJsonForWrite` separating the two answers is only half of it: what
 * matters is that the doors *act* on the difference. The identity door writes
 * one key into the account's own `settings.json`, so reading a file that could
 * not be read as an empty one would replace every setting the account holds with
 * the default identity alone — the same data loss, on an ordinary admin click.
 */
test("a writer refuses to replace a settings document it cannot read", async () => {
  const folderId = await ensureAppFolder(ctx, accountId);
  await clientOf(ctx).call(
    "FileNode/set",
    {
      accountId,
      create: {
        n: {
          parentId: folderId,
          name: "settings.json",
          blobId: "no-such-blob-2",
          type: "application/json",
          nodeType: "file",
        },
      },
    },
    [FILENODE_CAP],
  );
  const { writeDefaultIdentity, IdentityAdminError } = await import("./identityAdmin.js");
  const uploaded = mock.uploads.count;

  await assert.rejects(
    () => writeDefaultIdentity(ctx, accountId, "identity-1"),
    (err: unknown) =>
      err instanceof IdentityAdminError &&
      (err as { code?: string }).code === "settings_unreadable",
  );
  assert.equal(
    mock.uploads.count,
    uploaded,
    "and nothing was uploaded to replace it with",
  );
});
