import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort, jmapCall, responseOf } from "../testkit.js";

/**
 * An attachment is a part of its message's blob, and a FileNode is not.
 *
 * A real server answers an attachment's `blobId` as a **section** of the
 * message's own blob, and downloading it serves the part decoded
 * (`crates/email/src/message/body.rs`, `get_blob_section`, v0.16.23). A
 * `FileNode/set` keeps only the blob and its whole length
 * (`crates/jmap/src/file/set.rs`, same version), so a node pointed at a part
 * serves the entire raw message — a file nothing can open, which is what the
 * agent's `files.save` used to produce.
 *
 * Both answers are pinned here, next to the simulation: the mock is what keeps
 * a re-pointing save from looking correct in this repository and failing on a
 * real server.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_DEMO = "1";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:filenode",
];
const jmap = (methodCalls: unknown[]) => jmapCall(BASE, AUTH, USING, methodCalls);

const PART = "The booking is BK-42.";
const partType = "text/plain";

async function upload(text: string): Promise<string> {
  const res = await fetch(`${BASE}/jmap/upload/${ACCOUNT}/`, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": partType },
    body: text,
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { blobId: string }).blobId;
}

const download = (blobId: string) =>
  fetch(`${BASE}/jmap/download/${ACCOUNT}/${blobId}/part?accept=${partType}`, {
    headers: { authorization: AUTH },
  });

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("an attachment downloads as its part, and a FileNode keeps the whole message", async () => {
  const uploaded = await upload(PART);
  const created = responseOf(
    await jmap([
      [
        "Email/set",
        {
          accountId: ACCOUNT,
          create: {
            c: {
              subject: "the booking papers",
              from: [{ email: "ops@shipper.example" }],
              mailboxIds: { inbox: true },
              bodyStructure: {
                type: "multipart/mixed",
                subParts: [
                  { partId: "body", type: "text/plain" },
                  { blobId: uploaded, type: partType, name: "booking.txt" },
                ],
              },
              bodyValues: { body: { value: "the papers are attached" } },
            },
          },
        },
        "c",
      ],
    ]),
    "c",
  );
  const messageId = (created[1].created as { c: { id: string } }).c.id;

  const read = responseOf(
    await jmap([
      [
        "Email/get",
        { accountId: ACCOUNT, ids: [messageId], properties: ["blobId", "attachments"] },
        "g",
      ],
    ]),
    "g",
  );
  const message = (read[1].list as Array<{ blobId: string }>)[0]!;
  const attachment = (
    read[1].list as unknown as Array<{
      attachments: Array<{ blobId: string; size: number }>;
    }>
  )[0]!.attachments[0]!;

  assert.ok(
    attachment.blobId.startsWith(`${message.blobId}~`),
    "an attachment's id is a section of the message's blob",
  );
  assert.equal(
    await (await download(attachment.blobId)).text(),
    PART,
    "and it downloads as the part, decoded",
  );

  const saved = responseOf(
    await jmap([
      [
        "FileNode/set",
        {
          accountId: ACCOUNT,
          create: {
            n: {
              parentId: null,
              name: "booking.txt",
              blobId: attachment.blobId,
              type: partType,
              nodeType: "file",
            },
          },
        },
        "n",
      ],
    ]),
    "n",
  );
  const nodeId = (saved[1].created as { n: { id: string } }).n.id;

  const node = responseOf(
    await jmap([["FileNode/get", { accountId: ACCOUNT, ids: [nodeId] }, "g"]]),
    "g",
  );
  const held = (node[1].list as Array<{ blobId: string; size: number }>)[0]!;
  assert.equal(
    held.blobId,
    message.blobId,
    "the node keeps the message's blob, not the part",
  );
  const whole = await (await download(held.blobId)).text();
  assert.notEqual(whole, PART, "so the node does not serve the part");
  assert.match(whole, /^Subject: the booking papers/, "it serves the whole raw message");
  assert.equal(held.size, whole.length, "and its size is the whole blob's");
});
