/**
 * The memory's shape and its selection, without a server (ADR 0038).
 *
 * The four things the design rests on: an entity is identified by its
 * **normalized** name and an alias is an explicit fact; a fact carries the
 * interval it is true for and a closed one is never recalled; a turn's retrieval
 * matches the change's words **exactly first, then by similarity**, ranked by
 * subject, similarity and recency, and follows relations **one hop**; and the
 * TTL is applied when the pass reads the memory, so an old fact leaves the
 * retrieval without leaving the record.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMemoryIndex,
  cosine,
  type EntityDoc,
  entityFromName,
  entityIdFor,
  type FactDoc,
  factView,
  historyOf,
  isInForce,
  isLive,
  MEMORY_FACT_TTL_MS,
  MEMORY_VERSION,
  normalizeName,
  parseEntityDocumentDetailed,
  parseFactDocumentDetailed,
  parseMemoryDocument,
  predicateProblem,
  recallMemory,
  resolveEntity,
  singleValued,
  subjectProblem,
} from "./memory.js";

const AT = "2026-10-16T10:00:00.000Z";
const NOW = "2026-10-22T09:00:00.000Z";

function entityOf(name: string, over: Partial<EntityDoc> = {}): EntityDoc {
  return { ...entityFromName(name, { by: "run", run: "r-1" }, AT), ...over };
}

function factOf(name: string, over: Partial<FactDoc> & Pick<FactDoc, "id">): FactDoc {
  return {
    v: MEMORY_VERSION,
    entity: entityIdFor(name),
    predicate: "is",
    value: { text: "a sentence" },
    fact: "a sentence",
    origin: { by: "run", run: "r-1" },
    at: AT,
    validFrom: AT,
    ...over,
  };
}

test("an entity is identified by its normalized name", () => {
  assert.equal(normalizeName("  Maersk   Line "), "maersk line");
  assert.equal(entityIdFor("Maersk Line"), entityIdFor("  maersk line "));
  assert.notEqual(entityIdFor("Maersk Line"), entityIdFor("Maersk Lines"));
  const doc = entityOf("Maersk  Line");
  assert.equal(doc.normalized, "maersk line");
  assert.equal(doc.id, entityIdFor("maersk line"));
  const parsed = parseEntityDocumentDetailed(JSON.stringify(doc));
  assert.ok("entity" in parsed);
  assert.deepEqual(parsed.entity, doc);
});

test("a document this build did not write is refused, never guessed at", () => {
  /** The refusal's own sentence, whichever parser answered it. */
  const problem = (parsed: unknown): string =>
    typeof parsed === "object" && parsed !== null && "problem" in parsed
      ? String((parsed as { problem: unknown }).problem)
      : "";
  assert.match(
    problem(
      parseEntityDocumentDetailed(
        JSON.stringify({ ...entityOf("ACME"), v: MEMORY_VERSION + 1 }),
      ),
    ),
    /this build reads version/,
  );
  // An entity's id is derived from its normalized name; one that says otherwise
  // is a document two builds would disagree about.
  assert.match(
    problem(
      parseEntityDocumentDetailed(
        JSON.stringify({ ...entityOf("ACME"), id: "entity-0000000000000000" }),
      ),
    ),
    /the id its normalized name derives/,
  );
  assert.match(
    problem(
      parseFactDocumentDetailed(
        JSON.stringify(factOf("ACME", { id: "f-1", predicate: "" })),
      ),
    ),
    /"predicate"/,
  );
  assert.match(
    problem(
      parseFactDocumentDetailed(
        JSON.stringify({ ...factOf("ACME", { id: "f-1" }), validTo: "yesterday" }),
      ),
    ),
    /"validTo"/,
  );
});

test("a sheet of the earlier memory reads as an entity and an is-fact", () => {
  const sheet = {
    v: 3,
    id: "legacy-1",
    subject: "Bologna Express",
    fact: "the shipper the office books containers with",
    origin: { by: "person", who: "admin@example.com" },
    at: AT,
    links: ["some-other-sheet"],
    standing: true,
    group: "g-1",
  };
  const parsed = parseFactDocumentDetailed(JSON.stringify(sheet));
  assert.ok("fact" in parsed);
  assert.equal(parsed.legacyName, "Bologna Express", "the subject it named");
  assert.deepEqual(
    {
      entity: parsed.fact.entity,
      predicate: parsed.fact.predicate,
      value: parsed.fact.value,
      validFrom: parsed.fact.validFrom,
      validTo: parsed.fact.validTo,
      origin: parsed.fact.origin,
    },
    {
      entity: entityIdFor("Bologna Express"),
      predicate: "is",
      value: { text: "the shipper the office books containers with" },
      validFrom: AT,
      validTo: undefined,
      origin: { by: "person", who: "admin@example.com" },
    },
    "one fact, about the entity its subject named, valid from when it was written",
  );
  assert.equal(isInForce(parsed.fact), true, "a person's word is still in force");
  const whole = parseMemoryDocument(JSON.stringify(sheet));
  assert.ok("document" in whole && whole.document.kind === "fact");
  assert.equal(whole.document.legacyName, "Bologna Express");
});

