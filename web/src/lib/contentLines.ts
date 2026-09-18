/**
 * Content lines: the folding RFC 5545 and RFC 6350 ask for, in one place.
 *
 * A calendar, a vCard or an LDIF file fits a long value onto a line by breaking
 * it and prefixing the continuation with a single space; a reader puts it back
 * together before anything looks at the value. Both halves live here so the
 * three formats agree about it: their readers differ only in what they do with
 * a line, never in where a line ends, and a continuation is a continuation in
 * all three.
 *
 * **The limit is octets, not characters.** Both RFCs say 75 octets, and the
 * difference is exactly the text a mail client holds: a 75-character line of
 * CJK is 225 octets on the wire, and the server on the other side is entitled
 * to refuse it or store it wrong. Octets alone are not enough either — a break
 * placed by counting bytes lands inside a multi-octet character about one time
 * in three, and the reader then holds bytes that are not text. So the fold
 * counts octets and cuts at character boundaries, which is the whole reason
 * this is a module rather than a `slice`.
 */

/** The wire limit: RFC 5545 §3.1 and RFC 6350 §3.2 both say 75 octets. */
const FOLD_LIMIT = 75;

/** What a continuation line carries at its head, and unfolding takes off. */
const CONTINUATION = " ";

const encoder = new TextEncoder();

/** How many octets this text occupies in UTF-8, which is the measure here. */
function octetLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Break one content line the way the formats require, or leave it alone.
 *
 * The first line may carry `FOLD_LIMIT` octets and each continuation one less,
 * because the leading space is part of the line it belongs to — so a long ASCII
 * line also re-folds into different chunks than a copy that gave the first line
 * 74 would. The break falls on a **code point** boundary: `for…of` walks code
 * points, so a surrogate pair or an accented letter is never cut in half by the
 * count. A combining mark is a code point of its own, so a decomposed `e` and
 * U+0301 can still be split across a fold; both RFCs forbid splitting a
 * multi-octet *character*, and nothing more.
 */
export function foldLine(line: string): string {
  if (octetLength(line) <= FOLD_LIMIT) return line;
  const out: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const char of line) {
    const size = octetLength(char);
    const budget = out.length ? FOLD_LIMIT - CONTINUATION.length : FOLD_LIMIT;
    if (bytes + size > budget) {
      out.push((out.length ? CONTINUATION : "") + chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  if (chunk) out.push((out.length ? CONTINUATION : "") + chunk);
  return out.join("\r\n");
}

/**
 * Put folded lines back together: a continuation begins with a space or a tab
 * and joins the line before it, with nothing between.
 *
 * Two things a continuation is *not*. One with nothing above it to continue —
 * a leading space on the first line is part of that line. And one after a blank
 * line, which is how LDIF separates its records: joining there would swallow
 * the separator and merge two entries into one.
 */
export function unfoldLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const continues = raw.startsWith(CONTINUATION) || raw.startsWith("\t");
    if (continues && out.length && out[out.length - 1] !== "") {
      out[out.length - 1] += raw.slice(1);
      continue;
    }
    out.push(raw);
  }
  return out;
}
