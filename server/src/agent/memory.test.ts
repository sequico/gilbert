/**
 * The memory's store against the mock Stalwart (ADR 0037).
 *
 * The three facts the design rests on: a fact is one small sheet in the
 * **Master's** own account, written and read back whole; a sheet the agent
 * wrote about a subject is **corrected in place** rather than doubled; and a
 * fact a **person** wrote is in force — the write refuses it, in a code, and
 * leaves it exactly as it is. A sheet this build cannot read is reported with
 * its path and the reason, never read as an empty fact. And because a write is
 * made against a **reading** of the store that carries its own token, a write
 * whose reading has been overtaken is refused rather than overwriting what
 * landed since.
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
const { isInForce, MEMORY_VERSION, recallFacts, sameSubject } = await import(
  "../shared/memory.js"
);
const { isStateMismatch } = await import("../shared/errors.js");
const {
  correctFactByPerson,
  dismissProposal,
  factPath,
  forgetFact,
  listFacts,
  MemoryError,
  readFact,
  rememberFact,
} = await import("./memory.js");

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

/**
 * The installation's memory as one reading of it.
 *
 * A write is made against a reading and the reading carries the token it uses
 * (ADR 0037), so every write below is handed the store as the pass would hand
 * it over.
 */
const store = () => listFacts(ctx, accountId);

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
  const first = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Maersk",
      fact: "the usual shipper for container bookings",
      run: "r-1",
      at: AT,
      standing: true,
      group: accountId,
    },
    await store(),
  );
  written.push(first.id);

  const read = await readFact(ctx, accountId, first.id);
  assert.deepEqual(read?.fact, first, "the sheet reads back whole");
  assert.deepEqual(first.origin, { by: "run", run: "r-1" }, "with the run it came from");
  assert.equal(first.standing, true, "and what the group keeps standing");
  assert.equal(first.group, accountId, "about the group the run lives in");

  // The same subject again: the agent's own sheet is corrected, keeping its id,
  // so the links that point at it keep pointing at it.
  const again = await rememberFact(
    ctx,
    accountId,
    {
      subject: "maersk",
      fact: "the usual shipper, and only for containers",
      run: "r-2",
      at: AT,
      group: accountId,
    },
    await store(),
  );
  assert.equal(again.id, first.id, "one subject is one sheet");
  assert.equal(again.fact, "the usual shipper, and only for containers");
  assert.deepEqual(
    again.origin,
    { by: "run", run: "r-2" },
    "and it says who corrected it",
  );
  assert.equal(
    (await store()).facts.filter((fact) => sameSubject(fact.subject, "Maersk")).length,
    1,
    "the memory holds one fact about the subject, not two spellings of it",
  );
});

test("a later sentence about a subject keeps the mark and the links it does not restate", async () => {
  /*
   * `standing` and `links` are optional on a write, and a second conclusion about
   * the same subject is the ordinary case. Rebuilding the sheet from the new
   * write alone would quietly stop a fact every call of the group used to carry,
   * and cut the facts it was tied to — with the same id, so nothing looks broken.
   */
  const port = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Porto Marghera",
      fact: "the port the group ships from",
      run: "r-1",
      at: AT,
      group: accountId,
    },
    await store(),
  );
  written.push(port.id);

  const marked = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Nordwind",
      fact: "carries for the northern route",
      run: "r-1",
      at: AT,
      group: accountId,
      standing: true,
      links: ["Porto Marghera"],
    },
    await store(),
  );
  written.push(marked.id);
  assert.equal(marked.standing, true);
  assert.deepEqual(marked.links, [port.id], "the link resolved to the sheet it names");

  const later = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Nordwind",
      fact: "carries for the northern route and the Baltic",
      run: "r-2",
      at: AT,
      group: accountId,
    },
    await store(),
  );
  assert.equal(
    later.standing,
    true,
    "a rewrite that says nothing about the mark keeps it",
  );
  assert.deepEqual(later.links, [port.id], "and keeps the link it did not restate");
});

test("a write whose reading has been overtaken is refused, and the sheet is left as it was", async () => {
  /*
   * The write is a compare-and-set against the reading it was given (ADR 0037):
   * the token is the FileNode state that reading saw, so a write landing between
   * the read and the write makes this one stale. It is refused rather than
   * correcting a sheet this reading never saw — the mechanism two turns of one
   * answer rely on when they reach the same subject.
   */
  const first = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Maersk",
      fact: "the usual shipper",
      run: "r-1",
      at: AT,
      group: accountId,
    },
    await store(),
  );
  written.push(first.id);

  // A reading taken now, and a different fact written afterwards: the writing
  // moves the account's FileNode state on, so this reading is no longer current.
  const stale = await store();
  const other = await rememberFact(
    ctx,
    accountId,
    {
      subject: "ACME",
      fact: "the client this account books for",
      run: "r-1",
      at: AT,
      group: accountId,
    },
    await store(),
  );
  written.push(other.id);

  await assert.rejects(
    () =>
      rememberFact(
        ctx,
        accountId,
        {
          subject: "maersk",
          fact: "the usual shipper, corrected",
          run: "r-2",
          at: AT,
          group: accountId,
        },
        stale,
      ),
    (err: unknown) => isStateMismatch(err),
    "the write is refused as a lost compare-and-set, not applied",
  );
  assert.equal(
    (await readFact(ctx, accountId, first.id))?.fact.fact,
    "the usual shipper",
    "and the sheet the stale write meant to correct is left exactly as it was",
  );
});

