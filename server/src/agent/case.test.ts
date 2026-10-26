import assert from "node:assert/strict";
import { test } from "node:test";
import { CASE_NOTE_MAX, casePath, caseSlug } from "./case.js";

/**
 * A case is filed under the group's own name for it, and a later increment has to
 * compute the same name again from the same words: the slug is the whole of that
 * agreement, so it is tested as a rule and not as a detail (ADR 0034).
 */
test("a case's key becomes the file its note is kept in", () => {
  assert.equal(caseSlug("BK-901"), "bk-901");
  assert.equal(caseSlug("March import"), "march-import");
  assert.equal(caseSlug("  MS2 / BK 901  "), "ms2-bk-901", "punctuation is a dash");
  assert.equal(caseSlug("----"), "case", "a key with nothing in it still names a file");
  assert.equal(caseSlug("x".repeat(200)).length, 60, "and a key is bounded");
  assert.equal(
    caseSlug(`${"x".repeat(59)}-`),
    "x".repeat(59),
    "the bound leaves no dash",
  );

  assert.equal(
    casePath("BK-901"),
    "cases/bk-901.md",
    "under the agent's own bookkeeping",
  );
  assert.equal(CASE_NOTE_MAX, 4 * 1024, "a note is working memory, not a document");
});
