/**
 * What, if anything, we can show of a file without downloading it.
 *
 * Two questions, deliberately kept apart:
 *
 *  - `previewKind` — can the app render it in a dialog? Text is answered with
 *    `fetch`, which ignores Content-Disposition, so this is free to say yes to
 *    anything text-shaped.
 *  - `openableInTab` — will the *server* hand it back inline? It does not answer
 *    that here: it is `@gilbert/shared/media`'s `isInlineSafe`, the rule the
 *    server serves blobs by, because the client and the server giving different
 *    answers is a button that starts a download instead of opening a tab.
 *    Everything else is served as an attachment with a sandbox CSP.
 *
 * The two answer different questions and neither can be derived from the other:
 * a file the app can render is not always one the server will serve inline.
 */
import {
  GENERIC_TYPES,
  isMarkdownExtension,
  isPdfType,
  mediaType,
  typeFromName,
} from "@gilbert/shared/media";

type PreviewKind = "image" | "pdf" | "text";

/**
 * Uploads arrive with whatever type the browser guessed, which for anything
 * unusual is one of the generic types -- `files.ts` stores
 * `f.type || "application/octet-stream"`. A generic type is not evidence about
 * the file, so fall through to the name. The set is `@gilbert/shared/media`'s,
 * which the server asks about the same types.
 */
const BY_EXTENSION: Array<[RegExp, PreviewKind]> = [
  [
    /\.(txt|text|log|csv|tsv|json|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|fish|ps1|bat|js|mjs|cjs|jsx|ts|tsx|css|scss|less|html?|xhtml|xml|sql|py|rb|rs|go|c|h|cc|cpp|hpp|java|kt|swift|php|pl|lua|r|diff|patch|gitignore|dockerfile|makefile)$/i,
    "text",
  ],
];

function textish(type: string): boolean {
  return (
    type.startsWith("text/") ||
    type.endsWith("+json") ||
    type.endsWith("+xml") ||
    /^application\/(json|xml|javascript|ecmascript|sql|toml|x-yaml|yaml|x-sh|x-shellscript|x-httpd-php)$/.test(
      type,
    )
  );
}

/**
 * SVG is excluded on purpose, and stays excluded. It is a script carrier, the
 * server refuses to serve it inline, and deciding how to show one safely is a
 * question of its own rather than something to settle inside a file lister.
 * An SVG falls through to a download, which is what every type outside this
 * list gets.
 */
export function previewKind(
  type: string | null | undefined,
  name: string | null | undefined,
): PreviewKind | null {
  const t = mediaType(type);
  // A generic type is no evidence, so the name takes over -- through the same
  // extension list the server uses to choose the response type.
  const known = t && !GENERIC_TYPES.has(t) ? t : mediaType(typeFromName(name));
  if (known && !GENERIC_TYPES.has(known)) {
    if (known === "image/svg+xml") return null;
    if (known.startsWith("image/")) return "image";
    if (isPdfType(known)) return "pdf";
    if (textish(known)) return "text";
    // The server was specific and it is not something we show. Guessing from
    // the extension here would override a type the sender actually declared.
    return null;
  }
  const n = name ?? "";
  if (isMarkdownExtension(n)) return "text";
  for (const [re, kind] of BY_EXTENSION) if (re.test(n)) return kind;
  return null;
}

/**
 * Will the server hand this back inline? The server's own rule, asked here.
 *
 * Re-exported under the client's name for the question, so a surface importing
 * this module reads what it asks for rather than the server's vocabulary.
 */
export { isInlineImage, isInlineSafe as openableInTab } from "@gilbert/shared/media";

/**
 * Whether an attachment waiting in the composer can be looked at before it is
 * sent: the app can render it (`previewKind`), and it has reached the server —
 * a file still uploading has no blob for a dialog to fetch.
 */
export function previewableAttachment(a: {
  blobId?: string | null;
  error?: string | null;
  type?: string | null;
  name?: string | null;
}): boolean {
  return Boolean(a.blobId) && !a.error && previewKind(a.type, a.name) !== null;
}

/**
 * Past this, a text file is not read in a dialog -- it is downloaded and opened
 * in something built for it. The number is about the browser, not the network:
 * laying out a few million characters in one `<pre>` locks the tab up.
 */
export const TEXT_PREVIEW_MAX = 2 * 1024 * 1024;

/** A second guard for when the size was not known ahead of the fetch. */
export const TEXT_PREVIEW_CHARS = 400_000;
