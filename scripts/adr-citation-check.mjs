#!/usr/bin/env node
/**
 * Keep every citation of a decision record pointing at a record that exists.
 *
 * A comment that says `(ADR 0003)` is a claim about where a reader can go to
 * read why the code is shaped the way it is. The records were consolidated
 * once — six of them now hold what ten and fifteen used to — and the numbers
 * they retired are listed in `docs/adr/README.md` for anyone meeting one in
 * the history. That list is for the history; it is not a licence for the code
 * to keep citing a number whose file is gone, because a reader following it
 * finds the index and then has to search, which is the lookup this check
 * exists to save them.
 *
 * Two rules, both of them about the code and the skills rather than about the
 * records themselves:
 *
 *   - `ADR <nnnn>` / `ADR-<nnnn>` must name a record that is a file:
 *     `docs/adr/<nnnn>-*.md`. A number nothing answers to is an error.
 *   - A section citation is out. The records carry named sections, and the
 *     index says section numbers do not carry over between revisions, so
 *     `§6` after a number points at a structure that no longer exists, and
 *     `ADR §6` — which names no record at all — is the same error twice.
 *
 * Tests are read: a test that says which decision it pins is doing useful
 * work. The one exception is this check's own test, whose fixtures have to
 * contain the very shapes it refuses.
 *
 * `checkCitations` is pure — it takes text, not paths — so the rules can be
 * exercised without a repository to stage.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The ADR a file name owns: `0003-agent-fleet.md` -> `0003`. */
const ADR_FILE = /^(\d{4})-[^/]*\.md$/;

/** `ADR 0003`, `ADR-0003`, and the same with a section pinned to it. */
const CITATION = /\bADR[-\s](\d{1,4}|\s*§)/g;

/** Where a citation may appear: the code, and the skills that guide it. */
const ROOTS = ["server/src", "web/src", ".codewhale/skills"];
const EXT = new Set([".ts", ".tsx", ".mts", ".mjs", ".md"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "dev-dist", "coverage", ".git"]);

/** This check's own fixtures contain the shapes it refuses. */
const SKIP_FILES = new Set([
  "scripts/adr-citation-check.mjs",
  "server/src/adr-citation.test.ts",
]);

/** The line number of an offset, for a report a reader can act on. */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * Every citation in one file's text: `{ number, line }` for the ones that name
 * a record, and `{ line, why }` for the ones that cannot be followed.
 *
 * `numbers` is what the repository has to answer for; `broken` is a mistake
 * whatever the repository holds.
 */
export function citationsIn(text) {
  const numbers = [];
  const broken = [];
  for (const match of text.matchAll(CITATION)) {
    const line = lineOf(text, match.index);
    const number = match[1].trim();
    const after = text.slice(match.index + match[0].length);
    if (!/^\d{4}$/.test(number)) {
      broken.push({
        line,
        why: number.startsWith("§")
          ? "`ADR §` names a section of no record: name the record"
          : `ADR ${number} is not a four-digit number`,
      });
      continue;
    }
    /*
     * A record's sections are named, not numbered: the index says a section
     * number does not carry over between revisions, so pinning one to a
     * citation points at a structure the record no longer has. A `§` that
     * follows no record is somebody else's document -- an RFC's numbering is
     * not this repository's to police -- and is left alone.
     */
    if (/^\s*(?:\n\s*\*)?\s*§\s*\d+/.test(after)) {
      broken.push({
        line,
        why: `ADR ${number} is cited with a section number; name the section instead`,
      });
    }
    numbers.push({ number, line });
  }
  return { numbers, broken };
}

/**
 * Compare the citations with the records that exist. Pure: `{ files, records }`
 * in — the files as `[{ path, text }]`, the records as the set of four-digit
 * numbers that are files — and `{ ok, unknown, broken }` out.
 */
export function checkCitations({ files = [], records = [] } = {}) {
  const known = new Set(records);
  const unknown = [];
  const broken = [];
  for (const file of files) {
    const { numbers, broken: bad } = citationsIn(file.text ?? "");
    for (const { number, line } of numbers) {
      if (!known.has(number)) unknown.push({ path: file.path, line, number });
    }
    for (const one of bad) broken.push({ path: file.path, ...one });
  }
  return {
    ok: unknown.length === 0 && broken.length === 0,
    unknown,
    broken,
    counts: {
      files: files.length,
      records: known.size,
      citations: files.reduce((n, f) => n + citationsIn(f.text ?? "").numbers.length, 0),
    },
  };
}

/** The disagreement, one line each. */
export function formatReport(result) {
  const lines = [];
  for (const { path, line, number } of result.unknown)
    lines.push(`no record: ${path}:${line} cites ADR ${number}, and no such file exists`);
  for (const { path, line, why } of result.broken)
    lines.push(`unfollowable: ${path}:${line} — ${why}`);
  return lines;
}

/** Every file under a directory, relative to it, skipping what cannot cite. */
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

/** Read this repository: the records that exist, and what cites them. */
export function collectRepoInput(root = ROOT) {
  const adrDir = join(root, "docs", "adr");
  const records = readdirSync(adrDir)
    .map((name) => ADR_FILE.exec(name)?.[1])
    .filter((n) => n !== undefined);

  const files = [];
  for (const base of ROOTS) {
    for (const rel of walk(join(root, base)).sort()) {
      if (!EXT.has(extname(rel))) continue;
      const path = `${base}/${rel}`;
      if (SKIP_FILES.has(path)) continue;
      files.push({ path, text: readFileSync(join(root, path), "utf8") });
    }
  }
  return { files, records };
}

const USAGE =
  "Every `ADR <nnnn>` in server/, web/ and .codewhale/ must name a record that " +
  "is a file in docs/adr/, and sections are cited by name or not at all. " +
  "This check takes no arguments; running it is checking.";

/** Run the check over the repository, and say what is wrong. 0 or 1. */
function main() {
  if (process.argv.length > 2) {
    process.stdout.write(`adr-citation-check takes no arguments.\n${USAGE}\n`);
    return 1;
  }
  const { files, records } = collectRepoInput();
  const result = checkCitations({ files, records });
  const { citations, records: count } = result.counts;
  if (result.ok) {
    process.stdout.write(
      `ADR citations: ${citations} citation(s) in ${files.length} file(s) name ` +
        `one of ${count} record(s).\n`,
    );
    return 0;
  }
  const problems = formatReport(result).map((line) => `  ${line}`);
  process.stdout.write(
    `ADR citations do not resolve (${citations} citation(s), ${count} record(s)):\n` +
      `${problems.join("\n")}\n${USAGE}\n`,
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
