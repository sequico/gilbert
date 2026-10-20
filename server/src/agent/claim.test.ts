/**
 * The installation's single claim against the mock Stalwart (ADR 0032).
 *
 * One agent acts for an installation: what these tests pin is that a second
 * process is refused while a claim is live, that two processes racing for a
 * free claim leave exactly one winner, that holding it is not an event, that a
 * claim which is not renewed lapses into the next process's hands, and that a
 * release takes nobody's claim but its own. A claim document that cannot be
 * read is the other half: the installation keeps working, because a claim
 * nobody can read is no claim at all. The mock enforces `ifInState`
 * (`mock/compare-and-set.test.ts`), so the refusals these tests see are the
 * compare-and-set a real 0.16 server answers with.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { hostname } from "node:os";
import { after, before, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-claims";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { clientOf } = await import("../util.js");
const { ensureAppFolder, filesAccountId, FILENODE_CAP, writeAppFile } = await import(
  "../appFolder.js"
);
const { CLAIM_FILE, takeClaim, readClaim, renewClaim, releaseClaim, CLAIM_TTL_MS } =
  await import("./claim.js");

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;

let ctx: Ctx;
let accountId: string;
let folderId: string;

before(async () => {
  await waitForPort(BASE, AUTH);
  const session = await fetchUpstreamSession(AUTH, BASE);
  ctx = { authorization: AUTH, session, username: "demo@example.com" };
  accountId = filesAccountId(ctx);
  folderId = await ensureAppFolder(ctx, accountId);
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("two processes cannot both hold the installation's claim", async () => {
  const taken = await takeClaim(ctx, "process-a", new Date());
  assert.equal(taken?.holder, "process-a", "the first process takes the free claim");

  const refused = await takeClaim(ctx, "process-b", new Date());
  assert.equal(refused, null, "a second process is refused while the claim is live");
  assert.equal((await readClaim(ctx))?.holder, "process-a");

  // A process that already holds it is answered as itself: holding the claim is
  // not an event, and asking again writes nothing.
  assert.equal((await takeClaim(ctx, "process-a", new Date()))?.holder, "process-a");

  assert.equal(
    await releaseClaim(ctx, "process-b"),
    false,
    "a peer's release takes nothing",
  );
  assert.equal(await releaseClaim(ctx, "process-a"), true);
  assert.equal(await readClaim(ctx), null, "the claim is gone once it is let go");
  assert.equal(
    (await takeClaim(ctx, "process-b", new Date()))?.holder,
    "process-b",
    "and the next process takes it",
  );
  await releaseClaim(ctx, "process-b");
});

test("a claim that is not renewed lapses, and the next process takes it over", async () => {
  const t0 = new Date("2026-10-16T10:00:00.000Z");
  assert.ok(await takeClaim(ctx, "process-a", t0));

  assert.equal(
    await takeClaim(ctx, "process-b", new Date(t0.getTime() + CLAIM_TTL_MS - 1_000)),
    null,
    "inside the window the holder is still believed",
  );
  const taken = await takeClaim(
    ctx,
    "process-b",
    new Date(t0.getTime() + CLAIM_TTL_MS + 1_000),
  );
  assert.equal(
    taken?.holder,
    "process-b",
    "past it the claim a dead holder left is free",
  );
  await releaseClaim(ctx, "process-b");
});

test("a holder renews its claim, and nobody else can", async () => {
  const t0 = new Date("2026-10-16T11:00:00.000Z");
  const taken = await takeClaim(ctx, "process-a", t0);
  assert.ok(taken, "the claim is taken");

  assert.equal(await renewClaim(ctx, "process-b", t0), false, "a peer cannot renew it");
  assert.equal(
    await renewClaim(ctx, "process-a", new Date(t0.getTime() + 60_000)),
    true,
    "the holder can",
  );

  const held = await readClaim(ctx);
  assert.equal(
    held?.expires,
    new Date(t0.getTime() + 60_000 + CLAIM_TTL_MS).toISOString(),
    "the renewal moves the instant the claim stops being believed",
  );
  assert.equal(
    held?.takenAt,
    t0.toISOString(),
    "the take time is the one it was taken at",
  );

  await releaseClaim(ctx, "process-a");
});

test("two processes racing for a free claim leave exactly one winner", async () => {
  const now = new Date("2026-10-16T12:00:00.000Z");
  const taken = await Promise.all([
    takeClaim(ctx, "process-a", now),
    takeClaim(ctx, "process-b", now),
  ]);

  const winners = taken.filter((claim) => claim !== null);
  assert.equal(winners.length, 1, "exactly one of the two takes the claim");
  const winner = winners[0];
  assert.ok(winner);
  assert.deepEqual(
    await readClaim(ctx),
    winner,
    "and the document holds the winner, not a write of the loser's",
  );
  await releaseClaim(ctx, winner.holder);
});

test("a claim document that cannot be read is no claim, and the installation keeps working", async () => {
  // A node under the claim's name whose blob this server does not hold: the
  // document is there, and its bytes do not come back.
  await clientOf(ctx).call(
    "FileNode/set",
    {
      accountId,
      create: {
        n: {
          parentId: folderId,
          name: CLAIM_FILE,
          blobId: "no-such-blob",
          type: "application/json",
          nodeType: "file",
        },
      },
    },
    [FILENODE_CAP],
  );

  assert.equal(
    await readClaim(ctx),
    null,
    "a claim whose bytes do not come back reads as none",
  );
  const taken = await takeClaim(ctx, "process-c", new Date());
  assert.equal(
    taken?.holder,
    "process-c",
    "so the process still starts, rather than an installation with no agent",
  );
  assert.equal(
    (await readClaim(ctx))?.holder,
    "process-c",
    "and it holds the claim it took",
  );
  await releaseClaim(ctx, "process-c");
});

test("a claim whose dates are not instants is no claim", async () => {
  await writeAppFile(ctx, accountId, CLAIM_FILE, {
    v: 1,
    holder: "process-a",
    takenAt: new Date().toISOString(),
    expires: "whenever",
  });
  assert.equal(
    await readClaim(ctx),
    null,
    "an expiry that is not a date reads as no claim",
  );

  await writeAppFile(ctx, accountId, CLAIM_FILE, {
    v: 1,
    holder: "process-a",
    takenAt: "not a date either",
    expires: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
  });
  assert.equal(await readClaim(ctx), null, "and so does a take time that is not one");

  const taken = await takeClaim(ctx, "process-d", new Date());
  assert.equal(taken?.holder, "process-d", "either way the claim is free to be taken");
  await releaseClaim(ctx, "process-d");
});

test("a claim left by a dead process on this host is taken at once", async () => {
  /*
   * The live failure this pins: an update stops the service with SIGKILL, its
   * claim stays valid for the TTL, and the restarted process waited four and a
   * half minutes — long enough for a chat message to arrive and be anchored
   * past, never read. A PID this host can see is dead is no holder.
   */
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  assert.ok(child.pid, "the child has a pid");
  const now = new Date();
  await writeAppFile(ctx, accountId, CLAIM_FILE, {
    v: 1,
    holder: `${hostname()}#${child.pid}`,
    takenAt: now.toISOString(),
    expires: new Date(now.getTime() + CLAIM_TTL_MS).toISOString(),
  });
  const taken = await takeClaim(ctx, "process-after-restart", now);
  assert.equal(taken?.holder, "process-after-restart", "the dead claim does not hold");
  await releaseClaim(ctx, "process-after-restart");
});

test("a claim held by a live process on this host is still left alone", async () => {
  const now = new Date();
  const holder = `${hostname()}#${process.pid}`;
  await writeAppFile(ctx, accountId, CLAIM_FILE, {
    v: 1,
    holder,
    takenAt: now.toISOString(),
    expires: new Date(now.getTime() + CLAIM_TTL_MS).toISOString(),
  });
  assert.equal(
    await takeClaim(ctx, "process-other", now),
    null,
    "a live holder keeps the claim until it lapses",
  );
  await releaseClaim(ctx, holder);
});
