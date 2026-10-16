/**
 * The memory's sheet and its selection (ADR 0037) — no server, no I/O.
 *
 * What is pinned here is the whole of what a call carries: a malformed sheet is
 * refused and never guessed at, a sheet of the version before this one reads as
 * a fact about no group, the selection is the **standing set of the group being
 * worked** plus the subjects the change names plus their nearest links, a call
 * with nothing to recall carries nothing, and both ceilings bound what a call is
 * handed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FactDoc,
  MEMORY_VERSION,
  parseFactDocumentDetailed,
  RECALL_CHARS_MAX,
  RECALL_FACTS_MAX,
  recallFacts,
  sameSubject,
} from "./memory.js";

const AT = "2026-10-16T10:00:00.000Z";
/** The group the sheets below are about, unless a test says otherwise. */
const GROUP = "a-group";

/** One sheet this build would write, with whatever a test changes. */
function sheet(over: Partial<FactDoc> = {}): FactDoc {
  return {
    v: MEMORY_VERSION,
    id: "f-1",
    subject: "Maersk",
    fact: "the usual shipper for container bookings",
    origin: { by: "run", run: "r-1" },
    at: AT,
    links: [],
    standing: false,
    group: GROUP,
    ...over,
  };
}

test("a sheet carries what is held, where it came from, what it links to and the group it is about", () => {
  const written = sheet({ links: ["f-2", "f-3"] });
  const parsed = parseFactDocumentDetailed(JSON.stringify(written));
  assert.ok("fact" in parsed, "a sheet this build wrote is a sheet it reads");
  assert.deepEqual(parsed.fact, written, "round-tripped whole");
  assert.equal(parsed.fact.group, GROUP, "with the group the fact is about");

  const byPerson = parseFactDocumentDetailed(
    JSON.stringify(sheet({ origin: { by: "person", who: "admin@example.com" } })),
  );
  assert.ok("fact" in byPerson, "a fact a person wrote is a sheet like any other");
  assert.deepEqual(byPerson.fact.origin, {
    by: "person",
    who: "admin@example.com",
  });
});

test("a sheet of the version before this one reads as a fact about no group", () => {
  /*
   * `group` is the field this version added, so a sheet written before it names
   * none: it reads — a version carries a change to the facts an installation
   * wrote, it does not orphan them — and it is about no group, so it stands for
   * none while staying recalled by its subject.
   */
  const { group: _none, ...older } = sheet();
  const parsed = parseFactDocumentDetailed(JSON.stringify({ ...older, v: 1 }));
  assert.ok("fact" in parsed, "the version before this one is read");
  assert.equal(parsed.fact.group, "", "with no group it is about");
  assert.equal(parsed.fact.v, MEMORY_VERSION, "and it reads as this build's version");
});

test("a sheet this build cannot read is reported, with what was wrong", () => {
  const whole = sheet();
  const bad = [
    ["not JSON at all", /Not valid JSON/],
    ["[]", /must be a JSON object/],
    [JSON.stringify({ ...whole, v: MEMORY_VERSION + 1 }), /this build reads version/],
    // A version this build does not write and does not know: a document a newer
    // Gilbert wrote, refused rather than guessed at.
    [JSON.stringify({ ...whole, v: 0 }), /this build reads version/],
    [JSON.stringify({ ...whole, id: "" }), /"id" must be/],
    [JSON.stringify({ ...whole, subject: "  " }), /"subject" must say/],
    [JSON.stringify({ ...whole, fact: "" }), /"fact" must say/],
    [JSON.stringify({ ...whole, origin: { by: "nobody" } }), /"origin" must name/],
    [JSON.stringify({ ...whole, origin: { by: "run" } }), /"origin" must name/],
    [JSON.stringify({ ...whole, at: "soon" }), /"at" must be the instant/],
    [JSON.stringify({ ...whole, links: ["f-2", 7] }), /"links" must be the ids/],
    [JSON.stringify({ ...whole, standing: "yes" }), /"standing" must be true or false/],
    // A sheet of this version names the group it is about; one that names none is
    // a document this build did not write.
    [JSON.stringify({ ...whole, group: "" }), /"group" must name/],
    [JSON.stringify({ ...whole, group: 7 }), /"group" must name/],
    [JSON.stringify({ ...whole, group: undefined }), /"group" must name/],
  ] as const;

  for (const [text, expectation] of bad) {
    const parsed = parseFactDocumentDetailed(text);
    assert.ok("problem" in parsed, `${text} is refused`);
    assert.match(parsed.problem, expectation);
  }

  // A field this build does not know does not refuse a sheet that is otherwise
  // whole, and the next write of it drops what was unknown.
  const parsed = parseFactDocumentDetailed(JSON.stringify({ ...whole, confidence: 0.5 }));
  assert.ok("fact" in parsed, "an extra key decides nothing");
  assert.equal((parsed.fact as unknown as Record<string, unknown>).confidence, undefined);
});

