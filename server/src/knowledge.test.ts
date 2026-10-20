import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Ctx } from "./appFolder.js";
import { freePort, jsonCall, postWith } from "./testkit.js";

/**
 * The knowledge base's Master-owned door (ADR 0020), end to end.
 *
 * The company KB is created at boot as the Master and read through the route;
 * every write goes through the route, which acts as the Master and gates
 * approval on the caller being an administrator. What these pin is
 * the lifecycle the ADR is built on: one shared draft per article, a revision
 * minted only at approval, an effective instant that puts the revision in force
 * now or leaves it pending, and history that is opened as a new draft rather
 * than edited. Each fails if the mechanism is removed.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-knowledge";
process.env.LOGIN_RATE_LIMIT = "10000";
process.env.GILBERT_AGENT_ADDRESS = "gilbert@example.com";
process.env.GILBERT_AGENT_PASSWORD = "gilbert-password";

const DEMO = "demo@example.com";

const mock = await import("./mock/index.js");
const { createApp, useDurableSessions } = await import("./app.js");
const { fileChildren, FILENODE_CAP, findAppFileAt, findFolderPath, writeAppFile } =
  await import("./appFolder.js");
const { clientOf } = await import("./util.js");
const { signInAsMaster } = await import("./bootstrap.js");
const {
  readArticle: readArticleDoor,
  listArticles: listArticlesDoor,
  requireState,
} = await import("./knowledgeAdmin.js");

await useDurableSessions(
  { read: async () => null, write: async () => {} },
  { ttlSeconds: 3600, rememberTtlSeconds: 86_400 },
);

/** The Master's own session, for reading a document back after a write. */
const master = await signInAsMaster({
  stalwartUrl: `http://127.0.0.1:${PORT}`,
  masterAddress: "gilbert@example.com",
  masterPassword: "gilbert-password",
});
const ctx: Ctx = {
  authorization: master.authorization,
  session: master.session,
  username: master.address,
};

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "gilbert" };

const call = jsonCall(app, HEADERS);

const post = postWith(call);

/** A summary as the routes echo it. */
interface Summary {
  id: string;
  title: string;
  folder: string;
  nodeId: string;
  saved: boolean;
  inForce: { revision: string; effectiveAt: string } | null;
  pending: { revision: string; effectiveAt: string } | null;
}

const summaryOf = (body: Record<string, unknown> | null): Summary => {
  const summary = body?.summary as Summary | undefined;
  assert.ok(summary, "the route answers with a summary");
  return summary;
};

/** The company KB's location, as the client's read route discovers it. */
async function company(): Promise<{ accountId: string; folderId: string }> {
  const res = await call("/api/knowledge/company");
  const where = res.body?.company as { accountId: string; folderId: string } | null;
  assert.ok(where?.folderId, "the company knowledge base is there at boot");
  return where;
}

/** The article as the door reads it — the document a route does not return. */
async function readBack(folder: string) {
  const where = await company();
  return readArticleDoor(ctx, where.accountId, where.folderId, folder);
}

/** How many `draft.json` documents an article folder holds. */
async function draftCount(folder: string): Promise<number> {
  const where = await company();
  const folderId = await findFolderPath(ctx, where.accountId, `knowledge/${folder}`);
  assert.ok(folderId, "the article folder is there");
  const nodes = await fileChildren(ctx, where.accountId, folderId);
  return nodes.filter((node) => node.name === "draft.json").length;
}

async function create(title: string): Promise<Summary> {
  const res = await post("/api/knowledge/create", { scope: "company", title });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return summaryOf(res.body);
}