test("the only two things that are files are checked where they are written", () => {
  assert.equal(subjectProblem("Maersk"), null);
  assert.match(subjectProblem("id") ?? "", /at least 3 characters/);
  assert.equal(predicateProblem("ships-with"), null);
  assert.match(predicateProblem("Ships with!") ?? "", /not a relation/);
  assert.equal(singleValued("is", { text: "x" }), true, "a property has one value");
  assert.equal(
    singleValued("alias", { text: "x" }),
    false,
    "an entity answers to many names",
  );
  assert.equal(
    singleValued("ships-with", { entity: "entity-1" }),
    false,
    "a relation accumulates edges",
  );
});

test("retrieval finds a subject exactly, then by similarity, and never the closed fact", () => {
  const index = buildMemoryIndex(
    [entityOf("Maersk Line"), entityOf("booking 4711")],
    [
      factOf("Maersk Line", {
        id: "f-ship",
        fact: "the usual shipper",
        value: { text: "the usual shipper" },
      }),
      // Superseded: closed, so the live retrieval must not carry it.
      factOf("Maersk Line", {
        id: "f-ship-old",
        fact: "the shipper as it was",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: AT,
      }),
      factOf("booking 4711", {
        id: "f-book",
        fact: "goes by the usual shipper",
        value: { text: "goes by the usual shipper" },
      }),
    ],
  );
  const recalled = recallMemory(index, {
    words: "shipment from Maersk Line",
    now: NOW,
    similarity: new Map([
      ["f-book", 0.99],
      ["f-ship", 0.7],
    ]),
  });
  assert.deepEqual(
    recalled.facts.map((fact) => fact.id),
    ["f-ship", "f-book"],
    "the subject the change names comes first, whatever the vector says",
  );
  assert.deepEqual(
    recalled.facts.map((fact) => fact.entityName),
    ["Maersk Line", "booking 4711"],
  );

  // Without the capability nothing is matched by similarity.
  const exact = recallMemory(index, { words: "shipment from Maersk Line", now: NOW });
  assert.deepEqual(
    exact.facts.map((fact) => fact.id),
    ["f-ship"],
    "and a fact no name matches is not recalled",
  );
});

test("between two entities only similarity names, the closer one comes first", () => {
  const index = buildMemoryIndex(
    [entityOf("ACME"), entityOf("Oltremare")],
    [
      factOf("ACME", { id: "f-acme", fact: "books on Fridays" }),
      factOf("Oltremare", { id: "f-olt", fact: "ships to the Levant" }),
    ],
  );
  const recalled = recallMemory(index, {
    words: "the Levant booking",
    now: NOW,
    similarity: new Map([
      ["f-olt", 0.91],
      ["f-acme", 0.72],
    ]),
  });
  assert.deepEqual(
    recalled.facts.map((fact) => fact.id),
    ["f-olt", "f-acme"],
    "ranked by similarity, and a vector under the floor is not a subject name",
  );
  assert.deepEqual(
    recallMemory(index, {
      words: "the Levant booking",
      now: NOW,
      similarity: new Map([["f-acme", 0.2]]),
    }).facts,
    [],
    "a weak neighbour is a topic, not the subject the change is about",
  );
});

test("a relation is followed one hop, and no further", () => {
  const booking = entityOf("booking 4711");
  const shipper = entityOf("Maersk Line");
  const port = entityOf("Rotterdam");
  const index = buildMemoryIndex(
    [booking, shipper, port],
    [
      factOf("booking 4711", {
        id: "f-link",
        predicate: "ships-with",
        value: { entity: shipper.id },
        fact: "goes by the usual shipper",
      }),
      factOf("Maersk Line", {
        id: "f-port",
        predicate: "calls-at",
        value: { entity: port.id },
        fact: "calls at Rotterdam",
      }),
      factOf("Rotterdam", {
        id: "f-rot",
        fact: "the group's own port",
        value: { text: "the group's own port" },
      }),
    ],
  );
  const recalled = recallMemory(index, { words: "booking 4711", now: NOW });
  assert.deepEqual(
    recalled.facts.map((fact) => fact.id),
    ["f-link", "f-port"],
    "the entity the change names, then what its relation points at",
  );
  assert.ok(
    !recalled.facts.some((fact) => fact.id === "f-rot"),
    "the second hop belongs to the since-when read, not to the live turn",
  );
  assert.equal(
    recalled.facts[0]?.objectName,
    "Maersk Line",
    "a relation names the entity on the other side",
  );
});

