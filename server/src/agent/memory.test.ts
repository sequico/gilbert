/**
 * The memory's store against the mock Stalwart (ADR 0038).
 *
 * The mechanisms the store owns: a fact about a subject the memory does not hold
 * **creates the entity**; a contradicting fact **closes** the one it replaces and
 * the closed one is not recalled; a duplicate is not written again; a relation is
 * a fact whose value is another entity; a sheet of the earlier version is read as
 * an entity and an `is` fact without being touched, and the next write about it is
 * a document of this version; a person's fact is in force and the agent writes a
 * **proposal** beside it. A write is made against a **reading** of the store that
 * carries its own token, and a document this build cannot read is reported with
 * its path and the reason.
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
const { entityIdFor, isInForce, MEMORY_FACTS_PER_ENTITY, MEMORY_VERSION, recallMemory } =
  await import("../shared/memory.js");
const {
  correctFactByPerson,
  dismissProposal,
  entityPath,
  factPath,
  forgetFact,
  forgetMemoryStores,
  listMemory,
  MemoryError,
  readFact,
  readHistory,
  rememberFact,
} = await import("./memory.js");

const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = `Basic ${Buffer.from("demo@example.com:demo-password").toString("base64")}`;
const AT = "2026-10-16T10:00:00.000Z";
const LATER = "2026-10-17T10:00:00.000Z";
const NOW = "2026-10-22T09:00:00.000Z";

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

/** The installation's memory as one reading of it, at a fixed clock. */
const store = () => listMemory(ctx, accountId, NOW);

/** The documents this test wrote, taken back out with it. */
const written: string[] = [];

afterEach(async () => {
  forgetMemoryStores();
  for (const id of written.splice(0)) {
    for (const path of [factPath(id), entityPath(id)]) {
      const found = await readAppFileAt(ctx, accountId, path);
      const nodeId = found?.file.id;
      if (typeof nodeId === "string") await destroyAppNode(ctx, accountId, nodeId, {});
    }
  }
});

test("a fact about a name the memory does not hold creates the entity", async () => {
  const first = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Maersk Line",
      kind: "client",
      fact: "the usual shipper for container bookings",
      run: "r-1",
      at: AT,
    },
    await store(),
  );
  written.push(first.fact.id, first.entity.id);

  assert.equal(first.entity.normalized, "maersk line", "the name, normalized");
  assert.equal(first.entity.kind, "client", "of the kind the fact stated");
  assert.equal(
    first.fact.entity,
    first.entity.id,
    "and the fact points at the entity it created",
  );
  const document = await readAppFileAt(ctx, accountId, entityPath(first.entity.id));
  assert.ok(document, "the entity is one document under memory/");
  assert.deepEqual(JSON.parse(document.text), first.entity, "written whole");

  const read = await readFact(ctx, accountId, first.fact.id);
  assert.deepEqual(read?.fact, first.fact, "and the fact reads back whole");
  assert.equal(first.fact.validFrom, AT, "valid from when it was learned");
  assert.equal(first.fact.validTo, undefined, "and still in force");

  const [one] = [await store()];
  assert.equal(one?.entities.length, 1, "one entity, one document");
  assert.equal(one?.facts.length, 1, "and one fact");
});

