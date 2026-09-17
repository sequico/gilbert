import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  analyzeArgs,
  BUNDLE_DIR,
  createArgs,
  formatReport,
  LANGUAGE,
  main,
  missingCli,
  resolveCli,
  SUITE,
  summarize,
  treeFiles,
  workDir,
} from "../../scripts/codeql.mjs";

/**
 * Code scanning is configured in GitHub's settings, so nothing in this
 * repository fails when a change opens an alert there. `scripts/codeql.mjs` is
 * what tells a person before they push, and these are the parts of it that have
 * to be right for that to be true: which binary it runs, which files it
 * analyses, which suite it asks for, and -- the one that matters most -- that a
 * scan which did not happen is never reported as one that found nothing.
 */

/** A SARIF result as the CLI writes it, with the rule that scores it. */
function sarifWith(results: number): unknown {
  return {
    runs: [
      {
        tool: {
          driver: {
            rules: [
              {
                id: "js/clear-text-logging",
                shortDescription: { text: "Clear-text logging of sensitive information" },
                properties: { "security-severity": "7.5" },
              },
            ],
          },
        },
        results: Array.from({ length: results }, (_, i) => ({
          ruleId: "js/clear-text-logging",
          level: "error",
          message: { text: "This logs sensitive data." },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "file:///tree/server/src/a.ts" },
                region: { startLine: 10 + i },
              },
            },
          ],
        })),
      },
    ],
  };
}

test("the CLI is the one named, then the one on PATH, then the bundle cache", () => {
  const present = (paths: string[]) => (p: string) => paths.includes(p);
  const onPath = { PATH: "/usr/bin:/opt/tools" };

  assert.equal(
    resolveCli(
      { ...onPath, CODEQL_CLI: "/opt/codeql/codeql" },
      present(["/opt/codeql/codeql"]),
    ),
    "/opt/codeql/codeql",
    "CODEQL_CLI is the operator's word and outranks everything",
  );
  assert.equal(
    resolveCli(onPath, present(["/opt/tools/codeql"])),
    "/opt/tools/codeql",
    "a codeql on PATH is used when nothing is named",
  );
  assert.equal(
    resolveCli({ PATH: "" }, present([join(BUNDLE_DIR, "codeql")])),
    join(BUNDLE_DIR, "codeql"),
    "the bundle the install line unpacks is found without an environment variable",
  );
  assert.equal(
    resolveCli({ PATH: "" }, () => false),
    null,
  );
});

test("a missing toolchain is not a clean scan, and says how to install one", () => {
  const message = missingCli();
  assert.match(message, /not found/);
  assert.match(message, /codeql-bundle-linux64\.tar\.gz/);
  assert.ok(
    message.includes(BUNDLE_DIR),
    "the instructions name the directory the script looks in",
  );
});

test("the database is built from the tree, with no build step", () => {
  const args = createArgs({
    cli: "/opt/codeql/codeql",
    db: "/tmp/db",
    sourceRoot: "/tree",
  });
  assert.deepEqual(args.slice(0, 4), [
    "/opt/codeql/codeql",
    "database",
    "create",
    "/tmp/db",
  ]);
  assert.ok(args.includes(`--language=${LANGUAGE}`));
  assert.ok(
    args.includes("--build-mode=none"),
    "JavaScript needs no build, and a build step here would run the package scripts",
  );
  assert.ok(args.includes("--source-root=/tree"));
});

test("the analysis asks for the suite the repository's settings run", () => {
  const args = analyzeArgs({
    cli: "/opt/codeql/codeql",
    db: "/tmp/db",
    output: "/tmp/out.sarif",
  });
  assert.deepEqual(args.slice(0, 3), ["/opt/codeql/codeql", "database", "analyze"]);
  assert.ok(args.includes("--format=sarif-latest"));
  assert.ok(args.includes("--output=/tmp/out.sarif"));
  assert.equal(args.at(-1), SUITE);
  assert.match(
    SUITE,
    /javascript-code-scanning\.qls$/,
    "the default suite, not the extended one",
  );
});

test("the tree analysed is the files a push would carry", () => {
  const asked: string[][] = [];
  const files = treeFiles("/tree", (args) => {
    asked.push(args);
    return { status: 0, stdout: "README.md\0server/src/a.ts\0" };
  });
  assert.deepEqual(files, ["README.md", "server/src/a.ts"]);
  assert.deepEqual(
    asked[0],
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    "a checkout, not a working tree: .gitignore is what decides",
  );

  assert.throws(
    () =>
      treeFiles("/tree", () => ({ status: 128, stdout: "", stderr: "not a repository" })),
    /not a repository/,
    "a git that failed is not an empty tree to analyse",
  );
});

