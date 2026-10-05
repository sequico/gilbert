#!/usr/bin/env node
/**
 * CodeQL on this tree: the local half of the analysis the release pre-check
 * runs on GitHub (`.github/workflows/codeql.yml`).
 *
 * The hosted analysis runs when a release is prepared, which leaves a gap this
 * script closes: nothing local would tell a person that a change opens an
 * alert, and an alert nobody looked at is a finding this project does not know
 * about. `npm run codeql` analyses **the files a push would carry**, with the
 * same query suite that workflow runs, prints what it found, and exits non-zero
 * on any result — so a green run here means the release's analysis stays clean.
 *
 * The tree it analyses is exported, not the working directory. GitHub analyses
 * a checkout: `node_modules` is not in it, and `web/dist` is not in it, so
 * running here against the working directory would report on files no alert
 * can ever name — a built bundle's finding is nobody's to fix. `git ls-files
 * --cached --others --exclude-standard` is the list, which is exactly the files
 * a push would carry, and it means `.gitignore` stays the one place that
 * decides what is ignored.
 *
 * It is deliberately not part of `npm run prepush`: the toolchain is a 686 MB
 * bundle and one analysis takes a couple of minutes, and a fast gate that
 * cannot run on a fresh clone is not a gate. `npm run check:release` is
 * `check:ci` then this, and `npm run prepush:full` runs it, for a machine that
 * has the bundle; on a release the same suite is `.github/workflows/codeql.yml`.
 *
 * The CLI is looked for in `CODEQL_CLI`, then on `PATH`, then in the bundle
 * cache. Absent, the script says how to get it and exits non-zero: a scan that
 * did not happen is never reported as one that found nothing. The bundle it
 * names is the one the workflow's action ships (`BUNDLE_VERSION`), pinned by
 * hand so local and hosted runs ask the same queries.
 *
 * Usage: `npm run codeql`, or `node scripts/codeql.mjs`.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The language this repository's analysis is configured with.
 *
 * The JavaScript/TypeScript extractor also covers the GitHub Actions workflows
 * (its code-scanning suite carries those queries), so one database is the whole
 * of what the analysis covers here.
 */
export const LANGUAGE = "javascript-typescript";

/**
 * The query suite, by its pack-qualified name: the workflow's default suite is
 * this one, so a local run and the hosted one report the same queries.
 * `security-and-quality` is a superset a workflow could ask for by name, and
 * would report more than this gate sees.
 */
export const SUITE =
  "codeql/javascript-queries:codeql-suites/javascript-code-scanning.qls";

/** Where a bundle goes when `CODEQL_CLI` names no binary: see `missingCli()`. */
export const BUNDLE_DIR = join(homedir(), ".cache", "gilbert", "codeql");

/**
 * The CLI bundle the workflow's analysis ships, pinned by hand.
 *
 * The hosted action is `v4.38.2`, which ships CodeQL CLI 2.27.1; a local run
 * that used another bundle would report a different query set, so the one a
 * person installs is named rather than fetched from `latest` — a tag that moves
 * under them the way every other tag does. Bump it with the action.
 */
export const BUNDLE_VERSION = "codeql-bundle-v2.27.1";

/**
 * The database, the export and the SARIF, in the system's temporary space.
 *
 * Deliberately not inside the repository: the JavaScript extractor skips
 * anything under a `node_modules` directory, so a database built under one
 * analyses nothing at all — and reports that as "no code found" rather than as
 * a path it refused. The name carries a digest of the checkout, so two clones
 * on one machine do not overwrite each other's database.
 */
export function workDir(repo) {
  const key = createHash("sha256").update(repo).digest("hex").slice(0, 8);
  return join(tmpdir(), `gilbert-codeql-${key}`);
}

/**
 * The CLI to run: an explicit one, one on `PATH`, or the bundle cache.
 *
 * `exists` is a parameter so a test can put a toolchain where there is none.
 */
export function resolveCli(env = process.env, exists = existsSync) {
  const explicit = [env.CODEQL_CLI, join(BUNDLE_DIR, "codeql")].filter(Boolean);
  for (const candidate of explicit) {
    if (exists(candidate)) return candidate;
  }
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "codeql");
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** What to do about a missing toolchain, in the words of someone who needs it. */
export function missingCli() {
  return [
    "CodeQL was not found, so nothing was analysed.",
    "",
    "  install the bundle (686 MB, unpacked once):",
    "",
    `    mkdir -p ${BUNDLE_DIR}`,
    `    curl -L https://github.com/github/codeql-action/releases/download/${BUNDLE_VERSION}/codeql-bundle-linux64.tar.gz \\`,
    `      | tar xz -C ${BUNDLE_DIR} --strip-components=1`,
    "",
    "  or point CODEQL_CLI at an existing binary, or put `codeql` on PATH.",
  ].join("\n");
}

/**
 * The files a push would carry, relative to the repository root.
 *
 * `--cached` is what is tracked and `--others --exclude-standard` is what is
 * new and not ignored, which is the set a commit would hold. The list is read
 * through `-z` so a path with a newline in it survives.
 */
export function treeFiles(
  repo,
  git = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" }),
) {
  const done = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (done.status !== 0) {
    throw new Error(
      `git ls-files failed in ${repo}${done.stderr ? `: ${done.stderr.trim()}` : ""}`,
    );
  }
  return (done.stdout ?? "").split("\0").filter(Boolean);
}

/** Copy those files into `dest`, so the analysis sees a checkout and not a workspace. */
export function exportTree(repo, dest, files = treeFiles(repo)) {
  rmSync(dest, { recursive: true, force: true });
  for (const rel of files) {
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(repo, rel)));
  }
  return files.length;
}

