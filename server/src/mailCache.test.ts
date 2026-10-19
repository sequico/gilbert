import assert from "node:assert/strict";
import { test } from "node:test";
import { cachedMail, forgetMailCache } from "./mailCache.js";

test("a mailbox answer is reused until its mailbox tree is written", async () => {
  const scope = {};
  let reads = 0;
  const read = async () => ++reads;

  assert.equal(await cachedMail(scope, "a", "mailboxes", read), 1);
  assert.equal(
    await cachedMail(scope, "a", "mailboxes", read),
    1,
    "the answer is reused",
  );
  assert.equal(await cachedMail(scope, "b", "mailboxes", read), 2, "accounts are apart");

  forgetMailCache();
  assert.equal(
    await cachedMail(scope, "a", "mailboxes", read),
    3,
    "a mailbox write forgets the answer",
  );
});
