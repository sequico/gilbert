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
 * `checkWorkflowPins` is pure — it takes text, not paths — so the rules can be
 * exercised without a repository to stage, the way `scripts/version.mjs` is.
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

const WORKFLOW_EXT = new Set([".yml", ".yaml"]);

/**
 * Every `uses:` that is not pinned as this repository requires, as
 * `{ path, line, uses, reason }`, plus how many references were actually read.
 */
export function checkWorkflowPins(files = []) {
  const findings = [];
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
      const at = (reason) => findings.push({ path: file.path, line, uses, reason });
      if (!PINNED.test(uses)) {
        at("is not pinned to a full commit SHA (owner/action@<40 hex>)");
        continue;
      }
      if (!comment || !VERSION_IN_COMMENT.test(comment)) {
        at("carries no version in the comment beside the commit");
      }
    }
  }

  return { ok: findings.length === 0, findings, checked };
}

/** The findings, one line each, in the order a reader would fix them. */
export function formatReport(findings) {
  return findings.map(
    ({ path, line, uses, reason }) => `${path}:${line}: ${uses} ${reason}`,
  );
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

const USAGE =
  "An action's `uses:` is named by its full commit SHA, with the version it is " +
  "in a comment beside it: `owner/action@<40 hex> # vX.Y.Z`. A `./.github/…` " +
  "workflow reference and a `docker://` image are not actions and are not " +
  "pinned. This check takes no arguments; running it is checking.";

/** Run the check over the repository, and say what is wrong. 0 or 1. */
function main() {
  if (process.argv.length > 2) {
    process.stdout.write(`workflow-pin-check takes no arguments.\n${USAGE}\n`);
    return 1;
  }
  const { files } = collectRepoInput();
  const { ok, findings, checked } = checkWorkflowPins(files);
  if (ok) {
    process.stdout.write(
      `Workflow pins: ${checked} action reference(s) pinned to a commit.\n`,
    );
    return 0;
  }
  const problems = formatReport(findings).map((line) => `  ${line}`);
  process.stdout.write(
    `Workflow pins are not all pinned by commit (${findings.length} of ` +
      `${checked}):\n${problems.join("\n")}\n${USAGE}\n`,
  );
  return 1;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = main();
}
