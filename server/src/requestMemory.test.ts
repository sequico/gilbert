import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetRemembered, recalled } from "./requestMemory.js";

test("a scoped forget leaves another unit's memory alone", async () => {
  const a = {};
  const b = {};
  let reads = 0;
  const read = async () => ++reads;

  assert.equal(await recalled(a, "k", read), 1);
  assert.equal(await recalled(b, "k", read), 2);

  forgetRemembered(a);
  assert.equal(await recalled(a, "k", read), 3, "the scoped unit read again");
  assert.equal(await recalled(b, "k", read), 2, "the other unit kept its answer");

  forgetRemembered();
  assert.equal(await recalled(b, "k", read), 4, "no argument still clears all");
});