test("a subject is the same subject whatever case it is written in", () => {
  assert.equal(sameSubject(" Maersk ", "maersk"), true);
  assert.equal(sameSubject("Maersk", "Maersk Line"), false);
});

test("the selection carries the group's standing set, what the change names and their nearest links", () => {
  const standing = sheet({ id: "f-standing", subject: "this group", standing: true });
  const named = sheet({ id: "f-named", subject: "Maersk" });
  const linked = sheet({ id: "f-linked", subject: "container 12" });
  const far = sheet({ id: "f-far", subject: "an old invoice" });
  const withLink = sheet({ id: "f-linker", subject: "ACME", links: ["f-linked"] });
  /*
   * A group's own standing fact, and one of **another** group: the standing set
   * is what a group keeps about itself, so only the first is carried without
   * being named — while the second is a fact like any other, recalled by its
   * subject for any group, because one memory serves the installation.
   */
  const theirStanding = sheet({
    id: "f-theirs",
    subject: "the other group's convention",
    standing: true,
    group: "another-group",
  });
  const memory = [standing, named, linked, far, withLink, theirStanding];

  const picked = recallFacts(
    memory,
    "mail created: m-1\nshipper: Maersk\nclient: ACME",
    GROUP,
  );
  assert.deepEqual(
    picked.map((fact) => fact.id),
    ["f-standing", "f-named", "f-linker", "f-linked"],
    "the group's standing set first, then what the change names, then one hop from them",
  );
  assert.ok(
    !picked.some((fact) => fact.id === "f-far"),
    "a fact nothing named and nothing linked is not carried",
  );
  assert.ok(
    !picked.some((fact) => fact.id === "f-theirs"),
    "and another group's standing fact is not this group's to carry unnamed",
  );
  assert.deepEqual(
    recallFacts(memory, "the other group's convention", GROUP).map((fact) => fact.id),
    ["f-theirs"],
    "while any fact is recalled by its subject, whichever group it is about",
  );

  // A subject is recalled when the change's own words carry it, however the
  // sheet spells the subject around it.
  const around = sheet({ id: "f-around", subject: "shipper: Bologna Express" });
  const byWord = recallFacts([around], "the shipper: Bologna Express is late", GROUP);
  assert.deepEqual(
    byWord.map((fact) => fact.id),
    ["f-around"],
  );
  assert.deepEqual(
    recallFacts([named], "nothing here names it", GROUP).map((fact) => fact.id),
    [],
    "and a change that names nothing recalls nothing of it",
  );
});

test("a call with nothing to recall carries nothing at all", () => {
  assert.deepEqual(recallFacts([], "mail created: m-1", GROUP), [], "an empty memory");
  assert.deepEqual(
    recallFacts([sheet(), sheet({ id: "f-2", subject: "ACME" })], "", GROUP),
    [],
    "and a memory with nothing standing and no words to read it against",
  );
});

test("both ceilings bound what a call carries", () => {
  // More facts than the ceiling names: the selection is cut at the end, and
  // what is carried is what fits rather than the whole graph.
  const many = Array.from({ length: RECALL_FACTS_MAX + 5 }, (_, at) =>
    sheet({ id: `f-${at}`, subject: `s${at}` }),
  );
  const words = many.map((fact) => fact.subject).join(" ");
  const picked = recallFacts(many, words, GROUP);
  assert.equal(
    picked.length,
    RECALL_FACTS_MAX,
    "no call carries more facts than the ceiling allows",
  );
  assert.deepEqual(
    picked.map((fact) => fact.id),
    many.slice(0, RECALL_FACTS_MAX).map((fact) => fact.id),
    "and the ones it drops are the end of the selection",
  );

  // Fewer facts, and more characters than the ceiling: the character ceiling is
  // the one that bites.
  const long = Array.from({ length: 5 }, (_, at) =>
    sheet({ id: `g-${at}`, subject: `t${at}`, fact: "x".repeat(1_000) }),
  );
  const chars = recallFacts(long, long.map((fact) => fact.subject).join(" "), GROUP);
  assert.ok(chars.length < long.length, "the character ceiling cuts the selection");
  const carried = chars.reduce(
    (total, fact) => total + fact.subject.length + fact.fact.length,
    0,
  );
  assert.ok(
    carried <= RECALL_CHARS_MAX,
    `what a call carries stays inside the ceiling (${carried} > ${RECALL_CHARS_MAX})`,
  );

  // The standing set is taken first, so it is the last thing a ceiling drops.
  const standing = Array.from({ length: RECALL_FACTS_MAX + 3 }, (_, at) =>
    sheet({ id: `h-${at}`, subject: `u${at}`, standing: true }),
  );
  assert.equal(
    recallFacts(standing, "", GROUP).length,
    RECALL_FACTS_MAX,
    "and a standing set larger than the ceiling is still bounded by it",
  );
  assert.deepEqual(
    recallFacts(standing, "", GROUP).map((fact) => fact.id),
    standing.slice(0, RECALL_FACTS_MAX).map((fact) => fact.id),
    "with the standing facts it drops at the end of that set",
  );
});
