import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/**
 * The capability runner against the mock (ADR 0003 resolution 2).
 *
 * Every name in the catalogue is exercised where the mock can honour it: a
 * keyword on a real message, a move into a folder that has to be created, an
 * attachment written into the group's Files, a draft left unread in Drafts, a
 * chat post and a file. The one thing that cannot be exercised here is a real
 * submission's delivery — the mock records the submission without an MTA — so
 * `mail.send` is covered through the executor's approval test instead of here.
 */

const PORT = 18843;
process.env.MOCK_PORT = String(PORT);

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { readAppFileAt, writeAppFileAt } = await import("../appFolder.js");
const { JmapClient } = await import("../jmap.js");
const { fetchEmailRecord, runActions, undefinedAgentLabels } = await import(
  "./actions.js"
);
const { GROUP_LABELS_FILE } = await import("../shared/labels.js");
const { readChat } = await import("./chat.js");

const BASE = `http://127.0.0.1:${PORT}`;
const GROUP = "a3";
const AGENT = "gilbert@example.com";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo").toString("base64")}`;

const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };
const client = new JmapClient(AUTH, session);

let draftsId = "";
let messageId = "";
let attachedId = "";

async function createMessage(input: {
  subject: string;
  to?: string;
  text?: string;
  attachment?: { blobId: string; name: string; type: string };
}): Promise<string> {
  const bodyValues: Record<string, { value: string }> = {
    t: { value: input.text ?? "" },
  };
  const text = { partId: "t", type: "text/plain" };
  const created = await client.call<{
    created?: Record<string, { id?: string }>;
    notCreated?: Record<string, unknown>;
  }>(
    "Email/set",
    {
      accountId: GROUP,
      create: {
        m: {
          mailboxIds: { "g-inbox": true },
          keywords: {},
          subject: input.subject,
          from: [{ name: "Ada Lovelace", email: "ada@example.org" }],
          to: input.to ? [{ email: input.to }] : undefined,
          bodyStructure: input.attachment
            ? {
                type: "multipart/mixed",
                subParts: [text, { ...input.attachment, disposition: "attachment" }],
              }
            : text,
          bodyValues,
        },
      },
    },
    ["urn:ietf:params:jmap:mail"],
  );
  const id = created.created?.m?.id;
  assert.ok(id, `the mock created the message: ${JSON.stringify(created.notCreated)}`);
  return id;
}

before(async () => {
  // The group's own catalog: the `G-` set the admin surface creates once the
  // operator has granted the agent, and one human label.
  await writeAppFileAt(ctx, GROUP, GROUP_LABELS_FILE, {
    labels: [
      { keyword: "G-processed", name: "Gilbert: processed", color: "#15803d" },
      { keyword: "G-needattention", name: "Gilbert: needs attention", color: "#b91c1c" },
      { keyword: "G-awaiting", name: "Gilbert: awaiting approval", color: "#b45309" },
      { keyword: "invoice", name: "Invoice", color: "#2563eb" },
    ],
  });
  const drafts = await client.call<{ created?: Record<string, { id?: string }> }>(
    "Mailbox/set",
    {
      accountId: GROUP,
      create: { d: { name: "Drafts", role: "drafts", parentId: null } },
    },
    ["urn:ietf:params:jmap:mail"],
  );
  draftsId = drafts.created?.d?.id ?? "";
  messageId = await createMessage({ subject: "An invoice to file", text: "please file" });
  const blobId = await client.upload(
    GROUP,
    new TextEncoder().encode("the attachment's own bytes"),
    "text/plain",
  );
  attachedId = await createMessage({
    subject: "With an attachment",
    attachment: { blobId, name: "note.txt", type: "text/plain" },
  });
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a required parameter that is absent is refused before anything runs", async () => {
  await assert.rejects(
    () => runActions(ctx, GROUP, [{ do: "file.write", with: { folder: "notes" } }]),
    /needs name, text to run/,
  );
});

