#!/usr/bin/env node
/**
 * Keep every citation of a decision record pointing at a record that exists.
 *
 * A comment that says `(ADR 0003)` is a claim about where a reader can go to
 * read why the code is shaped the way it is, so it has to name a record that
 * is a file: a number nothing answers to sends the reader to the index and
 * then to a search, which is the lookup this check exists to save them.
 *
 * Two rules, and they hold wherever a citation may appear:
 *
 *   - `ADR <nnnn>` / `ADR-<nnnn>` must name a record that is a file:
 *     `docs/adr/<nnnn>-*.md`. A number nothing answers to is an error.
 *   - A section citation is out. The records carry named sections, so `§6`
 *     after a number points at a structure the record does not have, and
 *     `ADR §6` — which names no record at all — is the same error twice.
 *
 * A third rule is about the records rather than about what cites them, and it
 * is here because a citation can only be followed to a record that says what
 * it is.
 *
 *   - Every record states its `Status` and its `Implementation`, once each,
 *     above its first section. Both are required of every record and neither is
 *     optional: `Status` is where the decision stands, `Implementation` is where
 *     the tree stands, and a record missing either is a record a reader cannot
 *     place. Six records once carried no `Status` at all and nothing noticed,
 *     which is what this half exists to stop happening again.
 *
 * The scan covers the code, the skills, and the documents and deployment
 * files a reader meets by name: a number left in a stylesheet or a compose
 * file misleads exactly as one left in a module.
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

import { lineOf, walk } from "./lib/repoWalk.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The ADR a file name owns: `0003-agent-fleet.md` -> `0003`. */
const ADR_FILE = /^(\d{4})-[^/]*\.md$/;

/**
 * `ADR 0003`, `ADR-0003`, and the same with a section pinned to it.
 *
 * The gap between the two may hold the line break and the comment leader of a
 * wrapped sentence (`ADR\n * 0003`): a reader sees one sentence, and so must
 * this.
 */
const CITATION = /\bADR[-\s][*/\s]*(\d{1,4}|§)/g;

/** Where a citation may appear: the code, and the skills that guide it. */
const ROOTS = ["server/src", "web/src", ".codewhale/skills"];

/**
 * The documents and deployment files a reader meets by name rather than by
 * directory. Read whole, wherever they sit: the extension of a compose file
 * or a Caddyfile says nothing about whether it cites a record.
 */
const FILES = [
  "README.md",
  "FEATURES.md",
  "ROADMAP.md",
  "KNOWN-ISSUES.md",
  ".codewhale/instructions.md",
  "docker-compose.yml",
  "Caddyfile.example",
  "nginx.example.conf",
  "deploy.example.sh",
  ".env.example",
];

const EXT = new Set([".ts", ".tsx", ".mts", ".mjs", ".md", ".css"]);

/**
 * The two lines a record must carry, and the words each one may begin with.
 *
 * The vocabulary is the one `docs/adr/README.md` and the ADR section of
 * `.codewhale/instructions.md` define: a decision is `Proposed` until the owner
 * accepts it and `Accepted` after, and the tree either carries it (`Built`),
 * carries part of it (`Partly built`), or carries none of it (`Not built`).
 */
const STATUS_LINE = /^Status: (.+)$/gm;
const IMPLEMENTATION_LINE = /^Implementation: (.+)$/gm;
const STATUS_VALUES = ["Proposed", "Accepted"];
const IMPLEMENTATION_VALUES = ["Built", "Partly built", "Not built"];

/** The first section heading: the block above it is the record's own header. */
const FIRST_SECTION = /^## /m;

/** This check's own fixtures contain the shapes it refuses. */
const SKIP_FILES = new Set([
  "scripts/adr-citation-check.mjs",
  "server/src/adr-citation.test.ts",
]);

/**
 * Whether one record carries its two lines. Pure: `{ name, text }` in, and
 * `[{ line, why }]` out — the same shape the citation half reports in, so a
 * reader meets one kind of sentence.
 *
 * The lines are required exactly once and above the first section, which is
 * where every record puts them: a `Status` under `## Consequences` is a record
 * whose header says nothing, and a reader looking for it does not scroll.
 */