test("a person's correction and removal are refused when the memory moved under them", async () => {
  /*
   * Both of a person's writes carry the token of the reading the surface showed
   * them (`ifInState`), so a correction or a removal decided against a list that
   * has moved since is refused rather than landing over what somebody else
   * wrote. The store here moves between the read and the write, which is the
   * only case the token decides: a test whose store never moves writes the same
   * bytes with or without it.
   */
  const first = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Oltremare",
      fact: "the usual shipper for the northern route",
      run: "r-1",
      at: AT,
      group: accountId,
    },
    await store(),
  );
  written.push(first.id);

  // The reading the person's surface holds, and a write that lands after it:
  // the account's FileNode state has moved past this reading.
  const stale = await store();
  const other = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Cargo 88",
      fact: "the client that books on Fridays",
      run: "r-1",
      at: AT,
      group: accountId,
    },
    await store(),
  );
  written.push(other.id);

  const refused = (err: unknown) => err instanceof MemoryError && err.status === 409;
  await assert.rejects(
    () =>
      correctFactByPerson(
        ctx,
        accountId,
        {
          id: first.id,
          subject: "Oltremare",
          fact: "the shipper for the northern route, as the office reads it",
          who: "admin@example.com",
          at: AT,
        },
        stale,
      ),
    refused,
    "the correction loses the compare-and-set and is refused, not applied",
  );
  assert.equal(
    (await readFact(ctx, accountId, first.id))?.fact.fact,
    "the usual shipper for the northern route",
    "and the sheet the stale correction meant to change is left as it was",
  );

  await assert.rejects(
    () => forgetFact(ctx, accountId, first.id, stale.state),
    refused,
    "and the removal, decided against the same stale reading, is refused too",
  );
  assert.ok(
    await readFact(ctx, accountId, first.id),
    "so the fact is still in the memory",
  );
});

test("two writes of one reading cannot make two sheets for one subject", async () => {
  /*
   * Two `memory.remember` calls in one answer run **together** (the loop's wave,
   * `Promise.allSettled`) and both are made against the pass's one reading
   * (ADR 0037), so each finds the subject absent and each asks for a sheet. The
   * create carries the reading's token, so only the first lands: the second is
   * refused as a lost compare-and-set, which is what keeps "one subject is one
   * sheet" true when two calls decide it at once.
   */
  const reading = await store();
  const first = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Maersk",
      fact: "the usual shipper",
      run: "r-1",
      at: AT,
      group: accountId,
    },
    reading,
  );
  written.push(first.id);

  await assert.rejects(
    () =>
      rememberFact(
        ctx,
        accountId,
        {
          subject: "maersk",
          fact: "the same shipper, said again",
          run: "r-1",
          at: AT,
          group: accountId,
        },
        reading,
      ),
    (err: unknown) => isStateMismatch(err),
    "the second create carries the same token, so it is refused",
  );
  assert.equal(
    (await store()).facts.filter((fact) => sameSubject(fact.subject, "Maersk")).length,
    1,
    "and the memory holds one sheet for the subject, not two",
  );
});

test("a fact a person wrote is in force, and the agent writes a proposal beside it", async () => {
  await writeAppFileAt(ctx, accountId, factPath("person-1"), {
    v: MEMORY_VERSION,
    id: "person-1",
    subject: "Bologna Express",
    fact: "the account's own shipper, as the office reads it",
    origin: { by: "person", who: "admin@example.com" },
    at: AT,
    links: [],
    standing: false,
    group: accountId,
  });
  written.push("person-1");

  const reading = await store();
  const proposed = await rememberFact(
    ctx,
    accountId,
    {
      subject: "bologna express",
      fact: "what the agent concluded instead",
      run: "r-1",
      at: AT,
      group: accountId,
    },
    reading,
  );
  assert.deepEqual(
    proposed.proposal,
    { fact: "what the agent concluded instead", run: "r-1", at: AT },
    "what the agent concluded is written as a proposal beside the person's word",
  );

  const held = await readFact(ctx, accountId, "person-1");
  assert.equal(
    held?.fact.fact,
    "the account's own shipper, as the office reads it",
    "and the sheet a person wrote keeps its sentence exactly as it was",
  );
  assert.deepEqual(held?.fact.origin, { by: "person", who: "admin@example.com" });
  assert.equal(isInForce(held!.fact), true, "so the person's word is still in force");

  // A person accepts the proposal by correcting the sheet with those words —
  // the one write a person's word takes — and that write clears the proposal.
  const accepted = await correctFactByPerson(
    ctx,
    accountId,
    {
      id: "person-1",
      subject: "Bologna Express",
      fact: "what the agent concluded instead",
      who: "admin@example.com",
      at: AT,
    },
    await store(),
  );
  assert.equal(accepted.proposal, undefined, "the accepted proposal is gone");
  assert.equal(accepted.fact, "what the agent concluded instead");
  assert.deepEqual(accepted.correction, {
    by: "person",
    who: "admin@example.com",
    at: AT,
  });

  // A dismissal drops the proposal and nothing else.
  const again = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Bologna Express",
      fact: "a second conclusion",
      run: "r-2",
      at: AT,
      group: accountId,
    },
    await store(),
  );
  assert.ok(again.proposal, "a fresh proposal against the corrected sheet");
  const dismissed = await dismissProposal(ctx, accountId, "person-1", await store());
  assert.equal(dismissed.proposal, undefined, "dismissing takes the proposal away");
  assert.equal(
    dismissed.fact,
    "what the agent concluded instead",
    "and leaves the sentence the person's correction put there",
  );
  assert.deepEqual(dismissed.correction, accepted.correction, "with its provenance");
});

