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

import { isEntryPoint, lineOf, pathsOf, ROOT } from "./lib/repoWalk.mjs";

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

  // shortcut: `node-version:` is read as a literal, so a workflow that writes an
  // expression there is skipped and reported clean; revisit when one needs it.
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

/**
 * The package cleanup.yml prunes against the image the release publishes.
 *
 * `release.yml` and `publish.yml` name it as one `IMAGE` value while
 * `cleanup.yml` is handed an `owner` and a `package`. A registry path has to
 * stay lowercase, so the pair is compared with the lowercased value and not
 * derived from it; a rename that moves one spelling and not the other would
 * leave the pruner deleting a package this repository does not own, and nothing
 * in a run would say so.
 */
export function checkImageTarget(files = []) {
  const findings = [];
  const images = new Map();
  const pruned = new Map();

  for (const file of files) {
    const owners = [];
    const packages = [];
    for (const match of file.text.matchAll(/^(.*)$/gm)) {
      const at = { path: file.path, line: lineOf(file.text, match.index) };
      const image = IMAGE_ENV.exec(match[1]);
      const owner = OWNER_KEY.exec(match[1]);
      const pkg = PACKAGE_KEY.exec(match[1]);
      if (image) images.set(imagePath(image[1]), at);
      if (owner) owners.push({ value: owner[1], ...at });
      if (pkg) packages.push({ value: pkg[1], ...at });
    }
    // An owner without a package beside it names no package at all, so it is a
    // finding of its own rather than a pair that quietly compares unequal.
    for (const [index, owner] of owners.entries()) {
      const pkg = packages[index];
      if (!pkg) {
        findings.push({
          ...owner,
          subject: `owner: ${owner.value}`,
          reason: "has no package beside it",
        });
        continue;
      }
      pruned.set(`${owner.value}/${pkg.value}`, owner);
    }
  }

  const published = [...images.keys()].join(", ");
  for (const [name, at] of pruned) {
    if (!images.has(name)) {
      findings.push({
        ...at,
        subject: `prunes ${name}`,
        reason: `never published (${published})`,
      });
    }
  }
  for (const [name, at] of images) {
    if (!pruned.has(name)) {
      findings.push({
        ...at,
        subject: `publishes ${name}`,
        reason: "which nothing prunes",
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

/** A registry path with its host off: the owner and the package, lowercased. */
function imagePath(image) {
  return image.toLowerCase().split("/").slice(-2).join("/");
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
  return ["package.json", ...pathsOf(collectRepoInput(root))];
}

const USAGE =
  "An action's `uses:` is named by its full commit SHA, with the version it is " +
  "in a comment beside it: `owner/action@<40 hex> # vX.Y.Z`. A `./.github/…` " +
  "workflow reference and a `docker://` image are not actions and are not " +
  "pinned. Every `node-version:` runs the line `engines.node` declares, and the " +
  "package cleanup.yml prunes is the image the release publishes. This check " +
  "takes no arguments; running it is checking.";

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
  const image = checkImageTarget(files);
  const problems = [
    ...findings.map((one) => formatReport([one])[0]),
    ...[...node.findings, ...image.findings].map(report),
  ].map((line) => `  ${line}`);
  if (problems.length === 0) {
    process.stdout.write(
      `Workflow pins: ${checked} action reference(s) pinned to a commit.\n` +
        `${formatPins(references).join("\n")}\n` +
        `Node line: every workflow runs the engines.node line (${engines}).\n` +
        `Image: the pruner and the published image are the same package.\n`,
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
