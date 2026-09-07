import DOMPurify from "dompurify";
import { withBase } from "@/lib/basePath";

export interface SanitizeOptions {
  /** Map of Content-ID (without angle brackets) → URL for inline images. */
  cidMap?: Record<string, string>;
  /** Whether remote content (http/https images, css urls) may load. */
  allowRemote?: boolean;
  /** Route remote images through the privacy proxy. */
  proxyRemote?: boolean;
}

export interface SanitizeResult {
  html: string;
  remoteCount: number;
  bodyStyle: string;
}

const REMOTE_URL_RE = /^(https?:)?\/\//i;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const IE_CSS_HOOK_RE = /expression\s*\(|behavior\s*:/i;

let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
    // Forms are forbidden but be safe about formaction-like attributes on anything.
    for (const attr of ["formaction", "action", "ping", "xlink:href"]) {
      if (node.hasAttribute(attr)) node.removeAttribute(attr);
    }
  });
}

/**
 * Make CSS text look the way a CSS parser will see it, before the plain-text
 * decisions below run on it.
 *
 * The drop/block/proxy and position-neutralising surgery in this file runs on
 * raw text, and mail is welcome to disagree with the plain-text reading of it.
 * A CSS parser resolves backslash escapes and discards comments before it
 * tokenizes, so `u\72l(...)`, a `url(` split across a comment, and a
 * `fixed` spelled `\66ixed` are to it `url(...)`, `url(...)` and
 * `position:fixed`. Decoding the same way here means
 * the surgery sees what the browser will see, and the decoded form is what is
 * emitted -- a hostile escape sequence cannot hide a remote fetch, an @import
 * or a `position:fixed` from it any more than it can hide them from the parser.
 *
 * Comments are stripped first, on the raw text: a CSS comment ends at the
 * first literal star-slash and ignores escapes inside it, so that is also
 * where the comment really ends. Escapes are then decoded -- a backslash
 * before a hex code point (followed by one optional whitespace terminator)
 * becomes that character, a backslash before a newline is a dropped line
 * continuation, and any other backslash escapes the next character into
 * itself.
 */
function decodeCss(css: string): string {
  const noComments = css.replace(CSS_COMMENT_RE, "");
  return noComments.replace(
    /\\([0-9a-fA-F]{1,6}\s?|[\r\n]|.)/g,
    (_whole, esc: string) => {
      if (esc === "\r" || esc === "\n") return "";
      const hex = /^[0-9a-fA-F]{1,6}/.exec(esc)?.[0];
      if (hex == null) return esc;
      const cp = parseInt(hex, 16);
      // The spec maps NUL, out-of-range values and lone surrogates to U+FFFD;
      // String.fromCodePoint would rather throw on the last of those.
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\uFFFD";
      return String.fromCodePoint(cp);
    },
  );
}

/**
 * Decode numeric character references in an attribute value captured from raw
 * HTML. The DOM hands the sanitizer element style attributes already
 * entity-decoded; the `<body>` capture below reads the raw message instead, so
 * it has to do the HTML half of the decoding itself before the CSS half, or an
 * `&#117;rl(...)` would stay hidden from the url() surgery and then decode in
 * the reader's browser.
 */
function decodeNumericEntities(s: string): string {
  return s.replace(/&#(x[0-9a-fA-F]+|\d+);/g, (whole, ref: string) => {
    const hex = ref[0]?.toLowerCase() === "x";
    const cp = parseInt(hex ? ref.slice(1) : ref, hex ? 16 : 10);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(cp);
    } catch {
      return whole; // a lone surrogate: leave the reference alone
    }
  });
}

/**
 * Drop every declaration or rule run that carries an expression() or
 * behavior: hook, outright.
 *
 * Neither is something to rewrite away and keep: expression() and behavior:
 * are IE-era hooks that no current engine runs, but a sanitizer that leaves
 * them sitting in its output is one engine away from running them. A
 * declaration is only meaningful whole, so the run from one `;` (or `}`) to
 * the next is removed when it carries either hook. Runs inside quoted strings
 * are walked past, so a `content:` that merely displays the words is not split
 * on its semicolons -- it is still dropped if the words are in it, which is
 * the point of a blacklist this blunt.
 */
function dropIeCssHooks(css: string): string {
  let out = "";
  let run = "";
  let quote: string | null = null;
  const flush = (terminator: string) => {
    out += IE_CSS_HOOK_RE.test(run) ? "" : run + terminator;
    run = "";
  };
  for (const ch of css) {
    if (quote) {
      run += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      run += ch;
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "}") flush(ch);
    else run += ch;
  }
  flush("");
  return out;
}

