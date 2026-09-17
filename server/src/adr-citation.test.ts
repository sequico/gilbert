import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkCitations,
  checkRecordShape,
  citationsIn,
  collectRepoInput,
  formatReport,
  formatShapeReport,
  recordProblems,
} from "../../scripts/adr-citation-check.mjs";

/**
 * Every citation points at a record that exists, and every record says what it
 * is.
 *
 * A comment saying `(ADR 0003)` is a promise that a reader can go and read why
 * the code is shaped this way, and this is the check that keeps a citation
 * from pointing at a number whose file is gone, or at a section the record
 * does not have. It is the machine half of "a comment is a claim about the
 * code".
 *
 * The second half is what a citation is followed *to*: a record states its
 * `Status` and its `Implementation`, once each, above its first section. Six
 * records carried no `Status` at all and no gate noticed, which is the defect
 * these tests exist to keep from returning.
 */

const file = (path: string, text: string) => ({ path, text });
const RECORDS = ["0001", "0002", "0003", "0005", "0007", "0009"];

test("a citation naming a record that exists passes", () => {
  const result = checkCitations({
    files: [file("server/src/a.ts", "// The lock (ADR 0001).")],
    records: RECORDS,
  });
  assert.ok(result.ok);
  assert.equal(result.counts.citations, 1);
});

test("a citation naming a number no file answers to is reported", () => {
  const result = checkCitations({
    files: [file("server/src/a.ts", "// The policy (ADR 9999).")],
    records: RECORDS,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.unknown.map((one) => one.number),
    ["9999"],
  );
});

test("a citation with a section number is refused even when the record exists", () => {
  const result = checkCitations({
    files: [file("server/src/a.ts", "// Coordination (ADR 0003 §6).")],
    records: RECORDS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.unknown.length, 0, "the record exists");
  assert.match(result.broken[0]!.why, /section number/);
});

test("`ADR §6` names no record at all and is refused", () => {
  const { numbers, broken } = citationsIn("// exactly one worker holds it (ADR §6)");
  assert.deepEqual(numbers, []);
  assert.match(broken[0]!.why, /names a section of no record/);
});

test("a section citation that follows no record is somebody else's document", () => {
  /*
   * An RFC's numbering is not this repository's to police: `RFC 8620 §5.3` is
   * a citation of the spec, and a check that refused it would be wrong about
   * most of the tree.
   */
  const { numbers, broken } = citationsIn("// the error object RFC 8620 §5.3 defines");
  assert.deepEqual(numbers, []);
  assert.deepEqual(broken, []);
});

test("a three-digit number is refused rather than read as a record", () => {
  const { numbers, broken } = citationsIn("// (ADR 003)");
  assert.deepEqual(numbers, []);
  assert.match(broken[0]!.why, /four-digit/);
});

test("the report says where the citation is", () => {
  const result = checkCitations({
    files: [file("web/src/lib/x.ts", "one\n// (ADR 9999)\n")],
    records: RECORDS,
  });
  assert.equal(
    formatReport(result)[0],
    "no record: web/src/lib/x.ts:2 cites ADR 9999, and no such file exists",
  );
});

test("this repository passes, and it was actually read", () => {
  const { files, records } = collectRepoInput();
  const result = checkCitations({ files, records });
  assert.ok(files.length > 50, "the tree was read");
  assert.ok(records.length >= 6, "the records that exist were found");
  assert.ok(result.ok, `unresolved citations:\n${formatReport(result).join("\n")}`);
});

/* ----------------------------------------------------------------- */
/* The record's own header                                           */
/* ----------------------------------------------------------------- */

/** A record with the header the law describes, as a starting point. */
const record = (header: string) =>
  `# ADR 0001 — Administration\n\n${header}\n## Context\n\nSomething.\n`;

const HEAD = "Status: Accepted\n\nImplementation: Built. `server/src/app.ts`.";

/** The reasons `recordProblems` gave, for a header. */
const why = (header: string) =>
  recordProblems({ name: "docs/adr/0001-a.md", text: record(header) }).map(
    (one) => one.why,
  );

test("a record stating both lines passes", () => {
  assert.deepEqual(why(HEAD), []);
  assert.ok(checkRecordShape({ recordFiles: [{ name: "x", text: record(HEAD) }] }).ok);
});

test("a record with no Status is reported, and says which line is missing", () => {
  const reasons = why("Implementation: Built. Nothing else.");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /no `Status` line/);
});

test("a record with no Implementation is reported", () => {
  /* The half that matters most: this is the record a reader cannot place -- no
     `Status` and no `Implementation`, which is exactly how six records sat
     unnoticed before the header was checked at all. */
  const reasons = why("");
  assert.deepEqual(reasons.length, 2);
  assert.match(reasons.join("\n"), /no `Status` line/);
  assert.match(reasons.join("\n"), /no `Implementation` line/);
});

test("a record stating Status twice is reported rather than counted once", () => {
  const reasons = why(`Status: Proposed\n${HEAD}`);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /2 `Status` lines/);
});

test("a Status outside the vocabulary is refused", () => {
  const reasons = why("Status: Superseded\n\nImplementation: Built. `x.ts`.");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /begins with none of Proposed, Accepted/);
});

test("an Implementation outside the vocabulary is refused", () => {
  const reasons = why("Status: Accepted\n\nImplementation: Eventually, maybe.");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /Built, Partly built, Not built/);
});

test("the three values Implementation may carry are the three it accepts", () => {
  for (const value of [
    "Built. `a.ts`.",
    "Built, and carried by the repository's shape.",
    "Partly built. The read is there.",
    "Not built. Nothing carries this yet.",
  ])
    assert.deepEqual(why(`Status: Accepted\n\nImplementation: ${value}`), [], value);
});

test("lines below the first section are refused: the header says nothing anyway", () => {
  const text = `# ADR 0001 — Administration\n\n## Context\n\n${HEAD}\n`;
  const reasons = recordProblems({ name: "docs/adr/0001-a.md", text }).map(
    (one) => one.why,
  );
  assert.equal(reasons.length, 2);
  assert.match(reasons.join("\n"), /below the record's first section/);
});

test("the shape report says where, and names the record", () => {
  const problems = recordProblems({
    name: "docs/adr/0007-a.md",
    text: record("Status: Maybe\n\nImplementation: Built. `x.ts`."),
  });
  assert.equal(problems[0]!.path, "docs/adr/0007-a.md");
  assert.equal(problems[0]!.line, 3);
  assert.match(
    formatShapeReport({ problems })[0]!,
    /^record: docs\/adr\/0007-a\.md:3 — /,
  );
});

test("this repository's records all state both lines, and were actually read", () => {
  const { recordFiles } = collectRepoInput();
  const result = checkRecordShape({ recordFiles });
  assert.ok(recordFiles.length >= 6, "the records were found");
  assert.ok(
    result.ok,
    `records missing a line:\n${formatShapeReport(result).join("\n")}`,
  );
});
