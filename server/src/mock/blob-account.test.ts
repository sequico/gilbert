import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort } from "../testkit.js";

/**
 * A blob belongs to one account.
 *
 * A real server scopes a `blobId` to the account it was uploaded into, and a
 * download that names another account is not found there. That is what makes
 * "one account cannot read another's attachment" true of the server rather than
 * of the client that happens never to ask -- and the demo user's session holds
 * more than one account, so the account in the download URL is the only thing
 * that decides which blobs are reachable.
 *
 * Pinned so a blob store that serves any id to anybody fails this file.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_DEMO = "1";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
/** team@example.org, the group account the same session also holds. */
const GROUP_ACCOUNT = "a3";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const BODY = "an attachment only its own account may read";

async function upload(accountId: string, text: string): Promise<string> {
  const res = await fetch(`${BASE}/jmap/upload/${accountId}/`, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "text/plain" },
    body: text,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { accountId: string; blobId: string };
  assert.equal(body.accountId, accountId, "an upload answers the account that holds it");
  return body.blobId;
}

const download = (accountId: string, blobId: string) =>
  fetch(`${BASE}/jmap/download/${accountId}/${blobId}/doc.txt?accept=text/plain`, {
    headers: { authorization: AUTH },
  });

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a download is served from the account that uploaded the blob", async () => {
  const blobId = await upload(ACCOUNT, BODY);
  const own = await download(ACCOUNT, blobId);
  assert.equal(own.status, 200);
  assert.equal(await own.text(), BODY);
});

test("another account's blob is not found under this one", async () => {
  const groupBlob = await upload(GROUP_ACCOUNT, BODY);
  const own = await download(GROUP_ACCOUNT, groupBlob);
  assert.equal(own.status, 200, "the group's own download is served");
  assert.equal(await own.text(), BODY);
  assert.equal(
    (await download(ACCOUNT, groupBlob)).status,
    404,
    "the demo account is not served the group's blob",
  );

  const ownBlob = await upload(ACCOUNT, BODY);
  assert.equal(
    (await download(GROUP_ACCOUNT, ownBlob)).status,
    404,
    "and the group is not served the demo account's",
  );
  assert.equal((await download(ACCOUNT, ownBlob)).status, 200);
});
