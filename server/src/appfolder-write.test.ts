import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { FILE_PROPS, FOLDER_PROPS, isAppFolder } from "./shared/appFolder.js";
import { freePort, waitForPort } from "./testkit.js";

/**
 * The app-folder funnel's guarantees, against the mock Stalwart.
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
 *
 * The other half is the read. Resolving one request's documents walks the same
 * levels over and over and every walk is a round trip; `fileChildren` remembers
 * a level for as long as the request runs (`requestMemory.ts`) and a write
 * forgets it — both counted here too, because the mock answers every call in the
 * same process, so a level read seven times costs nothing visible in the time
 * this suite takes.
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
  AppFolderError,
  appFolderState,
  destroyAppNode,
  ensureAppFolder,
  ensureFolderPath,
  FILENODE_CAP,
  fileChildren,
  filesAccountId,
  findAppFileAt,
  findAppFolder,
  readAppFileAt,
  readAppJsonAt,
  readAppJsonForWrite,
  readVisibleFileAt,
  unusedVisibleName,
  writeAppBytesAt,
  writeAppFileAt,
  writeAppFileIn,
  writeBytesIntoVisibleFolder,
} = await import("./appFolder.js");
const { clientOf } = await import("./util.js");
type Ctx = import("./appFolder.js").Ctx;

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const utf8 = new TextEncoder();

/*
 * One `Ctx` for the whole file, deliberately: production builds one per HTTP
 * request, and the guarantee under test is "a level is read once per `Ctx`", so
 * the suite's own memory spans its tests. A test that reads a level without
 * having written first is served what an earlier test read -- write first, as
 * every one of them does, or build a `Ctx` of its own to stand in for a request.
 */
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

/**
 * Run `run` with the process's `fetch` wrapped, and put it back afterwards.
 *
 * A suite counts reads and stages a race by watching what goes to the mail
 * server, and both are the same act: stand in front of `fetch`, look at the
 * call, hand it on. The hook runs once the answer is in hand and before its
 * caller resumes, which is where a write has to land to be a race and where a
 * count is neither early nor late. The restore is the part that must never be
 * forgotten, so it is written once.
 */
