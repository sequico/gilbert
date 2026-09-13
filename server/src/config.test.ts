import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertImmutable } from "./config.js";

/**
 * `IMMUTABLE`, and what it is a claim about (ADR 0001).
 *
 * It says the container is read-only and keeps nothing durable of its own. It
 * is checked rather than taken on trust, because setting the variable while
 * forgetting `--read-only` is the easy mistake and an instance that believed
 * it would look healthy while writing where the next image will not look.
 * Nothing Gilbert holds durably is on this filesystem any more — sessions, the
 * policy, the lock and the agent's records are documents in Stalwart — so what
 * is left to check is the property itself.
 */

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "gilbert-immutable-"));
}

test("IMMUTABLE refuses a writable root, and leaves no probe behind", () => {
  const root = tempRoot();
  try {
    assert.throws(() => assertImmutable(root), /is writable/);
    assert.equal(existsSync(join(root, ".immutable-probe")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IMMUTABLE accepts a root it cannot write to", () => {
  const root = tempRoot();
  try {
    chmodSync(root, 0o555);
    assert.doesNotThrow(() => assertImmutable(root));
  } finally {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
