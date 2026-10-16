/**
 * The memory's store against the mock Stalwart (ADR 0037).
 *
 * The three facts the design rests on: a fact is one small sheet in the
 * **Master's** own account, written and read back whole; a sheet the agent
 * wrote about a subject is **corrected in place** rather than doubled; and a
 * fact a **person** wrote is in force — the write refuses it, in a code, and
 * leaves it exactly as it is. A sheet this build cannot read is reported with
 * its path and the reason, never read as an empty fact.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import type { Ctx } from "../appFolder.js";
import { freePort, waitForPort } from "../testkit.js";

const PORT = await freePort();
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_DEMO = "1";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-memory";

const mock = await import("../mock/index.js");
const { fetchUpstreamSession } = await import("../upstream.js");
const { destroyAppNode, filesAccountId, readAppFileAt, writeAppBytesAt, writeAppFileAt } =
  await import("../appFolder.js");
const { MEMORY_VERSION, recallFacts, sameSubject } = await import("../shared/memory.js");
const { factPath, listFacts, MemoryError, readFact, rememberFact } = await import(
  "./memory.js"
);

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const AT = "2026-10-16T10:00:00.000Z";

let ctx: Ctx;
let accountId: string;

before(async () => {
  await waitForPort(BASE, AUTH);
  const session = await fetchUpstreamSession(AUTH, BASE);
  ctx = { authorization: AUTH, session, username: "demo@example.com" };
  accountId = filesAccountId(ctx);
  assert.ok(accountId, "the Master's session owns Files");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** The sheets this test wrote, taken back out with it. */
const written: string[] = [];

afterEach(async () => {
  for (const id of written.splice(0)) {
    const found = await readAppFileAt(ctx, accountId, factPath(id));
    const nodeId = found?.file.id;
    if (typeof nodeId === "string") await destroyAppNode(ctx, accountId, nodeId, {});
  }
});

test("a fact is one sheet in the Master's memory, corrected in place", async () => {
  const first = await rememberFact(ctx, accountId, {
    subject: "Maersk",
    fact: "the usual shipper for container bookings",
    run: "r-1",
    at: AT,
    standing: true,
  });
  written.push(first.id);

  const read = await readFact(ctx, accountId, first.id);
  assert.deepEqual(read?.fact, first, "the sheet reads back whole");
  assert.deepEqual(first.origin, { by: "run", run: "r-1" }, "with the run it came from");
  assert.equal(first.standing, true, "and what the group keeps standing");

  // The same subject again: the agent's own sheet is corrected, keeping its id,
  // so the links that point at it keep pointing at it.
  const again = await rememberFact(ctx, accountId, {
    subject: "maersk",
    fact: "the usual shipper, and only for containers",
    run: "r-2",
    at: AT,
  });
  assert.equal(again.id, first.id, "one subject is one sheet");
  assert.equal(again.fact, "the usual shipper, and only for containers");
  assert.deepEqual(
    again.origin,
    { by: "run", run: "r-2" },
    "and it says who corrected it",
  );
  assert.equal(
    (await listFacts(ctx, accountId)).filter(({ fact }) =>
      sameSubject(fact.subject, "Maersk"),
    ).length,
    1,
    "the memory holds one fact about the subject, not two spellings of it",
  );
});

test("a fact a person wrote is in force, and the write refuses it", async () => {
  await writeAppFileAt(ctx, accountId, factPath("person-1"), {
    v: MEMORY_VERSION,
    id: "person-1",
    subject: "Bologna Express",
    fact: "the account's own shipper, as the office reads it",
    origin: { by: "person", who: "admin@example.com" },
    at: AT,
    links: [],
    standing: false,
  });
  written.push("person-1");

  await assert.rejects(
    () =>
      rememberFact(ctx, accountId, {
        subject: "bologna express",
        fact: "what the agent concluded instead",
        run: "r-1",
        at: AT,
      }),
    (err: unknown) => err instanceof MemoryError && err.code === "fact_in_force",
    "the refusal is a code a caller composes a sentence from",
  );

  const held = await readFact(ctx, accountId, "person-1");
  assert.equal(
    held?.fact.fact,
    "the account's own shipper, as the office reads it",
    "and the sheet a person wrote is left exactly as it is",
  );
  assert.deepEqual(held?.fact.origin, { by: "person", who: "admin@example.com" });
});

test("a link names a subject the memory holds, and one it does not is refused", async () => {
  const shipper = await rememberFact(ctx, accountId, {
    subject: "Maersk",
    fact: "the usual shipper",
    run: "r-1",
    at: AT,
  });
  written.push(shipper.id);
  const booking = await rememberFact(ctx, accountId, {
    subject: "booking 4711",
    fact: "goes by the usual shipper",
    run: "r-1",
    at: AT,
    links: ["maersk"],
  });
  written.push(booking.id);
  assert.deepEqual(
    booking.links,
    [shipper.id],
    "a link is written by its subject and stored as the sheet it names",
  );

  // What the link is for: a call about the booking is handed the shipper it
  // belongs with, one hop out and no further.
  const memory = (await listFacts(ctx, accountId)).map(({ fact }) => fact);
  assert.deepEqual(
    recallFacts(memory, "mail created: m-1\nbooking: booking 4711").map(
      (fact) => fact.subject,
    ),
    ["booking 4711", "Maersk"],
    "the selection carries the fact the change names and its nearest link",
  );

  await assert.rejects(
    () =>
      rememberFact(ctx, accountId, {
        subject: "booking 4712",
        fact: "goes somewhere else",
        run: "r-1",
        at: AT,
        links: ["Nowhere"],
      }),
    (err: unknown) => err instanceof MemoryError && err.code === "link_unknown",
    "a link to a subject the memory holds nothing for is refused, never dropped",
  );
});

test("a sheet this build cannot read is reported, never read as an empty fact", async () => {
  // Bytes that are not a document at all.
  await writeAppBytesAt(
    ctx,
    accountId,
    "memory/junk.json",
    new TextEncoder().encode("not a document"),
    "application/json",
  );
  written.push("junk");
  await assert.rejects(
    () => readFact(ctx, accountId, "junk"),
    (err: unknown) => err instanceof MemoryError && err.code === "fact_unreadable",
    "a sheet whose bytes do not parse is refused with its own code",
  );
  await assert.rejects(
    () => listFacts(ctx, accountId),
    /The fact at memory\/junk\.json/,
    "and a listing reports it rather than skipping it",
  );

  // A document of the right JSON that is not the shape this build writes.
  await writeAppFileAt(ctx, accountId, "memory/other.json", {
    v: MEMORY_VERSION,
    id: "other",
  });
  written.push("other");
  await assert.rejects(() => readFact(ctx, accountId, "other"), /"subject" must say/);
});
