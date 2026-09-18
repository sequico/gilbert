#!/usr/bin/env node
/**
 * Keep the debt an ADR declares and the code that owes it in step.
 *
 * A debt that has a site in the code is marked twice, once on each side:
 *
 *   docs/adr/0003-agent-fleet.md   <!-- owed: worker-lease-renewal -->
 *   server/src/agent/agent.ts            // ADR-0003 OWED: worker-lease-renewal
 *
 * An ADR may describe a debt for ever. What it may not do is keep a marked
 * debt whose code site is gone, or name a site the ADR stopped listing. An
 * alignment that rests on whoever remembers it rests on nothing: an ADR is
 * read when it is written and almost never afterwards.
 *
 * The comparison is per ADR, because the number in `ADR-0003 OWED:` is what
 * says which document owns the debt: two ADRs may both carry a slug such as
 * `retry`, and each is compared with the tags that name it. A slug repeated on
 * one side is an error on its own -- two lines of an ADR declaring the same
 * slug, or two sites claiming the same debt, leave no single answer to "where
 * does this debt live".
 *
 * Nothing here is optional and there is no `--check`: running it is checking.
 * It exits 0 when every ADR and the code agree, and 1 listing the slugs that
 * appear on one side only and the ones repeated on a side.
 *
 * Three deliberate narrowings of "the code":
 *
 *   - `docs/adr` holds an index (README.md) that is not an ADR; only
 *     `NNNN-*.md` names a document that can own a debt.
 *   - Tests are not read. `*.test.ts` and anything under `__tests__` carry
 *     fixture text like `ADR-0001 OWED: example` to exercise this check, and
 *     a fixture is not a site.
 *   - Build output (`dist`, `dev-dist`, `coverage`, `node_modules`) is not
 *     read, since a stale copy of a marked file would claim the same debt a
 *     second time.
 *
 * `checkOwed` is pure -- it takes text, not paths -- so the rules can be
 * exercised without a repository to stage, the way `scripts/version.mjs` is.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { walk } from "./lib/repoWalk.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The ADR a file name owns the debt of: `0003-agent-fleet.md` -> `0003`. */
const ADR_FILE = /^(\d{4})-[^/]*\.md$/;

/** The whole body of one HTML comment, so `--` inside it cannot end it early. */
const HTML_COMMENT = /<!--([\s\S]*?)-->/g;

/** An ADR marker, whole: `<!-- owed: <slug> -->` and nothing else in the body. */
const ADR_MARKER = /^\s*owed\s*:\s*(\S*)\s*$/i;

/** A code tag: `ADR-0003 OWED: <slug>`, the slug being the token after the colon. */
const CODE_TAG = /\bADR-(\d+)[\t ]+OWED:[\t ]*(\S*)/g;

/** A slug is lower-case letters, digits and inner hyphens, and nothing else. */
const SLUG_HEAD = /^[a-z0-9-]+/;

const CODE_ROOTS = ["server", "web"];
const CODE_EXT = new Set([".ts", ".tsx", ".mts", ".mjs"]);
const TEST_FILE = /\.test\.(?:ts|tsx|mts|mjs)$/;

/** The line number of an offset, for a report that can be acted on. */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * The slug a token starts with, or why it is not one. Greedy on the head, so
 * `retry-later.` reads as `retry-later` while `retry_later` is refused rather
 * than silently truncated to `retry`.
 */
function slugOf(token) {
  if (!token) return { error: "no slug after the marker" };
  const head = SLUG_HEAD.exec(token)?.[0];
  if (!head || /^[a-z0-9_-]/.test(token.slice(head.length)))
    return { error: `"${token}" is not a [a-z0-9-]+ slug` };
  return { slug: head };
}

/**
 * The markers one ADR document carries: `{ slug, line }` for each, plus the
 * lines that look like a marker and are not one -- an `owed:` body with two
 * words, or a slug with a capital or an underscore in it. A marker nobody can
 * read is a debt nobody is holding, so it is reported rather than skipped.
 */
