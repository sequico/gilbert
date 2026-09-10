import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adrNumberFromPath,
  checkOwed,
  collectRepoInput,
  formatReport,
} from "../../scripts/adr-owed-check.mjs";

/**
 * The owed debt, kept in one place (ADR 0003 "Owed").
 *
 * An ADR that declares a debt with a code site and the code that carries the
 * debt are two halves of one sentence. This is the check that keeps them from
 * drifting apart in silence: a marker the ADR declares and the code does not
 * carry, or a tag the code claims and no ADR declares, fails the gate.
 */

const file = (path: string, text: string) => ({ path, text });
const adr = (text: string) => file("docs/adr/0003-example.md", text);
const marked = "<!-- owed: a-thing -->\n";
const tagged = (n: string) => `// ADR-${n} OWED: a-thing\n`;

test("a debt marked on both sides passes", () => {
  const result = checkOwed({
    adrFiles: [adr(marked)],
    codeFiles: [file("server/src/x.ts", tagged("0003"))],
  });
  assert.equal(result.ok, true, formatReport(result));
  assert.equal(result.counts.adrMarkers, 1);
  assert.equal(result.counts.codeMarkers, 1);
});

test("a debt the ADR declares and no code carries is reported", () => {
  const result = checkOwed({ adrFiles: [adr(marked)] });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.adrOnly.map((one) => one.slug),
    ["a-thing"],
  );
});

test("a tag the code claims and no ADR declares is reported", () => {
  const result = checkOwed({
    codeFiles: [file("server/src/x.ts", tagged("0003"))],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.codeOnly.map((one) => one.slug),
    ["a-thing"],
  );
});

test("a slug repeated on one side is reported rather than counted twice", () => {
  const result = checkOwed({
    adrFiles: [adr(marked + marked)],
    codeFiles: [file("server/src/x.ts", tagged("0003"))],
  });
  assert.equal(result.ok, false);
  assert.equal(result.duplicates.length, 1);
});

test("the comparison is per ADR, so one slug in two ADRs is two debts", () => {
  const result = checkOwed({
    adrFiles: [
      file("docs/adr/0003-one.md", marked),
      file("docs/adr/0004-two.md", marked),
    ],
    codeFiles: [
      file("server/src/x.ts", tagged("0003")),
      file("server/src/y.ts", tagged("0004")),
    ],
  });
  assert.equal(result.ok, true, formatReport(result));
  assert.equal(result.counts.adrs, 2);
});

test("a marker that cannot be read is reported rather than ignored", () => {
  const result = checkOwed({
    adrFiles: [adr("<!-- owed: Two Words -->\n")],
  });
  assert.equal(result.malformed.length, 1);
});

test("the index cannot own a debt, and an ADR number is four digits", () => {
  assert.equal(adrNumberFromPath("docs/adr/README.md"), null);
  assert.equal(adrNumberFromPath("docs/adr/0003-a-fleet.md"), "0003");
});

test("this repository passes, and it was actually read", () => {
  const { adrFiles, codeFiles } = collectRepoInput();
  assert.ok(codeFiles.length > 100, "the code walk read the tree");
  const result = checkOwed({ adrFiles, codeFiles });
  assert.equal(result.ok, true, formatReport(result));
  assert.ok(result.counts.adrMarkers > 0, "the convention is in use, not only available");
});