test("a G- keyword the group's catalog does not define is refused loudly", async () => {
  const missing = await undefinedAgentLabels(ctx, GROUP, [
    { do: "keyword.add", with: { keyword: "G-nobody-defined-this" } },
  ]);
  assert.deepEqual(missing, ["G-nobody-defined-this"]);
  await assert.rejects(
    () =>
      runActions(
        ctx,
        GROUP,
        [{ do: "keyword.add", with: { keyword: "G-nobody-defined-this" } }],
        { emailId: messageId },
      ),
    /does not define G-nobody-defined-this/,
  );
  const after_ = await fetchEmailRecord(client, GROUP, messageId, {});
  assert.equal(
    (after_?.keywords as Record<string, unknown> | undefined)?.["G-nobody-defined-this"],
    undefined,
    "nothing was applied",
  );
});

test("a G- keyword the catalog defines is applied and removed", async () => {
  await runActions(
    ctx,
    GROUP,
    [
      { do: "keyword.add", with: { keyword: "G-processed" } },
      { do: "keyword.add", with: { keyword: "invoice" } },
    ],
    { emailId: messageId },
  );
  const marked = await fetchEmailRecord(client, GROUP, messageId, {});
  assert.equal((marked?.keywords as Record<string, unknown>)?.["G-processed"], true);
  assert.equal((marked?.keywords as Record<string, unknown>)?.invoice, true);
  await runActions(
    ctx,
    GROUP,
    [{ do: "keyword.remove", with: { keyword: "G-processed" } }],
    { emailId: messageId },
  );
  const cleared = await fetchEmailRecord(client, GROUP, messageId, {});
  assert.equal(
    (cleared?.keywords as Record<string, unknown>)?.["G-processed"],
    undefined,
  );
});

test("a move creates the folder when the action says so, and moves the message", async () => {
  const [result] = await runActions(
    ctx,
    GROUP,
    [{ do: "mail.move", with: { mailbox: "Filed invoices", create: "true" } }],
    { emailId: messageId },
  );
  assert.ok(result?.result?.mailboxId, "the folder it created is named in the result");
  const moved = await fetchEmailRecord(client, GROUP, messageId, {});
  assert.deepEqual(
    moved?.mailboxIds,
    { [String(result?.result?.mailboxId)]: true },
    "a move replaces the mailbox set",
  );
});

test("a move into a folder that is not there is refused when the action does not create it", async () => {
  await assert.rejects(
    () =>
      runActions(ctx, GROUP, [{ do: "mail.move", with: { mailbox: "Nowhere" } }], {
        emailId: messageId,
      }),
    /no mailbox named "Nowhere"/,
  );
});

test("attachments are written into the folder the rule names, with their own bytes", async () => {
  const [result] = await runActions(
    ctx,
    GROUP,
    [{ do: "mail.extract", with: { folder: "invoices/2026" } }],
    { emailId: attachedId },
  );
  assert.deepEqual(result?.result?.saved, ["invoices/2026/note.txt"]);
  const written = await readAppFileAt(ctx, GROUP, "invoices/2026/note.txt");
  assert.ok(written, "the file is in the group's own Files");
  assert.equal(written.text, "the attachment's own bytes");
});

test("a message without attachments extracts nothing, and says so", async () => {
  const [result] = await runActions(
    ctx,
    GROUP,
    [{ do: "mail.extract", with: { folder: "nowhere" } }],
    { emailId: messageId },
  );
  assert.deepEqual(result?.result?.saved, []);
});

test("a draft lands in Drafts, marked $draft and deliberately unread", async () => {
  assert.ok(draftsId, "the group has a Drafts mailbox");
  const [result] = await runActions(ctx, GROUP, [
    {
      do: "mail.draft",
      with: {
        to: "Ada Lovelace <ada@example.org>",
        subject: "Re: an invoice",
        text: "On it.",
      },
    },
  ]);
  const emailId = String(result?.result?.emailId ?? "");
  assert.ok(emailId);
  assert.equal(result?.result?.mailboxId, draftsId);
  const draft = await fetchEmailRecord(client, GROUP, emailId, {});
  assert.equal((draft?.keywords as Record<string, unknown>)?.$draft, true);
  assert.equal(
    (draft?.keywords as Record<string, unknown>)?.$seen,
    undefined,
    "Gilbert's pending drafts are kept unread so a human sees them",
  );
  assert.deepEqual(draft?.mailboxIds, { [draftsId]: true });
  const to = draft?.to as Array<{ name?: string; email?: string }> | undefined;
  assert.equal(to?.[0]?.email, "ada@example.org");
  assert.equal(to?.[0]?.name, "Ada Lovelace");
});