test("a contradicting fact closes the one it replaces, and the closed one is not recalled", async () => {
  const first = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Maersk",
      fact: "the usual shipper",
      run: "r-1",
      at: AT,
    },
    await store(),
  );
  written.push(first.fact.id, first.entity.id);
  const second = await rememberFact(
    ctx,
    accountId,
    {
      subject: "maersk",
      fact: "the usual shipper, and only for containers",
      run: "r-2",
      at: LATER,
    },
    await store(),
  );

  const held = (await store()).facts.filter((fact) => fact.entity === first.entity.id);
  assert.equal(held.length, 2, "the earlier fact keeps its document");
  const closed = held.find((fact) => fact.id === first.fact.id);
  assert.equal(closed?.validTo, LATER, "and gains the instant it stopped being true");
  assert.equal(closed?.fact, "the usual shipper", "its sentence is not overwritten");
  const open = held.find((fact) => fact.id === second.fact.id);
  assert.equal(open?.validTo, undefined, "the replacement is in force");

  const recalled = recallMemory((await store()).index, { words: "Maersk", now: NOW });
  assert.deepEqual(
    recalled.facts.map((fact) => fact.id),
    [second.fact.id],
    "the live retrieval carries what is true now, and nothing that was",
  );

  const history = await readHistory(ctx, accountId, "Maersk");
  assert.deepEqual(
    history.facts.map((fact) => fact.id),
    [first.fact.id, second.fact.id],
    "and the since-when read answers both, oldest first",
  );
  const past = await readHistory(ctx, accountId, "maersk", { to: AT });
  assert.deepEqual(
    past.facts.map((fact) => fact.id),
    [first.fact.id],
    "narrowed to an interval, it answers the interval",
  );
});

test("a duplicate fact is not written again", async () => {
  const first = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Oltremare",
      fact: "the shipper for the northern route",
      run: "r-1",
      at: AT,
    },
    await store(),
  );
  written.push(first.fact.id, first.entity.id);
  const again = await rememberFact(
    ctx,
    accountId,
    {
      subject: "OLTREMARE",
      fact: "the shipper for the northern route",
      run: "r-2",
      at: LATER,
    },
    await store(),
  );
  assert.equal(again.fact.id, first.fact.id, "the same fact is the one already held");
  assert.equal(again.duplicate, true, "and the write says it wrote nothing");
  assert.equal(
    (await store()).facts.filter((fact) => fact.entity === first.entity.id).length,
    1,
    "the memory holds one fact, not a copy of it",
  );
});

test("a relation is a fact whose value is the entity it points at", async () => {
  const shipper = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Maersk Line",
      kind: "client",
      fact: "the usual shipper",
      run: "r-1",
      at: AT,
    },
    await store(),
  );
  written.push(shipper.fact.id, shipper.entity.id);
  const booking = await rememberFact(
    ctx,
    accountId,
    {
      subject: "booking 4711",
      kind: "booking",
      predicate: "ships-with",
      object: "maersk line",
      fact: "goes by the usual shipper",
      run: "r-1",
      at: AT,
    },
    await store(),
  );
  written.push(booking.fact.id, booking.entity.id);

  assert.deepEqual(
    booking.fact.value,
    { entity: shipper.entity.id },
    "the value is the entity, named by the name it was written with",
  );
  assert.equal(
    (await store()).entities.length,
    2,
    "and the object named a name the memory already held: no second entity",
  );

  const recalled = recallMemory((await store()).index, {
    words: "booking 4711",
    now: NOW,
  });
  assert.deepEqual(
    recalled.facts.map((fact) => fact.id),
    [booking.fact.id, shipper.fact.id],
    "one hop: the booking, then the shipper it goes with",
  );
  assert.equal(
    recalled.facts[0]?.objectName,
    "Maersk Line",
    "the relation is read with the name on the other side",
  );
});

