/**
 * The signature every mail client writes, and how it is put on a body — one
 * definition, both tiers.
 *
 * The composer appends a signature when a message is written; the agent
 * appends the group's own signature when it prepares a draft or sends on the
 * group's behalf (ADR 0003 resolutions 2 and 13: "applies its text/HTML
 * signature exactly as the UI composer does"). Those are the same rule, so
 * they are the same function: a group's footer must not depend on which of
 * the two wrote the mail.
 *
 * The delimiter is the convention every client has used since Usenet — a line
 * holding dash dash space — and it is what lets the reader's client hide the
 * block. `/^-- $/` is what the other end's signature stripper looks for.
 */

export const SIGNATURE_SEPARATOR = "-- ";

/**
 * A plain-text signature on the end of a body.
 *
 * Two newlines below the text (one if the text already ended with a
 * newline), then the delimiter line, then the signature itself.
 */
export function textSignatureBlock(signature: string | null | undefined): string {
  if (!signature) return "";
  return `\n\n${SIGNATURE_SEPARATOR}\n${signature}`;
}
