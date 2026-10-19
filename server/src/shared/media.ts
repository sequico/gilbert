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
 * The media type a PDF carries.
 *
 * The one type `isInlineSafe` serves inline that is a document rather than a
 * picture, a recording or text, and the type the document family classifies as
 * `pdf` — named once so the server's rule and the agent's reading ask the same
 * answer.
 */
export const PDF_TYPE = "application/pdf";

/**
 * Whether a media type is a PDF.
 *
 * `application/x-pdf` and `application/acrobat` are what older senders still
 * write. They are the same document, so every reader here asks this one
 * question rather than spelling the comparison out and drifting.
 */
export function isPdfType(type: string | null | undefined): boolean {
  const t = mediaType(type);
  return t === PDF_TYPE || t === "application/x-pdf" || t === "application/acrobat";
}

/**
 * The media type a name gives a file whose declared type says nothing.
 *
 * A PDF sent by a booking system often arrives as `application/octet-stream`
 * with only its name as evidence, and a browser refuses to render
 * octet-stream even inside the preview frame. The binary types the app can
 * show are named here once, so the server's response type and the client's
 * preview decision take the same extension list. Text keeps its own list in
 * the client: those are read with `fetch`, where the response type does not
 * decide whether it is shown.
 */
export function typeFromName(name: string | null | undefined): string | null {
  const n = name ?? "";
  if (/\.pdf$/i.test(n)) return PDF_TYPE;
  if (/\.png$/i.test(n)) return "image/png";
  if (/\.jpe?g$/i.test(n)) return "image/jpeg";
  if (/\.gif$/i.test(n)) return "image/gif";
  if (/\.webp$/i.test(n)) return "image/webp";
  if (/\.avif$/i.test(n)) return "image/avif";
  if (/\.bmp$/i.test(n)) return "image/bmp";
  if (/\.ico$/i.test(n)) return "image/x-icon";
  if (/\.hei[cf]$/i.test(n)) return "image/heic";
  return null;
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
    isPdfType(t) ||
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
 * Whether a file name is a Markdown document.
 *
 * A `.md` upload usually arrives as `application/octet-stream`, so the name is
 * the only evidence. One test, so the viewer that renders it and the preview
 * that decides it is text-shaped accept the same extensions.
 */
export function isMarkdownExtension(name: string | null | undefined): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(name ?? "");
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
