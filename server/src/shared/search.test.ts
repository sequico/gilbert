/**
 * The search grammar a caller is told, and the parser it describes (ADR 0038).
 *
 * `SEARCH_GRAMMAR` is what a model reads before it writes a `query`, and a
 * sentence that promised an operator the parser does not take — or forgot one it
 * does — is a step the run pays for: one installation spent nine lookups guessing
 * `$hasattachment`, `attachment` and `has:attachment` before it found the third.
 * The test below reads the parser's own `case` labels, so the two cannot drift.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseQuery, SEARCH_GRAMMAR } from "./search.js";

/** The operators the parser takes, read off its source rather than listed twice. */
function parserOperators(): string[] {
  const source = readFileSync(new URL("./search.ts", import.meta.url), "utf8");
  const from = source.indexOf("export function parseQuery");
  assert.ok(from > 0, "the parser is where this test expects it");
  const body = source.slice(from);
  const keys = [...body.matchAll(/^\s*case "([a-z_]+)":/gm)].map((one) => one[1] ?? "");
  return [...new Set(keys)];
}

test("every operator the parser takes is named in the grammar a caller reads", () => {
  const keys = parserOperators();
  assert.ok(keys.length >= 15, `the parser takes ${keys.length} operators`);
  /*
   * The grammar names an operator by its prefix and then its values — `"has:star"`
   * covers `has:` — so the match is on the prefix, not on the bare word.
   */
  for (const key of keys)
    assert.ok(
      SEARCH_GRAMMAR.includes(`"${key}:`),
      `the parser takes "${key}:" and the grammar a model reads does not name it`,
    );
});

test("the grammar names no operator the parser drops", () => {
  /*
   * The other direction: a word the sentence promises and the parser sends to the
   * text search is a filter that silently widens the answer. Only the quoted
   * `name:` forms are checked, which is what the sentence uses for operators.
   */
  const quoted = [...SEARCH_GRAMMAR.matchAll(/"([a-z_]+):"/g)].map((one) => one[1] ?? "");
  const keys = new Set(parserOperators());
  for (const name of new Set(quoted))
    assert.ok(
      keys.has(name),
      `the grammar promises "${name}:" and the parser ignores it`,
    );
});

test("a query is read the way the grammar says", () => {
  const parsed = parseQuery(
    "in:Inbox has:attachment from:paypal after:2026-10-01 invoice",
  );
  assert.equal(parsed.in, "Inbox");
  assert.equal(parsed.hasAttachment, true);
  assert.equal(parsed.from, "paypal");
  assert.match(parsed.after ?? "", /^2026-10-01T/, "a date is read as a date");
  assert.deepEqual(parsed.text, ["invoice"]);
});
