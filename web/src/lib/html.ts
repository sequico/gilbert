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

/* "Even mail that styles itself" — the second, opt-in switch, applied on top of
   .themed. Everything the sender coloured is neutralised except the surfaces
   marked by markKeptSurfaces() and what it marked as sitting on them, so a
   white wrapper table
   stops being a bright card while a blue button keeps its white label. The
   sender's markup is untouched; this is all cascade, so the switch is
   reversible and print still pins the tokens to ink on white. */
.ihm-email-root.forced { color: var(--fg, #1f2937) !important; background: var(--bg-elev, #fff) !important; }
.ihm-email-root.forced *:not([data-ihm-keep]):not([data-ihm-in-keep]) { color: inherit !important; background-color: transparent !important; }
.ihm-email-root.forced a:not([data-ihm-keep]):not([data-ihm-in-keep]) { color: var(--link, #0f766e) !important; }
`;

/**
 * Does this message paint itself? Mail that sets a background or text colour
 * has a design of its own, and forcing a dark palette on half of it is worse
 * than leaving it alone — so those keep the light card they were built for.
 *
 * The bar is deliberately low, and that is the point of the second switch
 * (`themeStyledMessages`): in real mail this is true of very nearly everything.
 * One `color:#FFFFFF` on one button label is enough, so a template that is
 * plain in every way a reader would notice still counts as painting itself.
 * See `markKeptSurfaces` for what the opt-in does about it.
 */
export function htmlDeclaresColors(html: string, bodyStyle = ""): boolean {
  const haystack = `${bodyStyle} ${html}`;
  return (
    /\bbgcolor\s*=/i.test(haystack) ||
    /<font[^>]*\bcolor\s*=/i.test(haystack) ||
    /(?:^|[;"'\s{])(?:background(?:-color)?|color)\s*:/i.test(haystack)
  );
}

/* ---------- forcing the theme onto mail that styles itself ---------- */

/**
 * Relative luminance per WCAG 2.x, or `null` when the colour cannot be read.
 *
 * Only what actually turns up in mail is parsed: hex in three, six or eight
 * digits, `rgb()`/`rgba()`, and the handful of names senders still write out.
 * Anything else is `null`, which the caller treats as "not a deliberate
 * surface" — the safe way round, because the failure it avoids is a white
 * sheet surviving the switch the reader just turned on.
 */
const NAMED: Record<string, string> = {
  white: "#ffffff",
  ivory: "#fffff0",
  snow: "#fffafa",
  whitesmoke: "#f5f5f5",
  ghostwhite: "#f8f8ff",
  floralwhite: "#fffaf0",
  seashell: "#fff5ee",
  beige: "#f5f5dc",
  linen: "#faf0e6",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  gainsboro: "#dcdcdc",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  black: "#000000",
  navy: "#000080",
  darkblue: "#00008b",
  maroon: "#800000",
  teal: "#008080",
};

export function relativeLuminance(color: string): number | null {
  const raw = color.trim().toLowerCase();
  if (
    !raw ||
    raw === "transparent" ||
    raw === "inherit" ||
    raw === "initial" ||
    raw === "none"
  )
    return null;
  let r: number,
    g: number,
    b: number,
    a = 1;
  const named = NAMED[raw];
  const hex = (named ?? raw).match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3)
      [r, g, b] = [h[0]! + h[0]!, h[1]! + h[1]!, h[2]! + h[2]!].map((x) =>
        parseInt(x, 16),
      ) as [number, number, number];
    else if (h.length === 6 || h.length === 8) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
      if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
    } else return null;
  } else {
    const m = raw.match(
      /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)(?:[\s,/]+([0-9.%]+))?\s*\)$/,
    );
    if (!m) return null;
    r = Number(m[1]);
    g = Number(m[2]);
    b = Number(m[3]);
    if (m[4] !== undefined)
      a = m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  }
  if ([r, g, b, a].some((n) => !Number.isFinite(n))) return null;
  // A fully transparent colour paints nothing, whatever its channels say.
  if (a === 0) return null;
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Above this, a background is a sheet the message is laid on rather than a
 * thing drawn on top of it. White wrappers sit at 1.0; the blue of a call to
 * action lands near 0.09, mid-grey near 0.22.
 */
export const LIGHT_SURFACE_LUMINANCE = 0.5;

/** The background an element declares itself, or null if it declares none we can read. */
function declaredLuminance(el: HTMLElement): number | null {
  const declared = el.getAttribute("bgcolor") ?? el.style?.backgroundColor ?? "";
  if (!declared) return null;
  return relativeLuminance(declared);
}

/**
 * Mark the surfaces that must survive being themed, and count them.
 *
 * The reader has asked for their palette on mail that brings its own, which
 * cannot be done perfectly — this is the same bargain a dark-reader extension
 * makes. What it can do is tell the two kinds of colour apart: a **sheet** the
 * design sits on, which is what reads as a bright card and is neutralised, and
 * a **painted surface** — a button, a banner — which is kept whole so its
 * label stays legible on it.
 *
 * Two attributes come out of this. `data-ihm-keep` is a painted surface, which
 * keeps its own colours. `data-ihm-in-keep` is an element sitting on one with
 * no background of its own, whose colour is left alone so a white label on a
 * blue button stays readable. One rule in EMAIL_BASE_CSS neutralises
 * everything else.
 *
 * The distinction that matters is that being *inside* a painted surface is not
 * inherited past a sheet. A light table nested in a dark 600px card is still a
 * sheet and is still neutralised — that is issue #310, where a dark campaign
 * rendered with beige cards inside it because the exemption used to be
 * `[data-ihm-keep] *` in CSS and could not see the difference. Paint resumes
 * below it: a dark button inside that nested table is kept as usual.
 *
 * Nothing the sender wrote is removed, so turning the switch off puts the
 * message back exactly as it was — and a colour that arrived from a `<style>`
 * block rather than an attribute is covered too, which is most of them in
 * modern templates.
 */
export function markKeptSurfaces(root: ParentNode): number {
  let kept = 0;

  // An explicit stack rather than recursion: this walks untrusted mail, and
  // deeply nested tables are exactly what old newsletter HTML is made of.
  const stack: Array<{ el: HTMLElement; onPaint: boolean }> = [];
  const push = (parent: ParentNode, onPaint: boolean) => {
    for (const child of Array.from(parent.children)) {
      stack.push({ el: child as HTMLElement, onPaint });
    }
  };

  push(root, false);

  while (stack.length) {
    const { el, onPaint } = stack.pop()!;
    const lum = declaredLuminance(el);
    let childrenOnPaint = onPaint;

    if (lum !== null && lum < LIGHT_SURFACE_LUMINANCE) {
      // Painted: keep it whole, and anything on it inherits that protection.
      el.setAttribute("data-ihm-keep", "");
      kept++;
      childrenOnPaint = true;
    } else if (lum !== null) {
      // A sheet, wherever it sits. Left unmarked so it neutralises, and it
      // ends the protection rather than passing it on.
      childrenOnPaint = false;
    } else if (onPaint) {
      // No background of its own, sitting on paint: leave its colour alone.
      el.setAttribute("data-ihm-in-keep", "");
    }

    push(el, childrenOnPaint);
  }

  return kept;
}

export const TEXT_EMAIL_CSS = `
:host { display:block; }
.ihm-text-root { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 13.5px; line-height:1.55; white-space: pre-wrap; overflow-wrap: anywhere; color: inherit; }
.ihm-text-root a { color: var(--link, #0f766e); }
.ihm-text-root .q1 { color: var(--q1,#2563eb); } .ihm-text-root .q2 { color: var(--q2,#16a34a); } .ihm-text-root .q3 { color: var(--q3,#9333ea); }
`;
