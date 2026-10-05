#!/usr/bin/env node
/**
 * A pull request's commits carry a Developer Certificate of Origin sign-off.
 *
 * `Signed-off-by: Name <email>` is the contributor's certification, under the
 * DCO in `DCO`, that the change is theirs to submit. It is checked separately
 * from `check:ci` because the person it protects against -- a contributor
 * whose pull request did not pass through this repository's pre-push hook --
 * never runs the local gate.
 *
 * `checkCommits` is pure: it takes commit records, not a repository, so the
 * rule can be exercised without a checkout.
 */
import { execFileSync } from "node:child_process";

import { isEntryPoint, ROOT } from "./lib/repoWalk.mjs";

/** A `Signed-off-by:` trailer, the whole line and nothing else. */
const SIGN_OFF = /^signed-off-by:\s*(.+?)\s*<([^>]+)>\s*$/i;

/** The sign-offs a commit message carries, in order of appearance. */
export function parseSignOffs(message) {
  const signOffs = [];
  for (const raw of message.split("\n")) {
    const match = SIGN_OFF.exec(raw.trim());
    if (match) {
      signOffs.push({
        name: match[1].trim(),
        email: match[2].trim().toLowerCase(),
      });
    }
  }
  return signOffs;
}

/** The first line of a message, which is what names a commit to a reader. */
function subjectOf(message) {
  return message.split("\n", 1)[0] ?? "";
}

/**
 * Which commits are missing a sign-off matching their author or committer.
 *
 * `commits` is `[{ sha, author: { name, email }, committer: { name, email },
 * message }]`. A commit is signed off when at least one `Signed-off-by:` carries
 * the author's or the committer's email; the name is not compared, because the
 * same person spells it differently in different clients.
 */
export function checkCommits(commits = []) {
  const findings = [];
  for (const commit of commits) {
    const message = commit.message ?? "";
    const signOffs = parseSignOffs(message);
    if (signOffs.length === 0) {
      findings.push({
        sha: commit.sha,
        subject: subjectOf(message),
        reason: "carries no Signed-off-by line",
      });
      continue;
    }
    const emails = new Set(
      [commit.author, commit.committer]
        .filter(Boolean)
        .map((identity) => identity.email?.trim().toLowerCase())
        .filter(Boolean),
    );
    if (!signOffs.some((signOff) => emails.has(signOff.email))) {
      findings.push({
        sha: commit.sha,
        subject: subjectOf(message),
        reason:
          "is signed off by an email that is neither the author's nor the " +
          "committer's",
      });
    }
  }
  return { ok: findings.length === 0, findings };
}

/** The findings, one line each, in the order a contributor would fix them. */
export function formatReport(findings) {
  return findings.map(
    ({ sha, subject, reason }) => `${sha.slice(0, 7)} ${subject} -- ${reason}`,
  );
}

/** The commits introduced by `base..head`, merges excluded. */
function commitsInRange(base, head) {
  const format = "%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e";
  const out = execFileSync(
    "git",
    ["log", "--no-merges", `--format=${format}`, `${base}..${head}`],
    { cwd: ROOT, encoding: "utf8" },
  );
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha, authorName, authorEmail, committerName, committerEmail, message] =
        record.split("\x00");
      return {
        sha,
        author: { name: authorName, email: authorEmail },
        committer: { name: committerName, email: committerEmail },
        message,
      };
    });
}

const USAGE =
  "Usage: node scripts/dco-check.mjs <base> <head>\n" +
  "Every commit in `git rev-list <base>..<head>` must carry a Signed-off-by " +
  "line matching its author or committer. Add one with `git commit -s`; the " +
  "certification it stands for is the DCO in `DCO`.";

/** Run the check over a commit range, and say what is wrong. 0 or 1. */
function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    process.stdout.write(`${USAGE}\n`);
    return 1;
  }
  const [base, head] = argv;
  let commits;
  try {
    commits = commitsInRange(base, head);
  } catch (error) {
    process.stdout.write(
      `Could not read ${base}..${head} from git: ${error.message}\n${USAGE}\n`,
    );
    return 1;
  }
  if (commits.length === 0) {
    process.stdout.write("DCO: no commits to check.\n");
    return 0;
  }
  const { ok, findings } = checkCommits(commits);
  if (ok) {
    process.stdout.write(`DCO: ${commits.length} commit(s) signed off.\n`);
    return 0;
  }
  const problems = formatReport(findings).map((line) => `  ${line}`);
  process.stdout.write(
    `Commits without a developer certificate of origin (${findings.length} of ` +
      `${commits.length}):\n${problems.join("\n")}\n\n` +
      "Sign off with `git commit -s` (or `git rebase --signoff`), which adds a " +
      "`Signed-off-by: Name <email>` line.\n",
  );
  return 1;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = main();
}