/**
 * Blunt the positioning tricks mail CSS can use to escape its card.
 *
 * A shadow root scopes selectors but not layout, so `position:fixed` in a
 * message is still positioned against the viewport — enough to paint a
 * convincing fake over the whole app. The control that actually stops that is
 * layout containment on an ancestor of the shadow host (see `.message-body` in
 * app.css), which mail CSS has no selector for. This is the second line:
 * neutralise the declarations themselves, and defang `:host`, which is how mail
 * CSS would otherwise reach the host element.
 */
function hardenCss(css: string): string {
  return (
    css
      // `:host` / `:host-context` become a selector that matches nothing; where
      // they took an argument the rule is left invalid, and so dropped.
      .replace(/:host(-context)?/gi, ":not(*)")
      .replace(/position\s*:\s*(fixed|sticky)/gi, "position:static")
  );
}

export function proxiedImageUrl(url: string): string {
  return withBase(`/api/image?url=${encodeURIComponent(url)}`);
}

export function sanitizeEmailHtml(
  input: string,
  opts: SanitizeOptions = {},
): SanitizeResult {
  ensureHooks();
  let bodyStyle = "";
  const bodyMatch = /<body([^>]*)>/i.exec(input);
  if (bodyMatch) {
    const attrs = bodyMatch[1]!;
    const bg = /bgcolor\s*=\s*["']?([#\w()%,.\s-]+)["']?/i.exec(attrs)?.[1];
    const style =
      /style\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ??
      /style\s*=\s*'([^']*)'/i.exec(attrs)?.[1];
    // This capture reads the raw message, so numeric character references have
    // not been decoded for it the way the DOM decodes them for element styles.
    if (bg) bodyStyle += `background-color:${decodeNumericEntities(bg.trim())};`;
    if (style) bodyStyle += decodeNumericEntities(style);
  }

  const clean = DOMPurify.sanitize(input, {
    WHOLE_DOCUMENT: false,
    RETURN_DOM: true,
    FORBID_TAGS: [
      "script",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "applet",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
      "meta",
      "link",
      "base",
      "svg",
      "math",
      "video",
      "audio",
      "source",
      "track",
      "canvas",
      "template",
      "slot",
      "dialog",
      "noscript",
    ],
    FORBID_ATTR: [
      "srcdoc",
      "formaction",
      "action",
      "ping",
      "autofocus",
      "autoplay",
      "contenteditable",
      "draggable",
      "tabindex",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    USE_PROFILES: { html: true },
    ADD_TAGS: ["style", "center", "font", "marquee"],
    ADD_ATTR: [
      "bgcolor",
      "background",
      "valign",
      "align",
      "border",
      "cellpadding",
      "cellspacing",
      "width",
      "height",
      "color",
      "face",
      "size",
      "target",
    ],
  }) as unknown as HTMLElement;

  let remoteCount = 0;
  const cidMap = opts.cidMap ?? {};
  const allow = Boolean(opts.allowRemote);
  const proxy = Boolean(opts.proxyRemote);

  const remote = (url: string): string => {
    remoteCount++;
    if (!allow) return "";
    return proxy ? proxiedImageUrl(url) : url;
  };

  const rewriteUrl = (raw: string): { url: string; keep: boolean } => {
    const url = raw.trim();
    if (/^cid:/i.test(url)) {
      const cid = url.slice(4).replace(/^<|>$/g, "");
      const mapped = cidMap[cid] ?? cidMap[cid.toLowerCase()];
      return mapped ? { url: mapped, keep: true } : { url: "", keep: false };
    }
    if (/^data:image\//i.test(url)) return { url, keep: true };
    if (REMOTE_URL_RE.test(url)) {
      const abs = url.startsWith("//") ? `https:${url}` : url;
      const u = remote(abs);
      return { url: u, keep: Boolean(u) };
    }
    // Relative or unknown scheme -> drop.
    return { url: "", keep: false };
  };

  // Image-bearing attributes
  const els = clean.querySelectorAll<HTMLElement>("[src],[background],[poster],[srcset]");
  els.forEach((el) => {
    if (el.hasAttribute("srcset")) el.removeAttribute("srcset");
    for (const attr of ["src", "background", "poster"]) {
      const v = el.getAttribute(attr);
      if (v == null) continue;
      const r = rewriteUrl(v);
      if (r.keep) el.setAttribute(attr, r.url);
      else {
        el.removeAttribute(attr);
        if (attr === "src" && el.tagName === "IMG") {
          el.setAttribute("data-ihm-blocked", "1");
          if (REMOTE_URL_RE.test(v)) el.setAttribute("data-ihm-remote", v.trim());
        }
      }
    }
  });

  // CSS url() in style attributes and <style> blocks
  const rewriteCss = (css: string): string =>
    css.replace(CSS_URL_RE, (_m, q: string, u: string) => {
      const r = rewriteUrl(u);
      return r.keep ? `url(${q}${r.url}${q})` : "none";
    });
  // One pipeline for every CSS surface the sanitizer touches: decode what a
  // CSS parser would decode, drop the constructs that must not survive, then
  // harden and rewrite on the decoded form.
  const processCss = (raw: string): string => {
    const decoded = decodeCss(raw);
    const noImports = decoded.replace(/@import[^;]+;?/gi, "");
    return hardenCss(rewriteCss(dropIeCssHooks(noImports)));
  };
  clean.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    const s = el.getAttribute("style");
    if (!s) return;
    const out = processCss(s);
    if (out !== s) el.setAttribute("style", out);
  });
  clean.querySelectorAll("style").forEach((st) => {
    const css = st.textContent ?? "";
    if (!css) return;
    const out = processCss(css);
    // The decoded text is written back into a raw-text element, and that html
    // is parsed again when it lands in the reader (MessageView sets it via
    // innerHTML). A CSS escape that decoded to `</style` would otherwise end
    // the element early on that second parse; escaping the `<` keeps the
    // element intact and means the same character to the CSS parser.
    st.textContent = out.replace(/<\/style/gi, "\\3c /style");
  });
  if (bodyStyle) bodyStyle = processCss(bodyStyle);

  return { html: clean.innerHTML, remoteCount, bodyStyle };
}