test("an alias is an explicit fact, and a name no fact states is not one", () => {
  const maersk = entityOf("Maersk Line");
  const index = buildMemoryIndex(
    [maersk],
    [
      factOf("Maersk Line", {
        id: "f-alias",
        predicate: "alias",
        value: { text: "MSK" },
        fact: "also written MSK",
      }),
      factOf("Maersk Line", {
        id: "f-is",
        fact: "the usual shipper",
        value: { text: "the usual shipper" },
      }),
    ],
  );
  assert.equal(resolveEntity(index, "msk")?.id, maersk.id, "the alias names the entity");
  assert.equal(resolveEntity(index, "Maersk"), null, "another name is another entity");
  assert.equal(resolveEntity(index, "Maersk Line")?.id, maersk.id);
  assert.deepEqual(
    recallMemory(index, { words: "MSK booking", now: NOW }).facts.map((fact) => fact.id),
    ["f-alias", "f-is"],
    "and a change that names the alias recalls the entity it belongs to",
  );
});

test("an old fact leaves the retrieval but not the record", () => {
  const old = factOf("ACME", {
    id: "f-old",
    validFrom: "2025-01-01T00:00:00.000Z",
    fact: "the client this account books for",
  });
  const index = buildMemoryIndex([entityOf("ACME")], [old]);
  assert.equal(isLive(old, NOW), false, "past the memory's own TTL");
  assert.deepEqual(
    recallMemory(index, { words: "ACME", now: NOW }).facts,
    [],
    "the live retrieval leaves it out",
  );
  assert.deepEqual(
    recallMemory(index, {
      words: "ACME",
      now: new Date(Date.parse(old.validFrom) + MEMORY_FACT_TTL_MS - 1_000).toISOString(),
    }).facts.map((fact) => fact.id),
    ["f-old"],
    "and it was recalled while it was young enough to reason from",
  );
  assert.deepEqual(
    historyOf(index, "ACME").map((fact) => fact.id),
    ["f-old"],
    "while the since-when read still answers it",
  );
});

test("the since-when read answers the entity's interval, closed facts included", () => {
  const index = buildMemoryIndex(
    [entityOf("Maersk Line")],
    [
      factOf("Maersk Line", {
        id: "f-first",
        fact: "the shipper as it was",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-06-01T00:00:00.000Z",
      }),
      factOf("Maersk Line", {
        id: "f-second",
        fact: "the shipper as it is",
        validFrom: "2026-06-01T00:00:00.000Z",
      }),
    ],
  );
  assert.deepEqual(
    historyOf(index, "maersk line").map((fact) => fact.id),
    ["f-first", "f-second"],
    "oldest first, in force and closed alike",
  );
  assert.deepEqual(
    historyOf(index, "maersk line", { from: "2026-05-01T00:00:00.000Z" }).map(
      (fact) => fact.id,
    ),
    ["f-first", "f-second"],
    "the interval asked for overlaps both",
  );
  assert.deepEqual(
    historyOf(index, "maersk line", { to: "2026-03-01" }).map((fact) => fact.id),
    ["f-first"],
    "and a question about the past answers the past — the day alone covers that day",
  );
  assert.deepEqual(historyOf(index, "ACME"), [], "an entity the memory has not got");
});

test("a fact's view names its entity, and the index holds the vectors it was written with", () => {
  const vector = [1, 0, 0];
  const index = buildMemoryIndex(
    [entityOf("ACME")],
    [factOf("ACME", { id: "f-1", vector, fact: "books on Fridays" })],
  );
  assert.equal(index.vectors.length, 1, "the vector is carried by the fact's document");
  assert.deepEqual(
    factView(index.facts.get(entityIdFor("ACME"))?.[0] as FactDoc, index),
    {
      ...(index.facts.get(entityIdFor("ACME"))?.[0] as FactDoc),
      entityName: "ACME",
    },
  );
  assert.equal(Math.round(cosine(vector, [1, 0, 0])), 1);
  assert.equal(cosine(vector, [0, 1, 0]), 0);
});