test("a person's fact is in force, and the agent writes a proposal beside it", async () => {
  const name = "Bologna Express";
  const entity = {
    v: MEMORY_VERSION,
    id: entityIdFor(name),
    kind: "client",
    name,
    normalized: "bologna express",
    origin: { by: "person", who: "admin@example.com" },
    at: AT,
  };
  await writeAppFileAt(ctx, accountId, entityPath(entity.id), entity);
  await writeAppFileAt(ctx, accountId, factPath("person-1"), {
    v: MEMORY_VERSION,
    id: "person-1",
    entity: entity.id,
    predicate: "is",
    value: { text: "the account's own shipper, as the office reads it" },
    fact: "the account's own shipper, as the office reads it",
    origin: { by: "person", who: "admin@example.com" },
    at: AT,
    validFrom: AT,
  });
  written.push("person-1", entity.id);

  const proposed = await rememberFact(
    ctx,
    accountId,
    {
      subject: "bologna express",
      fact: "what the agent concluded instead",
      run: "r-1",
      at: LATER,
    },
    await store(),
  );
  assert.deepEqual(
    proposed.fact.proposal,
    { fact: "what the agent concluded instead", run: "r-1", at: LATER },
    "the agent's conclusion is a proposal beside the person's word",
  );
  const held = await readFact(ctx, accountId, "person-1");
  assert.equal(
    held?.fact.fact,
    "the account's own shipper, as the office reads it",
    "and the person's sentence is exactly as it was",
  );
  assert.equal(held?.fact.validTo, undefined, "still in force");
  assert.equal(isInForce(held!.fact), true, "a person's word is in force");

  const accepted = await correctFactByPerson(
    ctx,
    accountId,
    {
      id: "person-1",
      subject: "Bologna Express",
      fact: "what the agent concluded instead",
      who: "admin@example.com",
      at: LATER,
    },
    await store(),
  );
  assert.equal(accepted.proposal, undefined, "accepting drops the proposal");
  assert.equal(accepted.fact, "what the agent concluded instead");
  assert.deepEqual(accepted.correction, {
    by: "person",
    who: "admin@example.com",
    at: LATER,
  });

  const again = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Bologna Express",
      fact: "a second conclusion",
      run: "r-2",
      at: LATER,
    },
    await store(),
  );
  assert.ok(again.fact.proposal, "a fresh proposal against the corrected fact");
  const dismissed = await dismissProposal(ctx, accountId, "person-1", await store());
  assert.equal(dismissed.proposal, undefined, "dismissing takes the proposal away");
  assert.equal(
    dismissed.fact,
    "what the agent concluded instead",
    "and leaves the sentence the person's correction put there",
  );
  assert.deepEqual(dismissed.correction, accepted.correction, "with its provenance");
});

test("a sheet of the earlier memory is read as an entity, and the next write is this version", async () => {
  await writeAppFileAt(ctx, accountId, factPath("legacy-1"), {
    v: 3,
    id: "legacy-1",
    subject: "Cargo 88",
    fact: "the client that books on Fridays",
    origin: { by: "run", run: "r-0" },
    at: AT,
    links: [],
    standing: false,
    group: accountId,
  });
  written.push("legacy-1");

  const projected = await store();
  const entity = projected.entities.find((one) => one.normalized === "cargo 88");
  assert.ok(entity, "the subject is an entity the reading projects");
  assert.equal(entity.kind, "other", "of no kind the sheet stated");
  assert.equal(
    projected.facts.find((fact) => fact.id === "legacy-1")?.entity,
    entity.id,
    "and the sheet is a fact about it",
  );
  assert.deepEqual(
    recallMemory(projected.index, { words: "Cargo 88 books", now: NOW }).facts.map(
      (fact) => fact.id,
    ),
    ["legacy-1"],
    "which the retrieval already finds by its subject",
  );

  const next = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Cargo 88",
      fact: "the client that books on Fridays and Mondays",
      run: "r-1",
      at: LATER,
    },
    await store(),
  );
  written.push(next.fact.id);
  assert.equal(
    next.fact.entity,
    entity.id,
    "the write lands on the entity the sheet projected, not a second one",
  );
  const rewritten = await readFact(ctx, accountId, "legacy-1");
  assert.equal(rewritten?.fact.v, MEMORY_VERSION, "the document is this version now");
  assert.equal(
    rewritten?.fact.validTo,
    LATER,
    "and the fact it replaced is closed rather than overwritten",
  );
  assert.equal(
    rewritten?.fact.origin.by,
    "run",
    "keeping the run the earlier sheet came from",
  );
});

