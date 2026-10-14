#!/usr/bin/env node
/*
 * Every source string a catalogue needs, straight out of the calls.
 *
 * The English text is the key, so the catalogue's keys are not a list somebody
 * maintains -- they are whatever t(), tNode() and plural() are actually asked
 * for. Reading them from the code means a catalogue can never drift out of
 * step with the app in the one direction that matters: a key that no longer
 * exists is dead weight, but a call with no key is an untranslated string
 * nobody noticed.
 */
/* The parser, not the compiler: the shared explanation is `sourceAst` in
   ./lib/i18nSources.mjs. */
import { wantedStrings } from "./lib/i18nSources.mjs";

const { keys: strings, pluralForms: plurals } = wantedStrings();

const out = {
  strings: [...strings].sort(),
  plurals,
};
if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`${out.strings.length} strings, ${out.plurals.length} plural sets`);
  const short = out.strings.filter((s) => s.length <= 30).length;
  console.log(`  ${short} short (<=30 chars), ${out.strings.length - short} longer`);
}
