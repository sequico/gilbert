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
 * `process.env` read in `server/src` is a value that should have come from the
 * installation document.
 *
 * Two rules:
 *
 *   - the retired names (`RETIRED`) appear nowhere in the tree but here and in
 *     this check's test, which has to spell them to prove they are refused;
 *   - in `server/src`, outside tests, `process.env.<NAME>` appears only in the
 *     modules below, each with what it is still allowed to read and why.
 *
 * `checkDeadConfiguration` is pure — it takes text, not paths — so the rules
 * can be exercised without a repository to stage.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Names the installation no longer honours. The policy, the identity lock and
 * the app secret live in each account's own Stalwart storage now, and a
 * deployment that still carries one of these is a deployment whose settings
 * are silently not in force — which is why a mention of one anywhere is a
 * defect rather than a curiosity.
 */
const RETIRED = [
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
 * Trees that are not the repository's prose: the agent runtime's own records
 * quote whatever a session said, this check's own fixtures spell the names it
 * refuses, and a built tree repeats its sources.
 */
const NOT_PROSE = new Set([".codewhale/state"]);

/**
 * The modules in `server/src` that may still read the environment, and what
 * each is allowed to read. `bootstrap.ts` is the handshake: it is the only
 * place that knows how Stalwart is reached, and it reads nothing else. The
 * mock is a fixture that stands in for a server, configured by the test that
 * starts it.
 */
const ENV_ALLOWED = new Map([
  ["server/src/bootstrap.ts", "the handshake: where Stalwart is, and who the Master is"],
  [
    "server/src/mock/index.ts",
    "the fixture's own knobs (MOCK_*), set by the test that starts it",
  ],
]);

const ROOTS = ["server", "web", "scripts", ".codewhale", "docs"];
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".mjs",
  ".md",
  ".json",
  ".jsonc",
  ".sh",
  ".yml",
  ".yaml",
  ".example",
  ".conf",
  "",
]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dev-dist",
  "coverage",
  ".git",
  ".vite",
]);
const TEST_FILE = /\.test\.(?:ts|tsx|mts|mjs)$/;
const ENV_READ =
  /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\])/g;

/** The line number of an offset, for a report a reader can act on. */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

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
 * Every environment read one file's text makes: `{ name, line }` each.
 *
 * A read through a variable (`process.env[name]`) counts as one with the name
 * unknown: the point of the rule is that a module must not reach for the
 * process's environment at all, whatever key it computes.
 */
export function envReadsIn(text) {
  const found = [];
  for (const match of text.matchAll(ENV_READ)) {
    found.push({
      name: match[1] ?? match[3] ?? "<computed>",
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
      `${path}:${line} reads ${name} from the environment; configuration lives in the installation document`,
    );
  return lines;
}

/** Every file under a directory, relative to it. */
function walk(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      for (const child of walk(join(dir, entry.name)))
        found.push(join(entry.name, child));
    } else if (entry.isFile()) {
      found.push(entry.name);
    }
  }
  return found;
}

/** Read this repository: every file a name or a read could hide in. */
export function collectRepoInput(root = ROOT) {
  const files = [];
  for (const base of ROOTS) {
    for (const rel of walk(join(root, base)).sort()) {
      if (!TEXT_EXT.has(extname(rel))) continue;
      const path = `${base}/${rel}`;
      if (RETIRED_ALLOWED.has(path)) continue;
      if (
        NOT_PROSE.has(base) ||
        [...NOT_PROSE].some((skip) => path.startsWith(`${skip}/`))
      )
        continue;
      let text;
      try {
        text = readFileSync(join(root, path), "utf8");
      } catch {
        continue;
      }
      files.push({ path, text });
    }
  }
  return { files };
}

const USAGE =
  "The installation's configuration lives in Stalwart: no retired environment " +
  "name may appear in the tree, and `server/src` may read the environment only " +
  "for the handshake that reaches Stalwart. This check takes no arguments; " +
  "running it is checking.";

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
      `Dead configuration: none — ${result.counts.files} file(s) read, ` +
        `${result.counts.retiredNames} retired name(s) absent.\n`,
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
