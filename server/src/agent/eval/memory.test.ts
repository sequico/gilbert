import assert from "node:assert/strict";
import { test } from "node:test";
import { measureMemory } from "./memory.js";

test("the memory's retrieval measures whole on the repository's corpus", () => {
  /*
   * The measure is the guard on the three things a change to the retrieval can
   * break without any other test noticing: a closed or expired fact creeping into
   * the turn costs precision, a missed relation costs recall, and either way a
   * person reads two numbers that are no longer 1.
   */
  const measured = measureMemory();
  assert.equal(measured.precision, 1, "nothing a person would not want is carried");
  assert.equal(measured.recall, 1, "and nothing a person would want is left out");
  assert.equal(measured.cases.length, 6);
});

test("the two cases about time carry nothing, and the hop carries only one", () => {
  const measured = measureMemory();
  const byName = new Map(measured.cases.map((one) => [one.name, one]));
  assert.deepEqual(
    byName.get("a fact the memory closed is not recalled")?.found,
    [],
    "a closed fact is history, not a live turn",
  );
  assert.deepEqual(
    byName.get("a fact past the TTL is not recalled")?.found,
    [],
    "and so is one older than the memory's TTL",
  );
  assert.deepEqual(
    byName.get("a booking, and the one hop to its shipper")?.found,
    ["f-book", "f-book-is", "f-alias", "f-port", "f-ship"],
    "the shipper is one hop from the booking, and the port two: not carried",
  );
});

test("a case a person would not accept moves the number it should", () => {
  const measured = measureMemory([
    { name: "a wrong fact", words: "MSK", expected: ["f-bologna"] },
  ]);
  assert.equal(measured.precision, 0, "what was carried is not what was wanted");
  assert.equal(measured.recall, 0, "and what was wanted was not carried");
});
