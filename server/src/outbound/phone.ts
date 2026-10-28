/**
 * One number, one form (ADR 0040).
 *
 * The canonical form is E.164 — a `+`, the country code and digits — and it is
 * the number's identity: the duplicate rule, the do-not-call match and the
 * comparison against a card all rest on that one string, so anything that
 * arrives in another shape is normalised here, and a shape that cannot be
 * resolved is refused with its reason rather than guessed at.
 *
 * **The country lives in the number.** A form that starts with `+` (or `00`,
 * which is the same statement written the old way) carries its own country. A
 * form that does not is read against the calling-code table: the leading digits
 * are matched against the codes the world assigns, and the national part is
 * validated for a country that code belongs to. `02 123456` is not resolvable —
 * no calling code starts with a zero — and it is refused; `39 02 123456` is
 * Italy. Ambiguity *between* the countries of one code (+1 is the United States
 * and Canada) never changes the answer: what is stored is the code and the
 * national part, which those countries share.
 *
 * The table is the world's rather than ours, so it is `libphonenumber-js`'s
 * metadata: a hand-written table is the same data carrying our mistakes.
 *
 * An extension is not thrown away: it leaves the number and comes back beside
 * it, so a row can keep "int. 24" where a person reads it — in a spreadsheet cell
 * and inside a pasted sentence alike.
 */

import {
  type CountryCode,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from "libphonenumber-js";
import { isE164 } from "../shared/outbound.js";

/** Why a shape could not become a number. A refusal is counted, never guessed. */
export type NumberRefusal = "empty" | "no_country" | "invalid";

export type NormalisedNumber =
  | { ok: true; e164: string; extension: string | null }
  | { ok: false; reason: NumberRefusal };

/**
 * What may decorate a number, stated once: the punctuation a person writes around
 * digits, and the pattern that finds such a run inside a line of prose.
 */
const PUNCTUATION = "\\s\\u00a0().\\-/";
const DECORATION = new RegExp(`[${PUNCTUATION}]`, "g");
const CANDIDATE = new RegExp(`\\+?\\d[\\d${PUNCTUATION}]{5,}\\d`, "g");

/**
 * The marker that begins what is written beside a number, and the two ways it is
 * read: at the end of an entry, and at the start of what follows a number inside a
 * line. One source, so "int." means the same thing in both readers.
 */
const EXTENSION_SOURCE = "(?:int(?:erno)?\\.?|ext(?:ension)?\\.?|x|#|;)";
const EXTENSION_IN_ENTRY = new RegExp(`\\s*${EXTENSION_SOURCE}\\s*(\\d[\\d\\s]*)$`, "i");
const EXTENSION_AT_START = new RegExp(`^\\s*${EXTENSION_SOURCE}\\s*(\\d[\\d\\s]*)$`, "i");

/** The calling codes, longest first, so `39` is tried before `3` would be. */
const CALLING_CODES: readonly { code: string; countries: readonly CountryCode[] }[] =
  buildCallingCodes();

function buildCallingCodes(): { code: string; countries: CountryCode[] }[] {
  const byCode = new Map<string, CountryCode[]>();
  for (const country of getCountries()) {
    const code = getCountryCallingCode(country);
    const list = byCode.get(code);
    if (list) list.push(country);
    else byCode.set(code, [country]);
  }
  return [...byCode.entries()]
    .map(([code, countries]) => ({ code, countries }))
    .sort((a, b) => b.code.length - a.code.length);
}

/** The longest run of dialling characters in a line: the candidate number. */
function numberIn(line: string): string | null {
  let best: string | null = null;
  let bestDigits = 0;
  for (const match of line.matchAll(CANDIDATE)) {
    const digits = match[0].replace(/\D/g, "").length;
    if (digits > bestDigits) {
      best = match[0];
      bestDigits = digits;
    }
  }
  return best;
}

/** The digits of a raw entry, its extension, and whether it stated a country. */
function readEntry(raw: string): {
  digits: string;
  extension: string | null;
  international: boolean;
} {
  const match = EXTENSION_IN_ENTRY.exec(raw);
  const extension = match?.[1] ? match[1].replace(DECORATION, "") : null;
  const body = (match ? raw.slice(0, match.index) : raw).replace(DECORATION, "");
  if (body.startsWith("+"))
    return { digits: body.slice(1).replace(/\D/g, ""), extension, international: true };
  if (body.startsWith("00"))
    return { digits: body.slice(2).replace(/\D/g, ""), extension, international: true };
  return { digits: body.replace(/\D/g, ""), extension, international: false };
}

/**
 * Read one entry — a spreadsheet cell, a pasted line, a card's own field — as one
 * number, or say why it is not one.
 */
export function normaliseNumber(raw: string): NormalisedNumber {
  if (!raw?.trim()) return { ok: false, reason: "empty" };
  const { digits, extension, international } = readEntry(raw);
  if (!digits) return { ok: false, reason: "invalid" };

  if (international) {
    const parsed = parsePhoneNumberFromString(`+${digits}`);
    if (!parsed?.isValid() || !isE164(parsed.number))
      return { ok: false, reason: "invalid" };
    return { ok: true, e164: parsed.number, extension };
  }

  // No country stated: the leading digits must name one, or the entry is not
  // resolvable and refusing it is the honest answer.
  for (const { code, countries } of CALLING_CODES) {
    if (!digits.startsWith(code)) continue;
    const national = digits.slice(code.length);
    if (!national) continue;
    for (const country of countries) {
      const parsed = parsePhoneNumberFromString(national, country);
      if (
        parsed?.isValid() &&
        parsed.countryCallingCode === code &&
        isE164(parsed.number)
      ) {
        return { ok: true, e164: parsed.number, extension };
      }
    }
  }
  return { ok: false, reason: "no_country" };
}

/**
 * What one line of a pasted list gives: the entry to normalise, and the words that
 * were around it.
 *
 * A line is prose as often as it is a cell — "ACME, chiedi di Tizio, +39 333 123
 * 4567 int. 24" — so the number is found inside it and the extension that follows
 * the number belongs to the number, while everything else is context the row
 * keeps. Returning the entry rather than the number is what lets one reader own
 * both halves: the caller normalises, and nothing is parsed twice.
 */
export function lineEntry(line: string): {
  entry: string | null;
  context: string | null;
} {
  const candidate = numberIn(line);
  if (!candidate) return { entry: null, context: null };
  const start = line.indexOf(candidate);
  const after = line.slice(start + candidate.length);
  const extension = EXTENSION_AT_START.exec(after);
  const entry = extension ? `${candidate} ${extension[0].trim()}` : candidate;
  const rest = `${line.slice(0, start)}${extension ? after.slice(extension[0].length) : after}`;
  // One space between words, never three: the context is shown to a person, and a
  // hole where the number was is not information.
  const context = rest
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:\-\u2014]+|[\s,;:\-\u2014]+$/g, "");
  return { entry, context: context === "" ? null : context };
}
