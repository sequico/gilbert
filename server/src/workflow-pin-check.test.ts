import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  checkImageTarget,
  checkWorkflowNodeLine,
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
  assert.equal(result.ok, true, formatReport(result.findings).join("\n"));
  assert.equal(result.checked, 1);
});

test("a mutable tag is reported", () => {
  const result = checkWorkflowPins([file("      - uses: actions/checkout@v7\n")]);
  assert.equal(result.ok, false);
  assert.equal(result.findings[0]?.uses, "actions/checkout@v7");
});

test("a pin with no version comment is reported", () => {
  const result = checkWorkflowPins([
    file("      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n"),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.findings[0]?.reason ?? "", /no version/);
});

test("a pin whose comment names no version is reported", () => {
  const result = checkWorkflowPins([
    file(
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # fix 1\n",
    ),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.findings[0]?.reason ?? "", /no version/);
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
  assert.equal(result.ok, true, formatReport(result.findings).join("\n"));
  assert.ok(result.checked >= 10, "and every action reference in it was read");
  /*
   * The two drift assertions run against this repository's own workflows, so a
   * Node move or an image rename that missed one file fails here as well as at
   * the gate. The declared line is read here rather than through the command's
   * own helper, which is private to it.
   */
  const { engines } = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { engines: { node: string } };
  const node = checkWorkflowNodeLine(files, engines.node);
  assert.equal(node.ok, true, JSON.stringify(node.findings));
  const image = checkImageTarget(files);
  assert.equal(image.ok, true, JSON.stringify(image.findings));
});

/**
 * The two drift assertions beside the pin rule. Each is the same class of
 * failure — a value written by hand in one file and repeated in another, which
 * a rename moves in one place only — so each needs a test that a wrong value
 * fails, or the assertion could go missing and the gate would still print clean.
 */
test("a workflow on another Node line is reported, and the declared one is not", () => {
  const declared = checkWorkflowNodeLine(
    [file("          node-version: '24'\n")],
    ">=24",
  );
  assert.equal(declared.ok, true);
  const stale = checkWorkflowNodeLine([file("          node-version: '22'\n")], ">=24");
  assert.equal(stale.ok, false);
  assert.match(stale.findings[0]?.reason ?? "", /Node 24/);
});

test("a pruner naming another package is reported, and the published one is not", () => {
  const image = file("  IMAGE: ghcr.io/sequico/gilbert\n");
  const aligned = checkImageTarget([
    image,
    file("        owner: sequico\n        package: gilbert\n"),
  ]);
  assert.equal(aligned.ok, true, JSON.stringify(aligned.findings));
  const stale = checkImageTarget([
    image,
    file("        owner: sequico\n        package: someone-else\n"),
  ]);
  assert.equal(stale.ok, false);
  assert.equal(stale.findings[0]?.subject, "prunes sequico/someone-else");
});