export function owedMarkersInAdr(text) {
  const markers = [];
  const malformed = [];
  for (const comment of text.matchAll(HTML_COMMENT)) {
    const body = comment[1];
    if (!/\bowed\b/i.test(body)) continue;
    const line = lineOf(text, comment.index);
    const token = ADR_MARKER.exec(body)?.[1];
    if (token === undefined) {
      malformed.push({
        line,
        marker: body.trim(),
        reason: "a marker must read exactly `<!-- owed: <slug> -->`",
      });
      continue;
    }
    const parsed = slugOf(token);
    if (parsed.error) malformed.push({ line, marker: body.trim(), reason: parsed.error });
    else markers.push({ slug: parsed.slug, line });
  }
  return { markers, malformed };
}

/**
 * The tags one code file carries: `{ adr, slug, line }` for each, plus the
 * tags that are not readable as one -- a three-digit ADR number, or a slug
 * outside `[a-z0-9-]+`.
 */
export function owedTagsInCode(text) {
  const tags = [];
  const malformed = [];
  for (const tag of text.matchAll(CODE_TAG)) {
    const [, digits, token] = tag;
    const line = lineOf(text, tag.index);
    const marker = tag[0].trim();
    if (digits.length !== 4) {
      malformed.push({
        line,
        marker,
        reason: `ADR-${digits} is not a four-digit ADR number`,
      });
      continue;
    }
    const parsed = slugOf(token);
    if (parsed.error) malformed.push({ line, marker, reason: parsed.error });
    else tags.push({ adr: digits, slug: parsed.slug, line });
  }
  return { tags, malformed };
}

/** The ADR number a document path belongs to, or null when it is not one. */
export function adrNumberFromPath(path) {
  const base = path.split("/").pop() ?? "";
  return ADR_FILE.exec(base)?.[1] ?? null;
}

/** `[{ path, text }]` and `{ path: text }` say the same thing; accept both. */
function asFiles(files) {
  if (!files) return [];
  if (Array.isArray(files))
    return files.map((f) => ({ path: f.path, text: f.text ?? "" }));
  return Object.entries(files).map(([path, text]) => ({ path, text: text ?? "" }));
}

function add(map, adr, slug, site) {
  const slugs = map.get(adr) ?? new Map();
  map.set(adr, slugs);
  slugs.set(slug, [...(slugs.get(slug) ?? []), site]);
}

/**
 * Compare the debt declared in the ADRs with the debt claimed in the code.
 * Pure: `{ adrFiles, codeFiles }` in, `{ ok, adrOnly, codeOnly, duplicates,
 * malformed }` out, with no filesystem and no process involved.
 *
 * `adrOnly` and `codeOnly` name the slugs that appear on one side only, each
 * with the sites that said so; `duplicates` names the slugs one side repeats.
 */
export function checkOwed({ adrFiles = [], codeFiles = [] } = {}) {
  const adrSide = new Map();
  const codeSide = new Map();
  const malformed = [];

  for (const file of asFiles(adrFiles)) {
    const { markers, malformed: bad } = owedMarkersInAdr(file.text);
    // The directory's README is an index, not a document that can own a debt.
    const adr = adrNumberFromPath(file.path);
    if (adr !== null) {
      for (const { slug, line } of markers) {
        add(adrSide, adr, slug, `${file.path}:${line}`);
      }
    }
    for (const one of bad) malformed.push({ side: "adr", path: file.path, ...one });
  }

  for (const file of asFiles(codeFiles)) {
    const { tags, malformed: bad } = owedTagsInCode(file.text);
    for (const { adr, slug, line } of tags)
      add(codeSide, adr, slug, `${file.path}:${line}`);
    for (const one of bad) malformed.push({ side: "code", path: file.path, ...one });
  }

  const adrOnly = [];
  const codeOnly = [];
  const duplicates = [];
  const numbers = [...new Set([...adrSide.keys(), ...codeSide.keys()])].sort();

  for (const adr of numbers) {
    const declared = adrSide.get(adr) ?? new Map();
    const claimed = codeSide.get(adr) ?? new Map();
    for (const [slug, sites] of declared) {
      if (sites.length > 1) duplicates.push({ side: "adr", adr, slug, sites });
      if (!claimed.has(slug)) adrOnly.push({ adr, slug, sites });
    }
    for (const [slug, sites] of claimed) {
      if (sites.length > 1) duplicates.push({ side: "code", adr, slug, sites });
      if (!declared.has(slug)) codeOnly.push({ adr, slug, sites });
    }
  }

  const markers = (side) => [...side.values()].reduce((n, slugs) => n + slugs.size, 0);
  return {
    ok:
      adrOnly.length === 0 &&
      codeOnly.length === 0 &&
      duplicates.length === 0 &&
      malformed.length === 0,
    adrOnly,
    codeOnly,
    duplicates,
    malformed,
    counts: {
      adrs: numbers.length,
      adrMarkers: markers(adrSide),
      codeMarkers: markers(codeSide),
    },
  };
}