export function recordProblems({ name, text }) {
  const problems = [];
  const headerEnd = FIRST_SECTION.exec(text)?.index ?? text.length;

  for (const [what, pattern, allowed] of [
    ["Status", STATUS_LINE, STATUS_VALUES],
    ["Implementation", IMPLEMENTATION_LINE, IMPLEMENTATION_VALUES],
  ]) {
    const found = [...text.matchAll(pattern)];
    if (found.length === 0) {
      problems.push({ why: `no \`${what}\` line: every record states one` });
      continue;
    }
    if (found.length > 1) {
      problems.push({
        line: lineOf(text, found[1].index),
        why: `${found.length} \`${what}\` lines: a record states one`,
      });
    }
    const [match] = found;
    const line = lineOf(text, match.index);
    if (match.index > headerEnd) {
      problems.push({
        line,
        why: `\`${what}\` is below the record's first section; it belongs in the header`,
      });
    }
    /* The word it begins with, so a value that says nothing is refused: `Built`
       may be followed by a comma or a full stop, which is why this is a word
       boundary rather than a period. */
    const value = match[1].trim();
    if (!allowed.some((word) => new RegExp(`^${word}\\b`).test(value))) {
      problems.push({
        line,
        why: `\`${what}: ${value}\` begins with none of ${allowed.join(", ")}`,
      });
    }
  }
  return problems.map((one) => ({ path: name, ...one }));
}

/**
 * Whether every record states its two lines. Pure: the records as
 * `[{ name, text }]` in, `{ ok, problems }` out.
 */
export function checkRecordShape({ recordFiles = [] } = {}) {
  const problems = recordFiles.flatMap((record) => recordProblems(record));
  return {
    ok: problems.length === 0,
    problems,
    counts: { records: recordFiles.length },
  };
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

/** What a record's own header got wrong, one line each. */
export function formatShapeReport(result) {
  return result.problems.map(
    (one) =>
      `record: ${one.path}${one.line === undefined ? "" : `:${one.line}`} — ${one.why}`,
  );
}

/** Every file under a directory, relative to it, skipping what cannot cite. */
/** Read this repository: the records that exist, and what cites them. */
export function collectRepoInput(root = ROOT) {
  const adrDir = join(root, "docs", "adr");
  const entries = readdirSync(adrDir).sort();
  const records = entries
    .map((name) => ADR_FILE.exec(name)?.[1])
    .filter((n) => n !== undefined);
  /* The records read whole, for the header half: a citation is checked against
     the numbers, and a record is checked against itself. */
  const recordFiles = entries
    .filter((name) => ADR_FILE.test(name))
    .map((name) => ({
      name: `docs/adr/${name}`,
      text: readFileSync(join(adrDir, name), "utf8"),
    }));

  const files = [];
  for (const base of ROOTS) {
    for (const rel of walk(join(root, base)).sort()) {
      if (!EXT.has(extname(rel))) continue;
      const path = `${base}/${rel}`;
      if (SKIP_FILES.has(path)) continue;
      files.push({ path, text: readFileSync(join(root, path), "utf8") });
    }
  }
  for (const path of FILES) {
    if (SKIP_FILES.has(path)) continue;
    try {
      files.push({ path, text: readFileSync(join(root, path), "utf8") });
    } catch {
      // A file this installation does not ship is not a citation.
    }
  }
  return { files, records, recordFiles };
}

const USAGE =
  "Every `ADR <nnnn>` in the code, the skills and the documents that ship " +
  "beside them must name a record that is a file in docs/adr/, sections are " +
  "cited by name or not at all, and every record states its `Status` and its " +
  "`Implementation` above its first section. " +
  "This check takes no arguments; running it is checking.";

/** Run both halves over the repository, and say what is wrong. 0 or 1. */
function main() {
  if (process.argv.length > 2) {
    process.stdout.write(`adr-citation-check takes no arguments.\n${USAGE}\n`);
    return 1;
  }
  const { files, records, recordFiles } = collectRepoInput();
  const result = checkCitations({ files, records });
  const shape = checkRecordShape({ recordFiles });
  const { citations, records: count } = result.counts;
  if (result.ok && shape.ok) {
    process.stdout.write(
      `ADR citations: ${citations} citation(s) in ${files.length} file(s) name ` +
        `one of ${count} record(s), and every one states its Status and Implementation.\n`,
    );
    return 0;
  }
  const problems = [...formatReport(result), ...formatShapeReport(shape)].map(
    (line) => `  ${line}`,
  );
  process.stdout.write(
    `ADR records and their citations (${citations} citation(s), ${count} record(s)):\n` +
      `${problems.join("\n")}\n${USAGE}\n`,
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
