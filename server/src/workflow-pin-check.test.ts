import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkWorkflowPins,
  collectRepoInput,
  formatReport,
} from "../../scripts/workflow-pin-check.mjs";

/**
 * The pin rule, kept in one place (ADR 0025).
 *
 * A workflow action named by a tag is a moving target: a repointed tag runs in
 * this repository's release path with its token. This is the check that keeps
 * the rule from being a convention a reviewer has to remember, and it fails a
 * mutable tag, a bare reference and a pin whose version comment has gone.
 */

const file = (text: string) => ({
  path: ".github/workflows/example.yml",
  text,
});

test("a commit-pinned action with its version passes", () => {
  const result = checkWorkflowPins([
    file(
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n",
    ),
  ]);
  assert.equal(result.ok, true, formatReport(result.findings));
  assert.equal(result.checked, 1);
});

test("a mutable tag is reported", () => {
  const result = checkWorkflowPins([file("      - uses: actions/checkout@v7\n")]);
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].uses, "actions/checkout@v7");
});

test("a pin with no version comment is reported", () => {
  const result = checkWorkflowPins([
    file("      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n"),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.findings[0].reason, /no version/);
});

test("a local workflow reference is not an action and is not pinned", () => {
  const result = checkWorkflowPins([file("    uses: ./.github/workflows/ci.yml\n")]);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 0);
});

test("an image reference is not an action and is not pinned", () => {
  const result = checkWorkflowPins([file("      - uses: docker://alpine:3.20\n")]);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 0);
});

test("this repository passes, and it was actually read", () => {
  const { files } = collectRepoInput();
  assert.ok(files.length >= 4, "the workflow walk read the directory");
  const result = checkWorkflowPins(files);
  assert.equal(result.ok, true, formatReport(result.findings));
  assert.ok(result.checked >= 10, "and every action reference in it was read");
});