test("a link names a subject the memory holds, and one it does not is refused", async () => {
  const shipper = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Maersk",
      fact: "the usual shipper",
      run: "r-1",
      at: AT,
      group: accountId,
    },
    await store(),
  );
  written.push(shipper.id);
  const booking = await rememberFact(
    ctx,
    accountId,
    {
      subject: "booking 4711",
      fact: "goes by the usual shipper",
      run: "r-1",
      at: AT,
      group: accountId,
      links: ["maersk"],
    },
    await store(),
  );
  written.push(booking.id);
  assert.deepEqual(
    booking.links,
    [shipper.id],
    "a link is written by its subject and stored as the sheet it names",
  );

  // What the link is for: a call about the booking is handed the shipper it
  // belongs with, one hop out and no further.
  const memory = (await store()).facts;
  assert.deepEqual(
    recallFacts(memory, "mail created: m-1\nbooking: booking 4711", accountId).map(
      (fact) => fact.subject,
    ),
    ["booking 4711", "Maersk"],
    "the selection carries the fact the change names and its nearest link",
  );

  const reading = await store();
  await assert.rejects(
    () =>
      rememberFact(
        ctx,
        accountId,
        {
          subject: "booking 4712",
          fact: "goes somewhere else",
          run: "r-1",
          at: AT,
          group: accountId,
          links: ["Nowhere"],
        },
        reading,
      ),
    (err: unknown) => err instanceof MemoryError && err.code === "link_unknown",
    "a link to a subject the memory holds nothing for is refused, never dropped",
  );
});

test("a sheet whose stamp has not moved is not downloaded a second time", async () => {
  /*
   * The store is read once per pass and a pass is asked every ten seconds, so a
   * memory that has grown is a memory that is walked on every one of them. What
   * decides whether that costs is whether a sheet that has not moved is read
   * again — one write lands, one sheet's stamp moves, and the sheets beside it
   * are what must not be paid for a second time.
   */
  const real = globalThis.fetch;
  const named = ["stamp-fact", "stamp-other"];
  /** What the walk downloaded, by document. */
  const downloads: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (named.some((name) => url.includes(`/${name}.json`))) downloads.push(url);
    return await real(input, init);
  }) as typeof fetch;
  try {
    const sheet = async (id: string, sentence: string): Promise<void> => {
      await writeAppFileAt(ctx, accountId, factPath(id), {
        v: MEMORY_VERSION,
        id,
        subject: `stamp subject ${id}`,
        fact: sentence,
        origin: { by: "run", run: "r-1" },
        at: AT,
        links: [],
        standing: false,
        group: accountId,
      });
      written.push(id);
    };
    await sheet("stamp-fact", "the first sentence");
    await sheet("stamp-other", "a second fact, not the one that will move");

    downloads.length = 0;
    const first = await store();
    assert.equal(downloads.length, 2, "the first walk reads both sheets");

    await sheet("stamp-fact", "the second sentence, same subject");
    downloads.length = 0;
    const second = await store();
    assert.equal(downloads.length, 1, "the sheet that moved is read again, and only it");
    assert.equal(
      second.facts.find((fact) => fact.id === "stamp-fact")?.fact,
      "the second sentence, same subject",
      "and the walk answers with what is stored now",
    );
    assert.notEqual(
      first.facts.find((fact) => fact.id === "stamp-fact")?.fact,
      second.facts.find((fact) => fact.id === "stamp-fact")?.fact,
      "so the first walk really did read the earlier sentence",
    );
  } finally {
    globalThis.fetch = real;
  }
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
  const reading = await listFacts(ctx, accountId);
  assert.ok(
    reading.problems.some((problem) => problem.includes("memory/junk.json")),
    "and a listing reports it rather than skipping it",
  );
  assert.ok(
    !reading.facts.some((fact) => fact.id === "junk"),
    "without reading it as an empty fact",
  );

  // A document of the right JSON that is not the shape this build writes.
  await writeAppFileAt(ctx, accountId, "memory/other.json", {
    v: MEMORY_VERSION,
    id: "other",
  });
  written.push("other");
  await assert.rejects(() => readFact(ctx, accountId, "other"), /"subject" must say/);
});
