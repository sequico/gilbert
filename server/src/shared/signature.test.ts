import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNATURE_SEPARATOR, textSignatureBlock } from "./signature.js";

test("a signature sits below the body behind the standard delimiter", () => {
  // One rule for both writers: the composer and the agent put a group's footer
  // on a message the same way, which is what makes it a footer rather than
  // whatever each of them happened to do.
  assert.equal(SIGNATURE_SEPARATOR, "-- ");
  assert.equal(
    textSignatureBlock("Team Greensley"),
    "\n\n-- \nTeam Greensley",
    "two newlines, the delimiter line, then the signature",
  );
});

test("no signature is no block, not an empty delimiter", () => {
  // An identity without a signature must not leave a stray `-- ` line, which
  // every reader's client would then hide along with the line after it.
  assert.equal(textSignatureBlock(""), "");
  assert.equal(textSignatureBlock(null), "");
  assert.equal(textSignatureBlock(undefined), "");
});
