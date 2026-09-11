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
 * The cap on an identity's signature, in the bytes the mail server counts.
 *
 * One number for both tiers: the editor shows the count against it and the
 * server refuses what the editor would have warned about, so a signature that
 * saves is one the server accepts.
 */
export const SIGNATURE_LIMIT = 2047;

/** The length of a string in the UTF-8 bytes an identity's signature is capped in. */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

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

/**
 * The same signature in an HTML body.
 *
 * The delimiter is the same line — `SIGNATURE_SEPARATOR`, which is what the
 * reader's client hides the block by — and only the markup around it differs,
 * so it is written from the one constant rather than spelled again. The
 * caller passes the signature already rendered: it is the site that knows
 * whether the identity holds text or markup, and where the newlines inside it
 * become line breaks.
 */
export function htmlSignatureBlock(signatureHtml: string | null | undefined): string {
  if (!signatureHtml) return "";
  return `<br>${SIGNATURE_SEPARATOR}<br>${signatureHtml}`;
}