async function withFetchHook<T>(
  hook: (res: Response, init?: RequestInit) => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await real(input, init);
    await hook(res, init);
    return res;
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

/**
 * How many level reads go out while `run` runs.
 *
 * The mock answers every call in the same process, so a level read seven times
 * costs nothing a suite can see in the time it takes. Counting what was asked is
 * the only way to hold a guarantee about how much a unit of work reads. The pair
 * a level read is (`FileNode/query` then `FileNode/get`) travels in one request,
 * and both names count it once.
 */
async function queriesDuring<T>(
  run: () => Promise<T>,
): Promise<{ result: T; queries: number }> {
  let queries = 0;
  const result = await withFetchHook(async (_res, init) => {
    if (typeof init?.body === "string" && /FileNode\/(query|get)/.test(init.body))
      queries += 1;
  }, run);
  return { result, queries };
}

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

/**
 * The document a create was refused over is the one the caller asked for.
 *
 * A write looks the name up first, and a second writer of the same new name can
 * commit it between that lookup and the create — which the server then refuses
 * `alreadyExists`. The refusal is neither a failure nor a no-op: the node the
 * refusal names is where these bytes belong, so the write lands them there.
 * Reading only the create's id, which a refusal does not carry, would leave the
 * bytes unstored while the caller was told the write succeeded.
 */
test("a create refused because the name is taken writes into the node that holds it", async () => {
  const folderId = await ensureAppFolder(ctx, accountId);
  // A node holding the name with no bytes yet: what a writer's own lookup does
  // not count as the document (it wants a `blobId`), and what the create then
  // collides with.
  const held = await clientOf(ctx).call<{ created?: Record<string, { id?: string }> }>(
    "FileNode/set",
    {
      accountId,
      create: {
        n: {
          parentId: folderId,
          name: "raced.json",
          blobId: null,
          type: "application/json",
          nodeType: "file",
        },
      },
    },
    [FILENODE_CAP],
  );
  const nodeId = held.created?.n?.id;
  assert.ok(nodeId, "the node that holds the name is there");

  await writeAppFileIn(ctx, accountId, folderId, "raced.json", { v: 1 });

  assert.deepEqual(
    await readAppJsonAt(ctx, accountId, "raced.json"),
    { v: 1 },
    "the refused write's bytes are stored",
  );
  const { file } = await findAppFileAt(ctx, accountId, "raced.json");
  assert.equal(file?.id, nodeId, "in the node that already held the name");
});

/**
 * A refused removal is the caller's to see.
 *
 * `FileNode/set` answers a refusal inside `notDestroyed` in an otherwise
 * successful response — a folder that still holds something is the everyday
 * one — and a destroy that reads only the call's own success reports a removal
 * that never happened. Missing stays success; a refusal is thrown.
 */
test("a refused destroy reaches the caller, and a missing node does not", async () => {
  const folderId = await ensureFolderPath(ctx, accountId, "destroy-refused");
  await writeAppFileIn(ctx, accountId, folderId, "inside.json", { v: 1 });

  await assert.rejects(
    () => destroyAppNode(ctx, accountId, folderId),
    (err: unknown) => err instanceof AppFolderError,
    "a folder that still holds a file is refused, and the refusal is thrown",
  );

  await destroyAppNode(ctx, accountId, folderId, { removeChildren: true });
  // Gone is not refused: removing a node that is no longer there is the
  // "missing is success" `removeAppFile` relies on.
  await destroyAppNode(ctx, accountId, folderId);
});

/**
 * A level larger than one page is read whole.
 *
 * Folders here only grow — one chat file per message, an article's revisions,
 * an agent's jobs, the workorder registry — and a reader handed the first page
 * alone sees an arbitrary subset of the level, which is how a write misses the
 * document that is there and makes a second one.
 */
test("a folder whose level outgrows one page is read whole", async () => {
  const folderId = await ensureFolderPath(ctx, accountId, "many-nodes");
  const count = 1005; // past the 1000-node page
  // A `/set` carries at most 500 objects (the mock's ceiling, and a real
  // server's), so the fixture is built a batch at a time, the way any writer
  // filling a level past a page has to.
  const batch = 400;
  for (let from = 0; from < count; from += batch) {
    const create: Record<string, unknown> = {};
    for (let n = from; n < Math.min(from + batch, count); n++)
      create[`n${n}`] = {
        parentId: folderId,
        name: `file-${n}.json`,
        blobId: null,
        type: "application/json",
        nodeType: "file",
      };
    await clientOf(ctx).call("FileNode/set", { accountId, create }, [FILENODE_CAP]);
  }

  const children = await fileChildren(ctx, accountId, folderId);
  assert.equal(children.length, count, "every node of the level comes back");
});

/**
 * A free numbered name costs one listing of the folder.
 *
 * `unusedVisibleName` picks the first free `n-name.txt` an extract may write
 * under, so a person's existing files are not replaced. Asking `findVisibleFile`
 * per candidate walked the folder path from the root for every number it tried:
 * a folder already holding hundreds of `n-note.txt` files meant hundreds of
 * round trips, and the search could be refused part-way through. The folder is
 * read once now, and this counts the queries the account was actually asked.
 */
test("a free numbered name lists the folder once", async () => {
  const folder = "name-search";
  const taken = 20;
  for (let n = 1; n <= taken; n++) {
    await writeBytesIntoVisibleFolder(
      ctx,
      accountId,
      folder,
      n === 1 ? "note.txt" : `${n}-note.txt`,
      utf8.encode(`note ${n}\n`),
      "text/plain",
    );
  }

  const { result: name, queries } = await queriesDuring(() =>
    unusedVisibleName(ctx, accountId, folder, "note.txt"),
  );

  assert.equal(
    name,
    `${taken + 1}-note.txt`,
    "the first free number is the next one past what the folder holds",
  );
  // Two level reads whatever the candidate count -- the folder path's walk and
  // the level's own listing -- against two per candidate before.
  assert.ok(
    queries <= 2,
    `the folder is listed once, not once per candidate (${queries} reads)`,
  );
});

/** The naming rule itself: a name nothing holds is returned as it stands. */
test("a name the folder does not hold is used unchanged", async () => {
  const folder = "name-free";
  await writeBytesIntoVisibleFolder(
    ctx,
    accountId,
    folder,
    "taken.txt",
    utf8.encode("x"),
    "text/plain",
  );
  assert.equal(await unusedVisibleName(ctx, accountId, folder, "fresh.txt"), "fresh.txt");
});

/**
 * A level is read once per request, however often that request looks at it.
 *
 * Resolving one request's documents -- a workorder, its parts, the template it
 * instantiates -- walks the same folders over and over, and every walk was a
 * query and a get against the mail server: a click on one checklist step asked
 * it a hundred times. The level is remembered for as long as the request runs
 * (`requestMemory.ts`) and no longer, so the next request reads it again.
 */
test("a level is listed once however often one request reads it", async () => {
  await ensureFolderPath(ctx, accountId, "levels/read-once");

  const first = await queriesDuring(() =>
    findAppFileAt(ctx, accountId, "levels/read-once/one.json"),
  );
  assert.ok(first.queries > 0, "the first lookup walks the path from the app folder");

  const again = await queriesDuring(() =>
    findAppFileAt(ctx, accountId, "levels/read-once/two.json"),
  );
  assert.equal(
    again.queries,
    0,
    "a second lookup in the same request reads nothing it has already read",
  );

  const later: Ctx = {
    authorization: AUTH,
    session: await fetchUpstreamSession(AUTH, BASE),
    username: "demo@example.com",
  };
  const other = await queriesDuring(() =>
    findAppFileAt(later, accountId, "levels/read-once/three.json"),
  );
  assert.ok(
    other.queries > 0,
    "the next request reads the level for itself, having seen nothing of this one",
  );
});

/**
 * A write is what makes a listing wrong, and a reader cannot see who writes.
 *
 * The memory is dropped by every write in the process, not only by the writer's
 * own: a request, a suite's fixture and the agent beside the server all write
 * through the same mail client, and a reader served a listing from before a
 * write it never made would read a folder as it was.
 */
test("a level read before a write is read again after it", async () => {
  const folderId = await ensureFolderPath(ctx, accountId, "levels/written-into");
  assert.deepEqual(
    (await fileChildren(ctx, accountId, folderId, FOLDER_PROPS)).map((n) => n.name),
    [],
    "the folder starts empty in this request's own listing",
  );

  await writeAppFileAt(ctx, accountId, "levels/written-into/note.json", { v: 1 });

  assert.deepEqual(
    (await fileChildren(ctx, accountId, folderId, FOLDER_PROPS)).map((n) => n.name),
    ["note.json"],
    "the file the write made is in the level read after it",
  );

  // Somebody else's write, in a request of its own.
  const other: Ctx = {
    authorization: AUTH,
    session: await fetchUpstreamSession(AUTH, BASE),
    username: "demo@example.com",
  };
  await fileChildren(ctx, accountId, folderId, FOLDER_PROPS);
  await writeAppFileAt(other, accountId, "levels/written-into/second.json", { v: 2 });

  assert.deepEqual(
    (await fileChildren(ctx, accountId, folderId, FOLDER_PROPS)).map((n) => n.name),
    ["note.json", "second.json"],
    "a write this reader never made makes its listing wrong too",
  );
});

/**
 * A write that lands while a level is being read is not read over.
 *
 * Every write drops the memories, and a read that is already in flight answers
 * with what the server held when it was asked: remembering that answer would put
 * a listing from before the write back into the memory the write just cleared,
 * and every later lookup in this request would be served it. The write here is
 * made *inside* the read's own round trip -- the only place the race exists, and
 * the only way a sequential suite reaches it.
 */
test("a write while a level is being read is not read over", async () => {
  const folderId = await ensureFolderPath(ctx, accountId, "levels/in-flight");
  await writeAppFileAt(ctx, accountId, "levels/in-flight/first.json", { v: 1 });

  let overlapped = false;
  const listed = await withFetchHook(
    async (_res, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      // The read's own answer is in hand; the write lands before the reader can
      // remember it.
      if (!overlapped && body.includes(folderId)) {
        overlapped = true;
        await writeAppFileAt(ctx, accountId, "levels/in-flight/second.json", { v: 2 });
      }
    },
    async () =>
      (await fileChildren(ctx, accountId, folderId, FOLDER_PROPS)).map((n) => n.name),
  );

  assert.equal(overlapped, true, "the read really was overlapped by a write");
  assert.deepEqual(listed, ["first.json"], "the read answers with what it asked for");

  assert.deepEqual(
    (await fileChildren(ctx, accountId, folderId, FOLDER_PROPS)).map((n) => n.name),
    ["first.json", "second.json"],
    "the level the overlapping write changed is read again, not served from before it",
  );
});

/**
 * One read serves the folder lookup and the file lookup.
 *
 * `readProps` widens the caller's property list to `FILE_PROPS` (`appFolder.ts`),
 * because that set carries everything `FOLDER_PROPS` names: a caller asking for
 * the folders and a caller asking for the files of one level are answered by the
 * same read. Without that widening the walk from the app folder to a file is two
 * reads of the level it lands in, which is most of what made a click on a
 * checklist step a hundred round trips -- so it is pinned here, where the counts
 * live.
 */
test("one read serves both property sets", async () => {
  const folderId = await ensureFolderPath(ctx, accountId, "levels/one-read");
  await writeAppFileAt(ctx, accountId, "levels/one-read/a.json", { v: 1 });
  await writeAppFileAt(ctx, accountId, "levels/one-read/b.json", { v: 2 });

  const folders = await queriesDuring(() =>
    fileChildren(ctx, accountId, folderId, FOLDER_PROPS),
  );
  const files = await queriesDuring(() =>
    fileChildren(ctx, accountId, folderId, FILE_PROPS),
  );

  assert.ok(folders.queries > 0, "the first of the two reads goes to the mail server");
  assert.equal(files.queries, 0, "the second is answered by the first, wider read");
  assert.deepEqual(
    files.result.map((n) => n.name),
    ["a.json", "b.json"],
    "and it names every node of the level",
  );
});
