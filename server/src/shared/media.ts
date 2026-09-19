/**
 * What a media type is, and what may be handed to a browser inline.
 *
 * One rule, two askers, and they have to give the same answer. The server is the
 * boundary: it answers the blob endpoint with `Content-Disposition: inline` or
 * `attachment`, with a sandboxing CSP either way. The client asks the same
 * question for a smaller reason — navigating to a blob the server will not serve
 * inline just starts a download — and it used to spell the rule out again, by
 * hand, with a note saying to keep the two in step. A mirrored rule with a note
 * is a rule that drifts, and the two spellings had already drifted on case:
 * `IMAGE/PNG` was inline for one tier and an attachment for the other, though a
 * media type is case-insensitive and the browser reads it that way.
 *
 * No imports, so this reaches a bundle with nothing attached.
 */

/**
 * The type without its parameters, trimmed and lower-cased.
 *
 * `text/plain; charset=utf-8` and `TEXT/Plain` are both `text/plain`; a media
 * type is case-insensitive (RFC 2045) and every reader that matters — the
 * browser included — parses it that way.
 */
export function mediaType(type: string | null | undefined): string {
  return (type ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * May this be served inline at all?
 *
 * A picture that is not an SVG, a recording, a PDF, and the three text types
 * the app renders as text. Everything else is an attachment — including HTML,
 * XML and anything mentioning JavaScript, which `sanitizeContentType` refuses a
 * renderable type to before this is asked.
 */
export function isInlineSafe(type: string | null | undefined): boolean {
  const t = mediaType(type);
  return (
    isInlineImage(t) ||
    t.startsWith("video/") ||
    t.startsWith("audio/") ||
    t === "application/pdf" ||
    t === "text/plain" ||
    t === "text/calendar" ||
    t === "text/vcard"
  );
}

/**
 * May this be rendered inline as a picture?
 *
 * SVG is excluded on purpose and stays excluded: it is a script carrier, the
 * server serves it as an attachment with a sandbox CSP, and deciding how to show
 * one safely is a question of its own rather than something to settle inside a
 * file lister.
 */
export function isInlineImage(type: string | null | undefined): boolean {
  const t = mediaType(type);
  return t.startsWith("image/") && t !== "image/svg+xml";
}

/**
 * The types that say nothing about a file.
 *
 * An uploader with no guess, or a store that kept none, leaves one of these
 * behind: `application/octet-stream` is not a claim that a file is a binary blob
 * rather than, say, a PDF. The server asks this when it decides what to serve a
 * blob as, the client when it decides whether to fall back to the file's name,
 * and the two answers are meant to be the same one.
 */
export const GENERIC_TYPES: ReadonlySet<string> = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
  "unknown/unknown",
]);
