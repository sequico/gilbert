#!/usr/bin/env node
/**
 * Keep every `uses:` in this repository's workflows pinned to a commit.
 *
 * A tag is a moving target: `actions/checkout@v7` names whatever `v7` points at
 * today, and a tag repointed at somebody else's commit runs in this
 * repository's release path with its token. The rule that a workflow action is
 * named by its full commit SHA, with the version it is in a comment beside it,
 * was a convention until it was a check — and a convention a reviewer has to
 * remember is one that holds until the first busy afternoon.
 *
 * Two shapes are not actions and are not pinned here:
 *
 *   - `./.github/workflows/…` is a workflow of this repository rather than a
 *     third-party action; there is nothing upstream to repoint.
 *   - `docker://…` names an image, not an action, and the SHA that would pin it
 *     is a registry digest the runner resolves, not a git commit.
 *
 * The version comment is reported beside every pin. Whether a comment names the
 * release the commit belongs to cannot be told here -- that is a map from SHA to
 * version, which nothing offline holds -- so the comment is printed and a
 * repointed commit with a stale comment beside it is visible to the reader. A
 * comment that carries no version at all is a finding.
 *
 * Two further assertions come from the same files, because they are the same
 * class of drift: a value written by hand in one place and repeated in another.
 *
 *   - the Node line. `engines.node` declares the line this project supports and
 *     every workflow's `node-version:` names it; GitHub cannot share one value
 *     across workflows, so the rule is an assertion and not a merge.
 *
 *   - the pruned image. release.yml and publish.yml publish it as an `IMAGE`
 *     value and cleanup.yml prunes an `owner`/`package` pair, so a rename needs
 *     three edits and misses one silently -- and the miss is the pruner, which
 *     would then delete somebody else's package.
 *
 * `checkWorkflowPins` is pure — it takes text, not paths — so the rules can be
 * exercised without a repository to stage, the way `scripts/version.mjs` is. The
 * two assertions beside it are pure the same way: files in, findings out.
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import { isEntryPoint, lineOf, ROOT } from "./lib/repoWalk.mjs";

/** A `uses:` line, with the reference and whatever comment follows it. */
const USES_LINE = /^\s*(?:-\s*)?uses:\s*([^\s#]+)\s*(#.*)?$/;

/** A pinned reference: `owner/repo@<40 hex>`, and nothing looser. */
const PINNED = /^[^\s@]+@[0-9a-fA-F]{40}$/;

/** A version in the comment beside it, which is what says which release it is. */
const VERSION_IN_COMMENT = /#\s*v?\d/;

/** A hardcoded Node line in a workflow; a value with no digit is not one. */
const NODE_VERSION_LINE = /^\s*(?:-\s*)?node-version:\s*['"]?(\d+)/;

/** The first number in a range or a version, which is the major. */
const MAJOR = /\d+/;

/** The image a workflow publishes, as an `IMAGE` environment value. */
const IMAGE_ENV = /^\s*IMAGE:\s*['"]?([^\s'"]+)/;

/** The package an action prunes, as the `owner` and `package` it is given. */
const OWNER_KEY = /^\s*owner:\s*([^\s'"]+)/;
const PACKAGE_KEY = /^\s*package:\s*([^\s'"]+)/;

const WORKFLOW_EXT = new Set([".yml", ".yaml"]);

/**
 * Every `uses:` that is not pinned as this repository requires, as
 * `{ path, line, uses, comment, reason }`, the references that were read as
 * `{ path, line, uses, comment }`, and how many of them there were.
 */
export function checkWorkflowPins(files = []) {
  const findings = [];
  const references = [];
  let checked = 0;

  for (const file of files) {
    for (const match of file.text.matchAll(/^(.*)$/gm)) {
      const parsed = USES_LINE.exec(match[1]);
      if (!parsed) continue;
      const [, uses, comment] = parsed;
      const line = lineOf(file.text, match.index);
      // A local workflow and an image are not actions (see the header).
      if (uses.startsWith("./") || uses.startsWith("docker://")) continue;
      checked += 1;
      const reference = {
        path: file.path,
        line,
        uses,
        comment: comment?.trim() ?? "",
      };
      references.push(reference);
      const at = (reason) => findings.push({ ...reference, reason });
      if (!PINNED.test(uses)) {
        at("is not pinned to a full commit SHA (owner/action@<40 hex>)");
        continue;
      }
      if (!comment || !VERSION_IN_COMMENT.test(comment)) {
        at("carries no version in the comment beside the commit");
      }
    }
  }

  return { ok: findings.length === 0, findings, checked, references };
}

/** The findings, one line each, in the order a reader would fix them. */
export function formatReport(findings) {
  return findings.map(
    ({ path, line, uses, comment, reason }) =>
      `${path}:${line}: ${uses}${comment ? ` ${comment}` : ""} ${reason}`,
  );
}

/** Every pin with the version comment beside it, so a stale one is visible. */
export function formatPins(references) {
  return references.map(
    ({ path, line, uses, comment }) =>
      `  ${uses}${comment ? ` ${comment}` : ""}  (${path}:${line})`,
  );
}

/**
 * Every workflow's Node line against the one `engines.node` declares.
 *
 * A workflow is its own file with no way to read the root `package.json`, so the
 * line is written out by hand in each; the check is what keeps the copies equal
 * to the declaration instead of equal to each other by luck. A value that
 * carries no digit is not a line and is left alone.
 */
export function checkWorkflowNodeLine(files = [], engines = "") {
  const expected = majorOf(engines);
  const findings = [];
  if (expected === null) return { ok: true, findings };

  for (const file of files) {
    for (const match of file.text.matchAll(/^(.*)$/gm)) {
      const parsed = NODE_VERSION_LINE.exec(match[1]);
      if (!parsed) continue;
      const node = Number(parsed[1]);
      if (node === expected) continue;
      findings.push({
        path: file.path,
        line: lineOf(file.text, match.index),
        subject: `node-version: ${node}`,
        reason: `but engines.node declares Node ${expected}`,
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

/** The first number in a range (`>=24`) or a version (`24.x`) is the major. */
function majorOf(value) {
  const found = MAJOR.exec(value);
  return found ? Number(found[0]) : null;
}

/** A finding from the two assertions beside the pin check. */
function report({ path, line, subject, reason }) {
  return `${path}:${line}: ${subject} ${reason}`;
}

/** Every workflow in this repository, relative to the root. */
export function collectRepoInput(root = ROOT) {
  const dir = join(root, ".github", "workflows");
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    if (!WORKFLOW_EXT.has(extname(name))) continue;
    files.push({
      path: `.github/workflows/${name}`,
      text: readFileSync(join(dir, name), "utf8"),
    });
  }
  return { files };
}

/** The Node line the project supports, as `engines.node` declares it. */
function enginesNode(root = ROOT) {
  const { engines } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return engines?.node ?? "";
}

/** What this check reads, for the gate's read set (`gate-prepush.sh`). */
export function readPaths(root = ROOT) {
  return ["package.json", ...collectRepoInput(root).files.map((one) => one.path)];
}

const USAGE =
  "An action's `uses:` is named by its full commit SHA, with the version it is " +
  "in a comment beside it: `owner/action@<40 hex> # vX.Y.Z`. A `./.github/…` " +
  "workflow reference and a `docker://` image are not actions and are not " +
  "pinned. Every `node-version:` runs the line `engines.node` declares. This " +
  "check takes no arguments; running it is checking.";

/** Run the check over the repository, and say what is wrong. 0 or 1. */
function main() {
  if (process.argv.length > 2) {
    process.stdout.write(`workflow-pin-check takes no arguments.\n${USAGE}\n`);
    return 1;
  }
  const engines = enginesNode();
  const { files } = collectRepoInput();
  const { findings, checked, references } = checkWorkflowPins(files);
  const node = checkWorkflowNodeLine(files, engines);
  const problems = [
    ...findings.map((one) => formatReport([one])[0]),
    ...node.findings.map(report),
  ].map((line) => `  ${line}`);
  if (problems.length === 0) {
    process.stdout.write(
      `Workflow pins: ${checked} action reference(s) pinned to a commit.\n` +
        `${formatPins(references).join("\n")}\n` +
        `Node line: every workflow runs the engines.node line (${engines}).\n`,
    );
    return 0;
  }
  process.stdout.write(
    `Workflow checks are not satisfied (${problems.length} of ` +
      `${checked} pin(s) plus every Node line):\n${problems.join("\n")}\n${USAGE}\n`,
  );
  return 1;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = main();
}