test("a write whose reading was overtaken is decided again, against one entity", async () => {
  const first = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Maersk",
      fact: "the usual shipper",
      run: "r-1",
      at: AT,
    },
    await store(),
  );
  written.push(first.fact.id, first.entity.id);

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
    },
    await store(),
  );
  written.push(other.fact.id, other.entity.id);

  const second = await rememberFact(
    ctx,
    accountId,
    {
      subject: "maersk",
      fact: "the usual shipper, corrected",
      run: "r-2",
      at: LATER,
    },
    stale,
  );
  assert.equal(
    second.fact.entity,
    first.entity.id,
    "the write finds the entity it meant",
  );
  const open = (await store()).facts.filter(
    (fact) => fact.entity === first.entity.id && fact.validTo === undefined,
  );
  assert.deepEqual(
    open.map((fact) => fact.fact),
    ["the usual shipper, corrected"],
    "one fact in force about the entity, not two",
  );
});

test("writes made at once are made one at a time, so none loses the race", async () => {
  const reading = await store();
  const names = ["Hapag", "CMA CGM", "MSC"];
  const writes = names.flatMap((subject) => [
    { subject, fact: `${subject} books here`, run: "r-burst", at: AT },
    { subject, fact: `${subject} books here`, run: "r-burst", at: LATER },
  ]);
  const docs = await Promise.all(
    writes.map((write) => rememberFact(ctx, accountId, write, reading)),
  );
  for (const doc of docs) {
    if (!written.includes(doc.fact.id)) written.push(doc.fact.id);
    if (!written.includes(doc.entity.id)) written.push(doc.entity.id);
  }
  const held = (await store()).entities.filter((entity) =>
    names.some((name) => entity.normalized === name.toLowerCase()),
  );
  assert.equal(
    held.length,
    3,
    "one entity per subject, whatever order the writes ran in",
  );
  const facts = (await store()).facts.filter((fact) =>
    held.some((entity) => entity.id === fact.entity),
  );
  assert.equal(facts.length, 3, "and one fact each: the second write was a duplicate");
});

test("a person's correction and removal are refused when the fact they saw moved", async () => {
  const first = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Oltremare",
      fact: "the usual shipper for the northern route",
      run: "r-1",
      at: AT,
    },
    await store(),
  );
  written.push(first.fact.id, first.entity.id);

  const stale = await store();
  const moved = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Oltremare",
      fact: "what the agent now concludes about the northern route",
      run: "r-2",
      at: LATER,
    },
    await store(),
  );
  written.push(moved.fact.id);

  const refused = (err: unknown) => err instanceof MemoryError && err.status === 409;
  await assert.rejects(
    () =>
      correctFactByPerson(
        ctx,
        accountId,
        {
          id: first.fact.id,
          subject: "Oltremare",
          fact: "the shipper for the northern route, as the office reads it",
          who: "admin@example.com",
          at: LATER,
        },
        stale,
      ),
    refused,
    "the correction is decided on a fact that moved, and is refused",
  );
  await assert.rejects(
    () => forgetFact(ctx, accountId, first.fact.id, stale),
    refused,
    "and the removal, decided on the same stale fact, is refused too",
  );
  assert.ok(await readFact(ctx, accountId, first.fact.id), "so it is still in memory");
});

test("a person's correction moves the fact to the entity they named", async () => {
  const held = await rememberFact(
    ctx,
    accountId,
    {
      subject: "Cargo 88",
      fact: "the client that books on Fridays",
      run: "r-1",
      at: AT,
    },
    await store(),
  );
  written.push(held.fact.id, held.entity.id);

  const corrected = await correctFactByPerson(
    ctx,
    accountId,
    {
      id: held.fact.id,
      subject: "Cargo 99",
      fact: "the client that books on Fridays, as the office reads it",
      who: "admin@example.com",
      at: LATER,
    },
    await store(),
  );
  written.push(corrected.entity);
  assert.equal(
    corrected.entity,
    entityIdFor("Cargo 99"),
    "the fact is about the entity the person named",
  );
  assert.equal(corrected.correction?.who, "admin@example.com");
  assert.equal(
    (await store()).entities.some((one) => one.normalized === "cargo 99"),
    true,
    "and that entity exists, because a person's fact created it",
  );
});

