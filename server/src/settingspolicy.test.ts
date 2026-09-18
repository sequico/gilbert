import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isRecord } from "./shared/json.js";

/**
 * The shipped example policy, checked against the rules the server enforces.
 *
 * An example that has drifted out of step with the parser is worse than no
 * example: somebody copies it, the server refuses to start, and the first
 * experience of the feature is a crash loop. This does not import the config
 * module -- reading it has side effects and wants a whole environment -- so the
 * rules it checks are restated here. A rule that has one home in the tree is
 * asked at that home: the sections below are checked with `isRecord`
 * (`server/src/shared/json.ts`), the predicate the server reads them with.
 */
const EXAMPLE = fileURLToPath(
  new URL("../../settings-policy.example.json", import.meta.url),
);

test("the example policy is valid JSON", () => {
  assert.doesNotThrow(() => JSON.parse(readFileSync(EXAMPLE, "utf8")));
});

test("the example policy has the three sections, in the shapes the server reads", () => {
  const p = JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
  for (const section of ["defaults", "enforced"]) {
    const v = p[section];
    assert.ok(isRecord(v), `${section} must be an object`);
  }
  assert.ok(Array.isArray(p.changes), "changes must be a list");
});

test("every change in the example has a unique version and settings", () => {
  const p = JSON.parse(readFileSync(EXAMPLE, "utf8")) as {
    changes: Array<{ version?: unknown; settings?: unknown }>;
  };
  const seen = new Set<string>();
  for (const [i, c] of p.changes.entries()) {
    assert.equal(typeof c.version, "string", `changes[${i}] needs a string version`);
    assert.ok((c.version as string).trim(), `changes[${i}] needs a non-empty version`);
    assert.ok(
      !seen.has(c.version as string),
      `changes[${i}] repeats version ${String(c.version)}`,
    );
    seen.add(c.version as string);
    assert.ok(isRecord(c.settings), `changes[${i}] needs a settings object`);
  }
});

test("the example's commentary cannot be mistaken for a section", () => {
  /*
   * JSON has no comments, so the example explains itself in `_`-prefixed keys.
   * The server reads three names and ignores everything else, which is what
   * makes that safe -- but only for as long as no comment key collides with a
   * real one.
   */
  const p = JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
  const real = new Set(["defaults", "enforced", "changes"]);
  for (const key of Object.keys(p)) {
    assert.ok(real.has(key) || key.startsWith("_"), `unexpected top-level key ${key}`);
  }
});
