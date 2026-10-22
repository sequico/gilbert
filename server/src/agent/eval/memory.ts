/**
 * The memory's own measure: precision and recall of the retrieval (ADR 0038).
 *
 * The memory is measured by **what it recalls**, not by how much it holds, and a
 * wrong fact recalled is worse than a missing one — so the two numbers are read
 * together and never averaged into a third. The corpus is documents in the
 * repository, like the agent's eval tasks: a change's words, the facts a person
 * would say are about it, and nothing that needs a provider. The similarity cases
 * carry the scores an installation that embeds would have computed, so the
 * ranking is measured here without a key; the live run's own vector is the only
 * part this cannot rehearse.
 *
 *   npx tsx src/agent/eval/memory.ts
 *
 * It is not part of `npm test`'s cost and not the release gate: the suite beside
 * it (`memory.test.ts`) is the regression, and this prints the numbers a person
 * reads before deciding the memory got better.
 */
import {
  buildMemoryIndex,
  type EntityDoc,
  entityFromName,
  type FactDoc,
  MEMORY_VERSION,
  recallMemory,
} from "../../shared/memory.js";

const AT = "2026-10-16T10:00:00.000Z";
/** The pass's clock the corpus is read at: after every fact, inside its TTL. */
const NOW = "2026-10-22T09:00:00.000Z";

function entity(name: string, kind: EntityDoc["kind"]): EntityDoc {
  return { ...entityFromName(name, { by: "run", run: "r-1" }, AT), kind };
}

function fact(
  name: string,
  id: string,
  fact: string,
  over: Partial<FactDoc> = {},
): FactDoc {
  return {
    v: MEMORY_VERSION,
    id,
    entity: entityFromName(name, { by: "run", run: "r-1" }, AT).id,
    predicate: "is",
    value: { text: fact },
    fact,
    origin: { by: "run", run: "r-1" },
    at: AT,
    validFrom: AT,
    ...over,
  };
}

const ENTITIES: readonly EntityDoc[] = [
  entity("Maersk Line", "client"),
  entity("booking 4711", "booking"),
  entity("Bologna Express", "client"),
  entity("Rotterdam", "place"),
  entity("Ligure", "client"),
];

const FACTS: readonly FactDoc[] = [
  fact("Maersk Line", "f-ship", "the usual shipper for container bookings"),
  // Superseded: closed, so the live retrieval must never carry it.
  fact("Maersk Line", "f-ship-old", "the shipper as it was once", {
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: AT,
  }),
  fact("Maersk Line", "f-port", "calls at Rotterdam every second week", {
    predicate: "calls-at",
    value: { entity: entityFromName("Rotterdam", { by: "run", run: "r-1" }, AT).id },
  }),
  fact("booking 4711", "f-book", "goes by the usual shipper", {
    predicate: "ships-with",
    value: { entity: entityFromName("Maersk Line", { by: "run", run: "r-1" }, AT).id },
  }),
  fact("booking 4711", "f-book-is", "the Friday booking"),
  fact("Bologna Express", "f-bologna", "ships on Fridays"),
  fact("Maersk Line", "f-alias", "also written MSK", {
    predicate: "alias",
    value: { text: "MSK" },
  }),
  fact("Rotterdam", "f-rot", "the group's own port"),
  // Older than the memory's TTL: still in the store, never in a live turn.
  fact("Ligure", "f-old", "a client the group no longer books with", {
    validFrom: "2025-01-01T00:00:00.000Z",
  }),
];

/** One labelled case: a change's words, and what a person says it is about. */
export interface MemoryCase {
  name: string;
  words: string;
  /** The similarity an embedding-capable installation would have measured. */
  similarity?: ReadonlyMap<string, number>;
  /** The facts a person would say belong in the turn. */
  expected: readonly string[];
}

/** The corpus: what a change names, what is true now, and what a person expects. */
export const MEMORY_CASES: readonly MemoryCase[] = [
  {
    name: "the subject the change names, and its relations",
    words: "shipment from Maersk Line",
    expected: ["f-alias", "f-ship", "f-port", "f-rot"],
  },
  {
    name: "a booking, and the one hop to its shipper",
    words: "booking 4711 is late",
    expected: ["f-book", "f-book-is", "f-alias", "f-ship", "f-port"],
  },
  {
    name: "an alias an explicit fact states",
    words: "MSK asked for the papers",
    expected: ["f-alias", "f-ship", "f-port", "f-rot"],
  },
  {
    name: "a subject only the vector names",
    words: "the client on the northern route",
    similarity: new Map([["f-bologna", 0.81]]),
    expected: ["f-bologna"],
  },
  {
    name: "a fact the memory closed is not recalled",
    words: "the shipper as it was once",
    expected: [],
  },
  {
    name: "a fact past the TTL is not recalled",
    words: "Ligure",
    expected: [],
  },
];

/** One case, as the measure reads it. */
export interface MemoryCaseMeasure {
  name: string;
  found: string[];
  expected: string[];
  /** Of what was carried, how much a person wanted. */
  precision: number;
  /** Of what a person wanted, how much was carried. */
  recall: number;
}

/** What the memory's retrieval scores. */
export interface MemoryMeasure {
  /** Micro-average over the corpus. */
  precision: number;
  recall: number;
  cases: MemoryCaseMeasure[];
}

/** How much of one case's selection a person would keep, and how much was missed. */
function scoreCase(testCase: MemoryCase, found: readonly string[]): MemoryCaseMeasure {
  const expected = [...testCase.expected];
  const wanted = found.filter((id) => expected.includes(id));
  return {
    name: testCase.name,
    found: [...found],
    expected,
    precision: found.length ? wanted.length / found.length : 1,
    recall: expected.length ? wanted.length / expected.length : 1,
  };
}

/**
 * Measure the retrieval over the corpus, or over one a caller hands in.
 *
 * One index, one pass's clock and no provider: what is measured is the selection
 * this build makes — the subject match, the vector where it is given, the one
 * hop, the closed and expired facts left out — and nothing about how it stores.
 */
export function measureMemory(
  cases: readonly MemoryCase[] = MEMORY_CASES,
): MemoryMeasure {
  const index = buildMemoryIndex(ENTITIES, FACTS);
  const measured = cases.map((testCase) =>
    scoreCase(
      testCase,
      recallMemory(index, {
        words: testCase.words,
        now: NOW,
        ...(testCase.similarity ? { similarity: testCase.similarity } : {}),
      }).facts.map((one) => one.id),
    ),
  );
  const found = measured.reduce((total, one) => total + one.found.length, 0);
  const wanted = measured.reduce((total, one) => total + one.expected.length, 0);
  const kept = measured.reduce(
    (total, one) => total + one.found.filter((id) => one.expected.includes(id)).length,
    0,
  );
  return {
    precision: found ? kept / found : 1,
    recall: wanted ? kept / wanted : 1,
    cases: measured,
  };
}

/** Print the measure, one case a line, when this file is run on its own. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const measured = measureMemory();
  for (const one of measured.cases)
    console.log(
      `${one.precision === 1 && one.recall === 1 ? "ok  " : "miss"} ${one.name}: ` +
        `precision ${one.precision.toFixed(2)}, recall ${one.recall.toFixed(2)}`,
    );
  console.log(
    `memory: precision ${measured.precision.toFixed(3)}, recall ${measured.recall.toFixed(3)}, ` +
      `${measured.cases.length} cases`,
  );
}