test("a file is written where the action names it", async () => {
  await runActions(ctx, GROUP, [
    { do: "file.write", with: { folder: "notes", name: "summary.txt", text: "done" } },
  ]);
  const written = await readAppFileAt(ctx, GROUP, "notes/summary.txt");
  assert.equal(written?.text, "done");
});

test("a chat post becomes a message document, and its mentions are recorded", async () => {
  const posted = await runActions(
    ctx,
    GROUP,
    // The mention is the `@` plus the address; it ends at the whitespace (or
    // the end of the text), so a trailing full stop is not part of it.
    [{ do: "chat.post", with: { text: "Filed it for @ada@example.org" } }],
    { from: AGENT, participants: [AGENT, "ada@example.org"] },
  );
  const nodeId = String(posted[0]?.result?.nodeId ?? "");
  assert.ok(nodeId, "the post reports the node it wrote");
  const messages = await readChat(ctx, GROUP, client);
  const mine = messages.find((message) => message.id === nodeId);
  assert.ok(mine);
  assert.equal(mine.from, AGENT);
  assert.deepEqual(mine.mentions, [{ kind: "principal", id: "ada@example.org" }]);
});

test("chat.post without the agent's address is refused", async () => {
  await assert.rejects(
    () => runActions(ctx, GROUP, [{ do: "chat.post", with: { text: "hello" } }]),
    /needs the agent's own address/,
  );
});

test("noop runs and returns nothing", async () => {
  const results = await runActions(ctx, GROUP, [{ do: "noop" }]);
  assert.deepEqual(results, [{ action: "noop", ok: true }]);
});

test("a draft carries the group's own signature, as the composer writes it", async () => {
  // The group's footer is its identity's signature (ADR 0003 resolutions 2
  // and 13), and the rule that puts it on a body is the one the composer
  // calls — same delimiter, same spacing.
  const { JMAP_MAIL } = await import("../jmap.js");
  const identities = await client.call<{ list?: Array<{ id?: string }> }>(
    "Identity/get",
    { accountId: GROUP },
    [JMAP_MAIL],
  );
  const identityId = identities.list?.[0]?.id ?? "";
  assert.ok(identityId, "the group has its own identity");
  await client.call(
    "Identity/set",
    { accountId: GROUP, update: { [identityId]: { textSignature: "Team Greensley" } } },
    [JMAP_MAIL],
  );
  try {
    const readBack = await client.call<{ list?: Array<{ textSignature?: unknown }> }>(
      "Identity/get",
      {
        accountId: GROUP,
        ids: [identityId],
        properties: ["id", "name", "email", "textSignature"],
      },
      [JMAP_MAIL],
    );
    assert.equal(
      readBack.list?.[0]?.textSignature,
      "Team Greensley",
      "the fixture really carries the signature before the run",
    );
    const [result] = await runActions(ctx, GROUP, [
      {
        do: "mail.draft",
        with: { to: "ada@example.org", subject: "Signed", text: "On it." },
      },
    ]);
    const draft = await fetchEmailRecord(
      client,
      GROUP,
      String(result?.result?.emailId ?? ""),
      { body: true },
    );
    const values = (draft?.bodyValues ?? {}) as Record<string, { value?: string }>;
    const body = String(Object.values(values)[0]?.value ?? "");
    assert.match(
      body,
      /\n\n-- \nTeam Greensley$/,
      "the standard delimiter, then the group's footer",
    );
  } finally {
    // Leave the fixture as the other tests expect to find it.
    await client.call(
      "Identity/set",
      { accountId: GROUP, update: { [identityId]: { textSignature: "" } } },
      [JMAP_MAIL],
    );
  }
});