/** The arguments `database create` is given, for a test and for the run. */
export function createArgs({ cli, db, sourceRoot }) {
  return [
    cli,
    "database",
    "create",
    db,
    `--language=${LANGUAGE}`,
    /* JavaScript needs no build, and a build step here would run this
       repository's own package scripts to analyse the tree. */
    "--build-mode=none",
    `--source-root=${sourceRoot}`,
    "--threads=0",
  ];
}

/** The arguments `database analyze` is given: the suite, and where to write. */
export function analyzeArgs({ cli, db, output }) {
  return [
    cli,
    "database",
    "analyze",
    db,
    "--format=sarif-latest",
    `--output=${output}`,
    "--threads=0",
    SUITE,
  ];
}

/**
 * What one analysis reported, in the shape the summary is printed from.
 *
 * `severity` is the rule's `security-severity` — GitHub's own number, 7.5 for a
 * `js/clear-text-logging` — kept as the string the SARIF carries rather than
 * parsed into something a reader has to convert back.
 */
export function summarize(sarif) {
  const run = sarif?.runs?.[0] ?? {};
  const rules = new Map((run.tool?.driver?.rules ?? []).map((r) => [r.id, r]));
  const results = (run.results ?? []).map((res) => {
    const rule = rules.get(res.ruleId) ?? {};
    const place = res.locations?.[0]?.physicalLocation ?? {};
    return {
      rule: res.ruleId ?? "",
      severity: rule.properties?.["security-severity"] ?? "",
      description: rule.shortDescription?.text ?? "",
      level: res.level ?? rule.defaultConfiguration?.level ?? "",
      file: (place.artifactLocation?.uri ?? "").replace(/^file:\/\//, ""),
      line: place.region?.startLine ?? 0,
      message: res.message?.text ?? "",
    };
  });
  const byRule = new Map();
  for (const r of results) byRule.set(r.rule, (byRule.get(r.rule) ?? 0) + 1);
  return {
    total: results.length,
    results,
    byRule: [...byRule].map(([rule, count]) => ({
      rule,
      count,
      severity: rules.get(rule)?.properties?.["security-severity"] ?? "",
      description: rules.get(rule)?.shortDescription?.text ?? "",
    })),
  };
}

/** The summary a person reads: how many, which rules, and where. */
export function formatReport(report, { sarif, sourceRoot }) {
  const lines = [];
  if (report.total === 0) {
    lines.push("CodeQL: 0 result(s).");
  } else {
    const plural = report.total === 1 ? "result" : "results";
    lines.push(`CodeQL: ${report.total} ${plural} to fix.`);
    lines.push("");
    for (const { count, rule, severity, description } of report.byRule) {
      lines.push(
        `  ${String(count).padStart(3)}  ${rule} (${severity || "no score"}) ${description}`,
      );
    }
    lines.push("");
    for (const r of report.results) {
      lines.push(`  ${relative(r.file, sourceRoot)}:${r.line}  ${r.rule}  ${r.level}`);
    }
    lines.push("");
    lines.push("An alert is work to do, not context to report: fix it here, in the");
    lines.push("same change, and the release's analysis stays clean.");
  }
  lines.push(`SARIF: ${sarif}`);
  return lines.join("\n");
}

/** A finding's file, named as the reader's own checkout names it. */
function relative(file, sourceRoot) {
  return file.startsWith(sourceRoot) ? file.slice(sourceRoot.length + 1) : file;
}

/** Run one command, and keep its output for a failure rather than for a success. */
function run(args, log) {
  const [cli, ...rest] = args;
  const done = spawnSync(cli, rest, { encoding: "utf8" });
  if (done.status !== 0) {
    log(done.stdout ?? "");
    log(done.stderr ?? "");
    throw new Error(`${cli} database ${rest[1] ?? ""} failed with status ${done.status}`);
  }
}

/**
 * The analysis: export the tree a push would carry, create a database from it,
 * run the suite, print the summary — and answer with what a shell needs, 0 when
 * there is nothing to fix.
 */
export function main({
  repo,
  env = process.env,
  log = console.log,
  exists = existsSync,
  spawn = run,
  git,
} = {}) {
  const cli = resolveCli(env, exists);
  if (!cli) {
    log(missingCli());
    return 1;
  }

  const work = workDir(repo);
  const tree = join(work, "tree");
  const db = join(work, "db");
  const sarif = join(work, "gilbert.sarif");
  mkdirSync(work, { recursive: true });
  /* A database from an earlier tree is not one to add to: what this reports is
     this tree, and `database create` refuses a directory that exists. */
  rmSync(db, { recursive: true, force: true });

  let count;
  try {
    count = exportTree(repo, tree, treeFiles(repo, git));
  } catch (err) {
    log(`CodeQL: no tree to analyse -- ${err.message}`);
    return 1;
  }

  log(`CodeQL: analysing ${count} file(s) from ${repo} with ${cli}`);
  log("  (a couple of minutes: the database is rebuilt from the tree each run)");
  try {
    spawn(createArgs({ cli, db, sourceRoot: tree }), log);
    spawn(analyzeArgs({ cli, db, output: sarif }), log);
  } catch (err) {
    log(`CodeQL: the analysis did not finish -- ${err.message}`);
    return 1;
  }

  const report = summarize(JSON.parse(readFileSync(sarif, "utf8")));
  log("");
  log(formatReport(report, { sarif, sourceRoot: tree }));
  return report.total === 0 ? 0 : 1;
}

/* Only when run as a command: the pieces above are what a test imports. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(main({ repo }));
}
