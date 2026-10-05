import assert from "node:assert/strict";
import { after, test } from "node:test";
import { freePort } from "../testkit.js";

/**
 * The mock serves the account's own settings document (ADR 0007): a
 * `settings.json` inside the account's `gilbert` app folder, written whole and
 * read back whole.
 *
 * The default sending identity is one key of that document, so the
 * administration's write reaches Stalwart only if the document round-trips
 * through the mock the way it does through a real 0.16 server: the folder is
 * found by name, the document is uploaded as a blob and referenced by a node, a
 * second write replaces that node rather than adding a second file beside it,
 * and the download path serves the bytes back. These are the behaviours the
 * identity surfaces rest on; a mock that answered any of them differently would
 * make their tests pass against a server that does not exist.
 */

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";

const mock = await import("./index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { filesAccountId, listAppDir, readAppJsonAt, writeAppFile } = await import(
  "../appFolder.js"
);

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const session = await fetchUpstreamSession(AUTH, BASE);
const ctx = { authorization: AUTH, session, username: "demo@example.com" };
const ACCOUNT = filesAccountId(ctx);

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the settings document is written, read back, and updated instead of duplicated", async () => {
  assert.equal(
    await readAppJsonAt(ctx, ACCOUNT, "settings.json"),
    null,
    "nothing is seeded: an account with no document reads as absent",
  );

  await writeAppFile(ctx, ACCOUNT, "settings.json", {
    theme: "dark",
    defaultIdentityByAccount: { [ACCOUNT]: "i1" },
  });
  const first = (await readAppJsonAt(ctx, ACCOUNT, "settings.json")) as Record<
    string,
    unknown
  >;
  assert.equal(first.theme, "dark");
  assert.deepEqual(first.defaultIdentityByAccount, { [ACCOUNT]: "i1" });

  await writeAppFile(ctx, ACCOUNT, "settings.json", {
    theme: "light",
    defaultIdentityByAccount: { [ACCOUNT]: "i2" },
  });
  const second = (await readAppJsonAt(ctx, ACCOUNT, "settings.json")) as Record<
    string,
    unknown
  >;
  assert.equal(second.theme, "light", "the client whole-file-replaces the document");
  assert.equal(
    (await listAppDir(ctx, ACCOUNT, "")).filter((n) => n.name === "settings.json").length,
    1,
    "one document updated in place, not a second file beside the first",
  );
});
