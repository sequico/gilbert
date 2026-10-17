/**
 * Text every tier cleans the same way.
 *
 * A sender-supplied name has no honest use for direction overrides,
 * embeddings, isolates and marks: `Invoice_\u202Efdp.exe` would display as
 * "Invoice_exe.pdf". One definition both tiers read, so a filename a client
 * cleans and a header the server writes drop the same set — otherwise the same
 * name is safe in one place and not the other.
 */

/** Remove the characters that reorder text around them. */
export function withoutBidiControls(s: string): string {
  return s.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
}

/**
 * A reply's or a forward's subject, from the message it answers.
 *
 * Existing prefixes are stripped and the new one added, so a thread does not
 * grow "Re: Re: Re:", and a message already carrying the prefix keeps the
 * subject it has. One definition for both tiers: the client's reply and the
 * draft an agent writes cannot disagree about what a subject means.
 */
export function replySubject(
  subject: string | null | undefined,
  prefix: "Re" | "Fwd",
): string {
  const s = (subject ?? "").trim();
  const stripped = s.replace(/^((re|fw|fwd|aw|sv|vs|tr|wg)\s*:\s*)+/i, "");
  if (prefix === "Re" && /^re\s*:/i.test(s)) return s;
  if (prefix === "Fwd" && /^(fwd?|fw)\s*:/i.test(s)) return s;
  return `${prefix}: ${stripped}`;
}