/** Minimal sanitizer for signatures / composer HTML (no remote blocking, keeps images). */
export function sanitizeEditorHtml(input: string): string {
  ensureHooks();
  return DOMPurify.sanitize(input, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "style",
      "meta",
      "link",
      "base",
      "svg",
      "math",
    ],
    FORBID_ATTR: ["srcdoc", "formaction", "ping", "onerror", "onload"],
    ADD_ATTR: [
      "target",
      "bgcolor",
      "align",
      "valign",
      "border",
      "cellpadding",
      "cellspacing",
      "width",
      "height",
      "color",
      "face",
      "size",
    ],
  }) as string;
}

/** Base CSS injected into the shadow root that hosts HTML email. */
export const EMAIL_BASE_CSS = `
:host { display:block; color-scheme: light; }
:host(.themed) { color-scheme: inherit; }
.ihm-email-root { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color:#1f2937; background:#fff; padding:16px; border-radius:8px; overflow-wrap:anywhere; word-break:normal; contain: content; }
.ihm-email-root img { max-width:100%; height:auto; }
.ihm-email-root img[data-ihm-blocked] { display:inline-block; min-width:16px; min-height:16px; background:#f1f5f9 repeating-linear-gradient(45deg,#e2e8f0 0 6px,#f1f5f9 6px 12px); border:1px dashed #cbd5e1; }
.ihm-email-root table { max-width:100%; }
.ihm-email-root pre { white-space:pre-wrap; }
.ihm-email-root blockquote { margin:0 0 0 .8ex; border-left:2px solid #cbd5e1; padding-left:1ex; color:#475569; }
.ihm-email-root a { color:#0f766e; }
.ihm-email-root * { max-width:100%; box-sizing:border-box; }
.ihm-email-root [style*="position:fixed"], .ihm-email-root [style*="position: fixed"] { position:static !important; }

/* "Follow the app theme" — only applied to mail that brings no colours of its
   own. The custom properties are inherited from the host document, so a theme
   switch repaints the message without re-rendering it. */
.ihm-email-root.themed { color: var(--fg, #1f2937); background: var(--bg-elev, #fff); }
.ihm-email-root.themed blockquote { border-left-color: var(--border-strong, #cbd5e1); color: var(--fg-muted, #475569); }
.ihm-email-root.themed a { color: var(--link, #0f766e); }
.ihm-email-root.themed hr { border-color: var(--border, #e3e7ec); }
.ihm-email-root.themed img[data-ihm-blocked] { background: var(--bg-sunken, #f1f5f9) repeating-linear-gradient(45deg, var(--bg-hover, #e2e8f0) 0 6px, transparent 6px 12px); border-color: var(--border-strong, #cbd5e1); }
`;

/**
 * Does this message paint itself? Mail that sets a background or text colour
 * has a design of its own, and forcing a dark palette on half of it is worse
 * than leaving it alone — so those keep the light card they were built for.
 */
export function htmlDeclaresColors(html: string, bodyStyle = ""): boolean {
  const haystack = `${bodyStyle} ${html}`;
  return (
    /\bbgcolor\s*=/i.test(haystack) ||
    /<font[^>]*\bcolor\s*=/i.test(haystack) ||
    /(?:^|[;"'\s{])(?:background(?:-color)?|color)\s*:/i.test(haystack)
  );
}

export const TEXT_EMAIL_CSS = `
:host { display:block; }
.ihm-text-root { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 13.5px; line-height:1.55; white-space: pre-wrap; overflow-wrap: anywhere; color: inherit; }
.ihm-text-root a { color: var(--link, #0f766e); }
.ihm-text-root .q1 { color: var(--q1,#2563eb); } .ihm-text-root .q2 { color: var(--q2,#16a34a); } .ihm-text-root .q3 { color: var(--q3,#9333ea); }
`;
