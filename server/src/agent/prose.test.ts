/**
 * The prose that reaches the model, and the order it reaches it in (ADR 0038).
 *
 * The two levels are the installation's own line and the group's standing
 * instruction, and the record names them outermost first. This test is the whole
 * of that order: it fixes the levels and their sequence, so the builder's order
 * cannot move without it. It is the one pin on that order, and the reason it is a
 * test rather than a comment: swapping the two produces a prompt that reads as
 * though the group outranked the installation, and nothing else would notice.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PROSE_LEVELS, proseBlock, proseForModel } from "./prose.js";

test("the model is told the two levels outermost first", () => {
  const blocks = proseForModel({
    installation: "Never write as a person.",
    group: "Answer in the group's own language.",
  });

  assert.deepEqual(
    blocks,
    [
      "The installation's own rules, from whoever runs it:\nNever write as a person.",
      "The group's standing instruction, from its members:\nAnswer in the group's own language.",
    ],
    "the order is the record's: the installation, then the group",
  );
  assert.deepEqual(
    [...PROSE_LEVELS],
    ["installation", "group"],
    "and the order is stated once, outermost first",
  );
});

test("a level that says nothing contributes nothing, and the rest keep their order", () => {
  const blocks = proseForModel({
    group: "  Answer in the group's own language.  ",
  });
  assert.deepEqual(
    blocks,
    [
      "The group's standing instruction, from its members:\nAnswer in the group's own language.",
    ],
    "an empty level leaves no heading behind, and the text is trimmed",
  );
  assert.equal(proseBlock("group", ""), "", "an empty level is no block");
  assert.equal(proseBlock("group", undefined), "", "and neither is a missing one");
});
