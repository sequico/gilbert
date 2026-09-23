#!/usr/bin/env node
/**
 * Keep the tree free of two things it decided not to have: a retired name, and
 * a configuration value read from the environment.
 *
 * Both are the same mistake in different clothes — a durable fact kept
 * somewhere a redeploy can lose it, and a name the code no longer honours that
 * a reader can still find and believe. The installation's configuration lives
 * in Stalwart, in the Master account's own app folder, so the only environment
 * a boot may read is the handshake that reaches Stalwart at all: where it is,
 * who the Master is, and the container's own listening facts. Every other
 * reach for `process.env` in `server/src` is a value that should have come from
 * the installation document.
 *
 * Two rules:
 *
 *   - the retired names (`RETIRED`) appear nowhere in the tree but here and in
 *     this check's test, which has to spell them to prove they are refused;
 *   - in `server/src`, outside tests, `process.env` appears only in the modules
 *     below, each with what it is still allowed to read and why.
 *
 * The second rule is about the module, not about a property. `process.env.NAME`,
 * the bracketed and the computed form, a destructuring (`const { NAME } =
 * process.env`) and a stored reference (`const env = process.env`) are one
 * defect, not four: the last two are exactly the reads a rule that knew only
 * `process.env.NAME` could not see, which is what made "only the handshake and
 * the resolver read the environment" a sample of the tree rather than a fact
 * about it.
 *
 * What the walk reads is decided by *exclusion* (`lib/repoWalk.mjs`'s
 * `SKIP_DIRS` and this file's `EXCLUDED_PATHS`): the whole repository, less what is not this tree's own
 * text. That is what makes "nowhere in the tree" a claim about the tree rather
 * than about the trees somebody remembered — a `Dockerfile`, a `Makefile`, a
 * workflow, a file added tomorrow, is covered without being listed here.
 *
 * `checkDeadConfiguration` is pure — it takes text, not paths — so the rules
 * can be exercised without a repository to stage.
 */
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { isEntryPoint, lineOf, ROOT, walk } from "./lib/repoWalk.mjs";

/**
 * Names the installation no longer honours. The policy, the identity lock and
 * the app secret live in each account's own Stalwart storage now, and a
 * deployment that still carries one of these is a deployment whose settings
 * are silently not in force — which is why a mention of one anywhere is a
 * defect rather than a curiosity.
 */
const RETIRED = [
  "SESSION_FILE",
  "STALWART_SERVERS_FILE",
  "SETTINGS_POLICY_FILE",
  "SETTINGS_DEFAULTS",
  "SETTINGS_ENFORCED",
  "SETTINGS_CHANGES",
];

/**
 * Where a retired name is allowed to appear: the check that refuses it, and
 * the test that proves it refuses. Nothing else, ever — an allowlist that
 * grows is the defect this check exists to prevent.
 */
const RETIRED_ALLOWED = new Set([
  "scripts/dead-config-check.mjs",
  "server/src/dead-config-check.test.ts",
]);

/**
 * What the walk steps over, and why. The perimeter is this list: everything
 * else in the repository is read. Each entry is something that is not this
 * tree's own code or prose, where a name would be a copy of a copy rather than
 * a claim about what the installation honours:
 *
 *   - `node_modules` — installed dependencies, other people's text;
 *   - `.git` — history, not the tree (and a *file* rather than a directory
 *     inside a worktree, which is why the exclusion matches an entry's own
 *     name wherever it appears);
 *   - `dist`, `dev-dist`, `coverage`, `.vite`, `.turbo` — build and test
 *     output: a built tree repeats its sources, and a stale copy would report
 *     the same name a second time;
 *   - `package-lock.json` — npm's file, generated from `package.json`.
 */

/** Repository-relative paths the walk steps over, whether a tree or a file. */
const EXCLUDED_PATHS = new Set(["package-lock.json"]);

/**
 * The modules in `server/src` that may still read the environment, and what
 * each is allowed to read. The list is per module because the permission is
 * about the module's job, not about a key: a module that may reach for the
 * environment at all may read what its job needs and nothing more. `bootstrap.ts`
 * is the handshake: it is the only place that knows how Stalwart is reached,
 * and it reads nothing else. The mock is a fixture that stands in for a server,
 * configured by the test that starts it, and its knobs are its own.
 */
const ENV_ALLOWED = new Map([
  ["server/src/bootstrap.ts", "the handshake: where Stalwart is, and who the Master is"],
  [
    "server/src/configuration.ts",
    "the installation's configuration as the environment states it, for a process with no boot",
  ],
  [
    "server/src/mock/index.ts",
    "the fixture's own knobs (MOCK_*), set by the test that starts it",
  ],
]);

/**
 * What counts as text, and so what is read. A file whose extension is not here
 * is a binary — an icon, a photo, a captured message fixture — and is not read
 * at all, which is what keeps a whole-repository walk fast enough for
 * `prepush`. An extensionless file is text far more often than not: a
 * `Dockerfile`, a `Makefile`, `LICENSE`, a git hook.
 */
const TEXT_EXT = new Set([
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".md",
  ".markdown",
  ".txt",
  ".rst",
  ".json",
  ".jsonc",
  ".json5",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".example",
  ".env",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".svg",
  ".sql",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".php",
]);
const TEST_FILE = /\.test\.(?:ts|tsx|mts|mjs)$/;
/**
 * A reach for the process's environment, whole: the mention and the key it
 * names, where it names one. The mention is what the rule is about, so the key
 * group is optional — `process.env` on its own is the defect this catches, not
 * a prefix of it.
 */