test("the memory refuses one more fact about an entity at its ceiling", async () => {
  const name = "Hapag-Lloyd";
  const entity = {
    v: MEMORY_VERSION,
    id: entityIdFor(name),
    kind: "client",
    name,
    normalized: "hapag-lloyd",
    origin: { by: "run", run: "r-0" },
    at: AT,
  };
  await writeAppFileAt(ctx, accountId, entityPath(entity.id), entity);
  written.push(entity.id);
  for (let at = 0; at < MEMORY_FACTS_PER_ENTITY; at += 1) {
    const id = `cap-${at}`;
    await writeAppFileAt(ctx, accountId, factPath(id), {
      v: MEMORY_VERSION,
      id,
      entity: entity.id,
      predicate: "is",
      value: { text: `sentence ${at}` },
      fact: `sentence ${at}`,
      origin: { by: "run", run: "r-0" },
      at: AT,
      validFrom: AT,
      validTo: LATER,
    });
    written.push(id);
  }
  const held = await store();
  await assert.rejects(
    () =>
      rememberFact(
        ctx,
        accountId,
        {
          subject: name,
          fact: "one more thing about it",
          run: "r-1",
          at: NOW,
        },
        held,
      ),
    (err: unknown) => err instanceof MemoryError && err.code === "memory_full",
    "the cap is per entity, and it is refused loudly rather than silently pruned",
  );
});

test("a document this build cannot read is reported, never read as an empty fact", async () => {
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
    "a document whose bytes do not parse is refused with its own code",
  );
  const reading = await listMemory(ctx, accountId);
  assert.ok(
    reading.problems.some((problem) => problem.includes("memory/junk.json")),
    "and a listing reports it rather than skipping it",
  );
  assert.ok(
    !reading.facts.some((fact) => fact.id === "junk"),
    "without reading it as an empty fact",
  );

  await writeAppFileAt(ctx, accountId, "memory/other.json", {
    v: MEMORY_VERSION,
    id: "other",
  });
  written.push("other");
  assert.ok(
    (await listMemory(ctx, accountId)).problems.some((problem) =>
      problem.includes("other.json"),
    ),
    "a v4 document that is neither shape is refused by name",
  );
});

test("a document whose stamp has not moved is not downloaded a second time", async () => {
  /*
   * The store is read once per pass and a pass is asked every ten seconds, so a
   * memory that has grown is a memory that is walked on every one of them. What
   * decides whether that costs is whether a document that has not moved is read
   * again — one write lands, one document's stamp moves, and the ones beside it
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
        entity: entityIdFor(`stamp subject ${id}`),
        predicate: "is",
        value: { text: sentence },
        fact: sentence,
        origin: { by: "run", run: "r-1" },
        at: AT,
        validFrom: AT,
      });
      written.push(id);
    };
    await sheet("stamp-fact", "the first sentence");
    await sheet("stamp-other", "a second fact, not the one that will move");

    downloads.length = 0;
    const first = await store();
    assert.equal(downloads.length, 2, "the first walk reads both documents");

    await sheet("stamp-fact", "the second sentence, same entity");
    downloads.length = 0;
    const second = await store();
    assert.equal(
      downloads.length,
      1,
      "the document that moved is read again, and only it",
    );
    assert.equal(
      second.facts.find((fact) => fact.id === "stamp-fact")?.fact,
      "the second sentence, same entity",
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

test("an entity the memory holds nothing about has no history to read", async () => {
  await assert.rejects(
    () => readHistory(ctx, accountId, "Nobody"),
    (err: unknown) => err instanceof MemoryError && err.code === "entity_not_found",
    "the read refuses by name rather than answering an empty list",
  );
});
