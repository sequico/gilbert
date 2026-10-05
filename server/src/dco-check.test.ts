import assert from "node:assert/strict";
import { test } from "node:test";

import { checkCommits, formatReport, parseSignOffs } from "../../scripts/dco-check.mjs";

/**
 * The sign-off is the contributor's certification under the DCO, and the check
 * is the only thing that makes it more than a sentence in `DCO`. Each case here
 * fails if the mechanism it names is removed.
 */

const SHA = "a".repeat(40);

/** A commit as `commitsInRange` hands it to `checkCommits`. */
function commit(overrides = {}) {
  return {
    sha: SHA,
    author: { name: "Ada Lovelace", email: "ada@example.org" },
    committer: { name: "Ada Lovelace", email: "ada@example.org" },
    message: "feat: a thing\n",
    ...overrides,
  };
}

test("a sign-off is found whatever its case and spacing", () => {
  const message = "subject\n\nbody\n\nsigned-off-by:  Ada  <ADA@Example.org>\n";
  assert.deepEqual(parseSignOffs(message), [{ name: "Ada", email: "ada@example.org" }]);
});

test("a commit signed off by its author passes", () => {
  const message = "feat: a thing\n\nSigned-off-by: Ada Lovelace <ada@example.org>\n";
  assert.deepEqual(checkCommits([commit({ message })]), {
    ok: true,
    findings: [],
  });
});

test("a commit with no sign-off fails", () => {
  const { ok, findings } = checkCommits([commit()]);
  assert.equal(ok, false);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sha, SHA);
  assert.match(findings[0].reason, /no Signed-off-by/);
});

test("a sign-off by an unknown email fails", () => {
  const message = "feat: a thing\n\nSigned-off-by: Someone Else <else@example.org>\n";
  const { ok, findings } = checkCommits([commit({ message })]);
  assert.equal(ok, false);
  assert.match(findings[0].reason, /neither the author's nor the committer's/);
});

test("the committer's sign-off is enough, not only the author's", () => {
  const message = "feat: a thing\n\nSigned-off-by: Pat Committer <pat@example.org>\n";
  const onlyCommitter = commit({
    message,
    committer: { name: "Pat Committer", email: "pat@example.org" },
  });
  assert.equal(checkCommits([onlyCommitter]).ok, true);
});

test("a body line that merely mentions the trailer is not a sign-off", () => {
  const message = "docs: explain the trailer\n\nSee Signed-off-by: in DCO.\n";
  const { ok, findings } = checkCommits([commit({ message })]);
  assert.equal(ok, false);
  assert.match(findings[0].reason, /no Signed-off-by/);
});

test("a co-author trailer is not a sign-off", () => {
  const message = "feat: a thing\n\nCo-authored-by: Ada Lovelace <ada@example.org>\n";
  const { ok } = checkCommits([commit({ message })]);
  assert.equal(ok, false);
});

test("the report names the commit and what is wrong with it", () => {
  const { findings } = checkCommits([commit({ message: "feat: a thing\n" })]);
  assert.deepEqual(formatReport(findings), [
    `${"a".repeat(7)} feat: a thing -- carries no Signed-off-by line`,
  ]);
});