/** The disagreement, one line each, in the order a reader would fix it. */
export function formatReport(result) {
  const lines = [];
  for (const { side, adr, slug, sites } of result.duplicates) {
    const where = sites.join(", ");
    lines.push(`duplicate: the ${side} side repeats "${slug}" for ADR-${adr} — ${where}`);
  }
  for (const { adr, slug, sites } of result.adrOnly) {
    const where = sites.join(", ");
    lines.push(`ADR only: ADR-${adr} declares "${slug}" (${where}) and no code marks it`);
  }
  for (const { adr, slug, sites } of result.codeOnly) {
    const where = sites.join(", ");
    lines.push(
      `code only: ADR-${adr} declares no debt "${slug}", but ${where} claims it`,
    );
  }
  for (const { side, path, line, marker, reason } of result.malformed) {
    lines.push(`unreadable marker: ${path}:${line} (${side}) — ${reason}: ${marker}`);
  }
  return lines;
}

/** Every file under a directory, relative to it, skipping what cannot be a site. */
/** Read this repository: the ADRs, and the code that could owe them something. */
export function collectRepoInput(root = ROOT) {
  const adrDir = join(root, "docs", "adr");
  const adrFiles = readdirSync(adrDir)
    .filter((name) => ADR_FILE.test(name))
    .sort()
    .map((name) => ({
      path: `docs/adr/${name}`,
      text: readFileSync(join(adrDir, name), "utf8"),
    }));

  const codeFiles = [];
  for (const base of CODE_ROOTS) {
    for (const rel of walk(join(root, base)).sort()) {
      if (!CODE_EXT.has(extname(rel))) continue;
      if (TEST_FILE.test(rel) || rel.includes("__tests__")) continue;
      const path = `${base}/${rel}`;
      codeFiles.push({ path, text: readFileSync(join(root, base, rel), "utf8") });
    }
  }
  return { adrFiles, codeFiles };
}

const USAGE =
  "An ADR debt with a code site is marked on both sides: `<!-- owed: <slug> -->` " +
  "in docs/adr/<nnnn>-*.md, and `ADR-<nnnn> OWED: <slug>` in server/ or web/. " +
  "This check takes no arguments; running it is checking.";

/** Run the check over the repository, and say what is wrong. 0 or 1. */
function main() {
  if (process.argv.length > 2) {
    process.stdout.write(`adr-owed-check takes no arguments.\n${USAGE}\n`);
    return 1;
  }
  const { adrFiles, codeFiles } = collectRepoInput();
  const result = checkOwed({ adrFiles, codeFiles });
  const { adrMarkers, codeMarkers, adrs } = result.counts;
  if (result.ok) {
    process.stdout.write(
      `ADR owed debt: ${adrMarkers} marker(s) in ${adrs} ADR(s) match ` +
        `${codeMarkers} code tag(s).\n`,
    );
    return 0;
  }
  const problems = formatReport(result).map((line) => `  ${line}`);
  process.stdout.write(
    `ADR owed debt does not line up (${adrMarkers} marker(s), ` +
      `${codeMarkers} code tag(s)):\n${problems.join("\n")}\n${USAGE}\n`,
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