const ENV_MENTION =
  /process\.env\b(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*(?:["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]|([A-Za-z_][A-Za-z0-9_]*))\s*\])?/g;
/** The name a mention that names no key is reported under. */
const WHOLE_ENV = "<the environment itself>";

/** Every retired name one file's text carries: `{ name, line }` each. */
export function retiredNamesIn(text) {
  const found = [];
  for (const name of RETIRED) {
    let at = text.indexOf(name);
    while (at !== -1) {
      found.push({ name, line: lineOf(text, at) });
      at = text.indexOf(name, at + name.length);
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * Every reach for the process's environment one file's text makes: `{ name,
 * line }` each.
 *
 * What counts is the mention, not the property read after it. A module that
 * keeps the environment in a variable (`const env = process.env`) or
 * destructures names out of it (`const { NAME } = process.env`) has reached for
 * it exactly as much as one that names a key. `name` is therefore the key where
 * the mention names one, `<computed>` for a key computed at run time, and
 * `WHOLE_ENV` when the mention names none — the module took the environment
 * itself, whatever it reads out of it afterwards, and a pattern that cannot see
 * what that is says so rather than guessing.
 */
export function envReadsIn(text) {
  const found = [];
  for (const match of text.matchAll(ENV_MENTION)) {
    found.push({
      name: match[1] ?? match[2] ?? (match[3] ? "<computed>" : WHOLE_ENV),
      line: lineOf(text, match.index),
    });
  }
  return found;
}

/**
 * Judge one file. Pure: `{ path, text }` in, `{ retired, env }` out — the
 * retired names it carries and the environment reads it makes that it is not
 * allowed to make. Whether a path is allowed is decided by the tables above,
 * so the caller can hand any file and get the same answer.
 */
export function judgeFile({ path = "", text = "" } = {}) {
  const retired = RETIRED_ALLOWED.has(path) ? [] : retiredNamesIn(text);
  const isServerCode = path.startsWith("server/src/");
  const allowed = ENV_ALLOWED.get(path);
  const env =
    isServerCode && !TEST_FILE.test(path) && !allowed
      ? envReadsIn(text).map((read) => ({ ...read, path }))
      : [];
  return { retired: retired.map((one) => ({ ...one, path })), env };
}

/**
 * Judge the whole tree. Pure: `{ files }` in (each `{ path, text }`), and the
 * two lists of offenders out, with the counts a report needs.
 */
export function checkDeadConfiguration({ files = [] } = {}) {
  const retired = [];
  const env = [];
  for (const file of files) {
    const judged = judgeFile(file);
    retired.push(...judged.retired);
    env.push(...judged.env);
  }
  return {
    ok: retired.length === 0 && env.length === 0,
    retired,
    env,
    counts: { files: files.length, retiredNames: RETIRED.length },
  };
}

/** The offenders, one line each. */
export function formatReport(result) {
  const lines = [];
  for (const { path, line, name } of result.retired)
    lines.push(`${path}:${line} names ${name}, which the installation no longer honours`);
  for (const { path, line, name } of result.env)
    lines.push(
      name === WHOLE_ENV
        ? `${path}:${line} takes the whole environment (process.env); configuration lives in the installation document`
        : `${path}:${line} reads ${name} from the environment; configuration lives in the installation document`,
    );
  return lines;
}

/**
 * Every file under a directory, as a path relative to it, stepping over
 * `SKIP_DIRS` and `EXCLUDED_PATHS`. A symlink is neither a directory nor a
 * file to this walk: it follows nothing, and a link is not a claim of its own
 * — whatever it points at is read where it lives.
 */

/**
 * Read this repository: every text file the exclusions above do not step over.
 *
 * There is no list of what to read, so a file added tomorrow is read without
 * anybody remembering to add it. `root` is a parameter so the perimeter itself
 * can be exercised against a staged tree instead of the real one.
 */
export function collectRepoInput(root = ROOT) {
  const files = [];
  for (const path of walk(root, { skipPaths: EXCLUDED_PATHS }).sort()) {
    if (!TEXT_EXT.has(extname(path))) continue;
    if (RETIRED_ALLOWED.has(path)) continue;
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    // An extensionless file can still be a binary; a NUL byte says so, and a
    // binary decoded as UTF-8 would measure the wrong thing.
    if (text.includes("\0")) continue;
    files.push({ path, text });
  }
  return { files };
}

const USAGE =
  "The installation's configuration lives in Stalwart: no retired environment " +
  "name may appear anywhere in the tree, and `server/src` may reach the process's " +
  "environment only in the handshake that reaches Stalwart and the resolver beside " +
  "it. This check takes no arguments; running it is checking.";

/** Run the check over the repository, and say what is wrong. 0 or 1. */
function main() {
  if (process.argv.length > 2) {
    process.stdout.write(`dead-config-check takes no arguments.\n${USAGE}\n`);
    return 1;
  }
  const { files } = collectRepoInput();
  const result = checkDeadConfiguration({ files });
  if (result.ok) {
    process.stdout.write(
      `Dead configuration: none — ${result.counts.files} text file(s) read from ` +
        `the whole repository, ${result.counts.retiredNames} retired name(s) absent, ` +
        `no environment read outside the modules allowed one.\n`,
    );
    return 0;
  }
  const problems = formatReport(result).map((line) => `  ${line}`);
  process.stdout.write(
    `Dead configuration is still in the tree (${result.retired.length} name(s), ` +
      `${result.env.length} environment read(s)):\n${problems.join("\n")}\n${USAGE}\n`,
  );
  return 1;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = main();
}
