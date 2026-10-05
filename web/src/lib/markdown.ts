import { isMarkdownExtension, mediaType } from "@gilbert/shared/media";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { FORBID_ATTR, OURS_FORBID_TAGS } from "@/lib/html";

/**
 * Markdown, rendered for the file viewer.
 *
 * The source is somebody else's file -- uploaded, or shared into the account
 * by another user -- so it is treated as hostile. Markdown is not a safe
 * subset of anything: raw HTML passes straight through it by design, so
 * `<script>` in a .md is a script tag unless something takes it out. That
 * something is DOMPurify, which the app already carries for mail.
 *
 * Rendered inline rather than in a shadow root the way mail bodies are: this
 * output is ours, sanitised and styled by `.md-body`, where an email arrives
 * with a design of its own that has to be quarantined from the app's. That is
 * why its blocklist is the shared one with `style` added, the same policy the
 * composer gets (`@/lib/html`), and why the `style` attribute is forbidden here
 * as well: a file brings text, not the app's styling.
 */

marked.use({ gfm: true, breaks: false });

export function isMarkdown(
  type: string | null | undefined,
  name: string | null | undefined,
): boolean {
  const t = mediaType(type);
  if (t === "text/markdown" || t === "text/x-markdown") return true;
  // A .md upload usually arrives as application/octet-stream, so the name is
  // the only evidence -- one extension set, shared with the preview that
  // decides the same file is text-shaped.
  return isMarkdownExtension(name);
}

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false });
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: false,
    RETURN_DOM: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: [...OURS_FORBID_TAGS],
    FORBID_ATTR: [...FORBID_ATTR, "style"],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["target", "rel"],
  }) as unknown as HTMLElement;

  /*
   * Pictures become links rather than pictures.
   *
   * An image in a Markdown file is either a relative path, which has no base
   * to resolve against here and would render broken, or a URL somewhere else,
   * which fetches on open and tells that server the file was read -- the same
   * tracking pixel this app blocks in mail. Neither is worth rendering. A link
   * keeps the alt text and the address visible, so nothing vanishes silently
   * and the reader chooses whether to fetch it.
   */
  for (const img of [...clean.querySelectorAll("img")]) {
    const href = img.getAttribute("src") ?? "";
    const label = img.getAttribute("alt") || href || "image";
    const a = clean.ownerDocument.createElement("a");
    a.className = "md-img";
    a.textContent = label;
    if (/^https?:/i.test(href)) {
      a.setAttribute("href", href);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      a.setAttribute("title", href);
    }
    img.replaceWith(a);
  }

  // Links leave the app, so they leave it safely.
  for (const a of clean.querySelectorAll("a[href]")) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }

  return clean.innerHTML;
}