test("the work directory is outside any checkout, and its own per checkout", () => {
  const work = workDir("/driveb/sam/git/gilbert");
  assert.ok(
    !work.startsWith("/driveb/sam/git/gilbert"),
    "never inside the tree it analyses",
  );
  assert.match(work, /^\/tmp|^\/(var\/)?tmp|^\/private\/var/);
  assert.notEqual(
    work,
    workDir("/driveb/sam/git/gilbert-b"),
    "two clones, two databases",
  );
  assert.equal(
    work,
    workDir("/driveb/sam/git/gilbert"),
    "and the same clone reuses its own",
  );
});

test("a report counts the results, groups them by rule, and keeps the score", () => {
  const report = summarize(sarifWith(3));
  assert.equal(report.total, 3);
  assert.deepEqual(report.byRule, [
    {
      rule: "js/clear-text-logging",
      count: 3,
      severity: "7.5",
      description: "Clear-text logging of sensitive information",
    },
  ]);
  assert.equal(report.results[0]?.line, 10);
  assert.equal(summarize(sarifWith(0)).total, 0);
});

test("the summary reads as work when there is work, and as nothing when there is none", () => {
  const clean = formatReport(summarize(sarifWith(0)), {
    sarif: "/tmp/o.sarif",
    sourceRoot: "/tree",
  });
  assert.match(clean, /CodeQL: 0 result\(s\)\./);
  assert.match(clean, /SARIF: \/tmp\/o\.sarif/);

  const dirty = formatReport(summarize(sarifWith(2)), {
    sarif: "/tmp/o.sarif",
    sourceRoot: "/tree",
  });
  assert.match(dirty, /CodeQL: 2 results to fix\./);
  assert.match(dirty, /js\/clear-text-logging \(7\.5\)/);
  assert.match(dirty, /server\/src\/a\.ts:10/, "a finding is named by path and line");
  assert.match(dirty, /work to do, not context to report/);
});

test("the run exits non-zero on a finding and zero on none", () => {
  const repo = mkdtempSync(join(tmpdir(), "gilbert-codeql-"));
  const log: string[] = [];
  /* A stub toolchain: it records nothing and writes the SARIF the real one
     writes, and a stub git says which files a push would carry. Everything
     else -- the export, the paths, the removal of an earlier database, the
     exit code -- is the script's own. */
  const spawnWith = (results: number) => (args: string[]) => {
    const output = args.find((a) => a.startsWith("--output="));
    if (output)
      writeFileSync(output.slice("--output=".length), JSON.stringify(sarifWith(results)));
    return {};
  };
  const git = () => ({ status: 0, stdout: "README.md\0server/src/a.ts\0" });
  const runIt = (results: number) =>
    main({
      repo,
      env: { PATH: "" },
      log: (l) => log.push(l),
      exists: () => true,
      spawn: spawnWith(results),
      git,
    });

  try {
    writeFileSync(join(repo, "README.md"), "# Gilbert\n");
    mkdirSync(join(repo, "server", "src"), { recursive: true });
    writeFileSync(join(repo, "server", "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "ignored.ts"), "export const b = 2;\n");
    const work = workDir(repo);
    mkdirSync(join(work, "db", "stale"), { recursive: true });

    assert.equal(runIt(0), 0);
    assert.match(log.join("\n"), /CodeQL: 0 result\(s\)\./);
    assert.match(
      log.join("\n"),
      /analysing 2 file\(s\)/,
      "the export is what got analysed",
    );
    assert.equal(
      existsSync(join(work, "tree", "server", "src", "a.ts")),
      true,
      "the files a push would carry are the ones put in front of the analysis",
    );
    assert.equal(
      existsSync(join(work, "tree", "ignored.ts")),
      false,
      "a file git would not carry is not analysed",
    );
    assert.equal(
      existsSync(join(work, "db", "stale")),
      false,
      "a database from an earlier tree is not added to: it is replaced",
    );

    assert.equal(
      runIt(1),
      1,
      "one result is a failure: a gate that passes with findings is not a gate",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(workDir(repo), { recursive: true, force: true });
  }
});

test("a tree that cannot be read is a failure, not a result of none", () => {
  const repo = mkdtempSync(join(tmpdir(), "gilbert-codeql-"));
  const log: string[] = [];
  try {
    assert.equal(
      main({
        repo,
        env: { PATH: "" },
        log: (l) => log.push(l),
        exists: () => true,
        spawn: () => ({}),
        git: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      }),
      1,
    );
    assert.match(log.join("\n"), /no tree to analyse/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(workDir(repo), { recursive: true, force: true });
  }
});

test("no toolchain means a failure with the install instructions, not a quiet zero", () => {
  const repo = mkdtempSync(join(tmpdir(), "gilbert-codeql-"));
  const log: string[] = [];
  try {
    assert.equal(
      main({ repo, env: { PATH: "" }, log: (l) => log.push(l), exists: () => false }),
      1,
    );
    assert.match(log.join("\n"), /CodeQL was not found/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(workDir(repo), { recursive: true, force: true });
  }
});
