import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * The pre-push hook verifies a tree, and the only tree it can verify from a
 * checkout is the one checked out (`scripts/gate-prepush.sh`, ADR 0025). Which
 * commit a push carries is what git says on the hook's stdin, so that is read
 * and acted on: a push whose tip is not HEAD is refused rather than gated
 * against this branch's tree — the hole this file pins, because
 * `git push origin <other-branch>` used to run the gate over the current branch
 * and the tree-hash cache could even skip that.
 *
 * The gate itself is replaced by a stub `npm` on the path. What is under test is
 * which tree the hook decides to gate; running the real pipeline here would take
 * minutes and say nothing about that.
 */

const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "gate-prepush.sh");

/** Every temp repository this file made, removed when it is done. */
const made: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "gilbert-test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "gilbert-test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

/**
 * A repository with two commits and a stub `npm` that records that the gate ran.
 * The first commit is what a push carrying another branch's tree would name.
 */
function repo(): { dir: string; first: string; head: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "gate-prepush-"));
  made.push(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "note.txt"), "one\n");
  git(dir, "add", "note.txt");
  git(dir, "commit", "-qm", "one");
  const first = git(dir, "rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "note.txt"), "two\n");
  git(dir, "commit", "-qam", "two");
  const head = git(dir, "rev-parse", "HEAD").trim();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const marker = join(dir, "gate-ran");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\nprintf ran > "${marker}"\nexit 0\n`);
  chmodSync(join(bin, "npm"), 0o755);
  return { dir, first, head, marker };
}

/** Run the hook the way git does: in the checkout, with the ref update on stdin. */
function hook(dir: string, line: string) {
  return spawnSync("bash", [SCRIPT], {
    cwd: dir,
    input: `${line}\n`,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
  });
}

test("refuses a push whose tip is not the checked-out commit", () => {
  const { dir, first, marker } = repo();

  const result = hook(dir, `refs/heads/main ${first} refs/heads/other ${first}`);

  assert.notEqual(result.status, 0, "the push is refused");
  assert.match(result.stderr, /not the checked-out HEAD/);
  assert.equal(
    existsSync(marker),
    false,
    "and the gate never runs over a tree it was not asked about",
  );
});

test("gates a push whose tip is the checked-out commit", () => {
  const { dir, first, head, marker } = repo();

  const result = hook(dir, `refs/heads/main ${head} refs/heads/main ${first}`);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(marker), true, "the gate ran over the pushed tree");
});

test("a deletion carries no tree, so it is not refused", () => {
  const { dir, head, marker } = repo();
  const zeros = "0".repeat(head.length);

  const result = hook(dir, `(delete) ${zeros} refs/heads/gone ${head}`);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(marker), true, "the gate still runs, over the checkout");
});

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