async function save(folder: string, text: string): Promise<Summary> {
  const res = await post("/api/knowledge/save", {
    scope: "company",
    folder,
    input: { title: folder, tags: ["iso"], blocks: [], text },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return summaryOf(res.body);
}

async function approve(folder: string, effectiveAt: string): Promise<Summary> {
  const res = await post("/api/knowledge/approve", {
    scope: "company",
    folder,
    effectiveAt,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return summaryOf(res.body);
}

before(async () => {
  const res = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: DEMO, password: "demo-password" }),
  });
  assert.equal(res.status, 200, "the administrator signs in against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the company KB exists and the door creates, drafts and approves it", async () => {
  const where = await company();
  assert.ok(where.folderId, "the company knowledge base is there at boot");

  const article = await create("Quality manual");
  assert.equal(article.title, "Quality manual");
  assert.equal(article.saved, true);
  assert.equal(article.inForce, null, "nothing is in force before an approval");

  // One shared draft: two saves change one document, and the second save is
  // what the article now holds.
  const first = await save(article.folder, "first");
  const second = await save(article.folder, "second");
  assert.equal(first.id, article.id);
  assert.equal(second.id, article.id, "one draft, one identity");
  assert.equal(await draftCount(article.folder), 1, "one draft.json, never a second");
  assert.equal((await readBack(article.folder))?.draft?.text, "second");

  // A date already passed issues the revision at once.
  const issued = await approve(article.folder, new Date().toISOString());
  assert.ok(issued.inForce?.revision, "approval mints and points at a revision");
  assert.equal(issued.pending, null);
});

test("approval records the administrator who approved, never the agent", async () => {
  const article = await create("Attribution");
  const issued = await approve(article.folder, new Date().toISOString());
  assert.ok(issued.inForce?.revision);
  const view = await readBack(article.folder);
  const revision = view?.revisions.find((r) => r.revision === issued.inForce!.revision);
  assert.equal(
    revision?.approvedBy,
    DEMO,
    "the approver is the authenticated administrator, not the Master the door writes as",
  );
});

test("a future effective instant leaves the revision pending beside the one in force", async () => {
  const article = await create("Pending demo");
  const now = await approve(article.folder, new Date().toISOString());
  const current = now.inForce?.revision;
  assert.ok(current);

  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const pending = await approve(article.folder, future);
  assert.equal(
    pending.inForce?.revision,
    current,
    "the previous revision stays in force until the date arrives",
  );
  assert.ok(pending.pending?.revision, "the new revision waits in pending");
  assert.notEqual(pending.pending?.revision, current);
});

test("a restore copies the revision into a new draft and keeps the identity", async () => {
  const article = await create("Restore demo");
  const saved = await save(article.folder, "revision body");
  const issued = await approve(article.folder, new Date().toISOString());
  assert.ok(issued.inForce?.revision);
  // The draft moves on; the revision does not.
  await save(article.folder, "later draft");
  assert.equal((await readBack(article.folder))?.draft?.text, "later draft");

  const restored = await post("/api/knowledge/restore", {
    scope: "company",
    folder: article.folder,
    revision: issued.inForce!.revision,
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(summaryOf(restored.body).id, saved.id);
  // The invariant the route name promises: the revision's own body becomes the
  // draft, and the revision that was read is still there unchanged.
  const view = await readBack(article.folder);
  assert.equal(
    view?.draft?.text,
    "revision body",
    "the restore opened the revision as a draft",
  );
  assert.ok(
    view?.revisions.some((r) => r.revision === issued.inForce!.revision),
    "the revision is still in history, never edited",
  );
});

test("an article nothing can find is a 404, and a delete removes it", async () => {
  const missing = await post("/api/knowledge/save", {
    scope: "company",
    folder: "No such article",
    input: { title: "x", tags: [], blocks: [], text: "" },
  });
  assert.equal(missing.status, 404);

  const article = await create("Disposable");
  const removed = await post("/api/knowledge/delete", {
    scope: "company",
    folder: article.folder,
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
});

test("an article that was approved is retired, not destroyed", async () => {
  /*
   * Traceability (ADR 0020): an article something was issued from is never
   * removed — it is retired, kept with its revisions, and hidden from the tree
   * until a listing asks for retired articles.
   */
  const article = await create("Retire demo");
  const saved = await save(article.folder, "issued body");
  await approve(article.folder, new Date().toISOString());

  const removed = await post("/api/knowledge/delete", {
    scope: "company",
    folder: article.folder,
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(
    removed.body?.retired,
    true,
    "an approved article is retired, not removed",
  );

  const view = await readBack(article.folder);
  assert.ok(view, "the retired article is still there");
  assert.ok(view.summary.retired, "and is marked retired");
  assert.ok(view.revisions.length > 0, "with its revisions kept");

  const where = await company();
  const listed = await listArticlesDoor(ctx, where.accountId, where.folderId);
  assert.ok(
    !listed.some((a) => a.id === saved.id),
    "a retired article is not in the standing tree",
  );
  const withRetired = await listArticlesDoor(ctx, where.accountId, where.folderId, {
    includeRetired: true,
  });
  assert.ok(
    withRetired.some((a) => a.id === saved.id),
    "but a listing that asks for retired articles finds it",
  );
});

test("an article that was never approved is destroyed outright", async () => {
  const article = await create("Discard demo");
  await save(article.folder, "draft only");
  const removed = await post("/api/knowledge/delete", {
    scope: "company",
    folder: article.folder,
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body?.retired, false, "a draft nobody depended on is removed");
  assert.equal(await readBack(article.folder), null, "and it is gone");
});

test("the company tree and article are read through the route, not a share", async () => {
  /*
   * ADR 0020 reads the company tier through these two routes as the Master,
   * because a `shareWith` cannot name every account (the live probe's 10-share
   * cap). A boot that answered the location but not the tree would leave the
   * surface with nothing to draw, so both are pinned here.
   */
  const article = await create("Route read");
  await save(article.folder, "read through the route");

  const tree = await call("/api/knowledge/company/tree");
  assert.equal(tree.status, 200, JSON.stringify(tree.body));
  const articles = tree.body?.articles as Array<{ folder: string }> | undefined;
  assert.ok(
    articles?.some((a) => a.folder === article.folder),
    "the created article is in the tree the route answers",
  );

  const one = await call(
    `/api/knowledge/company/article?folder=${encodeURIComponent(article.folder)}`,
  );
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const view = one.body?.article as { draft?: { text?: string } } | null;
  assert.equal(view?.draft?.text, "read through the route");
});

test("a topic folder groups an article without becoming a page", async () => {
  const folderRes = await post("/api/knowledge/folder", {
    scope: "company",
    name: "Policies",
    parentFolder: null,
  });
  assert.equal(folderRes.status, 200, JSON.stringify(folderRes.body));
  const topic = summaryOf(folderRes.body);
  assert.equal(topic.saved, false, "a topic folder is not an article");

  const leafRes = await post("/api/knowledge/create", {
    scope: "company",
    title: "Returns",
    parentFolder: topic.folder,
  });
  assert.equal(leafRes.status, 200, JSON.stringify(leafRes.body));
  const leaf = summaryOf(leafRes.body);
  assert.equal(leaf.folder, `${topic.folder}/Returns`, "the leaf nests in the folder");

  const tree = await call("/api/knowledge/company/tree");
  const articles = tree.body?.articles as
    | Array<{ folder: string; kind: string }>
    | undefined;
  assert.ok(
    articles?.some((a) => a.folder === topic.folder && a.kind === "folder"),
    "the topic folder is in the tree as a group",
  );
  assert.ok(
    articles?.some((a) => a.folder === leaf.folder && a.kind === "article"),
    "the nested article is in the tree",
  );

  await save(leaf.folder, "nested body");
  const one = await call(
    `/api/knowledge/company/article?folder=${encodeURIComponent(leaf.folder)}`,
  );
  const view = one.body?.article as { draft?: { text?: string } } | null;
  assert.equal(view?.draft?.text, "nested body");
});

test("the revision number is minted from the article's own history", async () => {
  const article = await create("Numbered");
  await save(article.folder, "one");
  await approve(article.folder, new Date().toISOString());
  await save(article.folder, "two");
  await approve(article.folder, new Date().toISOString());
  const view = await readBack(article.folder);
  const revs = (view?.revisions ?? []).map((r) => r.rev).sort((a, b) => a - b);
  assert.deepEqual(revs, [1, 2], "each approval numbers one past the last");
});

test("a family is renumbered in one request when a drop's midpoint collapses", async () => {
  /*
   * A drop orders two neighbours by their midpoint, and the fractional gap runs
   * out of precision after enough drops into one slot. The client then sends the
   * whole family's new places at once; the route applies each, and the tree
   * reads back in the order the drop left it.
   */
  const a = await create("Renumber A");
  const b = await create("Renumber B");
  const c = await create("Renumber C");

  // A, B, C → C, A, B: the whole family renumbered 1..3 in the drop's order.
  const res = await post("/api/knowledge/reorder", {
    scope: "company",
    orders: [
      { folder: c.folder, order: 1 },
      { folder: a.folder, order: 2 },
      { folder: b.folder, order: 3 },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const tree = await call("/api/knowledge/company/tree");
  const articles = (tree.body?.articles as Array<{ folder: string }> | undefined) ?? [];
  const positions = [c.folder, a.folder, b.folder].map((f) =>
    articles.findIndex((x) => x.folder === f),
  );
  assert.ok(
    positions.every((p) => p >= 0),
    "every renumbered article is listed",
  );
  assert.ok(
    positions[0]! < positions[1]! && positions[1]! < positions[2]!,
    "the tree reads back in the order the renumber set",
  );
});

/** A minimal process definition: one variant, one section with one step. */
const processDef = {
  variants: [
    { key: "company", label: "Company", values: [{ value: "north", label: "North" }] },
  ],
  sections: [
    {
      key: "deposit",
      label: "Deposit",
      steps: [{ key: "load", label: "Load at the depot" }],
    },
  ],
};

test("a page created with a checklist definition is a checklist template", async () => {
  /*
   * A template is told from an ordinary page by its rules (ADR 0026): a create
   * that carries a checklist definition is flagged `template: "checklist"` from
   * its first moment, before any save, so the workorder picker offers it, and
   * the body is derived from the definition rather than authored as blocks.
   */
  const created = await post("/api/knowledge/create", {
    scope: "company",
    title: "Checklist template",
    checklist: processDef,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const summary = created.body?.summary as { template?: unknown } | undefined;
  assert.equal(summary?.template, "checklist");

  const plain = await post("/api/knowledge/create", {
    scope: "company",
    title: "Ordinary page",
    blocks: [
      { type: "checkListItem", id: "s1", content: [{ type: "text", text: "One" }] },
    ],
  });
  const plainSummary = plain.body?.summary as { template?: unknown } | undefined;
  assert.equal(
    plainSummary?.template,
    null,
    "checklist-looking blocks alone do not make a template",
  );
});

test("a template's draft carries the definition and its derived steps", async () => {
  const res = await post("/api/knowledge/create", {
    scope: "company",
    title: "Derived checklist",
    checklist: processDef,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const summary = summaryOf(res.body);
  const view = await readBack(summary.folder);
  assert.ok(view?.draft, "the created article has a draft");
  assert.deepEqual(
    view.draft.checklist,
    processDef,
    "the definition travels with the draft",
  );
  assert.deepEqual(
    view.draft.blocks.map((block) => (block as { type?: unknown }).type),
    ["heading", "checkListItem"],
    "the body is derived from the definition, never authored as blocks",
  );
});

test("a conditional KB write refuses an empty account state rather than writing unconditionally", () => {
  /*
   * `ifInState: token || undefined` degraded a conditional write to an
   * unconditional one whenever the account stated no state — a write that could
   * then silently replace one another writer had just made. The one helper every
   * KB write takes its token from refuses instead.
   */
  assert.throws(
    () => requireState(""),
    (err: unknown) => (err as { code?: string }).code === "no_state",
  );
  assert.equal(requireState("state-7"), "state-7", "a stated state is handed through");
});

test("a rename that loses the race on its title re-resolves the article by id", async () => {
  /*
   * The rename moves the folder, then writes the title documents. A title write
   * that loses the account-wide compare-and-set retries — and the retry must
   * read the article where the rename left it, by the node id that did not
   * change, rather than rename the vanished path a second time (which left the
   * title stale and the folder doubled). A foreign write is injected after the
   * rename so the first title write loses.
   */
  const article = await create("Rename race");
  const where = await company();
  const real = globalThis.fetch;
  let renamed = false;
  let injected = false;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (
      body.includes("FileNode/set") &&
      body.includes('"update"') &&
      body.includes('"name"')
    ) {
      renamed = true;
    } else if (
      renamed &&
      !injected &&
      body.includes("FileNode/get") &&
      body.includes('"ids":[]')
    ) {
      injected = true;
      const res = await real(input, init);
      await writeAppFile(ctx, where.accountId, "race-probe.json", { v: 1 });
      return res;
    }
    return real(input, init);
  }) as typeof fetch;
  let res: Awaited<ReturnType<typeof post>>;
  try {
    res = await post("/api/knowledge/rename", {
      scope: "company",
      folder: article.folder,
      title: "Renamed once",
    });
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(injected, "the foreign write landed after the rename");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(
    summaryOf(res.body).folder,
    "Renamed once",
    "the folder is renamed once, not a second time on the retry",
  );
  const view = await readBack("Renamed once");
  assert.equal(view?.summary.title, "Renamed once", "and the title moved with it");
  const tree = await call("/api/knowledge/company/tree");
  const folders = (
    (tree.body?.articles as Array<{ folder: string }> | undefined) ?? []
  ).map((a) => a.folder);
  assert.ok(
    !folders.some((folder) => folder.startsWith("Renamed once (")),
    "no doubled folder was left behind",
  );
});

test("a create whose listing key cannot be written is not left half-made", async () => {
  /*
   * A create writes the draft and then the listing key (`state.json`). A
   * listing key that never lands leaves a directory with no `state.json`, which
   * the tree reads as a topic folder — invisible as an article, its name taken.
   * A refused write takes the folder back with it, so the name is free again.
   */
  const real = globalThis.fetch;
  let injected = false;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (!injected && body.includes("FileNode/set") && body.includes('"state.json"')) {
      injected = true;
      return new Response("refused", { status: 500 });
    }
    return real(input, init);
  }) as typeof fetch;
  let res: Awaited<ReturnType<typeof post>>;
  try {
    res = await post("/api/knowledge/create", { scope: "company", title: "Half made" });
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(injected, "the listing key's write was made to fail");
  assert.notEqual(res.status, 200, "the create reports the failure");
  // The name is free again: a second create lands it rather than getting a
  // numbered sibling from the orphaned directory.
  const again = await create("Half made");
  assert.equal(again.folder, "Half made", "no orphan kept the name");
});

/**
 * A save refuses to replace an article document it cannot read.
 *
 * The shared draft and its listing key are read together, and a save that reads
 * either as absent treats the article as new: it mints an `id` and writes the
 * lifecycle pointers back as `null`, which revives a retired article and loses
 * the revision in force. A document whose bytes cannot be read reads as absent
 * in a reader's eyes, so the save refuses it instead — and nothing is uploaded
 * to replace what it could not read.
 */
test("a save refuses to replace an article document it cannot read", async () => {
  const article = await create("Unreadable draft");
  await save(article.folder, "body");
  const where = await company();
  const path = `knowledge/${article.folder}/draft.json`;
  const draft = await findAppFileAt(ctx, where.accountId, path);
  const nodeId = draft.file?.id;
  assert.ok(nodeId, "the article has a draft document to read");
  await clientOf(ctx).call(
    "FileNode/set",
    {
      accountId: where.accountId,
      update: { [String(nodeId)]: { blobId: "no-such-blob" } },
    },
    [FILENODE_CAP],
  );

  const uploaded = mock.uploads.count;
  const refused = await post("/api/knowledge/save", {
    scope: "company",
    folder: article.folder,
    input: { title: article.folder, tags: [], blocks: [], text: "another body" },
  });
  assert.equal(refused.status, 502, JSON.stringify(refused.body));
  assert.equal(refused.body?.error, "article_unreadable");
  assert.equal(mock.uploads.count, uploaded, "nothing was uploaded to replace it with");
  const after = await findAppFileAt(ctx, where.accountId, path);
  assert.equal(after.file?.blobId, "no-such-blob", "the document is where it was");
});
