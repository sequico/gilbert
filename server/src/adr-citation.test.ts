import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkCitations,
  citationsIn,
  collectRepoInput,
  formatReport,
} from "../../scripts/adr-citation-check.mjs";

/**
 * Every citation points at a record that exists (docs/adr/README.md).
 *
 * A comment saying `(ADR 0003)` is a promise that a reader can go and read why
 * the code is shaped this way. The records were consolidated — six of them now
 * hold what fifteen used to — and this is the check that keeps a citation from
 * pointing at a number whose file is gone, or at a section the record does not
 * have. It is the machine half of "a comment is a claim about the code".
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
    files: [file("server/src/a.ts", "// The policy (ADR 0015).")],
    records: RECORDS,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.unknown.map((one) => one.number),
    ["0015"],
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
    files: [file("web/src/lib/x.ts", "one\n// (ADR 0014)\n")],
    records: RECORDS,
  });
  assert.equal(
    formatReport(result)[0],
    "no record: web/src/lib/x.ts:2 cites ADR 0014, and no such file exists",
  );
});

test("this repository passes, and it was actually read", () => {
  const { files, records } = collectRepoInput();
  const result = checkCitations({ files, records });
  assert.ok(files.length > 50, "the tree was read");
  assert.ok(records.length >= 6, "the records that exist were found");
  assert.ok(result.ok, `unresolved citations:\n${formatReport(result).join("\n")}`);
});
