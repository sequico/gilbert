import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort, jmapCall, responseOf } from "../testkit.js";

/**
 * What the mock says about a Sieve script it is asked to check.
 *
 * `SieveScript/validate` answered `error: null` whatever it was handed, so the
 * client's validate-before-save path was permanently green: the store uploads
 * the script as a blob, asks the server to check it, and trusts the verdict — a
 * surface that never sees a refusal ships a broken script with a tick beside it.
 *
 * The mock has no Sieve parser and does not pretend to; the check it can make is
 * structural, and it is the same one a system script's own `/set` refuses on, so
 * the two cannot disagree about what is obviously wrong.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-sieve-validate";

const mock = await import("./index.js");

const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "a1";
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const USING = ["urn:ietf:params:jmap:core"];

async function validate(contents: string): Promise<{ type?: string } | null> {
  const up = await fetch(`${BASE}/jmap/upload/${ACCOUNT}/`, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/sieve" },
    body: contents,
  });
  assert.equal(up.status, 200, "the script uploads as a blob");
  const { blobId } = (await up.json()) as { blobId: string };
  const res = await jmapCall(BASE, AUTH, USING, [
    ["SieveScript/validate", { accountId: ACCOUNT, blobId }, "v"],
  ]);
  return (responseOf(res, "v")[1] as { error: { type?: string } | null }).error;
}

test("a script whose braces balance is accepted", async () => {
  assert.equal(
    await validate(
      'require ["fileinto"];\nif header :contains "subject" "x" {\n  fileinto "inbox";\n}\n',
    ),
    null,
  );
});

test("one that does not is refused by the property that is wrong", async () => {
  const bad = await validate('require ["fileinto"];\nif true {\n  fileinto "inbox";\n');
  assert.equal(bad?.type, "invalidScript");
});

test("an empty script is refused rather than ticked", async () => {
  const empty = await validate("   ");
  assert.equal(empty?.type, "invalidScript");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});
