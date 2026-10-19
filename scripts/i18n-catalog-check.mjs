#!/usr/bin/env node
import { readFileSync } from "node:fs";

import ts from "typescript";
/*
 * Check a catalogue against the strings the code actually asks for.
 *
 * Two failures, and only one of them is visible without this.
 *
 * A *missing* key renders English. That is the designed fallback and shows up
 * as an untranslated word on screen, which somebody will eventually notice.
 *
 * A *stale* key -- one whose English no longer exists, usually because it was
 * mistyped when the catalogue was written -- is silent. The translation sits
 * in the file looking correct, is never looked up, and the app renders English
 * for ever. Nothing warns, because a catalogue is only ever read by key.
 */
import {
  catalogFiles,
  catalogKeys,
  sourceAst,
  sourceFiles,
  wantedStrings,
} from "./lib/i18nSources.mjs";

/*
 * The English strings a catalogue may still lack. English is the source, so a
 * missing key renders English: that is the designed fallback, and this budget
 * is what keeps it from growing unnoticed. A new source string with no
 * catalogue entry raises a count above the pin and fails the check, and the pin
 * is moved by hand — down as translations land, up when a new source string is
 * added ahead of its translation — so the fallback stays a budget, not a
 * surprise. At zero the rule is the strict one: any missing key fails.
 *
 * 168 -> 169: the workorder surface's batch, plus the remote-image banner's
 * sentence for an installation whose proxy is off (`MessageView.tsx`), which is
 * a branch few deployments ever draw.
 *
 * 169 -> 170: the calendar's sentence for a subscription that did not answer in
 * time (`store/calendar.ts`), a third-party server's silence rather than ours.
 *
 * 170 -> 195: the agent's administration section's batch
 * (`views/admin/AdminAgent.tsx`) — where the agent is, a run's plan with the
 * order and the branch each step took, and the facts of the installation's
 * memory — with the states a step and a run left in, which the record names in
 * its own words and a reader cannot be left to guess at.
 *
 * 195 -> 196: the AI Agents page — its tabs, the standing rule and the work
 * metrics it draws (`views/admin/agents/`) — net of the agent page's old
 * sentences that the same change removed. The count moves by one because the
 * additions and the removals are one batch; it is not a new surface's worth of
 * unwritten translations.
 *
 * 196 -> 198: the metrics period — "Period" and "All time"; the day, week and
 * month labels the calendars already translated are reused (`views/admin/
 * agents/AgentOverview.tsx`).
 *
 * 198 -> 208: the model connection check's own sentences — connected, the key
 * refused, the address not found, unreachable, and the rest of what a probe can
 * come back with (`views/admin/agents/AgentGeneral.tsx`).
 *
 * 208 -> 209: the rule-name sentence beside the field that now refuses a space
 * (`views/admin/agents/GroupRules.tsx`).
 */
const MISSING_MAX = 209;

/**
 * What this check reads, for the pre-push hook's skip decision.
 *
 * The catalogues, the strings the code asks for, and the registry that says
 * which of them are offered. `i18n-literals` reads the same two of the three
 * and adds nothing; each answer is its own, because a check that named another's
 * files would skip a push over a path its sibling actually reads.
 */
export function readPaths() {
  return [...catalogFiles(), ...sourceFiles(), "web/src/lib/languages.ts"];
}

const { keys: wanted } = wantedStrings();

/*
 * A catalogue and a picker entry are two halves of one thing, and either half
 * alone is dead weight. A catalogue with no entry in UI_LANGUAGES never
 * reaches a reader -- it builds, it passes every test, and the language simply
 * is not offered. That happened to Dutch: the entry was added by a text
 * replacement anchored on a line that did not exist on that branch, so it was
 * a silent no-op and nothing anywhere complained.
 */
/** Run the check over the tree, and say what is wrong. 0 or 1. */
function main() {
  const languagesSrc = readFileSync("web/src/lib/languages.ts", "utf8");
  const registered = new Set(
    [...languagesSrc.matchAll(/tag:\s*"([\w-]+)"/g)].map((m) => m[1]),
  );
  const catalogues = new Set(
    catalogFiles().map((f) => f.split("/").pop().replace(".ts", "")),
  );

  let failed = false;
  for (const tag of catalogues) {
    if (!registered.has(tag)) {
      failed = true;
      console.log(
        `!! ${tag}.ts exists but is not in UI_LANGUAGES — the language is never offered\n`,
      );
    }
  }
  for (const tag of registered) {
    if (tag !== "en" && !catalogues.has(tag)) {
      failed = true;
      console.log(
        `!! UI_LANGUAGES offers ${tag} but there is no ${tag}.ts — it would fall back to English\n`,
      );
    }
  }

  for (const file of catalogFiles()) {
    const tag = file.split("/").pop().replace(".ts", "");
    const src = sourceAst(file, { kind: ts.ScriptKind.TS });
    const have = catalogKeys(src);
    /*
     * `catalogKeys` reads the `strings` and `plurals` objects structurally, so a
     * plural entry's form names (`one`, `other`, …) are the shape of the file and
     * are not keys at all: they never reach this list. A key literally named
     * `one` in `strings` is a string nothing looks up, exactly like any other
     * stale key, and is reported.
     */
    const stale = [...have].filter((k) => !wanted.has(k));
    const missing = [...wanted].filter((k) => !have.has(k));
    const pct = Math.round(((wanted.size - missing.length) / wanted.size) * 100);
    console.log(
      `${tag}: ${wanted.size - missing.length}/${wanted.size} translated (${pct}%), ${missing.length} falling back to English`,
    );
    if (missing.length > MISSING_MAX) {
      failed = true;
      console.log(
        `\n  ${missing.length} key(s) have no catalogue entry, above the pinned ${MISSING_MAX}:`,
      );
      for (const k of missing.slice(0, 25)) console.log(`    ${JSON.stringify(k)}`);
      if (missing.length > 25) console.log(`    …and ${missing.length - 25} more`);
    }
    if (stale.length) {
      failed = true;
      console.log(
        `\n  ${stale.length} STALE key(s) — translated but never looked up, so they do nothing:`,
      );
      for (const k of stale.slice(0, 25)) console.log(`    ${JSON.stringify(k)}`);
      if (stale.length > 25) console.log(`    …and ${stale.length - 25} more`);
    }
    if (process.argv.includes("--missing")) {
      console.log(`\n  missing:`);
      for (const k of missing) console.log(`    ${JSON.stringify(k)}`);
    }
  }
  if (failed && process.argv.includes("--check")) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
